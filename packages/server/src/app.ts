import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FilesystemProvider, SyncEngine } from "@feishu-sync/core";
import type { RemoteProvider, StateStore } from "@feishu-sync/core";
import { SqliteStateStore } from "@feishu-sync/storage";
import { createRemoteProvider } from "./provider.js";
import { SyncRuntime } from "./runtime.js";

export interface AppOptions {
  store?: StateStore;
  remote?: RemoteProvider;
  publicDir?: string;
  databasePath?: string;
}

export function buildApp(options: AppOptions = {}): FastifyInstance & { runtime: SyncRuntime; store: StateStore } {
  const store = options.store ?? new SqliteStateStore(options.databasePath ?? process.env.SYNC_DB_PATH ?? ".data/sync.db");
  const remote = options.remote ?? createRemoteProvider();
  const runtime = new SyncRuntime(store, new FilesystemProvider(), remote);
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  Object.assign(app, { runtime, store });

  void app.register(fastifyWebsocket);
  const defaultPublicDir = join(dirname(fileURLToPath(import.meta.url)), "../public");
  void app.register(fastifyStatic, { root: options.publicDir ?? defaultPublicDir, prefix: "/" });

  app.get("/api/health", async () => ({ ok: true, provider: remote.name, capabilities: remote.capabilities }));
  app.get("/api/roots", async () => store.listRoots());
  app.post<{ Body: { localPath: string; remoteToken: string; remoteType?: "folder" | "wiki"; pollIntervalMs?: number } }>("/api/roots", async (request, reply) => {
    const body = request.body;
    if (!body || typeof body.localPath !== "string" || !body.localPath.trim() || typeof body.remoteToken !== "string" || !body.remoteToken.trim()) {
      return reply.code(400).send({ error: "localPath and remoteToken are required" });
    }
    const pollIntervalMs = body.pollIntervalMs ?? 15000;
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1000) return reply.code(400).send({ error: "pollIntervalMs must be at least 1000ms" });
    const root = await store.createRoot({ localPath: body.localPath, remoteToken: body.remoteToken, remoteType: body.remoteType ?? "folder", enabled: true, pollIntervalMs });
    runtime.startRoot(root);
    return reply.code(201).send(root);
  });
  app.post<{ Params: { id: string } }>("/api/roots/:id/scan", async (request) => runtime.scanRoot(request.params.id));
  app.post<{ Params: { id: string } }>("/api/roots/:id/sync", async (request) => runtime.syncRoot(request.params.id));
  app.post<{ Params: { id: string }; Body: { relativePath: string; remoteToken: string } }>("/api/roots/:id/pair", async (request) => runtime.pairEntry(request.params.id, request.body.relativePath, request.body.remoteToken));
  app.post<{ Params: { id: string }; Body: { confirmed?: boolean } }>("/api/entries/:id/delete-remote", async (request, reply) => {
    if (request.body?.confirmed !== true) return reply.code(400).send({ error: "Remote deletion requires confirmed=true" });
    return runtime.deleteRemoteEntry(request.params.id);
  });
  app.delete<{ Params: { id: string } }>("/api/roots/:id", async (request, reply) => {
    runtime.stopRoot(request.params.id);
    await store.deleteRoot(request.params.id);
    return reply.code(204).send();
  });
  app.get<{ Params: { id: string } }>("/api/roots/:id/tree", async (request) => runtime.getTree(request.params.id));
  app.get("/api/conflicts", async () => Promise.all((await store.listConflicts("open")).map(async (conflict) => {
    const entry = await store.getEntry(conflict.entryId);
    const root = entry ? await store.getRoot(entry.rootId) : undefined;
    return { ...conflict, relativePath: entry?.relativePath, localRoot: root?.localPath };
  })));
  app.get<{ Params: { id: string } }>("/api/conflicts/:id", async (request, reply) => {
    const conflict = await store.getConflict(request.params.id);
    return conflict ? conflict : reply.code(404).send({ error: "conflict not found" });
  });
  app.post<{ Params: { id: string }; Body: { resolution: "local" | "remote" | "merged" | "abort"; mergedContent?: string } }>("/api/conflicts/:id/resolve", async (request, reply) => {
    const conflict = await store.getConflict(request.params.id);
    if (!conflict) return reply.code(404).send({ error: "conflict not found" });
    const resolved = await runtime.resolveConflict(conflict, request.body);
    return reply.send(resolved);
  });
  app.get("/api/operations", async () => store.listOperations());
  app.route({
    method: "GET",
    url: "/api/events",
    handler: (_request, reply) => reply.code(426).send({ error: "WebSocket upgrade required" }),
    wsHandler: (socket) => runtime.addClient(socket)
  });
  app.setErrorHandler((error, _request, reply) => reply.code((error as { statusCode?: number }).statusCode ?? 500).send({ error: error instanceof Error ? error.message : String(error) }));
  app.addHook("onClose", async () => {
    runtime.stop();
    const close = (store as StateStore & { close?: () => void }).close;
    close?.call(store);
  });
  return app as unknown as FastifyInstance & { runtime: SyncRuntime; store: StateStore };
}
