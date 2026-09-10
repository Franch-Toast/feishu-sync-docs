import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { accessSync, constants, createReadStream, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FilesystemProvider } from "@feishu-sync/core";
import type { ErrorCategory, GitStorage, MetaStorage, OperationRecord, RemoteProvider, SyncMode, SyncRoot, SyncTrigger } from "@feishu-sync/core";
import { GitStorageImpl, JsonMetaStorage } from "@feishu-sync/storage";
import { categorizeError } from "@feishu-sync/feishu";
import { ProviderRegistry } from "./provider.js";
import { CredentialStore, type CredentialInput } from "./credentials.js";
import { AppConfigStore, type LogLevel, type NotificationPreferences } from "./appconfig.js";
import { SyncRuntime, type TaskStatus } from "./runtime.js";
import { EventChannelService } from "./eventchannel.js";

/** Allowed sync modes / triggers for request validation (B1). */
const SYNC_MODES: readonly SyncMode[] = ["bidirectional", "pull-only", "push-only"];
const SYNC_TRIGGERS: readonly SyncTrigger[] = ["manual", "event", "poll", "watch"];

/** Best-effort write probe for the bind form: sync must be able to create
 *  `.feishu-sync`/`.git` and pull remote edits into this directory. */
function isWritable(directory: string): boolean {
  try { accessSync(directory, constants.W_OK); return true; } catch { return false; }
}

export interface AppOptions {
  gitStorage?: GitStorage;
  metaStorage?: MetaStorage;
  remote?: RemoteProvider;
  credentials?: CredentialStore;
  publicDir?: string;
  /** Injected by tests/embedding; defaults to ~/.feishu-sync-docs/config.json. */
  appConfig?: AppConfigStore;
}

