import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { dirname, extname, join, resolve, sep } from "node:path";
import { createReadStream, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FilesystemProvider, SyncEngine } from "@feishu-sync/core";
import type { RemoteProvider, StateStore } from "@feishu-sync/core";
import { SqliteStateStore } from "@feishu-sync/storage";
import { createRemoteProvider, ProviderRegistry } from "./provider.js";
import { CredentialStore, type CredentialInput } from "./credentials.js";
import { SyncRuntime } from "./runtime.js";
import { EventChannelService } from "./eventchannel.js";

export interface AppOptions {
  store?: StateStore;
  remote?: RemoteProvider;
  credentials?: CredentialStore;
  publicDir?: string;
  databasePath?: string;
}

export function buildApp(options: AppOptions = {}): FastifyInstance & { runtime: SyncRuntime; store: StateStore; credentials: CredentialStore; registry?: ProviderRegistry; eventChannel: EventChannelService } {
  const store = options.store ?? new SqliteStateStore(options.databasePath ?? process.env.SYNC_DB_PATH ?? ".data/sync.db");
  const app = Fastify({ logger: process.env.NODE_ENV === "test" ? false : { level: process.env.SYNC_LOG_LEVEL ?? "info" } });
  // Tolerate body-less requests that still carry the JSON content-type (e.g.
  // REST clients unbinding a root) instead of failing with
  // FST_ERR_CTP_EMPTY_JSON_BODY.
  app.addContentTypeParser<string>("application/json", { parseAs: "string" }, (_request, body, done) => {
    if (body === "" || body === undefined) return done(null, undefined);
    try { done(null, JSON.parse(body)); } catch (error) { done(error as Error); }
  });
  const credentials = options.credentials ?? new CredentialStore(store, undefined, undefined, app.log);
  // When a remote is injected (tests/embedding) it is used as-is; otherwise a
  // registry rebuilds the provider from stored credentials on every save.
  const registry = options.remote ? undefined : new ProviderRegistry(credentials);
  const remote = options.remote ?? registry!;
  const runtime = new SyncRuntime(
    store,
    new FilesystemProvider(),
    remote,
    registry ? () => registry.rebuild().then(() => undefined) : undefined,
    app.log,
    // Maintenance tick: proactively rotate user tokens, then swap the live
    // delegate so the registry's in-memory token stays in sync with the DB.
    () => credentials.maintainUserToken().then(() => registry?.rebuild()).then(() => undefined)
  );
  // Long-lived drive event subscription; polling stays enabled as the fallback.
  const eventChannel = new EventChannelService(credentials, store, runtime, app.log);
  Object.assign(app, { runtime, store, credentials, registry, eventChannel });

  void app.register(fastifyWebsocket);
  const defaultPublicDir = join(dirname(fileURLToPath(import.meta.url)), "../public");
  void app.register(fastifyStatic, { root: options.publicDir ?? defaultPublicDir, prefix: "/" });

  app.get("/api/health", async () => ({ ok: true, provider: remote.name, capabilities: remote.capabilities, authStatus: await credentials.getAuthStatus(), eventChannel: eventChannel.getState() }));

  // ---- Settings & credentials -------------------------------------------
  app.get("/api/settings", async () => ({ ...(await credentials.redacted()), eventChannel: eventChannel.getState() }));
  app.put<{ Body: CredentialInput }> ("/api/settings", async (request, reply) => {
    const body = request.body ?? {};
    if (body.mode !== undefined && !["user", "tenant", "cli"].includes(body.mode)) {
      return reply.code(400).send({ error: "mode must be one of user, tenant, cli" });
    }
    await credentials.save(body);
    let rebuilt = false;
    if (registry) {
      await registry.rebuild();
      rebuilt = true;
      runtime.broadcastEvent({ type: "settings-updated" });
    }
    // Probe immediately so the badge reflects the fresh credentials.
    const test = await credentials.testConnection();
    await credentials.setAuthStatus(test.ok ? "ok" : (body.mode === "cli" && test.ok ? "ok" : "invalid"));
    // Restart the event channel so the WS subscription follows the new
    // credentials; without app credentials it degrades to "disabled".
    await eventChannel.rebuild();
    return reply.send({ ...(await credentials.redacted()), rebuilt, test, eventChannel: eventChannel.getState() });
  });
  app.post<{ Body: CredentialInput | undefined }>("/api/settings/test-connection", async (request) => credentials.testConnection(request.body ?? undefined));

  app.get("/api/roots", async () => store.listRoots());
  app.post<{ Body: { localPath: string; remoteToken: string; remoteType?: "folder" | "wiki"; pollIntervalMs?: number } }>("/api/roots", async (request, reply) => {
    const body = request.body;
    if (!body || typeof body.localPath !== "string" || !body.localPath.trim() || typeof body.remoteToken !== "string" || !body.remoteToken.trim()) {
      return reply.code(400).send({ error: "localPath and remoteToken are required" });
    }
    const pollIntervalMs = body.pollIntervalMs ?? 15000;
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1000) return reply.code(400).send({ error: "pollIntervalMs must be at least 1000ms" });
    if (!existsSync(body.localPath) || !statSync(body.localPath).isDirectory()) {
      return reply.code(400).send({ error: "localPath must point to an existing directory" });
    }
    const root = await store.createRoot({ localPath: body.localPath, remoteToken: body.remoteToken, remoteType: body.remoteType ?? "folder", enabled: true, pollIntervalMs });
    runtime.startRoot(root);
    runtime.broadcastEvent({ type: "root-updated", rootId: root.id });
    return reply.code(201).send(root);
  });
  app.post<{ Params: { id: string } }>("/api/roots/:id/scan", async (request) => runtime.scanRoot(request.params.id));
  app.post<{ Params: { id: string } }>("/api/roots/:id/sync", async (request) => runtime.syncRoot(request.params.id));
  app.post<{ Params: { id: string }; Body: { relativePath: string; remoteToken: string } }>("/api/roots/:id/pair", async (request, reply) => {
    const body = request.body;
    if (!body || typeof body.relativePath !== "string" || !body.relativePath.trim() || typeof body.remoteToken !== "string" || !body.remoteToken.trim()) {
      return reply.code(400).send({ error: "relativePath and remoteToken are required" });
    }
    return runtime.pairEntry(request.params.id, body.relativePath, body.remoteToken);
  });
  app.post<{ Params: { id: string }; Body: { confirmed?: boolean } }>("/api/entries/:id/delete-remote", async (request, reply) => {
    if (request.body?.confirmed !== true) return reply.code(400).send({ error: "Remote deletion requires confirmed=true" });
    return runtime.deleteRemoteEntry(request.params.id);
  });
  app.delete<{ Params: { id: string } }>("/api/roots/:id", async (request, reply) => {
    // Broadcast before the removal so subscribers can drop the root while its
    // id is still resolvable (design contract: root created/updated/deleted
    // events all emit root-updated).
    const root = await store.getRoot(request.params.id);
    runtime.stopRoot(request.params.id);
    await store.deleteRoot(request.params.id);
    if (root) runtime.broadcastEvent({ type: "root-updated", rootId: root.id });
    return reply.code(204).send();
  });
  app.patch<{ Params: { id: string }; Body: { localPath?: string; remoteToken?: string; enabled?: boolean; pollIntervalMs?: number } }>("/api/roots/:id", async (request, reply) => {
    const body = request.body ?? {};
    const current = await store.getRoot(request.params.id);
    if (!current) return reply.code(404).send({ error: "root not found" });
    if (body.pollIntervalMs !== undefined && (!Number.isFinite(body.pollIntervalMs) || body.pollIntervalMs < 1000)) {
      return reply.code(400).send({ error: "pollIntervalMs must be at least 1000ms" });
    }
    if (body.localPath !== undefined && (!existsSync(body.localPath) || !statSync(body.localPath).isDirectory())) {
      return reply.code(400).send({ error: "localPath must point to an existing directory" });
    }
    const next = await store.updateRoot(request.params.id, body);
    // Hot-apply interval/enabled changes to the watcher and poll timer.
    runtime.restartRoot(next);
    runtime.broadcastEvent({ type: "root-updated", rootId: next.id });
    return next;
  });
  app.get<{ Params: { id: string } }> ("/api/roots/:id/tree", async (request) => runtime.getTree(request.params.id));
  app.get<{ Params: { id: string } }>("/api/roots/:id/stats", async (request, reply) => {
    const root = await store.getRoot(request.params.id);
    if (!root) return reply.code(404).send({ error: "root not found" });
    const entries = await store.listEntries(root.id);
    const entryRoot = new Map(entries.map((entry) => [entry.id, entry.rootId]));
    const operations = (await store.listOperations(500)).filter((operation) => operation.entryId !== undefined && entryRoot.get(operation.entryId) === root.id);
    const dayAgo = Date.now() - 86_400_000;
    const succeeded24h = operations.filter((operation) => operation.status === "succeeded" && Date.parse(operation.createdAt) >= dayAgo).length;
    const failed24h = operations.filter((operation) => operation.status === "failed" && Date.parse(operation.createdAt) >= dayAgo).length;
    const lastSuccess = operations.find((operation) => operation.status === "succeeded" && operation.completedAt);
    const counts: Record<string, number> = {};
    for (const entry of entries) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
    return reply.send({
      lastSyncAt: lastSuccess?.completedAt,
      succeeded24h,
      failed24h,
      conflicts: (await store.listConflicts("open")).length,
      entriesTotal: entries.length,
      entriesByStatus: counts
    });
  });
  const MIME_TYPES: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".ico": "image/x-icon",
    ".pdf": "application/pdf", ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".txt": "text/plain; charset=utf-8"
  };
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/roots/:id/file", async (request, reply) => {
    const root = await store.getRoot(request.params.id);
    if (!root) return reply.code(404).send({ error: "root not found" });
    const relative = request.query.path;
    if (!relative) return reply.code(400).send({ error: "path query parameter is required" });
    const base = resolve(root.localPath);
    const target = resolve(base, relative);
    // Strict traversal guard: the resolved path must stay inside the root.
    if (target !== base && !target.startsWith(base + sep)) return reply.code(403).send({ error: "path escapes the sync root" });
    if (!existsSync(target) || !statSync(target).isFile()) return reply.code(404).send({ error: "file not found" });
    reply.header("content-type", MIME_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream");
    reply.header("cache-control", "no-cache");
    return reply.send(createReadStream(target));
  });
  app.get<{ Params: { token: string } }>("/api/assets/:token", async (request, reply) => {
    // Only entries registered as synced assets may be proxied (design §6);
    // document tokens must not be downloadable through this endpoint.
    const entry = await store.findEntryByRemoteToken(request.params.token);
    if (!entry || entry.kind !== "asset") return reply.code(404).send({ error: "unknown asset token" });
    const content = await remote.downloadAsset(request.params.token);
    reply.header("content-type", MIME_TYPES[extname(entry.relativePath).toLowerCase()] ?? "application/octet-stream");
    reply.header("cache-control", "public, max-age=300");
    return reply.send(Buffer.from(content));
  });
  app.get<{ Params: { id: string } }>("/api/entries/:id/content", async (request) => runtime.readDocument(request.params.id));
  app.post<{ Params: { id: string } }>("/api/entries/:id/restore-base", async (request) => runtime.restoreBase(request.params.id));
  app.get<{ Querystring: { status?: string } }>("/api/conflicts", async (request) => {
    const status = request.query.status;
    const list = status === "all"
      ? await store.listConflicts()
      : await store.listConflicts(status === "resolved" || status === "aborted" ? status : "open");
    return Promise.all(list.map(async (conflict) => {
      const entry = await store.getEntry(conflict.entryId);
      const root = entry ? await store.getRoot(entry.rootId) : undefined;
      return { ...conflict, relativePath: entry?.relativePath, localRoot: root?.localPath, rootId: entry?.rootId };
    }));
  });
  app.get<{ Params: { id: string } }>("/api/conflicts/:id", async (request, reply) => {
    const conflict = await store.getConflict(request.params.id);
    return conflict ? conflict : reply.code(404).send({ error: "conflict not found" });
  });
  app.post<{ Params: { id: string }; Body: { resolution: "local" | "remote" | "merged" | "abort"; mergedContent?: string } }>("/api/conflicts/:id/resolve", async (request, reply) => {
    const body = request.body;
    if (!body || !["local", "remote", "merged", "abort"].includes(body.resolution)) {
      return reply.code(400).send({ error: "resolution must be one of local, remote, merged, abort" });
    }
    if (body.resolution === "merged" && typeof body.mergedContent !== "string") {
      return reply.code(400).send({ error: "mergedContent is required for merged resolution" });
    }
    const conflict = await store.getConflict(request.params.id);
    if (!conflict) return reply.code(404).send({ error: "conflict not found" });
    const resolved = await runtime.resolveConflict(conflict, body);
    return reply.send(resolved);
  });
  app.get("/api/operations", async () => {
    const operations = await store.listOperations();
    // Join entry/root info so the history view can filter by root and retry.
    return Promise.all(operations.map(async (operation) => {
      const entry = operation.entryId ? await store.getEntry(operation.entryId) : undefined;
      return { ...operation, rootId: entry?.rootId, relativePath: entry?.relativePath };
    }));
  });
  app.post<{ Body: { keepOperations?: number; keepOperationHours?: number; resolvedConflictDays?: number } }>("/api/maintenance/prune", async (request) => {
    const body = request.body ?? {};
    return runtime.pruneHistory({ keepOperations: body.keepOperations, keepOperationHours: body.keepOperationHours, resolvedConflictDays: body.resolvedConflictDays });
  });
  app.route({
    method: "GET",
    url: "/api/events",
    handler: (_request, reply) => reply.code(426).send({ error: "WebSocket upgrade required" }),
    wsHandler: (socket) => runtime.addClient(socket)
  });
  app.setErrorHandler((error, request, reply) => {
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    if (statusCode >= 500) app.log.error({ statusCode, url: request.url, error: error instanceof Error ? error.message : String(error) }, "request failed");
    return reply.code(statusCode).send({ error: error instanceof Error ? error.message : String(error) });
  });
  app.addHook("onClose", async () => {
    runtime.stop();
    eventChannel.stop();
    const close = (store as StateStore & { close?: () => void }).close;
    close?.call(store);
  });
  return app as unknown as FastifyInstance & { runtime: SyncRuntime; store: StateStore; credentials: CredentialStore; registry?: ProviderRegistry; eventChannel: EventChannelService };
}
