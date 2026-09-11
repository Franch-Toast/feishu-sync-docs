import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyBaseLogger } from "fastify";
import { FeishuOpenApiProvider, LarkCliProvider } from "@feishu-sync/feishu";
import type { UserTokenUpdate } from "@feishu-sync/feishu";
import type { RemoteProvider } from "@feishu-sync/core";
import { AppConfigStore, AUTH_FLAG_KEYS } from "./appconfig.js";

const execFileAsync = promisify(execFile);

/** Credential configuration modes offered in the settings UI. */
export type CredentialMode = "user" | "tenant" | "cli";
export type AuthStatus = "ok" | "invalid" | "unconfigured";

export interface CredentialInput {
  mode?: CredentialMode;
  baseUrl?: string;
  accessToken?: string;
  appId?: string;
  appSecret?: string;
  refreshToken?: string;
  larkCliBin?: string;
}

export interface CredentialConfig {
  mode: CredentialMode;
  baseUrl: string;
  accessToken?: string;
  appId?: string;
  appSecret?: string;
  refreshToken?: string;
  larkCliBin?: string;
}

export interface TestConnectionResult {
  ok: boolean;
  mode: CredentialMode;
  latencyMs: number;
  identity?: string;
  error?: string;
}

export interface RedactedSettings extends CredentialInput {
  mode: CredentialMode;
  baseUrl: string;
  accessToken?: string;
  hasAccessToken: boolean;
  appId?: string;
  hasAppSecret: boolean;
  refreshToken?: string;
  hasRefreshToken: boolean;
  refreshTokenExpiresAt?: string;
  /** True when a refresh token plus app credentials allow automatic renewal. */
  refreshSupported: boolean;
  larkCliBin?: string;
  authStatus: AuthStatus;
  authCheckedAt?: string;
  guideUrls: { user: string; tenant: string };
  envFallback: { hasAccessToken: boolean; hasAppCredentials: boolean; hasRefreshToken: boolean };
}

/** Credential keys persisted in config.json (saved values win over env vars). */
const KEYS = {
  mode: "feishu.mode",
  baseUrl: "feishu.baseUrl",
  accessToken: "feishu.accessToken",
  appId: "feishu.appId",
  appSecret: "feishu.appSecret",
  refreshToken: "feishu.refreshToken",
  refreshTokenExpiresAt: "feishu.refreshTokenExpiresAt",
  larkCliBin: "feishu.larkCliBin",
  authStatus: AUTH_FLAG_KEYS.status,
  authCheckedAt: AUTH_FLAG_KEYS.checkedAt,
  guideUrlUser: "feishu.guideUrl.user",
  guideUrlTenant: "feishu.guideUrl.tenant"
} as const;

const DEFAULT_BASE_URL = "https://open.feishu.cn";
const DEFAULT_GUIDE_USER = "https://open.feishu.cn/api-explorer/";
const DEFAULT_GUIDE_TENANT = "https://open.feishu.cn/app";

/** Optional hook for probing the lark-cli executable; tests inject a fake. */
export type CliProbe = (executable: string) => Promise<void>;

/** What `GET /api/oauth/start` hands the browser. */
export interface OAuthStartResult {
  /** Feishu authorization page to open in a new tab. */
  url: string;
  state: string;
  redirectUri: string;
}

/** What a completed authorization reports back to the workbench. */
export interface OAuthCompleteResult {
  ok: true;
  expiresAt: string;
  /** False when the app lacks `offline_access`, i.e. no auto-renewal. */
  refreshTokenReceived: boolean;
  scope?: string;
}

/** Persists Feishu credentials in the AppConfigStore (config.json) with
 *  env-var fallback, builds providers from the resolved config and runs
 *  lightweight connectivity probes. */
export class CredentialStore {
  private readonly fetchImpl: typeof fetch;
  private readonly probeCli?: CliProbe;
  private readonly logger?: FastifyBaseLogger;
  /** In-flight authorization-code attempts, keyed by CSRF `state`. */
  private readonly pendingOAuth = new Map<string, { redirectUri: string; createdAt: number }>();
  private lastOAuthRedirectUri?: string;
  private static readonly OAUTH_STATE_TTL_MS = 10 * 60_000;

