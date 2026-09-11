import type { WebSocket } from "ws";
import type { FastifyBaseLogger } from "fastify";
import { watch, type FSWatcher } from "chokidar";
import { randomUUID } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";
import { SyncEngine } from "@feishu-sync/core";
import { sha256, matchesAnyGlob } from "@feishu-sync/core";
import { categorizeError, FeishuApiError, RETRIABLE_ERROR_CATEGORIES } from "@feishu-sync/feishu";
import type { AuthStateStore } from "./appconfig.js";
import { ApiCallStats, instrumentRemote, type ApiStatsSnapshot } from "./apistats.js";
import { NoopSink, shouldNotify, type NotificationCategory, type NotificationSink } from "./notify.js";
import type { Commit, ConflictRecord, EntryBinding, ErrorCategory, FolderBinding, GitStorage, LocalProvider, MetaStorage, OperationRecord, PruneHistoryOptions, PruneHistoryResult, RemoteProvider, RoundSummary, SyncDirection, SyncMode, SyncRoot, SyncScope, SyncTrigger } from "@feishu-sync/core";

/** Task-center status filter; "active" groups queued + running operations. */
export type TaskStatus = "active" | "queued" | "running" | "succeeded" | "failed" | "cancelled" | "all";
/** An operation record joined with its entry's relativePath/kind for display. */
export type TaskView = OperationRecord & { relativePath?: string; kind?: string };
/** What one entry attempt produced, tallied into the round's `summary`. */
type EntryOutcome = { authInvalid: boolean; status: "pushed" | "pulled" | "merged" | "failed" | "skipped" };
/** Notification routing comes from config.json through a thunk, so a settings
 *  change takes effect on the next event without rebuilding the runtime. */
export interface NotificationSettings {
  channel: string;
  enabled: Partial<Record<NotificationCategory, boolean>>;
}

/** Directories the sync engine writes inside the user's tree. */
const METADATA_DIRECTORIES = new Set([".git", ".feishu-sync"]);
/** Atomic-write scratch files of the metadata stores, e.g. `x.feishu-sync-7f3.tmp`. */
const METADATA_TEMP_FILE = /\.feishu-sync-[^/]*\.tmp$/;

/**
 * Build the `ignored` predicate for a root's file watcher (B1 loop prevention).
 *
 * Three families, all of which the sync round itself writes and which would
 * otherwise trigger the next round:
 * - `.git/**` — every baseline commit rewrites the index, adds loose objects and
 *   moves the branch ref. Without this the watcher fired a `trigger:"watch"`
 *   round for each commit, and that round committed again: an endless ~600ms loop.
 * - `.feishu-sync/**` and the `*.feishu-sync-*.tmp` files of its atomic writer;
 * - user exclude patterns (B6.5), matched with the same gitignore-style matcher
 *   `local.scan` uses so watching and scanning stay consistent.
 *
 * chokidar v4 dropped glob support in `ignored` (a string is now an exact path),
 * so the rules are expressed as one predicate over the POSIX-relative path.
 */
export function watcherIgnore(root: SyncRoot): (testPath: string) => boolean {
  const base = resolve(root.localPath);
  return (testPath: string): boolean => {
    const absolute = resolve(testPath);
    // Never ignore the watched root itself, or chokidar watches nothing at all.
    if (absolute === base) return false;
    const relativePath = relative(base, absolute).split(sep).join("/");
    if (relativePath === "" || relativePath.startsWith("../")) return false;
    if (relativePath.split("/").some((segment) => METADATA_DIRECTORIES.has(segment))) return true;
    if (METADATA_TEMP_FILE.test(relativePath)) return true;
    return matchesAnyGlob(relativePath, root.exclude);
  };
}

/**
 * Consume the direction the engine recorded before it wrote, so a *failed*
 * operation still reports push/pull instead of the "merge" placeholder written
 * when the record was opened (B1: `direction` is never a constant).
 * Returns an empty patch when the attempt died before any direction was chosen.
 */
function failedDirection(engine: SyncEngine, entryId: string): { direction?: SyncDirection } {
  const direction = engine.takeDirection(entryId);
  return direction ? { direction } : {};
}

/** Fastify only maps a thrown error onto a status code when it carries
 *  `statusCode`; without it a missing root answered 500 instead of 404, which a
 *  stale client (e.g. a tab polling a rootId from before a restart) reads as a
 *  server fault rather than "this root is gone". */
function notFound(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 404 });
}

export class SyncRuntime {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly clients = new Set<WebSocket>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly engine: SyncEngine;
  private maintenanceTimer?: NodeJS.Timeout;
  /** Set by `stop()`: nothing new is scheduled, and `stop()` waits for the work
   *  already queued. Without it a closing process kept writing bindings after
   *  `app.close()` resolved, because binding a root starts a round right away. */
  private stopped = false;
  private currentTrigger: SyncTrigger = 'manual';
  /** Echo guards (TTL 5s): local paths we just pulled and remote tokens we just
   *  pushed, so the watcher / drive-event channel ignores our own writes instead
   *  of looping them back into another sync round. */
  private readonly recentLocalWrites = new Map<string, number>();
  private readonly recentRemotePushes = new Map<string, number>();
  private static readonly ECHO_TTL_MS = 5_000;
  private readonly backoffMs: number[];
  private readonly sleepImpl: (ms: number) => Promise<void>;
  /** Tally of remote API calls, surfaced as the settings-page 调用统计 (B6.2). */
  private readonly apiStats = new ApiCallStats();
  private readonly countedRemote: RemoteProvider;
  private readonly notificationSink: NotificationSink;
  private readonly notificationSettings: () => NotificationSettings;
  /** Conflicts already announced through the sink, so one long-running conflict
   *  notifies once instead of on every round. */
  private readonly announcedConflicts = new Set<string>();

  constructor(
    private readonly gitStorage: GitStorage,
    private readonly metaStorage: MetaStorage,
    private readonly local: LocalProvider,
    remote: RemoteProvider,
    private readonly prepareRemote?: () => Promise<void>,
    private readonly logger?: FastifyBaseLogger,
    /** Invoked on every maintenance tick: proactively rotates user tokens. */
    private readonly maintainCredentials?: () => Promise<void>,
    /** Auth lifecycle flags live in config.json; absent in bare-runtime tests. */
    private readonly authState?: AuthStateStore,
    /** Injectable auto-retry backoff schedule/sleep so tests never wait for real. */
    retryOptions?: { backoffMs?: number[]; sleep?: (ms: number) => Promise<void> },
    /** Notification delivery (D). Default `NoopSink`: the workbench is silent
     *  unless the user selects a channel in config.json. */
    notificationOptions?: { sink?: NotificationSink; settings?: () => NotificationSettings }
  ) {
    // Every remote call goes through the instrumented provider so the engine
    // and the runtime's own probes share one tally.
    this.countedRemote = instrumentRemote(remote, this.apiStats);
    this.engine = new SyncEngine(gitStorage, metaStorage, local, this.countedRemote);
    this.backoffMs = retryOptions?.backoffMs ?? [1_000, 2_000, 4_000];
    this.sleepImpl = retryOptions?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.notificationSink = notificationOptions?.sink ?? new NoopSink();
    this.notificationSettings = notificationOptions?.settings ?? (() => ({ channel: "none", enabled: {} }));
  }

  /** Remote provider whose calls are tallied; API routes should use this one. */
  get instrumentedRemote(): RemoteProvider {
    return this.countedRemote;
  }

