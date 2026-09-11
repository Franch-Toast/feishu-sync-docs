import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { accessSync, constants, createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FilesystemProvider } from "@feishu-sync/core";
import type { ErrorCategory, GitStorage, MetaStorage, OperationRecord, RemoteProvider, SyncMode, SyncRoot, SyncTrigger } from "@feishu-sync/core";
import { GitStorageImpl, JsonMetaStorage } from "@feishu-sync/storage";
import { categorizeError } from "@feishu-sync/feishu";
import { ProviderRegistry } from "./provider.js";
import { CredentialStore, type CredentialInput } from "./credentials.js";
import { AppConfigStore, type LogLevel, type NotificationChannel, type NotificationPreferences } from "./appconfig.js";
import { LogSink } from "./notify.js";
import { SyncRuntime, type TaskStatus } from "./runtime.js";
import { EventChannelService, type EventChannelState } from "./eventchannel.js";

/** Allowed sync modes / triggers for request validation (B1). */
const SYNC_MODES: readonly SyncMode[] = ["bidirectional", "pull-only", "push-only"];
const SYNC_TRIGGERS: readonly SyncTrigger[] = ["manual", "event", "poll", "watch"];

/** C2: the `error` values Feishu puts on the callback query when the user
 *  bails out or the app is misconfigured, translated. */
const OAUTH_CALLBACK_ERROR_LABELS: Record<string, string> = {
  access_denied: "你取消了授权（access_denied），可重新点击「前往飞书授权」",
  invalid_scope: "应用未开通所需权限（offline_access 等），请在开发者后台申请后重试",
  server_error: "飞书授权服务暂时不可用，请稍后重试",
  temporarily_unavailable: "飞书授权服务正在维护，请稍后重试"
};

/** C2: the callback lands in the user's browser, so it answers with a page,
 *  not JSON. Self-contained (no assets) because it is served before the SPA
 *  bundle is even relevant, and auto-closes on success. */
