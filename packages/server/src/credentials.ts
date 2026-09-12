import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
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
  oauthRedirectUri: "feishu.oauthRedirectUri",
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

/** Persists Feishu credentials in the AppConfigStore (config.json) with
 *  env-var fallback, builds providers from the resolved config and runs
 *  lightweight connectivity probes. */
export class CredentialStore {
  private readonly fetchImpl: typeof fetch;
  private readonly probeCli?: CliProbe;
  private readonly logger?: FastifyBaseLogger;

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

  /** Persist a settings patch. Empty strings mean "not provided" — the browser
   *  submits every input and a blank field must keep the stored secret instead
   *  of wiping a value the user can no longer see. undefined behaves the same. */
  async save(patch: CredentialInput): Promise<void> {
    const pairs: Array<[string, string | undefined]> = [];
    const provided = (value: string | undefined): value is string => value !== undefined && value.trim() !== "";
    if (provided(patch.mode)) pairs.push([KEYS.mode, patch.mode]);
    if (provided(patch.baseUrl)) pairs.push([KEYS.baseUrl, patch.baseUrl.trim() || DEFAULT_BASE_URL]);
    if (provided(patch.accessToken)) pairs.push([KEYS.accessToken, patch.accessToken.trim()]);
    if (provided(patch.appId)) pairs.push([KEYS.appId, patch.appId.trim()]);
    if (provided(patch.appSecret)) pairs.push([KEYS.appSecret, patch.appSecret.trim()]);
    if (provided(patch.refreshToken)) {
      pairs.push([KEYS.refreshToken, patch.refreshToken.trim()]);
      // A manually supplied refresh token has unknown validity until the first
      // rotation; clear any previously stored expiry.
      pairs.push([KEYS.refreshTokenExpiresAt, ""]);
    }
    if (provided(patch.larkCliBin)) pairs.push([KEYS.larkCliBin, patch.larkCliBin.trim()]);
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

  async buildProvider(): Promise<RemoteProvider> {
    const config = await this.load();
    if (config.mode === "cli") return new LarkCliProvider({ executable: config.larkCliBin, apiVersion: process.env.LARK_CLI_API_VERSION === "v2" ? "v2" : "v1" });
    if (config.mode === "tenant" && config.appId && config.appSecret) return new FeishuOpenApiProvider({ baseUrl: config.baseUrl, appId: config.appId, appSecret: config.appSecret });
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

  // ---- OAuth authorization-code flow (user mode) -------------------------
  // Browser flow: GET /api/auth/feishu/authorize returns the Feishu consent
  // page URL, the user approves, Feishu redirects to
  // /api/auth/feishu/callback?code=...&state=..., and the callback exchanges
  // the code for an access + refresh token pair. The refresh token is only
  // issued when the app has the offline_access permission enabled.

  /** In-memory one-time state store for the authorize → callback round trip. */
  private readonly oauthStates = new Map<string, { redirectUri: string; expiresAt: number }>();

  /** Redirect URI for the round trip: an explicit override (setting or env,
   *  reverse-proxy setups) wins, else it derives from the request Host. */
  async getOAuthRedirectUri(requestHost?: string): Promise<string> {
    const configured = nonEmpty(await this.config.getCredential(KEYS.oauthRedirectUri)) ?? nonEmpty(process.env.FEISHU_OAUTH_REDIRECT_URI);
    if (configured) return configured;
    if (!requestHost) throw Object.assign(new Error("无法推导 OAuth 回调地址(缺少 Host 头),请设置 feishu.oauthRedirectUri"), { statusCode: 400 });
    return `http://${requestHost}/api/auth/feishu/callback`;
  }

  /** Build the consent-page URL and remember the single-use state (10 min). */
  async buildAuthorizeUrl(redirectUri: string): Promise<string> {
    const config = await this.load();
    if (!config.appId || !config.appSecret) throw Object.assign(new Error("OAuth 授权登录需要先填写 App ID 与 App Secret"), { statusCode: 400 });
    const state = randomUUID();
    this.oauthStates.set(state, { redirectUri, expiresAt: Date.now() + 10 * 60_000 });
    const query = new URLSearchParams({ app_id: config.appId, redirect_uri: redirectUri, state, scope: "offline_access" });
    return `${accountsBaseUrl(config.baseUrl)}/open-apis/authen/v1/authorize?${query}`;
  }

  /** Consume a previously issued state; returns its redirect URI or undefined. */
  consumeOAuthState(state: string | undefined): string | undefined {
    if (!state) return undefined;
    const entry = this.oauthStates.get(state);
    this.oauthStates.delete(state);
    if (!entry || entry.expiresAt < Date.now()) return undefined;
    return entry.redirectUri;
  }

  /** Exchange the authorization code for tokens and persist them; the mode is
   *  pinned to "user" and the auth flag to "ok" so the UI reflects success. */
  async exchangeCode(code: string, redirectUri: string): Promise<void> {
    const config = await this.load();
    if (!config.appId || !config.appSecret) throw Object.assign(new Error("缺少 App ID / App Secret,无法完成 OAuth 换取"), { statusCode: 400 });
    const response = await this.fetchImpl(`${accountsBaseUrl(config.baseUrl)}/oauth/v3/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", client_id: config.appId, client_secret: config.appSecret, code, redirect_uri: redirectUri })
    });
    const body = await response.json() as { code?: number; msg?: string; access_token?: string; refresh_token?: string; refresh_token_expires_in?: number };
    if (!body.access_token || !body.refresh_token) {
      throw Object.assign(new Error(`OAuth 换取令牌失败: ${body.msg ?? "未返回 refresh_token(请确认应用已开通 offline_access 权限)"}`), { statusCode: 502 });
    }
    const pairs: Array<[string, string]> = [
      [KEYS.accessToken, body.access_token],
      [KEYS.refreshToken, body.refresh_token],
      [KEYS.mode, "user"],
      [KEYS.authStatus, "ok"],
      [KEYS.authCheckedAt, new Date().toISOString()]
    ];
    if (body.refresh_token_expires_in) pairs.push([KEYS.refreshTokenExpiresAt, String(Date.now() + body.refresh_token_expires_in * 1000)]);
    await this.config.setCredentials(pairs);
    this.logger?.info("OAuth 授权完成,refresh token 已存储");
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

/** Map the API base URL onto the accounts domain that serves OAuth pages. */
function accountsBaseUrl(baseUrl: string): string {
  if (baseUrl.includes("open.feishu.cn")) return "https://accounts.feishu.cn";
  if (baseUrl.includes("open.larksuite.com")) return "https://accounts.larksuite.com";
  return baseUrl.replace(/\/+$/, "");
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim() ? value.trim() : undefined;
}

/** Drop undefined AND empty-string fields: the browser submits every input,
 *  so blank fields mean "keep the stored value" (same contract as save()). */
function omitUndefined<T extends object>(input: T | undefined): Partial<T> {
  if (!input) return {};
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== "")) as Partial<T>;
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