export function buildApp(options: AppOptions = {}): FastifyInstance & { runtime: SyncRuntime; gitStorage: GitStorage; metaStorage: MetaStorage; credentials: CredentialStore; registry?: ProviderRegistry; eventChannel: EventChannelService; appConfig: AppConfigStore } {
  const appConfig = options.appConfig ?? new AppConfigStore();
  const app = Fastify({ logger: process.env.NODE_ENV === "test" ? false : { level: process.env.SYNC_LOG_LEVEL ?? appConfig.preferences.logLevel } });
  // Tolerate body-less requests that still carry the JSON content-type (e.g.
  // REST clients unbinding a root) instead of failing with
  // FST_ERR_CTP_EMPTY_JSON_BODY.
  app.addContentTypeParser<string>("application/json", { parseAs: "string" }, (_request, body, done) => {
    if (body === "" || body === undefined) return done(null, undefined);
    try { done(null, JSON.parse(body)); } catch (error) { done(error as Error); }
  });
  
  // Initialize storage layers
  const gitStorage = options.gitStorage ?? new GitStorageImpl();
  const metaStorage = options.metaStorage ?? new JsonMetaStorage(appConfig.configPath.replace('/config.json', ''));
  // Shared with the runtime and reused by the validate-path probe.
  const localProvider = new FilesystemProvider();
  
  const credentials = options.credentials ?? new CredentialStore(appConfig, undefined, undefined, app.log);
  // When a remote is injected (tests/embedding) it is used as-is; otherwise a
  // registry rebuilds the provider from stored credentials on every save.
  const registry = options.remote ? undefined : new ProviderRegistry(credentials);
  const remote = options.remote ?? registry!;
  const runtime = new SyncRuntime(
    gitStorage,
    metaStorage,
    localProvider,
    remote,
    registry ? () => registry.rebuild().then(() => undefined) : undefined,
    app.log,
    // Maintenance tick: proactively rotate user tokens, then swap the live
    // delegate so the registry's in-memory token stays in sync with the DB.
    () => credentials.maintainUserToken().then(() => registry?.rebuild()).then(() => undefined),
    appConfig
  );
  // Long-lived drive event subscription; polling stays enabled as the fallback.
  const eventChannel = new EventChannelService(credentials, metaStorage, runtime, app.log);
  Object.assign(app, { runtime, gitStorage, metaStorage, credentials, registry, eventChannel, appConfig });

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

  // ---- Global preferences (config.json; never exposes credential fields) --
  app.get("/api/app-config", async () => ({
    preferences: appConfig.preferences,
    paths: { config: appConfig.configPath }
  }));
  app.put<{ Body: { defaultPollIntervalMs?: number; logLevel?: LogLevel; notifications?: Partial<NotificationPreferences> } }>("/api/app-config", async (request) => {
    const preferences = await appConfig.setPreferences(request.body ?? {});
    // Apply the new verbosity live unless the env override wins.
    if (process.env.SYNC_LOG_LEVEL === undefined) app.log.level = preferences.logLevel;
    runtime.broadcastEvent({ type: "settings-updated" });
    return { preferences, paths: { config: appConfig.configPath } };
  });

  // ---- Lightweight API call tally (B6.2): is Feishu throttling us now? ----
  app.get("/api/api-stats", async () => runtime.getApiStats());

  app.get("/api/roots", async () => metaStorage.listRoots());
  app.post<{ Body: { localPath: string; remoteToken: string; remoteType?: "folder" | "wiki"; pollIntervalMs?: number; mode?: SyncMode; exclude?: string[] } }>("/api/roots", async (request, reply) => {
    const body = request.body;
    if (!body || typeof body.localPath !== "string" || !body.localPath.trim() || typeof body.remoteToken !== "string" || !body.remoteToken.trim()) {
      return reply.code(400).send({ error: "localPath and remoteToken are required" });
    }
    const pollIntervalMs = body.pollIntervalMs ?? appConfig.preferences.defaultPollIntervalMs;
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1000) return reply.code(400).send({ error: "pollIntervalMs must be at least 1000ms" });
    if (!existsSync(body.localPath) || !statSync(body.localPath).isDirectory()) {
      return reply.code(400).send({ error: "localPath must point to an existing directory" });
    }
    if (body.mode !== undefined && !SYNC_MODES.includes(body.mode)) return reply.code(400).send({ error: "mode must be one of bidirectional, pull-only, push-only" });
    if (body.exclude !== undefined && (!Array.isArray(body.exclude) || body.exclude.some((pattern) => typeof pattern !== "string"))) {
      return reply.code(400).send({ error: "exclude must be an array of glob strings" });
    }
    const root = await metaStorage.createRoot({ localPath: body.localPath, remoteToken: body.remoteToken, remoteType: body.remoteType ?? "folder", enabled: true, pollIntervalMs, mode: body.mode, exclude: body.exclude });
    // Initialize Git repo and meta storage for the new root
    await gitStorage.initRoot(root);
    await metaStorage.initRootMeta(root.id, root.localPath);
    runtime.startRoot(root);
    runtime.broadcastEvent({ type: "root-updated", rootId: root.id });
    return reply.code(201).send(root);
  });
  app.post<{ Params: { id: string } }>("/api/roots/:id/scan", async (request) => runtime.scanRoot(request.params.id));
  app.post<{ Params: { id: string }; Body?: { trigger?: SyncTrigger } }>("/api/roots/:id/sync", async (request, reply) => {
    const trigger = request.body?.trigger;
    if (trigger !== undefined && !SYNC_TRIGGERS.includes(trigger)) return reply.code(400).send({ error: "trigger must be one of manual, event, poll, watch" });
    return runtime.syncRoot(request.params.id, trigger ?? "manual");
  });
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
    const root = await metaStorage.getRoot(request.params.id);
    runtime.stopRoot(request.params.id);
    await metaStorage.deleteRoot(request.params.id);
    await gitStorage.deleteRoot(request.params.id);
    if (root) runtime.broadcastEvent({ type: "root-updated", rootId: root.id });
    return reply.code(204).send();
  });
  app.patch<{ Params: { id: string }; Body: { localPath?: string; remoteToken?: string; enabled?: boolean; pollIntervalMs?: number; mode?: SyncMode; exclude?: string[] } }>("/api/roots/:id", async (request, reply) => {
    const body = request.body ?? {};
    const current = await metaStorage.getRoot(request.params.id);
    if (!current) return reply.code(404).send({ error: "root not found" });
    if (body.pollIntervalMs !== undefined && (!Number.isFinite(body.pollIntervalMs) || body.pollIntervalMs < 1000)) {
      return reply.code(400).send({ error: "pollIntervalMs must be at least 1000ms" });
    }
    if (body.localPath !== undefined && (!existsSync(body.localPath) || !statSync(body.localPath).isDirectory())) {
      return reply.code(400).send({ error: "localPath must point to an existing directory" });
    }
    if (body.mode !== undefined && !SYNC_MODES.includes(body.mode)) return reply.code(400).send({ error: "mode must be one of bidirectional, pull-only, push-only" });
    if (body.exclude !== undefined && (!Array.isArray(body.exclude) || body.exclude.some((pattern) => typeof pattern !== "string"))) {
      return reply.code(400).send({ error: "exclude must be an array of glob strings" });
    }
    const next = await metaStorage.updateRoot(request.params.id, body);
    // Hot-apply interval/enabled changes to the watcher and poll timer.
    runtime.restartRoot(next);
    runtime.broadcastEvent({ type: "root-updated", rootId: next.id });
    return next;
  });
  app.get<{ Params: { id: string } }> ("/api/roots/:id/tree", async (request) => runtime.getTree(request.params.id));
  app.get<{ Params: { id: string } }>("/api/roots/:id/stats", async (request, reply) => {
    const root = await metaStorage.getRoot(request.params.id);
    if (!root) return reply.code(404).send({ error: "root not found" });
    const bindings = await metaStorage.listBindings(root.id);
    const operations = (await metaStorage.listOperations(500)).filter((operation) => operation.rootId === root.id);
    const dayAgo = Date.now() - 86_400_000;
    const succeeded24h = operations.filter((operation) => operation.status === "succeeded" && Date.parse(operation.createdAt) >= dayAgo).length;
    const failed24h = operations.filter((operation) => operation.status === "failed" && Date.parse(operation.createdAt) >= dayAgo).length;
    const lastSuccess = operations.find((operation) => operation.status === "succeeded" && operation.completedAt);
    const counts: Record<string, number> = {};
    for (const binding of bindings) counts[binding.status] = (counts[binding.status] ?? 0) + 1;
    return reply.send({
      lastSyncAt: lastSuccess?.completedAt,
      succeeded24h,
      failed24h,
      conflicts: (await metaStorage.listConflicts("open")).length,
      entriesTotal: bindings.length,
      entriesByStatus: counts
    });
  });
  const MIME_TYPES: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".ico": "image/x-icon",
    ".pdf": "application/pdf", ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".txt": "text/plain; charset=utf-8"
  };
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/roots/:id/file", async (request, reply) => {
    const root = await metaStorage.getRoot(request.params.id);
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
    // Search all roots for the asset binding
    const roots = await metaStorage.listRoots();
    let foundBinding;
    for (const root of roots) {
      const binding = await metaStorage.findBindingByToken(root.id, request.params.token);
      if (binding && binding.kind === "asset") {
        foundBinding = binding;
        break;
      }
    }
    if (!foundBinding) return reply.code(404).send({ error: "unknown asset token" });
    const content = await remote.downloadAsset(request.params.token);
    reply.header("content-type", MIME_TYPES[extname(foundBinding.relativePath).toLowerCase()] ?? "application/octet-stream");
    reply.header("cache-control", "public, max-age=300");
    return reply.send(Buffer.from(content));
  });
  app.get<{ Params: { id: string } }>("/api/entries/:id/content", async (request) => runtime.readDocument(request.params.id));
  app.post<{ Params: { id: string } }>("/api/entries/:id/restore-base", async (request) => runtime.restoreBase(request.params.id));
  // ---- Version history (B4): per-document timeline, diff and rollback -----
  app.get<{ Params: { id: string }; Querystring: { against?: string } }>("/api/entries/:id/diff", async (request) =>
    runtime.getEntryDiff(request.params.id, request.query.against ?? "baseline"));
  app.post<{ Params: { id: string }; Body: { commit?: string } }>("/api/entries/:id/rollback", async (request, reply) => {
    const commit = request.body?.commit;
    if (!commit || typeof commit !== "string") return reply.code(400).send({ error: "commit is required" });
    return runtime.rollbackEntry(request.params.id, commit);
  });
  app.get<{ Params: { id: string }; Querystring: { path?: string; limit?: string } }>("/api/roots/:id/history", async (request, reply) => {
    const relativePath = request.query.path;
    if (!relativePath) return reply.code(400).send({ error: "path query parameter is required" });
    const limit = request.query.limit !== undefined ? Number(request.query.limit) : undefined;
    return runtime.getRootHistory(request.params.id, relativePath, Number.isFinite(limit) ? limit : undefined);
  });
  // ---- Folder bindings (B3): list directory mappings and rebind manually ----
  app.get<{ Params: { id: string } }>("/api/roots/:id/folders", async (request, reply) => {
    const root = await metaStorage.getRoot(request.params.id);
    if (!root) return reply.code(404).send({ error: "root not found" });
    return runtime.listFolderBindings(request.params.id);
  });
  app.post<{ Params: { id: string }; Body: { relativePath?: string; remoteToken?: string } }>("/api/roots/:id/folders/rebind", async (request, reply) => {
    const { relativePath, remoteToken } = request.body ?? {};
    if (!relativePath || typeof relativePath !== "string") return reply.code(400).send({ error: "relativePath is required" });
    if (!remoteToken || typeof remoteToken !== "string") return reply.code(400).send({ error: "remoteToken is required" });
    return runtime.rebindFolder(request.params.id, relativePath, remoteToken);
  });
  // ---- Issue workbench: single-entry sync / ignore, batch missing resync --
  app.post<{ Params: { id: string } }>("/api/entries/:id/sync", async (request) => runtime.syncEntryNow(request.params.id));
  app.post<{ Params: { id: string }; Body: { ignored?: boolean } }>("/api/entries/:id/ignore", async (request, reply) => {
    if (typeof request.body?.ignored !== "boolean") return reply.code(400).send({ error: "ignored must be a boolean" });
    return runtime.setEntryIgnored(request.params.id, request.body.ignored);
  });
  // ---- Batch entry actions (B6.3): bulk retry / ignore from the workbench ----
  app.post<{ Body: { entryIds?: string[]; action?: string } }>("/api/entries/batch", async (request, reply) => {
    const { entryIds, action } = request.body ?? {};
    if (!Array.isArray(entryIds) || entryIds.length === 0) return reply.code(400).send({ error: "entryIds must be a non-empty array" });
    if (action !== "retry" && action !== "ignore" && action !== "unignore") return reply.code(400).send({ error: "action must be one of retry, ignore, unignore" });
    return runtime.batchEntries(entryIds, action);
  });
  app.post<{ Params: { id: string } }>("/api/roots/:id/sync-missing", async (request, reply) => {
    const root = await metaStorage.getRoot(request.params.id);
    if (!root) return reply.code(404).send({ error: "root not found" });
    return runtime.syncMissingEntries(request.params.id);
  });
  app.get<{ Querystring: { status?: string } }>("/api/conflicts", async (request) => {
    const status = request.query.status;
    const list = status === "all"
      ? await metaStorage.listConflicts()
      : await metaStorage.listConflicts(status === "resolved" || status === "aborted" ? status : "open");
    return Promise.all(list.map(async (conflict) => {
      const binding = await metaStorage.findBindingById(conflict.entryId);
      const root = binding ? await metaStorage.getRoot(binding.rootId) : undefined;
      return { ...conflict, relativePath: binding?.relativePath, localRoot: root?.localPath, rootId: binding?.rootId };
    }));
  });
  app.get<{ Params: { id: string } }>("/api/conflicts/:id", async (request, reply) => {
    const conflict = await metaStorage.getConflict(request.params.id);
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
    const conflict = await metaStorage.getConflict(request.params.id);
    if (!conflict) return reply.code(404).send({ error: "conflict not found" });
    const resolved = await runtime.resolveConflict(conflict, body);
    return reply.send(resolved);
  });
  app.get<{ Querystring: { rootId?: string; trigger?: string; errorCategory?: string; status?: string; limit?: string; cursor?: string } }>("/api/operations", async (request) => {
    const q = request.query;
    const limit = q.limit !== undefined ? Number(q.limit) : undefined;
    const operations = await metaStorage.listOperations({
      rootId: q.rootId,
      trigger: q.trigger as SyncTrigger | undefined,
      errorCategory: q.errorCategory as ErrorCategory | undefined,
      status: q.status as OperationRecord["status"] | undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
      cursor: q.cursor
    });
    // Join entry/root info so the history view can filter by root and retry.
    return Promise.all(operations.map(async (operation) => {
      const binding = operation.entryId ? await metaStorage.findBindingById(operation.entryId) : undefined;
      return { ...operation, rootId: operation.rootId ?? binding?.rootId, relativePath: binding?.relativePath };
    }));
  });
  // ---- Task center (B2): grouped operation view + retry/cancel/batch ------
  app.get<{ Querystring: { status?: string; rootId?: string; limit?: string; cursor?: string } }>("/api/tasks", async (request) => {
    const q = request.query;
    const limit = q.limit !== undefined ? Number(q.limit) : undefined;
    return runtime.listTasks({
      status: q.status as TaskStatus | undefined,
      rootId: q.rootId,
      limit: Number.isFinite(limit) ? limit : undefined,
      cursor: q.cursor
    });
  });
  app.post<{ Params: { id: string } }>("/api/tasks/:id/retry", async (request) => runtime.retryTask(request.params.id));
  app.post<{ Params: { id: string } }>("/api/tasks/:id/cancel", async (request) => runtime.cancelTask(request.params.id));
  app.post<{ Body: { operationIds?: string[] } }>("/api/tasks/batch-retry", async (request, reply) => {
    const ids = request.body?.operationIds;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) return reply.code(400).send({ error: "operationIds must be an array of strings" });
    return runtime.batchRetryTasks(ids);
  });
  // Task center「清空已完成」(B2). Unlike the retention prune this deletes the
  // finished records immediately, so the button's count matches what disappears.
  app.post<{ Body?: { statuses?: string[] } }>("/api/tasks/clear-completed", async (request, reply) => {
    const terminal = ["succeeded", "cancelled", "failed"];
    const requested = request.body?.statuses;
    if (requested !== undefined && (!Array.isArray(requested) || requested.some((status) => !terminal.includes(status)))) {
      return reply.code(400).send({ error: `statuses must be a subset of ${terminal.join(", ")}` });
    }
    return runtime.clearCompletedTasks(requested as OperationRecord["status"][] | undefined);
  });
  // ---- Bind-form helper (B5): light token validation before binding ------
  app.get<{ Querystring: { token?: string; type?: string } }>("/api/roots/validate-token", async (request, reply) => {
    const token = request.query.token;
    if (!token || !token.trim()) return reply.code(400).send({ error: "token query parameter is required" });
    const type = request.query.type === "document" ? "document" : request.query.type === "wiki" ? "wiki" : "folder";
    try {
      // Route probes through the instrumented provider so they land in the
      // settings-page API call tally alongside sync traffic (B6.2).
      const probeRemote = runtime.instrumentedRemote;
      if (type === "document") {
        const doc = await probeRemote.getDocument(token);
        return reply.send({ ok: true, type, token, name: doc.name });
      }
      const probe: SyncRoot = { id: "validate-token", localPath: "", remoteToken: token, remoteType: type, enabled: false, pollIntervalMs: 60_000 };
      const tree = await probeRemote.listTree(probe);
      const children = tree.nodes.filter((node) => node.parentToken === token).length;
      return reply.send({ ok: true, type, token, name: tree.root.name, children });
    } catch (error) {
      const category = categorizeError(error);
      const statusCode = category === "auth" ? 401 : category === "permission" ? 403 : category === "not_found" ? 404 : 400;
      return reply.code(statusCode).send({ ok: false, token, category, error: error instanceof Error ? error.message : String(error) });
    }
  });
  // ---- Bind-form helper (B5): local directory probe before binding -------
  // Mirrors validate-token for the 📁 side of the form: does the path exist, is
  // it a directory, and how many syncable files would the first scan pick up?
  // Exclude patterns are honoured so the count matches what will really sync.
  app.get<{ Querystring: { path?: string; exclude?: string } }>("/api/roots/validate-path", async (request, reply) => {
    const rawPath = request.query.path?.trim();
    if (!rawPath) return reply.code(400).send({ ok: false, error: "path query parameter is required" });
    if (!isAbsolute(rawPath)) return reply.code(400).send({ ok: false, path: rawPath, error: "path must be absolute" });
    if (!existsSync(rawPath)) return reply.code(404).send({ ok: false, path: rawPath, exists: false, isDirectory: false, error: "directory does not exist" });
    let isDirectory = false;
    try { isDirectory = statSync(rawPath).isDirectory(); } catch { isDirectory = false; }
    if (!isDirectory) return reply.code(400).send({ ok: false, path: rawPath, exists: true, isDirectory: false, error: "path is not a directory" });
    const exclude = (request.query.exclude ?? "").split(/[\n,;]+/).map((pattern) => pattern.trim()).filter(Boolean);
    try {
      const probe: SyncRoot = { id: "validate-path", localPath: rawPath, remoteToken: "", remoteType: "folder", enabled: false, pollIntervalMs: 60_000, exclude };
      const files = await localProvider.scan(probe);
      return reply.send({
        ok: true, path: rawPath, exists: true, isDirectory: true,
        documents: files.filter((file) => file.kind === "document").length,
        assets: files.filter((file) => file.kind === "asset").length,
        total: files.length, exclude, writable: isWritable(rawPath)
      });
    } catch (error) {
      return reply.code(400).send({ ok: false, path: rawPath, exists: true, isDirectory: true, error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.post<{ Body: { keepOperations?: number; keepOperationHours?: number; resolvedConflictDays?: number } }>("/api/maintenance/prune", async (request) => {
    const body = request.body ?? {};
    return runtime.pruneHistory({ keepOperations: body.keepOperations, keepOperationHours: body.keepOperationHours, resolvedConflictDays: body.resolvedConflictDays });
  });
  // The websocket route is declared inside a deferred child plugin on purpose:
  // @fastify/websocket installs an onRoute hook that rewrites the handler, and
  // Fastify runs onRoute hooks synchronously at declaration time. Registering
  // the route before the plugin has booted would silently leave it as a plain
  // HTTP route, so the browser's upgrade handshake got a 426 instead of 101 and
  // every live event (sync-started, operation-*, rate-limited) was lost.
  void app.register(async (events) => {
    events.route({
      method: "GET",
      url: "/api/events",
      handler: (_request, reply) => reply.code(426).send({ error: "WebSocket upgrade required" }),
      wsHandler: (socket) => runtime.addClient(socket)
    });
  });
  app.setErrorHandler((error, request, reply) => {
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    if (statusCode >= 500) app.log.error({ statusCode, url: request.url, error: error instanceof Error ? error.message : String(error) }, "request failed");
    return reply.code(statusCode).send({ error: error instanceof Error ? error.message : String(error) });
  });
  app.addHook("onClose", async () => {
    runtime.stop();
    eventChannel.stop();
  });
  return app as unknown as FastifyInstance & { runtime: SyncRuntime; gitStorage: GitStorage; metaStorage: MetaStorage; credentials: CredentialStore; registry?: ProviderRegistry; eventChannel: EventChannelService; appConfig: AppConfigStore };
}