  constructor(private readonly config: AppConfigStore, fetchImpl?: typeof fetch, probeCli?: CliProbe, logger?: FastifyBaseLogger) {
    this.fetchImpl = fetchImpl ?? fetch;
    this.probeCli = probeCli;
    this.logger = logger;
  }

  /** Resolve the effective config: saved settings first, env vars as fallback. */
  async load(): Promise<CredentialConfig> {
    const saved = await this.config.getCredentials();
    const savedMode = saved[KEYS.mode] as CredentialMode | undefined;
    const envHasAppCredentials = Boolean(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET);
    const mode: CredentialMode = savedMode ?? (process.env.FEISHU_PROVIDER === "cli" ? "cli" : envHasAppCredentials ? "tenant" : "user");
    const baseUrl = nonEmpty(saved[KEYS.baseUrl]) ?? nonEmpty(process.env.FEISHU_BASE_URL) ?? DEFAULT_BASE_URL;
    const accessToken = nonEmpty(saved[KEYS.accessToken]) ?? nonEmpty(process.env.FEISHU_ACCESS_TOKEN);
    const appId = nonEmpty(saved[KEYS.appId]) ?? nonEmpty(process.env.FEISHU_APP_ID);
    const appSecret = nonEmpty(saved[KEYS.appSecret]) ?? nonEmpty(process.env.FEISHU_APP_SECRET);
    const refreshToken = nonEmpty(saved[KEYS.refreshToken]) ?? nonEmpty(process.env.FEISHU_REFRESH_TOKEN);
    const larkCliBin = nonEmpty(saved[KEYS.larkCliBin]) ?? nonEmpty(process.env.LARK_CLI_BIN) ?? nonEmpty(process.env.LARK_CLI_PATH);
    return { mode, baseUrl, accessToken, appId, appSecret, refreshToken, larkCliBin };
  }

  /** Persist a settings patch. Empty-string values clear the stored setting;
   *  undefined leaves the stored value untouched. */
  async save(patch: CredentialInput): Promise<void> {
    const pairs: Array<[string, string | undefined]> = [];
    if (patch.mode !== undefined) pairs.push([KEYS.mode, patch.mode]);
    if (patch.baseUrl !== undefined) pairs.push([KEYS.baseUrl, patch.baseUrl.trim() || DEFAULT_BASE_URL]);
    if (patch.accessToken !== undefined) pairs.push([KEYS.accessToken, patch.accessToken.trim()]);
    if (patch.appId !== undefined) pairs.push([KEYS.appId, patch.appId.trim()]);
    if (patch.appSecret !== undefined) pairs.push([KEYS.appSecret, patch.appSecret.trim()]);
    if (patch.refreshToken !== undefined) {
      pairs.push([KEYS.refreshToken, patch.refreshToken.trim()]);
      // A manually supplied refresh token has unknown validity until the first
      // rotation; clear any previously stored expiry.
      pairs.push([KEYS.refreshTokenExpiresAt, ""]);
    }
    if (patch.larkCliBin !== undefined) pairs.push([KEYS.larkCliBin, patch.larkCliBin.trim()]);
    await this.config.setCredentials(pairs);
  }

  /** Build a provider that auto-renews user tokens via the stored refresh
   *  token; rotations are persisted back into settings before returning. */
  private buildUserProvider(config: CredentialConfig): FeishuOpenApiProvider {
    return new FeishuOpenApiProvider({
      baseUrl: config.baseUrl,
      accessToken: config.accessToken,
      refreshToken: config.refreshToken,
      appId: config.appId,
      appSecret: config.appSecret,
      // The same transport the store was built with: an injected fetch (tests,
      // embedded hosts, a proxy) must also cover the token endpoint, otherwise a
      // refresh or an authorization-code exchange silently bypasses it.
      fetchImpl: this.fetchImpl,
      onTokenRefresh: (update) => this.persistUserTokenUpdate(update),
      onRefreshInvalid: (reason) => this.handleRefreshInvalid(reason)
    });
  }

