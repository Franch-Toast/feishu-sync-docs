import type { WebSocket } from "ws";
import { watch, type FSWatcher } from "chokidar";
import { randomUUID } from "node:crypto";
import { SyncEngine } from "@feishu-sync/core";
import { sha256 } from "@feishu-sync/core";
import type { ConflictRecord, LocalProvider, RemoteProvider, StateStore, SyncRoot } from "@feishu-sync/core";

export class SyncRuntime {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly clients = new Set<WebSocket>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly engine: SyncEngine;

  constructor(private readonly store: StateStore, private readonly local: LocalProvider, private readonly remote: RemoteProvider) {
    this.engine = new SyncEngine(store, local, remote);
  }

  async start(): Promise<void> {
    for (const root of await this.store.listRoots()) if (root.enabled) this.startRoot(root);
  }

  stop(): void {
    for (const watcher of this.watchers.values()) void watcher.close();
    for (const timer of this.timers.values()) clearInterval(timer);
    for (const client of this.clients) client.close();
    this.watchers.clear(); this.timers.clear(); this.clients.clear();
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
  }

  stopRoot(id: string): void {
    void this.watchers.get(id)?.close();
    const timer = this.timers.get(id);
    if (timer) clearInterval(timer);
    this.watchers.delete(id);
    this.timers.delete(id);
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

  async getTree(id: string): Promise<unknown> {
    const root = await this.store.getRoot(id);
    if (!root) throw new Error(`Root not found: ${id}`);
    return { root, entries: await this.store.listEntries(id), remote: await this.remote.listTree(root) };
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
    await this.remote.softDelete(entry.remoteToken);
    await this.store.upsertEntry({ ...entry, status: "orphan", updatedAt: new Date().toISOString() });
    return this.store.getEntry(entryId);
  }

  async resolveConflict(conflict: ConflictRecord, input: { resolution: "local" | "remote" | "merged" | "abort"; mergedContent?: string }): Promise<ConflictRecord> {
    if (input.resolution === "abort") return conflict;
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
  }

  private async scanAndSync(root: SyncRoot): Promise<unknown> {
    const scan = await this.engine.scan(root);
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
          if (operation) await this.store.updateOperation(operation.id, { status: "failed", error: error instanceof Error ? error.message : String(error), completedAt: new Date().toISOString() });
          this.broadcast({ type: "error", rootId: root.id, entryId: entry.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    this.broadcast({ type: "sync", rootId: root.id });
    return { ...scan, entries: await this.store.listEntries(root.id) };
  }

  private enqueue(id: string, callback: () => Promise<unknown>): Promise<void> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.then(() => callback()).then(() => undefined).catch((error) => { this.broadcast({ type: "error", rootId: id, error: error instanceof Error ? error.message : String(error) }); });
    this.queues.set(id, next);
    return next;
  }

  private broadcast(event: unknown): void {
    const payload = JSON.stringify(event);
    for (const client of this.clients) if (client.readyState === 1) client.send(payload);
  }
}
