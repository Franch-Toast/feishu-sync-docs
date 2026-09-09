import type { WebSocket } from "ws";
import type { FastifyBaseLogger } from "fastify";
import { watch, type FSWatcher } from "chokidar";
import { randomUUID } from "node:crypto";
import { SyncEngine } from "@feishu-sync/core";
import { sha256 } from "@feishu-sync/core";
import { FeishuApiError } from "@feishu-sync/feishu";
import type { AuthStateStore } from "./appconfig.js";
import type { ConflictRecord, EntryBinding, GitStorage, LocalProvider, MetaStorage, PruneHistoryOptions, PruneHistoryResult, RemoteProvider, SyncRoot, SyncTrigger } from "@feishu-sync/core";

export class SyncRuntime {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly clients = new Set<WebSocket>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly engine: SyncEngine;
  private maintenanceTimer?: NodeJS.Timeout;
  private currentTrigger: SyncTrigger = 'manual';

  constructor(
    private readonly gitStorage: GitStorage,
    private readonly metaStorage: MetaStorage,
    private readonly local: LocalProvider,
    private readonly remote: RemoteProvider,
    private readonly prepareRemote?: () => Promise<void>,
    private readonly logger?: FastifyBaseLogger,
    /** Invoked on every maintenance tick: proactively rotates user tokens. */
    private readonly maintainCredentials?: () => Promise<void>,
    /** Auth lifecycle flags live in config.json; absent in bare-runtime tests. */
    private readonly authState?: AuthStateStore
  ) {
    this.engine = new SyncEngine(gitStorage, metaStorage, local, remote);
  }

  /** Structured logging helper; no-ops when no logger is injected (tests). */
  private log(level: "debug" | "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void {
    this.logger?.[level](data ?? {}, message);
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
    const watcher = watch(root.localPath, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 } });
    watcher.on("add", () => void this.enqueue(root.id, () => this.scanAndSync(root, 'watch')));
    watcher.on("change", () => void this.enqueue(root.id, () => this.scanAndSync(root, 'watch')));
    watcher.on("unlink", () => void this.enqueue(root.id, () => this.scanAndSync(root, 'watch')));
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
    if (!root) throw new Error(`Root not found: ${id}`);
    // Serialize with any in-flight round for this root: scan mutates bindings
    // and must not interleave with a watcher/poll sync.
    const result = await this.enqueueResult(root.id, () => this.engine.scan(root));
    this.broadcast({ type: "scan", rootId: id, result });
    return result;
  }

  async syncRoot(id: string, trigger: SyncTrigger = 'manual'): Promise<unknown> {
    const root = await this.metaStorage.getRoot(id);
    if (!root) throw new Error(`Root not found: ${id}`);
    // Serialize with watcher/poll/event syncs for this root. Concurrent rounds
    // would race on the shared git index and the JSON binding files, so an
    // API-triggered sync joins the same per-root queue.
    return this.enqueueResult(root.id, () => this.scanAndSync(root, trigger));
  }

  /** Queue a full scan+sync round for the root. Entry point for the event
   *  channel: serializes with watcher/poll tasks through the per-root queue
   *  and skips disabled roots. */
  async requestSync(rootId: string): Promise<void> {
    const root = await this.metaStorage.getRoot(rootId);
    if (!root || !root.enabled) return;
    await this.enqueue(root.id, () => this.scanAndSync(root, 'event'));
  }

  /** Local tree for the browser: fully DB-backed and credential-independent,
   *  so the detail page keeps working while Feishu credentials are invalid.
   *  Entries with an in-flight operation are flagged for the "syncing" badge. */
  async getTree(id: string): Promise<unknown> {
    const root = await this.metaStorage.getRoot(id);
    if (!root) throw new Error(`Root not found: ${id}`);
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
    if (!root) throw new Error(`Root not found: ${rootId}`);
    const remoteDocument = await this.remote.getDocument(remoteToken);
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
    await this.remote.softDelete(binding.remoteToken, binding.kind === "asset" ? "file" : "docx");
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
    const currentRemote = await this.remote.getDocument(binding.remoteToken);
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

  private async scanAndSync(root: SyncRoot, trigger: SyncTrigger = 'manual'): Promise<unknown> {
    const startedAt = Date.now();
    this.currentTrigger = trigger;
    // Unified entry-point signal (manual/poll/watcher/event channel alike) so
    // the UI can show per-root progress instead of silent syncing.
    this.broadcast({ type: "sync-started", rootId: root.id, trigger });
    let scan: Awaited<ReturnType<SyncEngine["scan"]>>;
    try {
      scan = await this.engine.scan(root, trigger);
    } catch (error) {
      if (isAuthError(error)) { this.log("warn", "scan aborted: Feishu credentials invalid", { rootId: root.id }); await this.flagAuthInvalid(); return { rootId: root.id, authInvalid: true }; }
      this.log("error", "scan failed", { rootId: root.id, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    this.log("info", "sync round started", { rootId: root.id, localPath: root.localPath, trigger });
    const attempts = new Map<string, number>();
    while (true) {
      const pending = (await this.metaStorage.listBindings(root.id))
        // Ignored entries are frozen by the user; never evaluate them here.
        .filter((binding) => binding.status === "pending" && !binding.ignoredAt && (attempts.get(binding.entryId) ?? 0) < 3)
        .sort((left, right) => Number(left.kind !== "asset") - Number(right.kind !== "asset"));
      if (pending.length === 0) break;
      for (const binding of pending) {
        attempts.set(binding.entryId, (attempts.get(binding.entryId) ?? 0) + 1);
        let operation;
        try {
          operation = await this.metaStorage.addOperation({ entryId: binding.entryId, rootId: root.id, direction: "merge", operation: "sync-entry", trigger });
          await this.metaStorage.updateOperation(operation.id, { status: "running" });
          await this.engine.syncEntry(binding, root);
          await this.metaStorage.updateOperation(operation.id, { status: "succeeded", completedAt: new Date().toISOString() });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (operation) await this.metaStorage.updateOperation(operation.id, { status: "failed", error: message, completedAt: new Date().toISOString() });
          this.broadcast({ type: "error", rootId: root.id, entryId: binding.entryId, error: message });
          this.log("warn", "entry sync failed", { rootId: root.id, entryId: binding.entryId, error: message });
          // Credential failures fail every entry; surface them once and stop
          // burning retries until the user refreshes the token.
          if (isAuthError(error)) {
            await this.flagAuthInvalid();
            return { ...scan, entries: await this.metaStorage.listBindings(root.id), authInvalid: true };
          }
          // Surface the failure on the entry itself; the next scan resets
          // "error" entries to "pending" so they are retried.
          const failed = await this.metaStorage.findBindingById(binding.entryId);
          if (failed) await this.metaStorage.setBinding(root.id, failed.relativePath, { ...failed, status: "error", updatedAt: new Date().toISOString() });
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
    this.broadcast({ type: "sync", rootId: root.id, trigger });
    this.log("info", "sync round completed", { rootId: root.id, elapsedMs: Date.now() - startedAt, trigger });
    return { ...scan, entries: finalBindings };
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
