export type CredentialMode = "user" | "tenant" | "cli";
export type AuthStatus = "ok" | "invalid" | "unconfigured";
/** "orphan" is legacy: the server reclassifies old rows on the next scan. */
export type EntryStatus = "clean" | "pending" | "conflict" | "orphan" | "error" | "local-missing" | "remote-missing";
export type ConflictStatus = "open" | "resolved" | "aborted";
export type Resolution = "local" | "remote" | "merged" | "abort";

export interface Root {
  id: string;
  localPath: string;
  remoteToken: string;
  remoteType: "folder" | "wiki";
  enabled: boolean;
  pollIntervalMs: number;
}

export interface Entry {
  id: string;
  rootId: string;
  relativePath: string;
  kind: "document" | "asset";
  status: EntryStatus;
  remoteToken?: string;
  updatedAt: string;
  /** Runtime flag from the tree API: an operation for this entry is queued/running. */
  syncing?: boolean;
  /** Set when the user ignored the entry; scan/sync skip it until restored. */
  ignoredAt?: string;
}

export interface Operation {
  id: string;
  entryId?: string;
  direction: "push" | "pull" | "merge";
  operation: string;
  status: "queued" | "running" | "succeeded" | "failed";
  retryCount: number;
  error?: string;
  createdAt: string;
  completedAt?: string;
  /** Joined server-side for history filtering. */
  rootId?: string;
  relativePath?: string;
}

export interface Conflict {
  id: string;
  entryId: string;
  status: ConflictStatus;
  baseContent: string;
  localContent: string;
  remoteContent: string;
  mergedContent?: string;
  createdAt: string;
  resolvedAt?: string;
  resolution?: Resolution;
  /** Joined server-side for display. */
  relativePath?: string;
  localRoot?: string;
  rootId?: string;
}

export interface TreeResponse {
  root: Root;
  entries: Entry[];
}

export interface RootStats {
  lastSyncAt?: string;
  succeeded24h: number;
  failed24h: number;
  conflicts: number;
  entriesTotal: number;
  entriesByStatus: Record<string, number>;
}

export interface TestConnectionResult {
  ok: boolean;
  mode: CredentialMode;
  latencyMs: number;
  identity?: string;
  error?: string;
}

export type EventChannelStatus = "disabled" | "connecting" | "connected" | "error";

export interface EventChannelState {
  status: EventChannelStatus;
  error?: string;
}

/** Server response is always redacted: tokens show first 6 + last 4 chars. */
export interface RedactedSettings {
  mode: CredentialMode;
  baseUrl: string;
  accessToken?: string;
  hasAccessToken: boolean;
  appId?: string;
  hasAppSecret: boolean;
  refreshToken?: string;
  hasRefreshToken: boolean;
  refreshTokenExpiresAt?: string;
  refreshSupported: boolean;
  larkCliBin?: string;
  authStatus: AuthStatus;
  authCheckedAt?: string;
  guideUrls: { user: string; tenant: string };
  envFallback: { hasAccessToken: boolean; hasAppCredentials: boolean; hasRefreshToken: boolean };
  /** Present when the server runs the drive event channel service. */
  eventChannel?: EventChannelState;
}

export interface SettingsSaveResult extends RedactedSettings {
  rebuilt: boolean;
  test: TestConnectionResult;
}

export interface CredentialPatch {
  mode?: CredentialMode;
  baseUrl?: string;
  accessToken?: string;
  appId?: string;
  appSecret?: string;
  refreshToken?: string;
  larkCliBin?: string;
}

