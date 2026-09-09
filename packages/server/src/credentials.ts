import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyBaseLogger } from "fastify";
import { FeishuOpenApiProvider, LarkCliProvider } from "@feishu-sync/feishu";
import type { UserTokenUpdate } from "@feishu-sync/feishu";
import type { RemoteProvider, StateStore } from "@feishu-sync/core";

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

/** Settings keys persisted in the state store (DB values win over env vars). */
const KEYS = {
  mode: "feishu.mode",
  baseUrl: "feishu.baseUrl",
  accessToken: "feishu.accessToken",
  appId: "feishu.appId",
  appSecret: "feishu.appSecret",
  refreshToken: "feishu.refreshToken",
  refreshTokenExpiresAt: "feishu.refreshTokenExpiresAt",
  larkCliBin: "feishu.larkCliBin",
  authStatus: "feishu.authStatus",
  authCheckedAt: "feishu.authCheckedAt",
  guideUrlUser: "feishu.guideUrl.user",
  guideUrlTenant: "feishu.guideUrl.tenant"
} as const;

const DEFAULT_BASE_URL = "https://open.feishu.cn";
const DEFAULT_GUIDE_USER = "https://open.feishu.cn/api-explorer/";
const DEFAULT_GUIDE_TENANT = "https://open.feishu.cn/app";

/** Optional hook for probing the lark-cli executable; tests inject a fake. */
export type CliProbe = (executable: string) => Promise<void>;

/** Persists Feishu credentials in SQLite with env-var fallback, builds providers
 *  from the resolved config and runs lightweight connectivity probes. */
export class CredentialStore {
  private readonly fetchImpl: typeof fetch;
  private readonly probeCli?: CliProbe;
  private readonly logger?: FastifyBaseLogger;

  constructor(private readonly store: StateStore, fetchImpl?: typeof fetch, probeCli?: CliProbe, logger?: FastifyBaseLogger) {
    this.fetchImpl = fetchImpl ?? fetch;
    this.probeCli = probeCli;
    this.logger = logger;
  }

  /** Resolve the effective config: DB settings first, env vars as fallback. */
  async load(): Promise<CredentialConfig> {
    const saved = await this.store.getSettings();
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
    for (const [key, value] of pairs) await this.store.setSetting(key, value ?? "");
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
    await this.store.setSetting(KEYS.accessToken, update.accessToken);
    if (update.refreshToken !== undefined) await this.store.setSetting(KEYS.refreshToken, update.refreshToken);
    if (update.refreshTokenExpiresAt !== undefined) await this.store.setSetting(KEYS.refreshTokenExpiresAt, String(update.refreshTokenExpiresAt));
    this.logger?.info({ refreshTokenExpiresAt: update.refreshTokenExpiresAt }, "user access token rotated via refresh token");
  }

  /** The refresh token can no longer be used; clear it and surface the failure
   *  in the UI so the user knows re-authorization is required. */
  private async handleRefreshInvalid(reason: string): Promise<void> {
    await this.store.setSetting(KEYS.refreshToken, "");
    await this.store.setSetting(KEYS.refreshTokenExpiresAt, "");
    await this.store.setSetting(KEYS.authStatus, "invalid");
    await this.store.setSetting(KEYS.authCheckedAt, new Date().toISOString());
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
    const saved = await this.store.getSetting(KEYS.authStatus);
    if (saved === "ok" || saved === "invalid") return saved;
    const config = await this.load();
    const configured = config.mode === "cli" || Boolean(config.accessToken) || Boolean(config.appId && config.appSecret);
    return configured ? "ok" : "unconfigured";
  }

  async setAuthStatus(status: AuthStatus): Promise<void> {
    await this.store.setSetting(KEYS.authStatus, status);
    await this.store.setSetting(KEYS.authCheckedAt, new Date().toISOString());
  }

  async setGuideUrls(user?: string, tenant?: string): Promise<void> {
    if (user !== undefined) await this.store.setSetting(KEYS.guideUrlUser, user);
    if (tenant !== undefined) await this.store.setSetting(KEYS.guideUrlTenant, tenant);
  }

  /** Redacted view for the browser: secrets are never returned in full. */
  async redacted(): Promise<RedactedSettings> {
    const config = await this.load();
    const guideUser = (await this.store.getSetting(KEYS.guideUrlUser)) ?? DEFAULT_GUIDE_USER;
    const guideTenant = (await this.store.getSetting(KEYS.guideUrlTenant)) ?? DEFAULT_GUIDE_TENANT;
    const savedRefreshExpiry = await this.store.getSetting(KEYS.refreshTokenExpiresAt);
    return {
      mode: config.mode,
      baseUrl: config.baseUrl,
      accessToken: mask(config.accessToken),
      hasAccessToken: Boolean(config.accessToken),
      appId: config.appId,
      hasAppSecret: Boolean(config.appSecret),
      refreshToken: mask(config.refreshToken),
      hasRefreshToken: Boolean(config.refreshToken),
      refreshTokenExpiresAt: toIsoEpoch(savedRefreshExpiry),
      refreshSupported: Boolean(config.refreshToken && config.appId && config.appSecret),
      larkCliBin: config.larkCliBin,
      authStatus: await this.getAuthStatus(),
      authCheckedAt: await this.store.getSetting(KEYS.authCheckedAt),
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
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
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