  /** Snapshot of the in-memory API call tally since process start (B6.2). */
  getApiStats(): ApiStatsSnapshot {
    return this.apiStats.snapshot(this.countedRemote.name);
  }

  /** Structured logging helper; no-ops when no logger is injected (tests). */
  private log(level: "debug" | "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void {
    this.logger?.[level](data ?? {}, message);
  }

  /** Deliver one notification if — and only if — the configured channel and the
   *  matching category switch both allow it (D). Delivery failures never break
   *  a sync round; a sink is an convenience, not a dependency. */
  private async notify(category: NotificationCategory, title: string, body: string, ids: { rootId?: string; entryId?: string } = {}): Promise<void> {
    const { channel, enabled } = this.notificationSettings();
    if (!shouldNotify(channel, enabled, category)) return;
    try {
      await this.notificationSink.notify({ category, title, body, ...ids, at: new Date().toISOString() });
    } catch (error) {
      this.log("warn", "notification delivery failed", { category, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    // Give credential-based providers (ProviderRegistry) a chance to initialize
    // from stored settings before the first watcher/poller runs.
    await this.prepareRemote?.();
    await this.cancelInterruptedTasks();
    for (const root of await this.metaStorage.listRoots()) {
      if (root.enabled) {
        // Initialize Git repo and meta storage for this root
        await this.gitStorage.initRoot(root);
        await this.metaStorage.initRootMeta(root.id, root.localPath);
        this.startRoot(root);
      }
    }
    this.scheduleMaintenance();
    this.log("info", "runtime started");
  }

  /** A4: records left `queued`/`running` belong to a process that is gone. Without
   *  this the task centre's「进行中」shows tasks from before a restart forever,
   *  because nothing will ever pick them up again. */
  private async cancelInterruptedTasks(): Promise<void> {
    const stale = await this.metaStorage.listOperations({ limit: 1000 }).then((operations) =>
      operations.filter((operation) => operation.status === "queued" || operation.status === "running"));
    for (const operation of stale) {
      try {
        await this.metaStorage.updateOperation(operation.id, { status: "cancelled", error: "服务重启，任务中断", completedAt: new Date().toISOString(), needsAction: false });
      } catch {
        // Record vanished between the listing and the update; nothing to clean.
      }
    }
    if (stale.length > 0) this.log("info", "cancelled tasks interrupted by restart", { count: stale.length });
  }

  /** Stop listening, then let already-queued rounds finish.
   *
   *  Awaited on purpose: `app.close()` resolving must mean the process is done
   *  touching the metadata directories, otherwise an embedder or a test that
   *  removes the workspace right after closing races a round still writing it.
   *  The queue holds only each root's tail promise, which chains everything
   *  queued before it, and the `stopped` gate keeps late watcher callbacks from
   *  appending more work while we drain. */
  async stop(): Promise<void> {
    this.stopped = true;
    const closing = [...this.watchers.values()].map((watcher) => watcher.close());
    for (const timer of this.timers.values()) clearInterval(timer);
    for (const client of this.clients) client.close();
    this.watchers.clear(); this.timers.clear(); this.clients.clear();
    if (this.maintenanceTimer) { clearInterval(this.maintenanceTimer); this.maintenanceTimer = undefined; }
    await Promise.all(closing).catch(() => undefined);
    await Promise.all([...this.queues.values()]).catch(() => undefined);
    this.queues.clear();
  }

  /** Enforce retention policies; defaults configurable via SYNC_RETENTION_* env vars. */
  async pruneHistory(options: PruneHistoryOptions = {}): Promise<PruneHistoryResult> {
    const result = await this.metaStorage.pruneHistory({
      keepOperations: options.keepOperations ?? numberFromEnv("SYNC_RETENTION_OPERATIONS", 1000),
      keepOperationHours: options.keepOperationHours ?? numberFromEnv("SYNC_RETENTION_OPERATION_HOURS", 24),
      resolvedConflictDays: options.resolvedConflictDays ?? numberFromEnv("SYNC_RETENTION_CONFLICT_DAYS", 30)
    });
    if (result.operations + result.conflicts + result.snapshots > 0) {
      this.broadcast({ type: "maintenance-pruned", ...result });
    }
    this.log("info", "maintenance prune finished", { ...result });
    return result;
  }

  /**
   * Task center「清空已完成」: drop finished operation records right now.
   * pruneHistory is retention-based (keep 1000 / 24h), so routing the button
   * there reported "cleared 0" for anything short of a very long history.
   * Failures stay unless the caller explicitly asks for them.
   */
  async clearCompletedTasks(statuses?: OperationRecord["status"][]): Promise<{ cleared: number }> {
    const cleared = await this.metaStorage.clearCompletedOperations(statuses);
    if (cleared > 0) this.broadcast({ type: "maintenance-pruned", operations: cleared, conflicts: 0, snapshots: 0 });
    this.log("info", "cleared completed operations", { cleared });
    return { cleared };
  }

  private scheduleMaintenance(): void {
    if (this.maintenanceTimer) return;
    const intervalMs = numberFromEnv("SYNC_MAINTENANCE_INTERVAL_MS", 3_600_000);
    if (intervalMs <= 0) return;
    this.maintenanceTimer = setInterval(() => {
      void this.pruneHistory().catch(() => undefined);
      // Proactively rotate user tokens so long-idle deployments never hit an
      // expired access token; failures surface via the refresh-invalid hook.
      void this.maintainCredentials?.().catch(() => undefined);
    }, intervalMs);
    this.maintenanceTimer.unref();
  }

  startRoot(root: SyncRoot): void {
    if (this.stopped || this.watchers.has(root.id)) return;
    const watcher = watch(root.localPath, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      // See watcherIgnore: our own metadata (.git / .feishu-sync / atomic tmp
      // files) and user excludes must never start another sync round.
      ignored: watcherIgnore(root)
    });
    // Incremental watch sync scoped to the changed path, skipping echoes of our
    // own pull-writes (recentLocalWrites) to avoid a watcher → sync → write loop.
    const onLocalChange = (changedPath: string) => {
      if (this.isRecentLocalWrite(changedPath)) return;
      const relativePath = relative(root.localPath, changedPath).split(sep).join("/");
      void this.queueRound(root, 'watch', { relativePaths: [relativePath] });
    };
    watcher.on("add", onLocalChange);
    watcher.on("change", onLocalChange);
    watcher.on("unlink", onLocalChange);
    watcher.on("error", (error) => this.broadcast({ type: "error", rootId: root.id, error: String(error) }));
    this.watchers.set(root.id, watcher);
    const timer = setInterval(() => void this.queueRound(root, 'poll'), root.pollIntervalMs);
    this.timers.set(root.id, timer);
    void this.queueRound(root, 'manual');
    this.log("info", "started watcher and poll timer", { rootId: root.id, localPath: root.localPath, pollIntervalMs: root.pollIntervalMs });
  }

  stopRoot(id: string): void {
    void this.watchers.get(id)?.close();
    const timer = this.timers.get(id);
    if (timer) clearInterval(timer);
    this.watchers.delete(id);
    this.timers.delete(id);
    this.log("info", "stopped watcher and poll timer", { rootId: id });
  }

  /** Apply runtime changes to a root (interval/enabled) without losing state. */
  restartRoot(root: SyncRoot): void {
    this.stopRoot(root.id);
    if (root.enabled) this.startRoot(root);
  }

  async scanRoot(id: string): Promise<unknown> {
    const root = await this.metaStorage.getRoot(id);
    if (!root) throw notFound(`Root not found: ${id}`);
    // Serialize with any in-flight round for this root: scan mutates bindings
    // and must not interleave with a watcher/poll sync.
    const result = await this.queueRound(root, 'manual', undefined, 'scan');
    this.broadcast({ type: "scan", rootId: id, result });
    return result;
  }

  async syncRoot(id: string, trigger: SyncTrigger = 'manual'): Promise<unknown> {
    const root = await this.metaStorage.getRoot(id);
    if (!root) throw notFound(`Root not found: ${id}`);
    // Serialize with watcher/poll/event syncs for this root. Concurrent rounds
    // would race on the shared git index and the JSON binding files, so an
    // API-triggered sync joins the same per-root queue.
    return this.queueRound(root, trigger);
  }

  /**
   * A4: every round of work — poll, watcher, drive event, API button — is one
   * visible `sync-round` task. Without it a round lives only as its per-entry
   * records, so「进行中」was empty for the whole scan phase and a round that
   * found nothing to do never appeared at all.
   *
   * `mode: "scan"` re-uses the same visibility for the scan-only endpoint
   * without secretly syncing the root.
   */
  private queueRound(root: SyncRoot, trigger: SyncTrigger, scope?: SyncScope, mode: "sync" | "scan" = "sync"): Promise<unknown> {
    // Rounds fire from watcher/poll/event callbacks that can outlive `stop()` by
    // a tick; a stopped runtime must not open a task nobody will ever finish.
    if (this.stopped) return Promise.resolve(undefined);
    return this.enqueueResult(root.id, async () => {
      const queued = await this.metaStorage.addOperation({
        rootId: root.id, direction: "merge", operation: "sync-round", trigger,
        startedAt: new Date().toISOString(), maxRetries: 0
      });
      this.broadcast({ type: "operation-queued", rootId: root.id, operation: queued });
      const running = await this.metaStorage.updateOperation(queued.id, { status: "running", startedAt: new Date().toISOString() });
      this.broadcast({ type: "operation-started", rootId: root.id, operation: running });
      try {
        const result = mode === "scan" ? await this.scanOnly(root, trigger, scope) : await this.scanAndSync(root, trigger, scope);
        const summary = (result as { summary?: RoundSummary }).summary;
        const succeeded = await this.metaStorage.updateOperation(queued.id, {
          status: "succeeded", direction: "merge", completedAt: new Date().toISOString(), needsAction: false, ...(summary ? { summary } : {})
        });
        this.broadcast({ type: "operation-completed", rootId: root.id, operation: succeeded });
        return { ...(result as object), roundId: queued.id };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failed = await this.metaStorage.updateOperation(queued.id, {
          status: "failed", error: message, errorCategory: categorizeError(error, "pending"), completedAt: new Date().toISOString(), needsAction: true
        });
        this.broadcast({ type: "operation-failed", rootId: root.id, operation: failed });
        throw error;
      }
    });
  }

  /** A scan-only round: same bookkeeping as a sync round, no content is moved. */
  private async scanOnly(root: SyncRoot, trigger: SyncTrigger, scope?: SyncScope): Promise<unknown> {
    this.currentTrigger = trigger;
    let scan: Awaited<ReturnType<SyncEngine["scan"]>>;
    try {
      scan = await this.engine.scan(root, trigger, scope);
    } catch (error) {
      if (isAuthError(error)) { await this.flagAuthInvalid(); return { rootId: root.id, authInvalid: true }; }
      throw error;
    }
    this.logScanWarnings(root);
    this.broadcast({ type: "sync", rootId: root.id, trigger });
    return { ...scan, entries: scan.entries, summary: emptySummary(scan.scanned) };
  }

  /** Surface the file-name/path findings the engine could not act on itself. */
  private logScanWarnings(root: SyncRoot): void {
    for (const warning of this.engine.drainWarnings()) {
      this.log("warn", warning, { rootId: root.id });
    }
  }

  /** Queue a scan+sync round for the root. Entry point for the event channel:
   *  serializes with watcher/poll tasks through the per-root queue, skips
   *  disabled roots, ignores drive events that merely echo our own recent push,
   *  and narrows the round to the changed token via an incremental scope. */
  async requestSync(rootId: string, fileToken?: string): Promise<void> {
    const root = await this.metaStorage.getRoot(rootId);
    if (!root || !root.enabled) return;
    if (fileToken && this.isRecentRemotePush(fileToken)) {
      this.log("debug", "drive event ignored: echo of a recent push", { rootId, fileToken });
      return;
    }
    const scope: SyncScope | undefined = fileToken ? { remoteTokens: [fileToken] } : undefined;
    await this.queueRound(root, 'event', scope);
  }

  /** Local tree for the browser: fully DB-backed and credential-independent,
   *  so the detail page keeps working while Feishu credentials are invalid.
   *  Entries with an in-flight operation are flagged for the "syncing" badge. */
  async getTree(id: string): Promise<unknown> {
    const root = await this.metaStorage.getRoot(id);
    if (!root) throw notFound(`Root not found: ${id}`);
    const bindings = await this.metaStorage.listBindings(id);
    const active = new Set((await this.metaStorage.listOperations(200))
      .filter((operation) => (operation.status === "queued" || operation.status === "running") && operation.entryId !== undefined)
      .map((operation) => operation.entryId!));
    return {
      root,
      entries: active.size === 0 ? bindings : bindings.map((binding) => (active.has(binding.entryId) ? { ...binding, syncing: true } : binding))
    };
  }

  async pairEntry(rootId: string, relativePath: string, remoteToken: string): Promise<unknown> {
    const root = await this.metaStorage.getRoot(rootId);
    if (!root) throw notFound(`Root not found: ${rootId}`);
    const remoteDocument = await this.countedRemote.getDocument(remoteToken);
    // E1: this only has to answer "does this one path exist locally?".
    const localPathExists = (await this.local.scan(root, { onlyPaths: [relativePath] })).length > 0;
    if (!localPathExists) await this.local.writeText(root, relativePath, remoteDocument.content);
    const existing = await this.metaStorage.getBinding(rootId, relativePath);
    const binding: EntryBinding = existing ?? {
      entryId: randomUUID(), rootId, relativePath, kind: "document", status: "pending", updatedAt: new Date().toISOString()
    };
    await this.metaStorage.setBinding(rootId, relativePath, { ...binding, kind: "document", remoteToken, remoteParentToken: remoteDocument.parentToken || root.remoteToken, status: "pending", updatedAt: new Date().toISOString() });
    return this.syncRoot(rootId);
  }

  async deleteRemoteEntry(entryId: string): Promise<unknown> {
    const binding = await this.metaStorage.findBindingById(entryId);
    if (!binding?.remoteToken) throw new Error("Entry is not bound to a remote resource");
    await this.countedRemote.softDelete(binding.remoteToken, binding.kind === "asset" ? "file" : "docx");
    await this.metaStorage.setBinding(binding.rootId, binding.relativePath, { ...binding, status: "orphan", updatedAt: new Date().toISOString() });
    return this.metaStorage.findBindingById(entryId);
  }

  async resolveConflict(conflict: ConflictRecord, input: { resolution: "local" | "remote" | "merged" | "abort"; mergedContent?: string }): Promise<ConflictRecord> {
    if (input.resolution === "abort") {
      // Persist the abort decision and re-arm the entry so the next scan
      // re-evaluates it with fresh three-way data.
      const aborted = await this.metaStorage.resolveConflict(conflict.id, "abort");
      const abortedBinding = await this.metaStorage.findBindingById(conflict.entryId);
      if (abortedBinding) {
        await this.metaStorage.setBinding(abortedBinding.rootId, abortedBinding.relativePath, { ...abortedBinding, status: "pending", updatedAt: new Date().toISOString() });
        const abortedRoot = await this.metaStorage.getRoot(abortedBinding.rootId);
        if (abortedRoot) await this.enqueue(abortedRoot.id, () => this.scanAndSync(abortedRoot, 'manual'));
      }
      this.broadcast({ type: "conflict-aborted", conflict: aborted });
      return aborted;
    }
    const binding = await this.metaStorage.findBindingById(conflict.entryId);
    if (!binding?.remoteToken) {
      // B4: a title collision leaves the entry unbound on purpose. 「采用该远端
      // 文档」 is the one resolution that works without a token: it transfers the
      // colliding document to this entry. 「保留本地」 cannot — the title is taken —
      // so it is answered with the guidance the workbench shows instead of a
      // misleading English error.
      if (input.resolution === "remote" && conflict.collidingToken) {
        const adopted = await this.engine.adoptCollidingDocument(conflict.entryId, conflict.collidingToken);
        const adoptRoot = await this.metaStorage.getRoot(adopted.rootId);
        if (adoptRoot) await this.local.writeText(adoptRoot, adopted.relativePath, conflict.remoteContent);
        const adoptedResolved = await this.metaStorage.resolveConflict(conflict.id, "remote", conflict.remoteContent);
        if (adoptRoot) await this.queueRound(adoptRoot, 'manual');
        this.broadcast({ type: "conflict-resolved", conflict: adoptedResolved });
        return adoptedResolved;
      }
      if (conflict.collidingToken) {
        throw Object.assign(new Error("远端同名文档属于另一条目：请先重命名本地文件后重新推送，或选择「采用该远端文档」"), { statusCode: 400 });
      }
      throw new Error("Conflict entry is no longer bound to a remote document");
    }
    const root = await this.metaStorage.getRoot(binding.rootId);
    if (!root) throw new Error("Conflict root not found");
    const currentRemote = await this.countedRemote.getDocument(binding.remoteToken);
    if (conflict.remoteRevision !== undefined && currentRemote.revisionId !== undefined && conflict.remoteRevision !== currentRemote.revisionId) {
      throw Object.assign(new Error("This conflict is stale because the remote document changed again"), { statusCode: 409 });
    }
    if (conflict.remoteContentHash !== undefined && sha256(currentRemote.content) !== conflict.remoteContentHash) {
      throw Object.assign(new Error("This conflict is stale because the remote document changed again"), { statusCode: 409 });
    }
    const content = input.resolution === "local" ? conflict.localContent : input.resolution === "remote" ? conflict.remoteContent : input.mergedContent;
    if (content === undefined) throw new Error("mergedContent is required for merged resolution");
    await this.engine.applyResolvedContent(binding, root, content, currentRemote);
    await this.local.writeText(root, binding.relativePath, content);
    const resolved = await this.metaStorage.resolveConflict(conflict.id, input.resolution, content);
    await this.enqueue(binding.rootId, () => this.scanAndSync(root, 'manual'));
    this.broadcast({ type: "conflict-resolved", conflict: resolved });
    return resolved;
  }

  addClient(socket: WebSocket): void {
    this.clients.add(socket);
    socket.send(JSON.stringify({ type: "connected" }));
    socket.on("close", () => this.clients.delete(socket));
    this.log("info", "dashboard client connected", { clients: this.clients.size });
  }

  /** Public broadcast used by the app layer for settings/auth lifecycle events. */
  broadcastEvent(event: unknown): void {
    this.broadcast(event);
  }

  /** Return the stored local text of a document entry for browser preview. */
  async readDocument(entryId: string): Promise<{ relativePath: string; content: string }> {
    const binding = await this.metaStorage.findBindingById(entryId);
    if (!binding) throw Object.assign(new Error(`Entry not found: ${entryId}`), { statusCode: 404 });
    if (binding.kind !== "document") throw Object.assign(new Error("Only document entries can be previewed"), { statusCode: 400 });
    const root = await this.metaStorage.getRoot(binding.rootId);
    if (!root) throw Object.assign(new Error(`Root not found: ${binding.rootId}`), { statusCode: 404 });
    return { relativePath: binding.relativePath, content: await this.local.readText(root, binding.relativePath) };
  }

  /** Restore the entry's local file to the last known common baseline. */
  async restoreBase(entryId: string): Promise<{ ok: boolean; entryId: string; relativePath: string }> {
    const binding = await this.metaStorage.findBindingById(entryId);
    if (!binding) throw Object.assign(new Error(`Entry not found: ${entryId}`), { statusCode: 404 });
    if (binding.kind !== "document") throw Object.assign(new Error("Only document entries can be restored"), { statusCode: 400 });
    const baselineContent = await this.gitStorage.getBaseline(binding.rootId, binding.relativePath);
    if (!baselineContent) throw Object.assign(new Error("No baseline stored for this entry yet"), { statusCode: 404 });
    const root = await this.metaStorage.getRoot(binding.rootId);
    if (!root) throw Object.assign(new Error(`Root not found: ${binding.rootId}`), { statusCode: 404 });
    await this.local.writeText(root, binding.relativePath, baselineContent);
    await this.metaStorage.setBinding(binding.rootId, binding.relativePath, { ...binding, status: "pending", updatedAt: new Date().toISOString() });
    await this.enqueue(root.id, () => this.scanAndSync(root, 'manual'));
    return { ok: true, entryId, relativePath: binding.relativePath };
  }

  /** Version timeline for one document: commits that touched its path (B4).
   *  Root+path based because git history lives in the root's repository. */
  async getRootHistory(rootId: string, relativePath: string, limit = 50): Promise<Commit[]> {
    return this.gitStorage.listCommitsForPath(rootId, relativePath, limit);
  }

  /** Two-ended content for a document so the browser can diff it (B4).
   *  against="baseline" compares the working tree with the last common base;
   *  against=<commit> compares the working tree with that historical version. */
  async getEntryDiff(entryId: string, against: string = "baseline"): Promise<{ relativePath: string; against: string; baseContent: string; currentContent: string }> {
    const binding = await this.metaStorage.findBindingById(entryId);
    if (!binding) throw Object.assign(new Error(`Entry not found: ${entryId}`), { statusCode: 404 });
    if (binding.kind !== "document") throw Object.assign(new Error("Only document entries can be diffed"), { statusCode: 400 });
    const root = await this.metaStorage.getRoot(binding.rootId);
    if (!root) throw Object.assign(new Error(`Root not found: ${binding.rootId}`), { statusCode: 404 });
    const currentContent = await this.local.readText(root, binding.relativePath);
    const baseContent = against === "baseline"
      ? await this.gitStorage.getBaseline(binding.rootId, binding.relativePath) ?? ""
      : await this.gitStorage.readBlobAt(binding.rootId, against, binding.relativePath) ?? "";
    return { relativePath: binding.relativePath, against, baseContent, currentContent };
  }

  /** Roll a document's local file back to a historical commit, re-arm it as
   *  pending and queue a manual round so the remote follows (B4). Deliberately
   *  writes the blob + re-syncs rather than git.checkout, keeping the baseline
   *  linear and letting the normal push path propagate the restored content. */
  async rollbackEntry(entryId: string, commit: string): Promise<{ ok: boolean; entryId: string; relativePath: string }> {
    const binding = await this.metaStorage.findBindingById(entryId);
    if (!binding) throw Object.assign(new Error(`Entry not found: ${entryId}`), { statusCode: 404 });
    if (binding.kind !== "document") throw Object.assign(new Error("Only document entries can be rolled back"), { statusCode: 400 });
    const root = await this.metaStorage.getRoot(binding.rootId);
    if (!root) throw Object.assign(new Error(`Root not found: ${binding.rootId}`), { statusCode: 404 });
    const content = await this.gitStorage.readBlobAt(binding.rootId, commit, binding.relativePath);
    if (content === undefined) throw Object.assign(new Error(`No such version for this entry: ${commit}`), { statusCode: 404 });
    await this.local.writeText(root, binding.relativePath, content);
    await this.metaStorage.setBinding(binding.rootId, binding.relativePath, { ...binding, status: "pending", updatedAt: new Date().toISOString() });
    await this.enqueue(root.id, () => this.scanAndSync(root, 'manual'));
    return { ok: true, entryId, relativePath: binding.relativePath };
  }

  /** Folder bindings for a root, enriched with the number of bound child files
   *  so the UI can show how much each mapped directory carries (B3). */
  async listFolderBindings(rootId: string): Promise<Array<FolderBinding & { childCount: number }>> {
    const folders = await this.metaStorage.listFolderBindings(rootId);
    const bindings = await this.metaStorage.listBindings(rootId);
    return folders
      .map((folder) => ({ ...folder, childCount: bindings.filter((item) => item.relativePath.startsWith(`${folder.relativePath}/`)).length }))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  /** Manually (re)bind a local directory to a remote folder token, e.g. after
   *  the folder was recreated on the drive or the mapping went stale (B3). */
  async rebindFolder(rootId: string, relativePath: string, remoteToken: string): Promise<FolderBinding> {
    const root = await this.metaStorage.getRoot(rootId);
    if (!root) throw Object.assign(new Error(`Root not found: ${rootId}`), { statusCode: 404 });
    const binding: FolderBinding = { relativePath, remoteToken, createdAt: new Date().toISOString() };
    await this.metaStorage.setFolderBinding(rootId, relativePath, binding);
    return binding;
  }

  /** Single-entry forced sync (issue workbench / docs view retry):
   *  local-missing re-pulls the remote document, remote-missing re-creates
   *  the remote side, everything else is re-evaluated from scratch. */
  async syncEntryNow(entryId: string): Promise<EntryBinding> {
    const binding = await this.metaStorage.findBindingById(entryId);
    if (!binding) throw Object.assign(new Error(`Entry not found: ${entryId}`), { statusCode: 404 });
    const root = await this.metaStorage.getRoot(binding.rootId);
    if (!root) throw Object.assign(new Error(`Root not found: ${binding.rootId}`), { statusCode: 404 });
    await this.enqueue(root.id, () => this.syncSingleEntry(binding, root));
    const result = await this.metaStorage.findBindingById(entryId);
    if (!result) throw Object.assign(new Error(`Entry not found: ${entryId}`), { statusCode: 404 });
    // A3: the manual/batch 「重试」 button is a human action too — once the entry
    // is clean again its failure record must leave the 失败待处理 queue. When the
    // sync is still broken the record stays, because nobody has resolved it.
    if (result.status === "clean") await this.clearPendingFailures(root.id, entryId);
    return result;
  }

  /** Ignore or restore an entry. Ignoring keeps the current single-side
   *  state and skips every future evaluation until restored. */
  async setEntryIgnored(entryId: string, ignored: boolean): Promise<EntryBinding> {
    const binding = await this.metaStorage.findBindingById(entryId);
    if (!binding) throw Object.assign(new Error(`Entry not found: ${entryId}`), { statusCode: 404 });
    const rearmed = !ignored && binding.status === "error";
    const next: EntryBinding = {
      ...binding,
      ignoredAt: ignored ? new Date().toISOString() : undefined,
      // Restoring an entry frozen while it was failing means "try again": A1
      // made `error` terminal, and nothing would have noticed that the file
      // needs another push while it was ignored. Structural statuses
      // (local-missing/remote-missing/conflict) are preserved — the batch
      // resync of missing entries filters on them.
      status: rearmed ? "pending" : binding.status,
      lastErrorAt: rearmed ? undefined : binding.lastErrorAt,
      updatedAt: new Date().toISOString(),
    };
    await this.metaStorage.setBinding(binding.rootId, binding.relativePath, next);
    // A3: ignoring is one of the two ways out of the「失败待处理」queue, so it
    // retires the pending failure record immediately even though no sync ran.
    if (ignored) await this.clearPendingFailures(binding.rootId, entryId);
    this.broadcast({ type: "sync", rootId: binding.rootId });
    return (await this.metaStorage.findBindingById(entryId)) ?? next;
  }

  /** Apply a bulk action to a set of entries (B6.3): "retry" re-syncs each one,
   *  "ignore"/"unignore" flips the ignored flag. Failures on individual entries
   *  are counted, not thrown, so one bad id cannot abort the whole batch. */
  async batchEntries(entryIds: string[], action: "retry" | "ignore" | "unignore"): Promise<{ accepted: number; total: number; failed: number }> {
    let accepted = 0;
    let failed = 0;
    for (const entryId of entryIds) {
      try {
        if (action === "retry") await this.syncEntryNow(entryId);
        else await this.setEntryIgnored(entryId, action === "ignore");
        accepted += 1;
      } catch (error) {
        failed += 1;
        this.log("warn", "batch entry action failed", { entryId, action, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { accepted, total: entryIds.length, failed };
  }

  /** One-click resync of every local-missing / remote-missing entry of a
   *  root. Returns how many entries were actually processed. */
  async syncMissingEntries(rootId: string): Promise<{ rootId: string; synced: number; total: number }> {
    const root = await this.metaStorage.getRoot(rootId);
    if (!root) throw Object.assign(new Error(`Root not found: ${rootId}`), { statusCode: 404 });
    const missing = (await this.metaStorage.listBindings(rootId))
      .filter((binding) => !binding.ignoredAt && (binding.status === "local-missing" || binding.status === "remote-missing"));
    let synced = 0;
    await this.enqueue(root.id, async () => {
      for (const binding of missing) {
        try {
          await this.syncSingleEntry(binding, root);
          synced += 1;
        } catch (error) {
          this.log("warn", "missing-entry resync failed", { rootId, entryId: binding.entryId, error: error instanceof Error ? error.message : String(error) });
        }
      }
    });
    this.broadcast({ type: "sync", rootId });
    return { rootId, synced, total: missing.length };
  }

  /** Execute one forced entry sync without queueing; shared by the single
   *  and batch resync paths. */
  private async syncSingleEntry(binding: EntryBinding, root: SyncRoot): Promise<EntryBinding> {
    if (binding.ignoredAt) throw Object.assign(new Error("Entry is ignored; restore it before syncing"), { statusCode: 400 });
    let result: EntryBinding;
    if (binding.status === "local-missing") {
      result = (await this.engine.pullRemoteEntry(binding, root)) ?? binding;
    } else if (binding.status === "remote-missing") {
      result = await this.engine.recreateRemoteEntry(binding, root);
    } else {
      // error/pending (and conflicts): force a fresh three-way evaluation.
      const rearmed: EntryBinding = { ...binding, status: "pending", updatedAt: new Date().toISOString() };
      await this.metaStorage.setBinding(binding.rootId, binding.relativePath, rearmed);
      result = await this.engine.syncEntry(rearmed, root);
    }
    this.broadcast({ type: "sync", rootId: root.id });
    return result;
  }

  private async scanAndSync(root: SyncRoot, trigger: SyncTrigger = 'manual', scope?: SyncScope): Promise<unknown> {
    const startedAt = Date.now();
    this.currentTrigger = trigger;
    const mode: SyncMode = root.mode ?? "bidirectional";
    // Unified entry-point signal (manual/poll/watcher/event channel alike) so
    // the UI can show per-root progress instead of silent syncing. mode lets the
    // running bar phrase the round (bidirectional / pull-only / push-only).
    this.broadcast({ type: "sync-started", rootId: root.id, trigger, mode });
    let scan: Awaited<ReturnType<SyncEngine["scan"]>>;
    try {
      scan = await this.engine.scan(root, trigger, scope);
    } catch (error) {
      if (isAuthError(error)) { this.log("warn", "scan aborted: Feishu credentials invalid", { rootId: root.id }); await this.flagAuthInvalid(); return { rootId: root.id, authInvalid: true }; }
      this.log("error", "scan failed", { rootId: root.id, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    this.log("info", "sync round started", { rootId: root.id, localPath: root.localPath, trigger, mode });
    this.logScanWarnings(root);
    // Outer loop re-lists pending entries so cascading re-arms (a synced asset
    // re-arming the documents that reference it, link maps) are processed in the
    // same round. A2: an entry is attempted at most once per round — the earlier
    // per-entry attempt counter let the same file fail three separate times in
    // one round, which read as a hang rather than as one clear failure. The
    // auto-retry budget lives in syncEntryWithRetry's exponential backoff.
    const attempted = new Set<string>();
    const counters = { pushed: 0, pulled: 0, merged: 0, failed: 0 };
    while (true) {
      const pending = (await this.metaStorage.listBindings(root.id))
        // Ignored entries are frozen by the user; never evaluate them here.
        .filter((binding) => binding.status === "pending" && !binding.ignoredAt && !attempted.has(binding.entryId))
        .sort((left, right) => Number(left.kind !== "asset") - Number(right.kind !== "asset"));
      if (pending.length === 0) break;
      for (const binding of pending) {
        attempted.add(binding.entryId);
        // Credential failures fail every entry; surface once and stop the round.
        const outcome = await this.syncEntryWithRetry(binding, root, trigger);
        if (outcome.status === "pushed") counters.pushed += 1;
        else if (outcome.status === "pulled") counters.pulled += 1;
        else if (outcome.status === "merged") counters.merged += 1;
        else if (outcome.status === "failed") counters.failed += 1;
        if (outcome.authInvalid) {
          const aborted = await this.metaStorage.listBindings(root.id);
          return { entries: aborted, conflicts: 0, scanned: scan.scanned, authInvalid: true, summary: summarize(scan.scanned, counters, aborted) };
        }
      }
    }
    // Commit baseline after the sync round, but only for entries that reached a
    // clean state. Entries left in conflict/error/missing keep their previous
    // baseline so the next round re-evaluates them against the last-synced
    // content (per-entry three-way base), instead of absorbing an unsynced local
    // edit and mistaking it for the baseline. Ignored entries are frozen by the
    // user, so their working-tree drift must never become the baseline either;
    // when restored they are re-evaluated against the last-synced content.
    const finalBindings = await this.metaStorage.listBindings(root.id);
    const clean = finalBindings.filter((binding) => binding.status === "clean" && !binding.ignoredAt);
    const cleanPaths = new Set(clean.map((binding) => binding.relativePath));
    // The exact bytes each clean entry was left at. A file the user saved while
    // this round was still running no longer matches, and `commitBaseline` drops
    // it from the commit: absorbing an unsynced edit here would make the next
    // round read it as `base === local` and pull the remote over the edit.
    const reconciled = new Map(clean.flatMap((binding) => (binding.localContentHash ? [[binding.relativePath, binding.localContentHash] as const] : [])));
    try {
      await this.gitStorage.commitBaseline(root.id, `sync: ${trigger}`, trigger, cleanPaths, reconciled);
    } catch (error) {
      this.log("warn", "git commit failed", { rootId: root.id, error: error instanceof Error ? error.message : String(error) });
    }
    await this.markAuthHealthy();
    await this.announceConflicts(root);
    this.broadcast({ type: "sync", rootId: root.id, trigger });
    this.log("info", "sync round completed", { rootId: root.id, elapsedMs: Date.now() - startedAt, trigger });
    return { ...scan, entries: finalBindings, summary: summarize(scan.scanned, counters, finalBindings) };
  }

  /** Sync one entry behind a single operation record with per-round exponential
   *  backoff (1s/2s/4s) for transient failures. Emits operation-queued/started/
   *  completed/failed/retrying so the task center can track progress live.
   *  The returned outcome feeds the round summary. */
  private async syncEntryWithRetry(binding: EntryBinding, root: SyncRoot, trigger: SyncTrigger): Promise<EntryOutcome> {
    const operation = await this.metaStorage.addOperation({
      entryId: binding.entryId, rootId: root.id, direction: "merge", operation: "sync-entry",
      trigger, startedAt: new Date().toISOString(), maxRetries: 3
    });
    this.broadcast({ type: "operation-queued", rootId: root.id, operation });
    const maxRetries = operation.maxRetries ?? 3;
    let retryCount = 0;
    for (;;) {
      const running = await this.metaStorage.updateOperation(operation.id, { status: "running", startedAt: new Date().toISOString() });
      this.broadcast({ type: "operation-started", rootId: root.id, operation: running });
      try {
        await this.engine.syncEntry(binding, root);
        const direction = this.engine.takeDirection(binding.entryId) ?? "merge";
        // Register echo guards for the side we just wrote so the watcher /
        // drive-event channel ignores our own change instead of looping it back.
        const after = await this.metaStorage.findBindingById(binding.entryId);
        if (direction === "pull") this.registerLocalWrite(root, binding.relativePath);
        if ((direction === "push" || direction === "merge") && after?.remoteToken) this.registerRemotePush(after.remoteToken);
        const succeeded = await this.metaStorage.updateOperation(operation.id, { status: "succeeded", direction, completedAt: new Date().toISOString(), needsAction: false });
        this.broadcast({ type: "operation-completed", rootId: root.id, operation: succeeded });
        // A success retires any earlier「失败待处理」record for this entry: the
        // queue must not keep showing a failure that has since been fixed.
        await this.clearPendingFailures(root.id, binding.entryId, operation.id);
        return { authInvalid: false, status: direction === "pull" ? "pulled" : direction === "push" ? "pushed" : "merged" };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const category: ErrorCategory = categorizeError(error, binding.status);
        if (isAuthError(error) || category === "auth") {
          const failedOp = await this.recordEntryFailure(root.id, operation.id, binding.entryId, { status: "failed", error: message, errorCategory: "auth", retryCount, completedAt: new Date().toISOString(), ...failedDirection(this.engine, binding.entryId) });
          this.broadcast({ type: "operation-failed", rootId: root.id, operation: failedOp });
          this.broadcast({ type: "error", rootId: root.id, entryId: binding.entryId, error: message });
          this.log("warn", "entry sync aborted: credentials invalid", { rootId: root.id, entryId: binding.entryId });
          await this.flagAuthInvalid();
          return { authInvalid: true, status: "failed" };
        }
        // Transient categories (network/rate_limit/unknown) auto-retry with
        // exponential backoff; conflict/not_found/permission fail fast for the
        // user to resolve. Backoff delays are injectable so tests never wait.
        if (retryCount < maxRetries && RETRIABLE_ERROR_CATEGORIES.has(category)) {
          const scheduled = this.backoffMs[Math.min(retryCount, this.backoffMs.length - 1)] ?? 0;
          // A 429 may carry Retry-After; honor it as the delay floor so we do
          // not hammer a rate-limited API before its window resets (B6.2).
          const retryAfterMs = error instanceof FeishuApiError ? error.retryAfterMs : undefined;
          const delayMs = retryAfterMs !== undefined ? Math.max(scheduled, retryAfterMs) : scheduled;
          retryCount += 1;
          const queued = await this.metaStorage.updateOperation(operation.id, { status: "queued", error: message, errorCategory: category, retryCount });
          if (category === "rate_limit") this.broadcast({ type: "rate-limited", rootId: root.id, operationId: operation.id, retryAfterMs: delayMs, retryCount });
          this.broadcast({ type: "operation-retrying", rootId: root.id, operation: queued, delayMs, retryCount });
          this.log("warn", "entry sync failed; auto-retrying with backoff", { rootId: root.id, entryId: binding.entryId, retryCount, delayMs, category, error: message });
          await this.sleep(delayMs);
          continue;
        }
        const failedOp = await this.recordEntryFailure(root.id, operation.id, binding.entryId, { status: "failed", error: message, errorCategory: category, retryCount, completedAt: new Date().toISOString(), ...failedDirection(this.engine, binding.entryId) });
        this.broadcast({ type: "operation-failed", rootId: root.id, operation: failedOp });
        this.broadcast({ type: "error", rootId: root.id, entryId: binding.entryId, error: message });
        this.log("warn", "entry sync failed", { rootId: root.id, entryId: binding.entryId, category, retryCount, error: message });
        // Surface the failure on the entry itself. A1: `error` is terminal — the
        // next scan leaves it alone unless the local content actually changed or
        // a human retries, so one broken file stops burning a round forever.
        const failed = await this.metaStorage.findBindingById(binding.entryId);
        if (failed) await this.metaStorage.setBinding(root.id, failed.relativePath, { ...failed, status: "error", lastErrorAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        await this.notify("failure", `同步失败：${binding.relativePath}`, message, { rootId: root.id, entryId: binding.entryId });
        return { authInvalid: false, status: "failed" };
      }
    }
  }

  /** A3: a failed entry owns exactly one「失败待处理」record. When an entry that
   *  already waits for a human fails again (e.g. the user retried and it broke
   *  once more), the existing record absorbs the new details and the record this
   *  round just opened is marked as superseded instead of piling up. */
  private async recordEntryFailure(
    rootId: string,
    currentId: string,
    entryId: string,
    patch: Parameters<MetaStorage["updateOperation"]>[1]
  ): Promise<OperationRecord> {
    const previous = (await this.metaStorage.listOperations({ rootId, status: "failed", needsAction: true, limit: 200 }))
      .find((operation) => operation.entryId === entryId && operation.id !== currentId);
    if (previous) {
      await this.metaStorage.updateOperation(previous.id, { ...patch, needsAction: true });
      return this.metaStorage.updateOperation(currentId, { status: "failed", needsAction: false, error: patch.error });
    }
    return this.metaStorage.updateOperation(currentId, { ...patch, needsAction: true });
  }

  /** A3: drop the「失败待处理」marker from an entry's failed records, so retrying
   *  or ignoring one takes it out of the queue immediately rather than after the
   *  next round happens to succeed. `keepId` stays actionable if the fresh
   *  attempt fails again for its own reason. */
  private async clearPendingFailures(rootId: string, entryId: string, keepId?: string): Promise<void> {
    const pending = await this.metaStorage.listOperations({ rootId, status: "failed", needsAction: true, limit: 200 });
    for (const operation of pending) {
      if (operation.entryId !== entryId || operation.id === keepId) continue;
      await this.metaStorage.updateOperation(operation.id, { needsAction: false });
    }
  }

  /** Task-center view over operation records. status="active" groups queued +
   *  running; concrete statuses pass through to the storage filter. Each task is
   *  joined with its entry path/kind for display. Cursor paging stays stable by
   *  deriving nextCursor from the raw page rather than the in-memory filter. */
  async listTasks(options: { status?: TaskStatus; rootId?: string; limit?: number; cursor?: string } = {}): Promise<{ tasks: TaskView[]; nextCursor?: string }> {
    const limit = options.limit ?? 100;
    // A3:「失败待处理」is the human queue, not the failure history. Only records
    // still waiting for an action show up there; retried/ignored ones stay in the
    // history view but leave the group. `needsAction` absent means true, so
    // records written before this field keep surfacing.
    const wantsPendingFailures = options.status === "failed";
    const concrete = options.status && options.status !== "active" && options.status !== "all" && !wantsPendingFailures ? options.status : undefined;
    const operations = await this.metaStorage.listOperations({
      rootId: options.rootId, limit, cursor: options.cursor, status: concrete,
      ...(wantsPendingFailures ? { needsAction: true } : {})
    });
    const visible = options.status === "active"
      ? operations.filter((operation) => operation.status === "queued" || operation.status === "running")
      : operations;
    const tasks: TaskView[] = [];
    for (const operation of visible) {
      const binding = operation.entryId ? await this.metaStorage.findBindingById(operation.entryId) : undefined;
      tasks.push({ ...operation, relativePath: binding?.relativePath, kind: binding?.kind });
    }
    const nextCursor = operations.length === limit ? operations[operations.length - 1]!.id : undefined;
    return { tasks, nextCursor };
  }

  /** Re-arm the entry behind a failed/cancelled operation and queue a manual
   *  round so the task center's retry button reprocesses it immediately. */
  async retryTask(operationId: string): Promise<{ ok: boolean; operationId: string; roundId?: string }> {
    const operation = await this.metaStorage.getOperation(operationId);
    if (!operation) throw Object.assign(new Error(`Operation not found: ${operationId}`), { statusCode: 404 });
    // A4: a round record carries no entry — retrying it means "run the whole
    // round again", which is also the recovery path for a round killed by an
    // auth failure mid-way. It must not be rejected as "not bound to an entry".
    if (!operation.entryId) {
      if (!operation.rootId) throw Object.assign(new Error(`Root not found for operation: ${operationId}`), { statusCode: 404 });
      const roundRoot = await this.metaStorage.getRoot(operation.rootId);
      if (!roundRoot) throw notFound(`Root not found: ${operation.rootId}`);
      await this.metaStorage.updateOperation(operationId, { needsAction: false });
      const roundId = await this.queueRound(roundRoot, 'manual');
      return { ok: true, operationId, roundId: (roundId as { roundId?: string })?.roundId };
    }
    const binding = await this.metaStorage.findBindingById(operation.entryId);
    if (!binding) throw Object.assign(new Error(`Entry not found: ${operation.entryId}`), { statusCode: 404 });
    const root = await this.metaStorage.getRoot(binding.rootId);
    if (!root) throw notFound(`Root not found: ${binding.rootId}`);
    // A3: the record leaves the「失败待处理」queue the moment the user acts on it,
    // and the binding re-arms as pending (also un-ignored) with the error stamp
    // cleared so the next round re-evaluates it.
    await this.metaStorage.updateOperation(operationId, { needsAction: false });
    await this.clearPendingFailures(root.id, binding.entryId, operationId);
    await this.metaStorage.setBinding(binding.rootId, binding.relativePath, {
      ...binding, status: "pending", ignoredAt: undefined, lastErrorAt: undefined, updatedAt: new Date().toISOString()
    });
    const result = await this.queueRound(root, 'manual');
    return { ok: true, operationId, roundId: (result as { roundId?: string })?.roundId };
  }

  /** Mark a queued/running operation cancelled. The in-flight engine call is
   *  not interrupted; cancellation is advisory and drops it from the active
   *  task-center group. */
  async cancelTask(operationId: string): Promise<{ ok: boolean; operationId: string }> {
    const operation = await this.metaStorage.getOperation(operationId);
    if (!operation) throw Object.assign(new Error(`Operation not found: ${operationId}`), { statusCode: 404 });
    if (operation.status !== "queued" && operation.status !== "running") throw Object.assign(new Error("Only queued or running tasks can be cancelled"), { statusCode: 400 });
    const cancelled = await this.metaStorage.updateOperation(operationId, { status: "cancelled", completedAt: new Date().toISOString() });
    this.broadcast({ type: "operation-cancelled", rootId: operation.rootId, operation: cancelled });
    return { ok: true, operationId };
  }

  /** Retry a batch of operations; returns how many were accepted (re-armed and
   *  queued). Failures on individual ids are logged and skipped. */
  async batchRetryTasks(operationIds: string[]): Promise<{ accepted: number; total: number }> {
    let accepted = 0;
    for (const operationId of operationIds) {
      try { await this.retryTask(operationId); accepted += 1; }
      catch (error) { this.log("warn", "batch retry skipped an operation", { operationId, error: error instanceof Error ? error.message : String(error) }); }
    }
    return { accepted, total: operationIds.length };
  }

  /** Injectable sleep so auto-retry backoff never blocks tests on real timers. */
  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return this.sleepImpl(ms);
  }

  /** Remember a local path we just pulled so the watcher ignores our own write. */
  private registerLocalWrite(root: SyncRoot, relativePath: string): void {
    this.pruneEchoMap(this.recentLocalWrites);
    this.recentLocalWrites.set(join(root.localPath, relativePath), Date.now() + SyncRuntime.ECHO_TTL_MS);
  }

  /** Remember a remote token we just pushed so drive events ignore the echo. */
  private registerRemotePush(remoteToken: string): void {
    this.pruneEchoMap(this.recentRemotePushes);
    this.recentRemotePushes.set(remoteToken, Date.now() + SyncRuntime.ECHO_TTL_MS);
  }

  private isRecentLocalWrite(absolutePath: string): boolean {
    const expiry = this.recentLocalWrites.get(absolutePath);
    if (expiry === undefined) return false;
    if (expiry < Date.now()) { this.recentLocalWrites.delete(absolutePath); return false; }
    return true;
  }

  private isRecentRemotePush(remoteToken: string): boolean {
    const expiry = this.recentRemotePushes.get(remoteToken);
    if (expiry === undefined) return false;
    if (expiry < Date.now()) { this.recentRemotePushes.delete(remoteToken); return false; }
    return true;
  }

  private pruneEchoMap(map: Map<string, number>): void {
    const now = Date.now();
    for (const [key, expiry] of map) if (expiry < now) map.delete(key);
  }

  private enqueue(id: string, callback: () => Promise<unknown>): Promise<void> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.then(() => callback()).then(() => undefined).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.log("error", "queued task failed", { rootId: id, error: message });
      this.broadcast({ type: "error", rootId: id, error: message });
    });
    this.queues.set(id, next);
    return next;
  }

  /** Run a task serialized with the root's queue and return its result.
   *  Watcher/poll tasks use enqueue() (fire-and-forget, errors broadcast);
   *  API routes use this so the caller receives the result or the thrown error.
   *  The shared queue promise still never rejects, preserving fire-and-forget
   *  semantics for any task queued after this one. */
  private enqueueResult<T>(id: string, callback: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const result = previous.then(() => callback());
    this.queues.set(id, result.then(() => undefined).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.log("error", "queued task failed", { rootId: id, error: message });
      this.broadcast({ type: "error", rootId: id, error: message });
    }));
    return result;
  }

  private broadcast(event: unknown): void {
    const payload = JSON.stringify(event);
    for (const client of this.clients) if (client.readyState === 1) client.send(payload);
  }

  /** Persist the credential-invalid state once and alert every open page. */
  private async flagAuthInvalid(): Promise<void> {
    const current = (await this.authState?.getAuthFlag())?.status;
    if (current !== "invalid") {
      await this.authState?.setAuthFlag("invalid", new Date().toISOString());
      this.broadcast({ type: "auth-invalid" });
      this.log("warn", "Feishu credentials marked invalid");
      await this.notify("credential", "飞书凭证已失效", "用户令牌无法续期，请在设置页重新授权。");
    }
  }

  /** Clear a previously flagged invalid state after a successful sync round. */
  private async markAuthHealthy(): Promise<void> {
    const current = (await this.authState?.getAuthFlag())?.status;
    if (current === "invalid") {
      await this.authState?.setAuthFlag("ok", new Date().toISOString());
      this.broadcast({ type: "auth-restored" });
      this.log("info", "Feishu credentials restored");
      await this.notify("credential", "飞书凭证已恢复", "令牌续期成功，同步继续。");
    }
  }

  /** Re-announce conflicts that appeared since the last notification check, at
   *  most once per conflict id. Called at the end of every round so the channel
   *  stays useful without spamming the same conflict each round. */
  private async announceConflicts(root: SyncRoot): Promise<void> {
    const open = await this.metaStorage.listConflicts("open");
    for (const conflict of open) {
      if (this.announcedConflicts.has(conflict.id)) continue;
      const binding = await this.metaStorage.findBindingById(conflict.entryId);
      if (!binding || binding.rootId !== root.id) continue;
      this.announcedConflicts.add(conflict.id);
      await this.notify("conflict", `同步冲突：${binding.relativePath}`, conflict.reason || "本地与远端都有改动，请在异常工作台选择保留哪一侧", { rootId: root.id, entryId: conflict.entryId });
    }
  }
}

/** B6.1: the round task's badge counts. `conflicts`/`skipped` come from the
 *  final bindings so they describe the root's state after the round, while
 *  pushed/pulled/merged/failed count what this round actually did. */
function summarize(scanned: number, counters: { pushed: number; pulled: number; merged: number; failed: number }, bindings: EntryBinding[]): RoundSummary {
  const active = bindings.filter((binding) => !binding.ignoredAt);
  return {
    scanned,
    pushed: counters.pushed,
    pulled: counters.pulled,
    merged: counters.merged,
    conflicts: active.filter((binding) => binding.status === "conflict").length,
    failed: counters.failed,
    skipped: active.filter((binding) => binding.status === "local-missing" || binding.status === "remote-missing").length
  };
}

/** A scan moved nothing, so every action counter is zero by definition. */
function emptySummary(scanned: number): RoundSummary {
  return { scanned, pushed: 0, pulled: 0, merged: 0, conflicts: 0, failed: 0, skipped: 0 };
}

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function isAuthError(error: unknown): boolean {
  return error instanceof FeishuApiError && error.kind === "auth";
}
