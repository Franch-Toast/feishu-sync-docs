import type { WebSocket } from "ws";
import type { FastifyBaseLogger } from "fastify";
import { watch, type FSWatcher } from "chokidar";
import { randomUUID } from "node:crypto";
import { SyncEngine } from "@feishu-sync/core";
import { sha256 } from "@feishu-sync/core";
import { FeishuApiError } from "@feishu-sync/feishu";
import type { ConflictRecord, LocalProvider, PruneHistoryOptions, PruneHistoryResult, RemoteProvider, StateStore, SyncEntry, SyncRoot } from "@feishu-sync/core";

export class SyncRuntime {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly clients = new Set<WebSocket>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly engine: SyncEngine;
  private maintenanceTimer?: NodeJS.Timeout;

  constructor(
    private readonly store: StateStore,
    private readonly local: LocalProvider,
    private readonly remote: RemoteProvider,
    private readonly prepareRemote?: () => Promise<void>,
    private readonly logger?: FastifyBaseLogger,
    /** Invoked on every maintenance tick: proactively rotates user tokens. */
    private readonly maintainCredentials?: () => Promise<void>
  ) {
    this.engine = new SyncEngine(store, local, remote);
  }

  /** Structured logging helper; no-ops when no logger is injected (tests). */
  private log(level: "debug" | "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void {
    this.logger?.[level](data ?? {}, message);
  }

