import type { WebSocket } from "ws";
import type { FastifyBaseLogger } from "fastify";
import { watch, type FSWatcher } from "chokidar";
import { randomUUID } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";
import { SyncEngine } from "@feishu-sync/core";
import { sha256, matchesAnyGlob } from "@feishu-sync/core";
import { categorizeError, FeishuApiError, RETRIABLE_ERROR_CATEGORIES } from "@feishu-sync/feishu";
import type { AuthStateStore } from "./appconfig.js";
import { NoopNotifier, type Notifier, type NotificationEvent } from "./notify.js";
import { ApiCallStats, instrumentRemote, type ApiStatsSnapshot } from "./apistats.js";
import type { Commit, ConflictRecord, EntryBinding, ErrorCategory, FolderBinding, GitStorage, LocalProvider, MetaStorage, OperationRecord, PruneHistoryOptions, PruneHistoryResult, RemoteProvider, SyncDirection, SyncMode, SyncRoot, SyncScope, SyncTrigger } from "@feishu-sync/core";

/** Task-center status filter; "active" groups queued + running operations. */
export type TaskStatus = "active" | "queued" | "running" | "succeeded" | "failed" | "cancelled" | "all";
/** An operation record joined with its entry's relativePath/kind for display. */
export type TaskView = OperationRecord & { relativePath?: string; kind?: string };

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
  private readonly notifier: Notifier;
  /** Conflict ids already announced through the notifier (per process). */
  private readonly notifiedConflicts = new Set<string>();

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
    /** Conflict/failure/credential announcements; defaults to a silent no-op. */
    notifier?: Notifier
  ) {
    // Every remote call goes through the instrumented provider so the engine
    // and the runtime's own probes share one tally.
    this.countedRemote = instrumentRemote(remote, this.apiStats);
    this.engine = new SyncEngine(gitStorage, metaStorage, local, this.countedRemote);
    this.backoffMs = retryOptions?.backoffMs ?? [1_000, 2_000, 4_000];
    this.sleepImpl = retryOptions?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.notifier = notifier ?? new NoopNotifier();
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

  /** Fire-and-forget notification (conflicts/failures/credential loss): a
   *  failing notifier must never break the sync round, so its errors are
   *  swallowed and logged. The default notifier is a silent no-op. */
  private notify(event: NotificationEvent): void {
    void this.notifier.send(event).catch((error) => this.log("warn", "notifier delivery failed", { error: error instanceof Error ? error.message : String(error) }));
  }

  async start(): Promise<void> {
    // Give credential-based providers (ProviderRegistry) a chance to initialize
    // from stored settings before the first watcher/poller runs.
    await this.prepareRemote?.();
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

  stop(): void {
    for (const watcher of this.watchers.values()) void watcher.close();
    for (const timer of this.timers.values()) clearInterval(timer);
    for (const client of this.clients) client.close();
    this.watchers.clear(); this.timers.clear(); this.clients.clear();
    if (this.maintenanceTimer) { clearInterval(this.maintenanceTimer); this.maintenanceTimer = undefined; }
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
    if (this.watchers.has(root.id)) return;
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
      void this.enqueue(root.id, () => this.scanAndSync(root, 'watch', { relativePaths: [relativePath] }));
    };
    watcher.on("add", onLocalChange);
    watcher.on("change", onLocalChange);
    watcher.on("unlink", onLocalChange);
    watcher.on("error", (error) => this.broadcast({ type: "error", rootId: root.id, error: String(error) }));
    this.watchers.set(root.id, watcher);
    const timer = setInterval(() => void this.enqueue(root.id, () => this.scanAndSync(root, 'poll')), root.pollIntervalMs);
    this.timers.set(root.id, timer);
    void this.enqueue(root.id, () => this.scanAndSync(root, 'manual'));
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
    const result = await this.enqueueResult(root.id, () => this.engine.scan(root));
    this.broadcast({ type: "scan", rootId: id, result });
    return result;
  }

  async syncRoot(id: string, trigger: SyncTrigger = 'manual'): Promise<unknown> {
    const root = await this.metaStorage.getRoot(id);
    if (!root) throw notFound(`Root not found: ${id}`);
    // Serialize with watcher/poll/event syncs for this root. Concurrent rounds
    // would race on the shared git index and the JSON binding files, so an
    // API-triggered sync joins the same per-root queue.
    return this.enqueueResult(root.id, () => this.scanAndSync(root, trigger));
  }

  /** Queue a scan+sync round for the root. Entry point for the event channel:
   *  serializes with watcher/poll tasks through the per-root queue, skips
   *  disabled roots, ignores drive events that merely echo our own recent push,
   *  and narrows the round to the changed token via an incremental scope. */
  async requestSync(rootId: string, fileToken?: string, folderToken?: string): Promise<void> {
    const root = await this.metaStorage.getRoot(rootId);
    if (!root || !root.enabled) return;
    if (fileToken && this.isRecentRemotePush(fileToken)) {
      this.log("debug", "drive event ignored: echo of a recent push", { rootId, fileToken });
      return;
    }
    // folderToken (drive.file.created_in_folder) feeds the incremental fast
    // path: an unbound new token is located with a single-level listing of the
    // announced folder instead of a full drive walk.
    const scope: SyncScope | undefined = fileToken || folderToken
      ? { remoteTokens: fileToken ? [fileToken] : undefined, remoteParentTokens: folderToken ? [folderToken] : undefined }
      : undefined;
    await this.enqueue(root.id, () => this.scanAndSync(root, 'event', scope));
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
    const localPathExists = (await this.local.scan(root)).some((file) => file.relativePath === relativePath);
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
    if (!binding?.remoteToken) throw new Error("Conflict entry is no longer bound to a remote document");
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
    return result;
  }

  /** Ignore or restore an entry. Ignoring keeps the current single-side
   *  state and skips every future evaluation until restored. */
  async setEntryIgnored(entryId: string, ignored: boolean): Promise<EntryBinding> {
    const binding = await this.metaStorage.findBindingById(entryId);
    if (!binding) throw Object.assign(new Error(`Entry not found: ${entryId}`), { statusCode: 404 });
    const next: EntryBinding = { ...binding, ignoredAt: ignored ? new Date().toISOString() : undefined, updatedAt: new Date().toISOString() };
    await this.metaStorage.setBinding(binding.rootId, binding.relativePath, next);
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
    // Outer loop re-lists pending entries so cascading re-arms (a synced asset
    // re-arming the documents that reference it, link maps) are processed in the
    // same round; the per-entry attempt cap bounds pathological cascades. Each
    // entry owns one operation record whose retryCount climbs on transient
    // failures via syncEntryWithRetry's exponential backoff.
    const attempts = new Map<string, number>();
    while (true) {
      const pending = (await this.metaStorage.listBindings(root.id))
        // Ignored entries are frozen by the user; never evaluate them here.
        .filter((binding) => binding.status === "pending" && !binding.ignoredAt && (attempts.get(binding.entryId) ?? 0) < 3)
        .sort((left, right) => Number(left.kind !== "asset") - Number(right.kind !== "asset"));
      if (pending.length === 0) break;
      // Queue the whole round up-front: every entry about to sync gets its
      // queued operation record before the first one starts, so the task
      // center shows the full in-progress queue instead of a single running
      // task (cascading re-arms queue the same way on their pass).
      const queued: Array<{ binding: EntryBinding; operation: OperationRecord }> = [];
      for (const binding of pending) {
        attempts.set(binding.entryId, (attempts.get(binding.entryId) ?? 0) + 1);
        const operation = await this.metaStorage.addOperation({
          entryId: binding.entryId, rootId: root.id, direction: "merge", operation: "sync-entry",
          trigger, startedAt: new Date().toISOString(), maxRetries: 3
        });
        this.broadcast({ type: "operation-queued", rootId: root.id, operation });
        queued.push({ binding, operation });
      }
      for (let index = 0; index < queued.length; index += 1) {
        const item = queued[index]!;
        // Credential failures fail every entry; surface once, cancel the
        // still-queued records so no orphan stays "in progress", stop the round.
        if (await this.syncEntryWithRetry(item.binding, root, trigger, item.operation)) {
          for (const rest of queued.slice(index + 1)) {
            const cancelled = await this.metaStorage.updateOperation(rest.operation.id, { status: "cancelled", completedAt: new Date().toISOString() });
            this.broadcast({ type: "operation-cancelled", rootId: root.id, operation: cancelled });
          }
          return { ...scan, entries: await this.metaStorage.listBindings(root.id), authInvalid: true };
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
    const cleanPaths = new Set(finalBindings.filter((binding) => binding.status === "clean" && !binding.ignoredAt).map((binding) => binding.relativePath));
    try {
      await this.gitStorage.commitBaseline(root.id, `sync: ${trigger}`, trigger, cleanPaths);
    } catch (error) {
      this.log("warn", "git commit failed", { rootId: root.id, error: error instanceof Error ? error.message : String(error) });
    }
    await this.markAuthHealthy();
    // Announce conflicts this round produced (Notifier hook). Each conflict is
    // announced once per process; resolving and re-conflicting makes a new id.
    for (const conflict of await this.metaStorage.listConflicts("open")) {
      if (this.notifiedConflicts.has(conflict.id)) continue;
      this.notifiedConflicts.add(conflict.id);
      const binding = await this.metaStorage.findBindingById(conflict.entryId);
      this.notify({ category: "conflict", title: "Sync conflict needs a decision", body: `${binding?.relativePath ?? conflict.entryId}: local and remote diverged on both sides`, rootId: root.id, entryId: conflict.entryId, at: new Date().toISOString() });
    }
    this.broadcast({ type: "sync", rootId: root.id, trigger });
    this.log("info", "sync round completed", { rootId: root.id, elapsedMs: Date.now() - startedAt, trigger });
    return { ...scan, entries: finalBindings };
  }

  /** Sync one entry behind a pre-queued operation record (created by
   *  scanAndSync so the whole round is visible in the task center up front)
   *  with per-round exponential backoff (1s/2s/4s) for transient failures.
   *  Emits operation-started/completed/failed/retrying; the caller broadcasts
   *  operation-queued at queue time. Returns true when the round must abort
   *  because credentials are invalid (auth/permission fail fast and are never
   *  auto-retried). */
  private async syncEntryWithRetry(binding: EntryBinding, root: SyncRoot, trigger: SyncTrigger, operation: OperationRecord): Promise<boolean> {
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
        const succeeded = await this.metaStorage.updateOperation(operation.id, { status: "succeeded", direction, completedAt: new Date().toISOString() });
        this.broadcast({ type: "operation-completed", rootId: root.id, operation: succeeded });
        return false;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const category: ErrorCategory = categorizeError(error, binding.status);
        if (isAuthError(error) || category === "auth") {
          const failedOp = await this.metaStorage.updateOperation(operation.id, { status: "failed", error: message, errorCategory: "auth", retryCount, completedAt: new Date().toISOString(), ...failedDirection(this.engine, binding.entryId) });
          this.broadcast({ type: "operation-failed", rootId: root.id, operation: failedOp });
          this.broadcast({ type: "error", rootId: root.id, entryId: binding.entryId, error: message });
          this.log("warn", "entry sync aborted: credentials invalid", { rootId: root.id, entryId: binding.entryId });
          this.notify({ category: "credential", title: "Feishu credentials are no longer valid", body: `${binding.relativePath}: ${message}`, rootId: root.id, entryId: binding.entryId, at: new Date().toISOString() });
          await this.flagAuthInvalid();
          return true;
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
        const failedOp = await this.metaStorage.updateOperation(operation.id, { status: "failed", error: message, errorCategory: category, retryCount, completedAt: new Date().toISOString(), ...failedDirection(this.engine, binding.entryId) });
        this.broadcast({ type: "operation-failed", rootId: root.id, operation: failedOp });
        this.broadcast({ type: "error", rootId: root.id, entryId: binding.entryId, error: message });
        this.log("warn", "entry sync failed", { rootId: root.id, entryId: binding.entryId, category, retryCount, error: message });
        this.notify({ category: "failure", title: "Entry sync failed and awaits a retry", body: `${binding.relativePath}: ${message}`, rootId: root.id, entryId: binding.entryId, at: new Date().toISOString() });
        // Surface the failure on the entry itself. The status stays "error"
        // across rounds — no automatic resurrection; retryTask re-arms it.
        const failed = await this.metaStorage.findBindingById(binding.entryId);
        if (failed) await this.metaStorage.setBinding(root.id, failed.relativePath, { ...failed, status: "error", updatedAt: new Date().toISOString() });
        return false;
      }
    }
  }

  /** Task-center view over operation records. status="active" groups queued +
   *  running; concrete statuses pass through to the storage filter. Each task is
   *  joined with its entry path/kind for display. Cursor paging stays stable by
   *  deriving nextCursor from the raw page rather than the in-memory filter. */
  async listTasks(options: { status?: TaskStatus; rootId?: string; limit?: number; cursor?: string } = {}): Promise<{ tasks: TaskView[]; nextCursor?: string }> {
    const limit = options.limit ?? 100;
    const concrete = options.status && options.status !== "active" && options.status !== "all" ? options.status : undefined;
    const operations = await this.metaStorage.listOperations({ rootId: options.rootId, limit, cursor: options.cursor, status: concrete });
    const visible = options.status === "active"
      ? operations.filter((operation) => operation.status === "queued" || operation.status === "running")
      : operations;
    const tasks: TaskView[] = [];
    // The "failed & awaiting" queue only holds failures nobody has dealt with:
    // once the entry is ignored or has re-synced (clean/pending) the record
    // drops out, and only the latest failure per entry stays visible (the
    // storage listing is newest-first, so first sight wins the dedupe).
    const seenEntries = new Set<string>();
    for (const operation of visible) {
      if (operation.entryId) {
        const isLatest = !seenEntries.has(operation.entryId);
        seenEntries.add(operation.entryId);
        if (options.status === "failed" && !isLatest) continue;
      }
      const binding = operation.entryId ? await this.metaStorage.findBindingById(operation.entryId) : undefined;
      if (options.status === "failed" && binding && (binding.ignoredAt || binding.status === "clean" || binding.status === "pending")) continue;
      tasks.push({ ...operation, relativePath: binding?.relativePath, kind: binding?.kind });
    }
    const nextCursor = operations.length === limit ? operations[operations.length - 1]!.id : undefined;
    return { tasks, nextCursor };
  }

  /** Re-arm the entry behind a failed/cancelled operation and queue a manual
   *  round so the task center's retry button reprocesses it immediately. */
  async retryTask(operationId: string): Promise<{ ok: boolean; operationId: string }> {
    const operation = await this.metaStorage.getOperation(operationId);
    if (!operation) throw Object.assign(new Error(`Operation not found: ${operationId}`), { statusCode: 404 });
    if (!operation.entryId) throw Object.assign(new Error("Operation is not bound to an entry"), { statusCode: 400 });
    const binding = await this.metaStorage.findBindingById(operation.entryId);
    if (!binding) throw Object.assign(new Error(`Entry not found: ${operation.entryId}`), { statusCode: 404 });
    const root = await this.metaStorage.getRoot(binding.rootId);
    if (!root) throw Object.assign(new Error(`Root not found: ${binding.rootId}`), { statusCode: 404 });
    // Re-arm as pending (and un-ignore) so the next round re-evaluates it.
    await this.metaStorage.setBinding(binding.rootId, binding.relativePath, { ...binding, status: "pending", ignoredAt: undefined, updatedAt: new Date().toISOString() });
    await this.enqueue(root.id, () => this.scanAndSync(root, 'manual'));
    return { ok: true, operationId };
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
    }
  }

  /** Clear a previously flagged invalid state after a successful sync round. */
  private async markAuthHealthy(): Promise<void> {
    const current = (await this.authState?.getAuthFlag())?.status;
    if (current === "invalid") {
      await this.authState?.setAuthFlag("ok", new Date().toISOString());
      this.broadcast({ type: "auth-restored" });
      this.log("info", "Feishu credentials restored");
    }
  }
}

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function isAuthError(error: unknown): boolean {
  return error instanceof FeishuApiError && error.kind === "auth";
}