  /** Persist a rotated token pair. The old refresh token is already dead
   *  server-side, so write the new values before the caller proceeds. */
  private async persistUserTokenUpdate(update: UserTokenUpdate): Promise<void> {
    const pairs: Array<[string, string]> = [[KEYS.accessToken, update.accessToken]];
    if (update.refreshToken !== undefined) pairs.push([KEYS.refreshToken, update.refreshToken]);
    if (update.refreshTokenExpiresAt !== undefined) pairs.push([KEYS.refreshTokenExpiresAt, String(update.refreshTokenExpiresAt)]);
    await this.config.setCredentials(pairs);
    this.logger?.info({ refreshTokenExpiresAt: update.refreshTokenExpiresAt }, "user access token rotated via refresh token");
  }

  /** The refresh token can no longer be used; clear it and surface the failure
   *  in the UI so the user knows re-authorization is required. */
  private async handleRefreshInvalid(reason: string): Promise<void> {
    await this.config.setCredentials([
      [KEYS.refreshToken, ""],
      [KEYS.refreshTokenExpiresAt, ""],
      [KEYS.authStatus, "invalid"],
      [KEYS.authCheckedAt, new Date().toISOString()]
    ]);
    this.logger?.warn({ reason }, "refresh token invalid, re-authorization required");
  }

  /** Proactively rotate the user token before it expires so long-idle
   *  deployments never hit an expired access token. Safe to call on a timer:
   *  the provider only performs a network refresh inside its own margin. */
  async maintainUserToken(): Promise<void> {
    const config = await this.load();
    if (config.mode !== "user" || !config.refreshToken || !config.appId || !config.appSecret) return;
    try {
      await this.buildUserProvider(config).getAccessToken();
    } catch {
      // Auth failures are already persisted via handleRefreshInvalid; nothing
      // else to do until the user re-authorizes.
    }
  }

  /** C2: start an OAuth 2.0 authorization-code flow. The `state` and the exact
   *  `redirectUri` we advertised live in memory only — they are CSRF guards and
   *  a token-exchange parameter, never durable configuration. */
  async beginOAuth(redirectUri: string): Promise<OAuthStartResult> {
    const config = await this.load();
    if (!config.appId || !config.appSecret) {
      throw Object.assign(new Error("前往飞书授权前需要先填写 App ID 与 App Secret"), { statusCode: 400 });
    }
    const state = randomBytes(16).toString("hex");
    this.prunePendingOAuth();
    const createdAt = Date.now();
    this.pendingOAuth.set(state, { redirectUri, createdAt });
    this.lastOAuthRedirectUri = redirectUri;
    const provider = new FeishuOpenApiProvider({ baseUrl: config.baseUrl, appId: config.appId, appSecret: config.appSecret, fetchImpl: this.fetchImpl });
    return { url: provider.buildAuthorizeUrl({ appId: config.appId, redirectUri, state }), state, redirectUri };
  }

  /** C2: finish the flow. `state` is required for the browser callback; the
   *  paste-the-code fallback may omit it and then reuses the redirect URI of the
   *  last `beginOAuth`, which is what the authorization request was bound to. */
  async completeOAuth(input: { code: string; state?: string }): Promise<OAuthCompleteResult> {
    const code = input.code?.trim();
    if (!code) throw Object.assign(new Error("授权码为空"), { statusCode: 400 });
    const pending = input.state ? this.pendingOAuth.get(input.state) : undefined;
    if (input.state && !pending) {
      throw Object.assign(new Error("授权会话已过期或不匹配，请重新发起授权"), { statusCode: 400 });
    }
    const redirectUri = pending?.redirectUri ?? this.lastOAuthRedirectUri;
    if (!redirectUri) {
      throw Object.assign(new Error("没有进行中的授权会话，请先点击「前往飞书授权」"), { statusCode: 400 });
    }
    if (input.state) this.pendingOAuth.delete(input.state);
    const config = await this.load();
    const provider = this.buildUserProvider({ ...config, accessToken: undefined });
    const tokens = await provider.exchangeAuthorizationCode({ code, redirectUri });
    // Authorization replaces the whole user-token pair, and it only makes sense
    // in user mode: the refresh token we just got is what keeps syncing alive.
    await this.config.setCredentials([[KEYS.mode, "user"], [KEYS.accessToken, ""]]);
    await this.persistUserTokenUpdate(tokens);
    await this.setAuthStatus("ok");
    return { ok: true, scope: tokens.scope, refreshTokenReceived: Boolean(tokens.refreshToken), expiresAt: new Date(tokens.tokenExpiresAt).toISOString() };
  }