export interface RootPatch {
  localPath?: string;
  remoteToken?: string;
  enabled?: boolean;
  pollIntervalMs?: number;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AppConfigPreferences {
  defaultPollIntervalMs: number;
  logLevel: LogLevel;
}

/** GET /api/app-config: global preferences plus the resolved storage paths. */
export interface AppConfigView {
  preferences: AppConfigPreferences;
  paths: { config: string; database: string };
}

export interface AppConfigPatch {
  defaultPollIntervalMs?: number;
  logLevel?: LogLevel;
}

export interface EntryContent {
  relativePath: string;
  content: string;
}

export interface PruneResult {
  operations: number;
  conflicts: number;
  snapshots: number;
}

export type ServerEvent =
  | { type: "connected" }
  | { type: "sync-started"; rootId: string }
  | { type: "sync"; rootId: string }
  | { type: "scan"; rootId: string }
  | { type: "error"; rootId?: string; entryId?: string; error: string }
  | { type: "auth-invalid" }
  | { type: "auth-restored" }
  | { type: "settings-updated" }
  | { type: "root-updated"; rootId: string }
  | { type: "conflict-resolved"; conflict: { id: string } }
  | { type: "conflict-aborted"; conflict: { id: string } }
  | { type: "maintenance-pruned"; operations: number; conflicts: number; snapshots: number };

/** One line of the live activity feed (issue workbench & history tab). */
export interface ActivityItem {
  at: string;
  kind: "sync-started" | "sync" | "scan" | "error" | "pruned" | "conflict" | "ignored";
  text: string;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  // Only set the JSON content-type when a body is present: body-less requests
  // (e.g. DELETE) carrying the header get rejected by Fastify with 400
  // FST_ERR_CTP_EMPTY_JSON_BODY, which broke root unbinding.
  const headers = init?.body ? { "content-type": "application/json" } : undefined;
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      /* keep statusText */
    }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function post<T>(url: string, body?: unknown): Promise<T> {
  return json<T>(url, { method: "POST", body: JSON.stringify(body ?? {}) });
}

export const api = {
  // roots
  listRoots: () => json<Root[]>("/api/roots"),
  createRoot: (input: { localPath: string; remoteToken: string; remoteType?: "folder" | "wiki"; pollIntervalMs?: number }) =>
    json<Root>("/api/roots", { method: "POST", body: JSON.stringify(input) }),
  patchRoot: (id: string, patch: RootPatch) =>
    json<Root>(`/api/roots/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteRoot: (id: string) => json<void>(`/api/roots/${id}`, { method: "DELETE" }),
  getTree: (id: string) => json<TreeResponse>(`/api/roots/${id}/tree`),
  getRootStats: (id: string) => json<RootStats>(`/api/roots/${id}/stats`),
  syncRoot: (id: string) => post(`/api/roots/${id}/sync`),
  // conflicts
  listConflicts: (status: "open" | "resolved" | "aborted" | "all" = "open") =>
    json<Conflict[]>(`/api/conflicts?status=${status}`),
  resolveConflict: (id: string, resolution: Resolution, mergedContent?: string) =>
    post<Conflict>(`/api/conflicts/${id}/resolve`, { resolution, mergedContent }),
  // history
  listOperations: () => json<Operation[]>("/api/operations"),
  prune: () => post<PruneResult>("/api/maintenance/prune"),
  // settings & credentials
  getSettings: () => json<RedactedSettings>("/api/settings"),
  saveSettings: (patch: CredentialPatch) =>
    json<SettingsSaveResult>("/api/settings", { method: "PUT", body: JSON.stringify(patch) }),
  testConnection: (patch?: CredentialPatch) => post<TestConnectionResult>("/api/settings/test-connection", patch ?? {}),
  // global preferences (config.json)
  getAppConfig: () => json<AppConfigView>("/api/app-config"),
  saveAppConfig: (patch: AppConfigPatch) =>
    json<AppConfigView>("/api/app-config", { method: "PUT", body: JSON.stringify(patch) }),
  // documents & assets
  getEntryContent: (entryId: string) => json<EntryContent>(`/api/entries/${entryId}/content`),
  restoreBase: (entryId: string) => post(`/api/entries/${entryId}/restore-base`),
  // issue workbench
  syncEntry: (entryId: string) => post<Entry>(`/api/entries/${entryId}/sync`),
  setEntryIgnored: (entryId: string, ignored: boolean) =>
    post<Entry>(`/api/entries/${entryId}/ignore`, { ignored }),
  syncMissing: (rootId: string) => post<{ rootId: string; synced: number; total: number }>(`/api/roots/${rootId}/sync-missing`),
  fileUrl: (rootId: string, relativePath: string) =>
    `/api/roots/${rootId}/file?path=${encodeURIComponent(relativePath)}`,
  assetUrl: (token: string) => `/api/assets/${encodeURIComponent(token)}`
};

/** Where to send the user to fix / renew credentials, per auth mode. */
export function authGuideUrl(settings: RedactedSettings): string {
  if (settings.mode === "tenant") {
    const base = settings.guideUrls.tenant.replace(/\/+$/, "");
    return settings.appId ? `${base}/${settings.appId}/baseinfo` : base;
  }
  return settings.guideUrls.user;
}

export const ENTRY_STATUS_LABELS: Record<EntryStatus, string> = {
  clean: "已同步",
  pending: "待同步",
  conflict: "冲突",
  orphan: "远端已删除",
  error: "失败",
  "local-missing": "本地缺失",
  "remote-missing": "远端缺失"
};

export const AUTH_STATUS_LABELS: Record<AuthStatus, string> = {
  ok: "凭证正常",
  invalid: "凭证失效",
  unconfigured: "未配置凭证"
};

export const EVENT_CHANNEL_LABELS: Record<EventChannelStatus, string> = {
  disabled: "未配置",
  connecting: "连接中",
  connected: "已连接",
  error: "连接失败"
};

export function formatDateTime(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

/** Human friendly "n minutes ago" style duration for polling countdowns. */
export function formatDuration(ms: number): string {
  if (ms <= 0) return "即将执行";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} 秒后`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟后`;
  return `${Math.floor(minutes / 60)} 小时后`;
}