function oauthPage(title: string, message: string, ok: boolean): string {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message).replace(/\n/g, "<br>");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${safeTitle} · Feishu Sync</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e6e8eb;font:15px/1.6 ui-sans-serif,system-ui,"PingFang SC","Microsoft YaHei",sans-serif}
.card{max-width:34rem;padding:2rem 1.75rem;border:1px solid ${ok ? "#2f6f4f" : "#7a3b3b"};border-radius:12px;background:#171a21}
h1{margin:0 0 .75rem;font-size:1.15rem}p{margin:0 0 1rem;color:#c8ccd2}
small{color:#8b929c}a{color:#7aa2f7}</style></head>
<body><div class="card"><h1>${safeTitle}</h1><p>${safeMessage}</p>
<small>${ok ? "本页将在 3 秒后自动关闭。" : "<a href=\"/\" target=\"_self\">返回工作台</a>"}</small></div>${ok ? "<script>setTimeout(function(){window.close()},3000)</script>" : ""}</body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

/** G6: what a candidate directory already carries. Read straight from disk so
 *  the probe works before any root exists and never touches the network. */
interface DirectoryProbe { hasGit: boolean; gitBranch?: string; hasMeta: boolean; metaRootId?: string; metaIgnored: boolean }

function readDirectoryProbe(directory: string): DirectoryProbe {
  const hasGit = existsSync(join(directory, ".git"));
  const metaDir = join(directory, ".feishu-sync");
  const hasMeta = existsSync(metaDir);
  let gitBranch: string | undefined;
  if (hasGit) {
    try {
      const head = readFileSync(join(directory, ".git", "HEAD"), "utf8").trim();
      gitBranch = head.startsWith("ref: ") ? head.slice(5).split("/").pop() : head.slice(0, 7);
    } catch { gitBranch = undefined; }
  }
  let metaRootId: string | undefined;
  if (hasMeta) {
    try {
      const state = JSON.parse(readFileSync(join(metaDir, "state.json"), "utf8")) as { rootId?: string };
      metaRootId = typeof state.rootId === "string" && state.rootId ? state.rootId : undefined;
    } catch { metaRootId = undefined; }
  }
  let metaIgnored = false;
  try {
    const ignore = readFileSync(join(directory, ".gitignore"), "utf8");
    metaIgnored = ignore.split("\n").some((line) => { const t = line.trim(); return t === ".feishu-sync" || t === ".feishu-sync/" || t === "/.feishu-sync/"; });
  } catch { metaIgnored = false; }
  return { hasGit, gitBranch, hasMeta, metaRootId, metaIgnored };
}

/** Best-effort write probe for the bind form: sync must be able to create
 *  `.feishu-sync`/`.git` and pull remote edits into this directory. */
function isWritable(directory: string): boolean {
  try { accessSync(directory, constants.W_OK); return true; } catch { return false; }
}

/** What the app needs from the drive-event subscription. Kept as a port so a
 *  test (or an embedded host) can swap the websocket client out without opening
 *  a real connection to Feishu. */
export interface EventChannelPort {
  getState(): EventChannelState;
  start(): Promise<void>;
  rebuild(): Promise<void>;
  stop(): void;
}

export interface AppOptions {
  gitStorage?: GitStorage;
  metaStorage?: MetaStorage;
  remote?: RemoteProvider;
  credentials?: CredentialStore;
  publicDir?: string;
  /** Injected by tests/embedding; defaults to ~/.feishu-sync-docs/config.json. */
  appConfig?: AppConfigStore;
  /** Defaults to a real {@link EventChannelService} over the injected credentials. */
  eventChannel?: EventChannelPort;
}

export function buildApp(options: AppOptions = {}): FastifyInstance & { runtime: SyncRuntime; gitStorage: GitStorage; metaStorage: MetaStorage; credentials: CredentialStore; registry?: ProviderRegistry; eventChannel: EventChannelPort; appConfig: AppConfigStore } {
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
    appConfig,
    // Auto-retry backoff stays the production default here; tests inject their own.
    undefined,
    // D: notifications are opt-in. The sink and the switches are read from
    // config.json on every event, so a settings change takes effect live.
    { sink: new LogSink((level, message, data) => app.log[level](data, message)), settings: () => ({ channel: appConfig.preferences.notificationChannel, enabled: appConfig.preferences.notifications }) }
  );
  // Long-lived drive event subscription; polling stays enabled as the fallback.
  const eventChannel: EventChannelPort = options.eventChannel ?? new EventChannelService(credentials, metaStorage, runtime, app.log);
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

  // ---- OAuth 2.0 authorization code (C2) --------------------------------
  // The loopback redirect is derived from the request host so the flow works on
  // whatever port/address the workbench was opened at; FEISHU_OAUTH_REDIRECT_URI
  // overrides it for tunnelled deployments.
  const oauthRedirectUri = (host: string | undefined): string =>
    process.env.FEISHU_OAUTH_REDIRECT_URI ?? `http://${host || "127.0.0.1:8787"}/oauth/callback`;

  /** A fresh token pair changes everything downstream: the live provider
   *  delegate and the drive-event subscription both have to be rebuilt. */
  const refreshCredentialDependents = async (): Promise<void> => {
    if (registry) await registry.rebuild();
    await eventChannel.rebuild();
    runtime.broadcastEvent({ type: "settings-updated" });
  };

  app.get("/api/oauth/start", async (request) => credentials.beginOAuth(oauthRedirectUri(request.headers.host)));

  // Feishu redirects the browser here with `?code=&state=` (or `?error=`).
  // Nothing about it is JSON: it is the tail end of a login flow, so it answers
  // with a page the user can read, and pushes the real result over the WS.
  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    "/oauth/callback", async (request, reply) => {
      const { code, state, error: oauthError, error_description: oauthDescription } = request.query;
      reply.type("text/html; charset=utf-8");
      if (oauthError) {
        const reason = oauthDescription || OAUTH_CALLBACK_ERROR_LABELS[oauthError] || oauthError;
        runtime.broadcastEvent({ type: "oauth-failed", error: reason });
        return oauthPage("授权未完成", reason, false);
      }
      if (!code) return oauthPage("授权未完成", "回调缺少 code 参数，请重新发起授权。", false);
      try {
        const result = await credentials.completeOAuth({ code, state });
        await refreshCredentialDependents();
        runtime.broadcastEvent({ type: "oauth-completed", expiresAt: result.expiresAt, refreshTokenReceived: result.refreshTokenReceived });
        return oauthPage(
          "授权完成",
          result.refreshTokenReceived
            ? "已获取访问令牌与刷新令牌，之后会自动续期，可以关闭本页回到工作台。"
            : "已获取访问令牌，但未拿到刷新令牌（约 2 小时后失效）。请在开发者后台开通 offline_access 后重新授权。",
          true
        );
      } catch (caught) {
        const reason = caught instanceof Error ? caught.message : String(caught);
        runtime.broadcastEvent({ type: "oauth-failed", error: reason });
        return oauthPage("授权失败", `${reason}\n可在设置页重试，或使用「手工粘贴授权码」完成换取。`, false);
      }
    }
  );

  // Fallback for setups where the browser cannot reach this loopback port
  // (server behind a tunnel / on another machine): paste the code by hand.
  app.post<{ Body: { code?: string; state?: string } | undefined }>("/api/oauth/code", async (request, reply) => {
    const body = request.body ?? {};
    if (!body.code?.trim()) return reply.code(400).send({ error: "code is required" });
    let result: Awaited<ReturnType<CredentialStore["completeOAuth"]>>;
    try {
      result = await credentials.completeOAuth({ code: body.code, state: body.state });
    } catch (caught) {
      // The code came from the user, so a rejected exchange (expired, reused,
      // redirect mismatch, unknown session) is a 400 carrying the Chinese reason
      // the settings page shows verbatim — not a 500.
      const reason = caught instanceof Error ? caught.message : String(caught);
      runtime.broadcastEvent({ type: "oauth-failed", error: reason });
      return reply.code((caught as { statusCode?: number }).statusCode ?? 400).send({ error: reason });
    }
    await refreshCredentialDependents();
    runtime.broadcastEvent({ type: "oauth-completed", expiresAt: result.expiresAt, refreshTokenReceived: result.refreshTokenReceived });
    return { ...result, settings: await credentials.redacted() };
  });

  // ---- Global preferences (config.json; never exposes credential fields) --
  app.get("/api/app-config", async () => ({
    preferences: appConfig.preferences,
    paths: { config: appConfig.configPath }
  }));
  app.put<{ Body: { defaultPollIntervalMs?: number; logLevel?: LogLevel; notifications?: Partial<NotificationPreferences>; notificationChannel?: NotificationChannel } }>("/api/app-config", async (request) => {
    const preferences = await appConfig.setPreferences(request.body ?? {});
    // Apply the new verbosity live unless the env override wins.
    if (process.env.SYNC_LOG_LEVEL === undefined) app.log.level = preferences.logLevel;
    runtime.broadcastEvent({ type: "settings-updated" });
    return { preferences, paths: { config: appConfig.configPath } };
  });

  // ---- Lightweight API call tally (B6.2): is Feishu throttling us now? ----
  app.get("/api/api-stats", async () => runtime.getApiStats());

  app.get("/api/roots", async () => metaStorage.listRoots());
  app.post<{ Body: { localPath: string; remoteToken: string; remoteType?: "folder" | "wiki"; pollIntervalMs?: number; mode?: SyncMode; exclude?: string[]; metadataAction?: "adopt" | "reset" } }>("/api/roots", async (request, reply) => {
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
    if (body.metadataAction !== undefined && body.metadataAction !== "adopt" && body.metadataAction !== "reset") {
      return reply.code(400).send({ error: "metadataAction must be one of adopt, reset" });
    }
    // G1: one directory can only ever back one root. Binding the same path twice
    // used to create two records sharing one `.feishu-sync` directory, so they
    // overwrote each other's bindings. Re-use the existing root instead, and say
    // so, because the front-end needs to phrase it as "已切换到现有绑定".
    const existing = await metaStorage.findRootByLocalPath(body.localPath);
    const root = existing
      ? await metaStorage.updateRoot(existing.id, { remoteToken: body.remoteToken, remoteType: body.remoteType ?? "folder", pollIntervalMs, mode: body.mode, exclude: body.exclude })
      : await metaStorage.createRoot({ localPath: body.localPath, remoteToken: body.remoteToken, remoteType: body.remoteType ?? "folder", enabled: true, pollIntervalMs, mode: body.mode, exclude: body.exclude });
    if (!root) return reply.code(404).send({ error: `Root not found: ${existing?.id}` });
    // G3: an orphan `.feishu-sync/` (its state.json names a root that no longer
    // exists) is adopted by default, keeping history and the git baseline. The
    // bind form's「重新绑定」choice archives it first so this starts from zero.
    const archived = body.metadataAction === "reset" && !existing
      ? await metaStorage.archiveRootMeta(root.localPath)
      : false;
    if (archived) request.log.info(`bound ${root.localPath} with a reset metadata directory; the previous .feishu-sync payload was moved to backup-<timestamp>/`);
    // Initialize Git repo and meta storage for the (re)bound root
    await gitStorage.initRoot(root);
    await metaStorage.initRootMeta(root.id, root.localPath);
    runtime.startRoot(root);
    runtime.broadcastEvent({ type: "root-updated", rootId: root.id });
    if (existing) return reply.code(200).send({ reused: true, root });
    return reply.code(201).send(archived ? { ...root, metadataArchived: true } : root);
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
    // G1: moving a root onto another root's directory would recreate the
    // shared-`.feishu-sync` corruption that duplicate binding caused, so it is
    // refused with the occupant's id for the UI to name.
    if (body.localPath !== undefined && body.localPath !== current.localPath) {
      const occupant = await metaStorage.findRootByLocalPath(body.localPath);
      if (occupant && occupant.id !== request.params.id) {
        return reply.code(409).send({ error: "该目录已被另一个同步根绑定", boundRootId: occupant.id });
      }
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
      // G6: the bind form must be able to tell the user what is already in this
      // directory before it creates anything — a git repo, a live binding, or
      // metadata left behind by a root that was deleted.
      const probeMeta = readDirectoryProbe(rawPath);
      const boundRoot = await metaStorage.findRootByLocalPath(rawPath);
      const orphanOwner = boundRoot ? undefined : await metaStorage.findOrphanMetaOwner(rawPath);
      return reply.send({
        ok: true, path: rawPath, exists: true, isDirectory: true,
        documents: files.filter((file) => file.kind === "document").length,
        assets: files.filter((file) => file.kind === "asset").length,
        total: files.length, exclude, writable: isWritable(rawPath),
        hasGit: probeMeta.hasGit,
        gitBranch: probeMeta.gitBranch,
        hasMeta: probeMeta.hasMeta,
        metaRootId: probeMeta.metaRootId,
        metaIgnored: probeMeta.metaIgnored,
        orphanMeta: Boolean(orphanOwner) || (probeMeta.hasMeta && !boundRoot && !probeMeta.metaRootId),
        boundRootId: boundRoot?.id
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
    // Awaited: a round started by `POST /api/roots` keeps writing the metadata
    // directory, and closing must mean "no more writes", not "stopped listening".
    await runtime.stop();
    eventChannel.stop();
  });
  return app as unknown as FastifyInstance & { runtime: SyncRuntime; gitStorage: GitStorage; metaStorage: MetaStorage; credentials: CredentialStore; registry?: ProviderRegistry; eventChannel: EventChannelService; appConfig: AppConfigStore };
}