  /** The redirect URI a future callback will be matched against, if any. */
  get hasOAuthSession(): boolean {
    return this.pendingOAuth.size > 0;
  }

  private prunePendingOAuth(): void {
    const deadline = Date.now() - CredentialStore.OAUTH_STATE_TTL_MS;
    for (const [state, attempt] of this.pendingOAuth) {
      if (attempt.createdAt < deadline) this.pendingOAuth.delete(state);
    }
  }

  async buildProvider(): Promise<RemoteProvider> {
    const config = await this.load();
    if (config.mode === "cli") return new LarkCliProvider({ executable: config.larkCliBin, apiVersion: process.env.LARK_CLI_API_VERSION === "v2" ? "v2" : "v1" });
    if (config.mode === "tenant" && config.appId && config.appSecret) return new FeishuOpenApiProvider({ baseUrl: config.baseUrl, appId: config.appId, appSecret: config.appSecret, fetchImpl: this.fetchImpl });
    return this.buildUserProvider(config);
  }

  /** Probe Feishu with the given config (or the stored one) and report identity. */
  async testConnection(patch?: CredentialInput): Promise<TestConnectionResult> {
    const base = await this.load();
    const config: CredentialConfig = { ...base, ...omitUndefined(patch) };
    const started = Date.now();
    try {
      if (config.mode === "cli") {
        const executable = config.larkCliBin ?? "lark-cli";
        try {
          // Design contract (backend features §5.4): a CLI connection test must
          // actually probe the executable instead of reporting a fake success.
          if (this.probeCli) await this.probeCli(executable);
          else await execFileAsync(executable, ["--version"], { timeout: 5000 });
          return { ok: true, mode: "cli", latencyMs: Date.now() - started, identity: executable };
        } catch (error) {
          return { ok: false, mode: "cli", latencyMs: Date.now() - started, error: `无法找到可执行的 lark-cli (${executable}): ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      if (config.mode === "user") {
        if (!config.accessToken && !config.refreshToken) return { ok: false, mode: "user", latencyMs: Date.now() - started, error: "缺少 user access token，请先在飞书开放平台获取" };
        // Route through the provider so an expired token is refreshed first.
        const provider = this.buildUserProvider(config);
        const token = await provider.getAccessToken();
        const response = await this.fetchImpl(`${config.baseUrl}/open-apis/authen/v1/user_info`, { headers: { Authorization: `Bearer ${token}` } });
        const body = await response.json() as { code?: number; msg?: string; data?: { name?: string; user_id?: string; open_id?: string } };
        if (body.code !== 0) return { ok: false, mode: "user", latencyMs: Date.now() - started, error: `飞书校验失败 ${body.code}: ${body.msg ?? "token 无效"}` };
        return { ok: true, mode: "user", latencyMs: Date.now() - started, identity: body.data?.name ?? body.data?.open_id ?? body.data?.user_id };
      }
      if (!config.appId || !config.appSecret) return { ok: false, mode: "tenant", latencyMs: Date.now() - started, error: "缺少 app id / app secret" };
      const tokenResponse = await this.fetchImpl(`${config.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret })
      });
      const tokenBody = await tokenResponse.json() as { code?: number; msg?: string; tenant_access_token?: string };
      if (!tokenBody.tenant_access_token) return { ok: false, mode: "tenant", latencyMs: Date.now() - started, error: `应用凭证校验失败: ${tokenBody.msg ?? "missing token"}` };
      const metaResponse = await this.fetchImpl(`${config.baseUrl}/open-apis/drive/explorer/v2/root_folder/meta`, { headers: { Authorization: `Bearer ${tokenBody.tenant_access_token}` } });
      const metaBody = await metaResponse.json() as { code?: number; msg?: string };
      if (metaBody.code !== 0) return { ok: false, mode: "tenant", latencyMs: Date.now() - started, error: `云盘权限校验失败 ${metaBody.code}: ${metaBody.msg ?? "request failed"}` };
      return { ok: true, mode: "tenant", latencyMs: Date.now() - started, identity: config.appId };
    } catch (error) {
      return { ok: false, mode: config.mode, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async getAuthStatus(): Promise<AuthStatus> {
    const saved = await this.config.getCredential(KEYS.authStatus);
    if (saved === "ok" || saved === "invalid") return saved;
    const config = await this.load();
    const configured = config.mode === "cli" || Boolean(config.accessToken) || Boolean(config.appId && config.appSecret);
    return configured ? "ok" : "unconfigured";
  }

  async setAuthStatus(status: AuthStatus): Promise<void> {
    await this.config.setCredentials([[KEYS.authStatus, status], [KEYS.authCheckedAt, new Date().toISOString()]]);
  }

  async setGuideUrls(user?: string, tenant?: string): Promise<void> {
    const pairs: Array<[string, string]> = [];
    if (user !== undefined) pairs.push([KEYS.guideUrlUser, user]);
    if (tenant !== undefined) pairs.push([KEYS.guideUrlTenant, tenant]);
    await this.config.setCredentials(pairs);
  }

  /** Redacted view for the browser: secrets are never returned in full. */
  async redacted(): Promise<RedactedSettings> {
    const config = await this.load();
    const saved = await this.config.getCredentials();
    const guideUser = saved[KEYS.guideUrlUser] ?? DEFAULT_GUIDE_USER;
    const guideTenant = saved[KEYS.guideUrlTenant] ?? DEFAULT_GUIDE_TENANT;
    return {
      mode: config.mode,
      baseUrl: config.baseUrl,
      accessToken: mask(config.accessToken),
      hasAccessToken: Boolean(config.accessToken),
      appId: config.appId,
      hasAppSecret: Boolean(config.appSecret),
      refreshToken: mask(config.refreshToken),
      hasRefreshToken: Boolean(config.refreshToken),
      refreshTokenExpiresAt: toIsoEpoch(saved[KEYS.refreshTokenExpiresAt]),
      refreshSupported: Boolean(config.refreshToken && config.appId && config.appSecret),
      larkCliBin: config.larkCliBin,
      authStatus: await this.getAuthStatus(),
      authCheckedAt: saved[KEYS.authCheckedAt],
      guideUrls: { user: guideUser, tenant: guideTenant },
      envFallback: {
        hasAccessToken: Boolean(process.env.FEISHU_ACCESS_TOKEN),
        hasAppCredentials: Boolean(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET),
        hasRefreshToken: Boolean(process.env.FEISHU_REFRESH_TOKEN)
      }
    };
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim() ? value.trim() : undefined;
}

function omitUndefined<T extends object>(input: T | undefined): Partial<T> {
  if (!input) return {};
  // C1: an empty or whitespace-only field means "leave the stored credential
  // alone", exactly like `undefined`. The settings form always renders the
  // saved secrets masked, so submitting the untouched form must never blank a
  // working token — `test-connection` has to probe with the value on disk.
  return Object.fromEntries(Object.entries(input).filter(([, value]) =>
    value !== undefined && !(typeof value === "string" && value.trim() === ""))) as Partial<T>;
}

/** Never return a full secret: show the first 6 and last 4 characters only. */
function mask(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length <= 12) return "•".repeat(8);
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/** Convert an epoch-ms string stored in settings into an ISO timestamp. */
function toIsoEpoch(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;
}