  async start(): Promise<void> {
    // Give credential-based providers (ProviderRegistry) a chance to initialize
    // from stored settings before the first watcher/poller runs.
    await this.prepareRemote?.();
    for (const root of await this.store.listRoots()) if (root.enabled) this.startRoot(root);
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
    const result = await this.store.pruneHistory({
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
    watcher.on("add", () => void this.enqueue(root.id, () => this.scanAndSync(root)));
    watcher.on("change", () => void this.enqueue(root.id, () => this.scanAndSync(root)));
    watcher.on("unlink", () => void this.enqueue(root.id, () => this.scanAndSync(root)));
    watcher.on("error", (error) => this.broadcast({ type: "error", rootId: root.id, error: String(error) }));
    this.watchers.set(root.id, watcher);
    const timer = setInterval(() => void this.enqueue(root.id, () => this.scanAndSync(root)), root.pollIntervalMs);
    this.timers.set(root.id, timer);
    void this.enqueue(root.id, () => this.scanAndSync(root));
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
    const root = await this.store.getRoot(id);
    if (!root) throw new Error(`Root not found: ${id}`);
    const result = await this.engine.scan(root);
    this.broadcast({ type: "scan", rootId: id, result });
    return result;
  }

  async syncRoot(id: string): Promise<unknown> {
    const root = await this.store.getRoot(id);
    if (!root) throw new Error(`Root not found: ${id}`);
    return this.scanAndSync(root);
  }

  /** Queue a full scan+sync round for the root. Entry point for the event
   *  channel: serializes with watcher/poll tasks through the per-root queue
   *  and skips disabled roots. */
  async requestSync(rootId: string): Promise<void> {
    const root = await this.store.getRoot(rootId);
    if (!root || !root.enabled) return;
    await this.enqueue(root.id, () => this.scanAndSync(root));
  }

  /** Local tree for the browser: fully DB-backed and credential-independent,
   *  so the detail page keeps working while Feishu credentials are invalid.
   *  Entries with an in-flight operation are flagged for the "syncing" badge. */
  async getTree(id: string): Promise<unknown> {
    const root = await this.store.getRoot(id);
    if (!root) throw new Error(`Root not found: ${id}`);
    const entries = await this.store.listEntries(id);
    const active = new Set((await this.store.listOperations(200))
      .filter((operation) => (operation.status === "queued" || operation.status === "running") && operation.entryId !== undefined)
      .map((operation) => operation.entryId!));
    return {
      root,
      entries: active.size === 0 ? entries : entries.map((entry) => (active.has(entry.id) ? { ...entry, syncing: true } : entry))
    };
  }

  async pairEntry(rootId: string, relativePath: string, remoteToken: string): Promise<unknown> {
    const root = await this.store.getRoot(rootId);
    if (!root) throw new Error(`Root not found: ${rootId}`);
    const remoteDocument = await this.remote.getDocument(remoteToken);
    const localPathExists = (await this.local.scan(root)).some((file) => file.relativePath === relativePath);
    if (!localPathExists) await this.local.writeText(root, relativePath, remoteDocument.content);
    const existing = await this.store.findEntry(rootId, relativePath);
    const entry = existing ?? {
      id: randomUUID(), rootId, relativePath, kind: "document" as const, status: "pending" as const, updatedAt: new Date().toISOString()
    };
    await this.store.upsertEntry({ ...entry, kind: "document", remoteToken, remoteParentToken: remoteDocument.parentToken || root.remoteToken, status: "pending", updatedAt: new Date().toISOString() });
    return this.syncRoot(rootId);
  }

  async deleteRemoteEntry(entryId: string): Promise<unknown> {
    const entry = await this.store.getEntry(entryId);
    if (!entry?.remoteToken) throw new Error("Entry is not bound to a remote resource");
    await this.remote.softDelete(entry.remoteToken, entry.kind === "asset" ? "file" : "docx");
    await this.store.upsertEntry({ ...entry, status: "orphan", updatedAt: new Date().toISOString() });
    return this.store.getEntry(entryId);
  }

  async resolveConflict(conflict: ConflictRecord, input: { resolution: "local" | "remote" | "merged" | "abort"; mergedContent?: string }): Promise<ConflictRecord> {
    if (input.resolution === "abort") {
      // Persist the abort decision and re-arm the entry so the next scan
      // re-evaluates it with fresh three-way data.
      const aborted = await this.store.resolveConflict(conflict.id, "abort");
      const abortedEntry = await this.store.getEntry(conflict.entryId);
      if (abortedEntry) {
        await this.store.upsertEntry({ ...abortedEntry, status: "pending", updatedAt: new Date().toISOString() });
        const abortedRoot = await this.store.getRoot(abortedEntry.rootId);
        if (abortedRoot) await this.enqueue(abortedRoot.id, () => this.scanAndSync(abortedRoot));
      }
      this.broadcast({ type: "conflict-aborted", conflict: aborted });
      return aborted;
    }
    const entry = await this.store.getEntry(conflict.entryId);
    if (!entry?.remoteToken) throw new Error("Conflict entry is no longer bound to a remote document");
    const root = await this.store.getRoot(entry.rootId);
    if (!root) throw new Error("Conflict root not found");
    const currentRemote = await this.remote.getDocument(entry.remoteToken);
    if (conflict.remoteRevision !== undefined && currentRemote.revisionId !== undefined && conflict.remoteRevision !== currentRemote.revisionId) {
      throw Object.assign(new Error("This conflict is stale because the remote document changed again"), { statusCode: 409 });
    }
    if (conflict.remoteContentHash !== undefined && sha256(currentRemote.content) !== conflict.remoteContentHash) {
      throw Object.assign(new Error("This conflict is stale because the remote document changed again"), { statusCode: 409 });
    }
    const content = input.resolution === "local" ? conflict.localContent : input.resolution === "remote" ? conflict.remoteContent : input.mergedContent;
    if (content === undefined) throw new Error("mergedContent is required for merged resolution");
    await this.engine.applyResolvedContent(entry, root, content, currentRemote);
    await this.local.writeText(root, entry.relativePath, content);
    const resolved = await this.store.resolveConflict(conflict.id, input.resolution, content);
    await this.enqueue(entry.rootId, () => this.scanAndSync(root));
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
    const entry = await this.store.getEntry(entryId);
    if (!entry) throw Object.assign(new Error(`Entry not found: ${entryId}`), { statusCode: 404 });
    if (entry.kind !== "document") throw Object.assign(new Error("Only document entries can be previewed"), { statusCode: 400 });
    const root = await this.store.getRoot(entry.rootId);
    if (!root) throw Object.assign(new Error(`Root not found: ${entry.rootId}`), { statusCode: 404 });
    return { relativePath: entry.relativePath, content: await this.local.readText(root, entry.relativePath) };
  }

  /** Restore the entry's local file to the last known common baseline. */
  async restoreBase(entryId: string): Promise<{ ok: boolean; entryId: string; relativePath: string }> {
    const entry = await this.store.getEntry(entryId);
    if (!entry) throw Object.assign(new Error(`Entry not found: ${entryId}`), { statusCode: 404 });
    if (entry.kind !== "document") throw Object.assign(new Error("Only document entries can be restored"), { statusCode: 400 });
    const snapshot = await this.store.getSnapshot(entryId);
    if (!snapshot) throw Object.assign(new Error("No baseline snapshot stored for this entry yet"), { statusCode: 404 });
    const root = await this.store.getRoot(entry.rootId);
    if (!root) throw Object.assign(new Error(`Root not found: ${entry.rootId}`), { statusCode: 404 });
    await this.local.writeText(root, entry.relativePath, snapshot.baseContent);
    await this.store.upsertEntry({ ...entry, status: "pending", updatedAt: new Date().toISOString() });
    await this.enqueue(root.id, () => this.scanAndSync(root));
    return { ok: true, entryId, relativePath: entry.relativePath };
  }

  private async scanAndSync(root: SyncRoot): Promise<unknown> {
    const startedAt = Date.now();
    let scan: Awaited<ReturnType<SyncEngine["scan"]>>;
    try {
      scan = await this.engine.scan(root);
    } catch (error) {
      if (isAuthError(error)) { this.log("warn", "scan aborted: Feishu credentials invalid", { rootId: root.id }); await this.flagAuthInvalid(); return { rootId: root.id, authInvalid: true }; }
      this.log("error", "scan failed", { rootId: root.id, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    this.log("info", "sync round started", { rootId: root.id, localPath: root.localPath });
    const attempts = new Map<string, number>();
    while (true) {
      const pending = (await this.store.listEntries(root.id))
        .filter((entry) => entry.status === "pending" && (attempts.get(entry.id) ?? 0) < 3)
        .sort((left, right) => Number(left.kind !== "asset") - Number(right.kind !== "asset"));
      if (pending.length === 0) break;
      for (const entry of pending) {
        attempts.set(entry.id, (attempts.get(entry.id) ?? 0) + 1);
        let operation;
        try {
          operation = await this.store.addOperation({ entryId: entry.id, direction: "merge", operation: "sync-entry" });
          await this.store.updateOperation(operation.id, { status: "running" });
          await this.engine.syncEntry(entry, root);
          await this.store.updateOperation(operation.id, { status: "succeeded", completedAt: new Date().toISOString() });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (operation) await this.store.updateOperation(operation.id, { status: "failed", error: message, completedAt: new Date().toISOString() });
          this.broadcast({ type: "error", rootId: root.id, entryId: entry.id, error: message });
          this.log("warn", "entry sync failed", { rootId: root.id, entryId: entry.id, error: message });
          // Credential failures fail every entry; surface them once and stop
          // burning retries until the user refreshes the token.
          if (isAuthError(error)) {
            await this.flagAuthInvalid();
            return { ...scan, entries: await this.store.listEntries(root.id), authInvalid: true };
          }
          // Surface the failure on the entry itself; the next scan resets
          // "error" entries to "pending" so they are retried.
          const failed = await this.store.getEntry(entry.id);
          if (failed) await this.store.upsertEntry({ ...failed, status: "error", updatedAt: new Date().toISOString() });
        }
      }
    }
    await this.markAuthHealthy();
    this.broadcast({ type: "sync", rootId: root.id });
    this.log("info", "sync round completed", { rootId: root.id, elapsedMs: Date.now() - startedAt });
    return { ...scan, entries: await this.store.listEntries(root.id) };
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

  private broadcast(event: unknown): void {
    const payload = JSON.stringify(event);
    for (const client of this.clients) if (client.readyState === 1) client.send(payload);
  }

  /** Persist the credential-invalid state once and alert every open page. */
  private async flagAuthInvalid(): Promise<void> {
    const current = await this.store.getSetting("feishu.authStatus");
    if (current !== "invalid") {
      await this.store.setSetting("feishu.authStatus", "invalid");
      await this.store.setSetting("feishu.authCheckedAt", new Date().toISOString());
      this.broadcast({ type: "auth-invalid" });
      this.log("warn", "Feishu credentials marked invalid");
    }
  }

  /** Clear a previously flagged invalid state after a successful sync round. */
  private async markAuthHealthy(): Promise<void> {
    const current = await this.store.getSetting("feishu.authStatus");
    if (current === "invalid") {
      await this.store.setSetting("feishu.authStatus", "ok");
      await this.store.setSetting("feishu.authCheckedAt", new Date().toISOString());
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
