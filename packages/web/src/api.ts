export type CredentialMode = "user" | "tenant" | "cli";
export type AuthStatus = "ok" | "invalid" | "unconfigured";
/** "orphan" is legacy: the server reclassifies old rows on the next scan. */
export type EntryStatus = "clean" | "pending" | "conflict" | "orphan" | "error" | "local-missing" | "remote-missing";
export type ConflictStatus = "open" | "resolved" | "aborted";
export type Resolution = "local" | "remote" | "merged" | "abort";
/** Trigger source of a sync round, mirrored from the server contract. */
export type SyncTrigger = "manual" | "event" | "poll" | "watch";
/** Per-root sync direction policy; absent means bidirectional. */
export type SyncMode = "bidirectional" | "pull-only" | "push-only";
/** Semantic bucket of a failed operation, driving task-center guidance. */
export type ErrorCategory = "auth" | "conflict" | "network" | "permission" | "not_found" | "rate_limit" | "unknown";

export interface Root {
  id: string;
  localPath: string;
  remoteToken: string;
  remoteType: "folder" | "wiki";
  enabled: boolean;
  pollIntervalMs: number;
  /** Sync direction policy; absent means bidirectional. */
  mode?: SyncMode;
  /** Glob patterns excluded from the local scan and the file watcher. */
  exclude?: string[];
}

export interface Entry {
  /** Binding id used by every /api/entries/:id route (the server field name). */
  entryId: string;
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
  /** What kicked off this operation (manual/event/poll/watch). */
  trigger?: SyncTrigger;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  retryCount: number;
  /** Auto-retry ceiling; absent records default to 3. */
  maxRetries?: number;
  error?: string;
  /** Semantic failure bucket driving task-center guidance and retry policy. */
  errorCategory?: ErrorCategory;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  /** Joined server-side for history filtering. */
  rootId?: string;
  relativePath?: string;
}

/** Task-center status filter; "active" groups queued + running operations. */
export type TaskStatus = "active" | "queued" | "running" | "succeeded" | "failed" | "cancelled" | "all";

/** An operation joined with its entry kind for the task center. */
export interface TaskView extends Operation {
  kind?: "document" | "asset";
}

export interface TaskPage {
  tasks: TaskView[];
  nextCursor?: string;
}

/** GET /api/roots/validate-token result (B5 bind-form helper). */
export interface ValidateTokenResult {
  ok: boolean;
  type: "folder" | "wiki" | "document";
  token: string;
  name?: string;
  children?: number;
  error?: string;
  category?: ErrorCategory;
}

export interface ValidatePathResult {
  ok: boolean;
  path?: string;
  exists?: boolean;
  isDirectory?: boolean;
  /** Markdown files the first scan would pick up (after exclude patterns). */
  documents?: number;
  /** Images the first scan would pick up (after exclude patterns). */
  assets?: number;
  total?: number;
  exclude?: string[];
  /** Whether the service can write .feishu-sync/.git and pulled edits there. */
  writable?: boolean;
  error?: string;
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

/** GET /api/auth/feishu/authorize: consent-page URL plus the callback address
 *  that must be registered in the Feishu app's redirect-URL settings. */
export interface FeishuAuthorizeResult {
  url: string;
  redirectUri: string;
}

export interface RootPatch {
  localPath?: string;
  remoteToken?: string;
  enabled?: boolean;
  pollIntervalMs?: number;
  mode?: SyncMode;
  exclude?: string[];
}

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Per-category in-app notification toggles, stored server-side (B6.8). */
export interface NotificationPreferences {
  conflict: boolean;
  failure: boolean;
  credential: boolean;
}

export interface AppConfigPreferences {
  defaultPollIntervalMs: number;
  logLevel: LogLevel;
  notifications: NotificationPreferences;
}

/** GET /api/app-config: global preferences plus the resolved storage paths. */
export interface AppConfigView {
  preferences: AppConfigPreferences;
  paths: { config: string };
}

export interface AppConfigPatch {
  defaultPollIntervalMs?: number;
  logLevel?: LogLevel;
  /** Partial: only the named categories are flipped. */
  notifications?: Partial<NotificationPreferences>;
}

export interface EntryContent {
  relativePath: string;
  content: string;
}

/** One commit in a document's version timeline (B4). */
export interface Commit {
  hash: string;
  message: string;
  timestamp: string;
  trigger: SyncTrigger;
}

/** Two-ended content for a document diff (B4). against="baseline" or a commit. */
export interface EntryDiff {
  relativePath: string;
  against: string;
  baseContent: string;
  currentContent: string;
}

export interface PruneResult {
  operations: number;
  conflicts: number;
  snapshots: number;
}

/** A local directory ↔ remote folder mapping persisted in folders.json (B3). */
export interface FolderBinding {
  relativePath: string;
  remoteToken: string;
  createdAt: string;
  childCount: number;
}

export type ServerEvent =
  | { type: "connected" }
  | { type: "sync-started"; rootId: string; trigger: SyncTrigger; mode?: SyncMode }
  | { type: "sync"; rootId: string }
  | { type: "scan"; rootId: string }
  | { type: "operation-queued"; rootId: string; operation: Operation }
  | { type: "operation-started"; rootId: string; operation: Operation }
  | { type: "operation-completed"; rootId: string; operation: Operation }
  | { type: "operation-failed"; rootId: string; operation: Operation }
  | { type: "operation-retrying"; rootId: string; operation: Operation; delayMs: number; retryCount: number }
  | { type: "rate-limited"; rootId: string; operationId: string; retryAfterMs: number; retryCount: number }
  | { type: "operation-cancelled"; rootId: string; operation: Operation }
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
  kind: "sync-started" | "sync" | "scan" | "error" | "pruned" | "conflict" | "ignored" | "rate-limit";
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

/**
 * Read a *probe* answer. validate-path / validate-token ask a question ("can I
 * use this directory / token?"), so an HTTP 4xx is still a valid answer: the body
 * carries `ok:false` plus the structured flags (`exists`, `isDirectory`,
 * `writable`, `category`) that the bind form turns into Chinese. Routing probes
 * through `json()` threw those flags away and kept only the raw upstream string,
 * so an unusable path read "directory does not exist" in the UI. Only a body-less
 * failure (network error, non-JSON gateway page) still throws.
 */
async function probe<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = (await response.json().catch(() => undefined)) as T | undefined;
  if (body === undefined) {
    throw new Error(response.ok ? "探测未返回结果" : response.statusText || `探测失败（HTTP ${response.status}）`);
  }
  return body;
}

/** Build a query string from defined params only (skips undefined). */
function queryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export const api = {
  // roots
  listRoots: () => json<Root[]>("/api/roots"),
  createRoot: (input: { localPath: string; remoteToken: string; remoteType?: "folder" | "wiki"; pollIntervalMs?: number; mode?: SyncMode; exclude?: string[] }) =>
    json<Root>("/api/roots", { method: "POST", body: JSON.stringify(input) }),
  patchRoot: (id: string, patch: RootPatch) =>
    json<Root>(`/api/roots/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteRoot: (id: string) => json<void>(`/api/roots/${id}`, { method: "DELETE" }),
  getTree: (id: string) => json<TreeResponse>(`/api/roots/${id}/tree`),
  getRootStats: (id: string) => json<RootStats>(`/api/roots/${id}/stats`),
  syncRoot: (id: string, trigger?: SyncTrigger) => post(`/api/roots/${id}/sync`, trigger ? { trigger } : {}),
  validateToken: (token: string, type: "folder" | "wiki" | "document" = "folder") =>
    probe<ValidateTokenResult>(`/api/roots/validate-token${queryString({ token, type })}`),
  /** Local-directory counterpart of validateToken, used by the bind form (B5). */
  validatePath: (path: string, exclude?: string[]) =>
    probe<ValidatePathResult>(`/api/roots/validate-path${queryString({ path, exclude: exclude?.join("\n") })}`),
  // conflicts
  listConflicts: (status: "open" | "resolved" | "aborted" | "all" = "open") =>
    json<Conflict[]>(`/api/conflicts?status=${status}`),
  resolveConflict: (id: string, resolution: Resolution, mergedContent?: string) =>
    post<Conflict>(`/api/conflicts/${id}/resolve`, { resolution, mergedContent }),
  // history
  listOperations: (params: { rootId?: string; trigger?: SyncTrigger; errorCategory?: ErrorCategory; status?: Operation["status"]; limit?: number; cursor?: string } = {}) =>
    json<Operation[]>(`/api/operations${queryString(params)}`),
  // task center
  listTasks: (params: { status?: TaskStatus; rootId?: string; limit?: number; cursor?: string } = {}) =>
    json<TaskPage>(`/api/tasks${queryString(params)}`),
  retryTask: (id: string) => post<{ ok: boolean; operationId: string }>(`/api/tasks/${id}/retry`),
  cancelTask: (id: string) => post<{ ok: boolean; operationId: string }>(`/api/tasks/${id}/cancel`),
  batchRetryTasks: (operationIds: string[]) => post<{ accepted: number; total: number }>("/api/tasks/batch-retry", { operationIds }),
  /** Task center「清空已完成」— deletes finished records now, unlike `prune`
   *  which only trims by retention and so usually reports zero. */
  clearCompletedTasks: (statuses?: Array<"succeeded" | "cancelled" | "failed">) =>
    post<{ cleared: number }>("/api/tasks/clear-completed", statuses ? { statuses } : undefined),
  prune: () => post<PruneResult>("/api/maintenance/prune"),
  // settings & credentials
  getSettings: () => json<RedactedSettings>("/api/settings"),
  saveSettings: (patch: CredentialPatch) =>
    json<SettingsSaveResult>("/api/settings", { method: "PUT", body: JSON.stringify(patch) }),
  testConnection: (patch?: CredentialPatch) => post<TestConnectionResult>("/api/settings/test-connection", patch ?? {}),
  /** OAuth authorization-login: returns the Feishu consent page URL (the
   *  callback route exchanges the code and persists the refresh token). */
  authorizeFeishuOAuth: () => json<FeishuAuthorizeResult>("/api/auth/feishu/authorize"),
  // global preferences (config.json)
  getAppConfig: () => json<AppConfigView>("/api/app-config"),
  saveAppConfig: (patch: AppConfigPatch) =>
    json<AppConfigView>("/api/app-config", { method: "PUT", body: JSON.stringify(patch) }),
  /** In-memory remote API call tally since the server started (B6.2). */
  getApiStats: () => json<ApiStats>("/api/api-stats"),
  // documents & assets
  getEntryContent: (entryId: string) => json<EntryContent>(`/api/entries/${entryId}/content`),
  restoreBase: (entryId: string) => post(`/api/entries/${entryId}/restore-base`),
  // version history (B4)
  getEntryHistory: (rootId: string, path: string, limit?: number) =>
    json<Commit[]>(`/api/roots/${rootId}/history${queryString({ path, limit })}`),
  getEntryDiff: (entryId: string, against: string = "baseline") =>
    json<EntryDiff>(`/api/entries/${entryId}/diff${queryString({ against })}`),
  rollbackEntry: (entryId: string, commit: string) =>
    post<{ ok: boolean; entryId: string; relativePath: string }>(`/api/entries/${entryId}/rollback`, { commit }),
  // folder bindings (B3)
  listFolders: (rootId: string) => json<FolderBinding[]>(`/api/roots/${rootId}/folders`),
  rebindFolder: (rootId: string, relativePath: string, remoteToken: string) =>
    post<{ relativePath: string; remoteToken: string; createdAt: string }>(`/api/roots/${rootId}/folders/rebind`, { relativePath, remoteToken }),
  // issue workbench
  syncEntry: (entryId: string) => post<Entry>(`/api/entries/${entryId}/sync`),
  setEntryIgnored: (entryId: string, ignored: boolean) =>
    post<Entry>(`/api/entries/${entryId}/ignore`, { ignored }),
  /** Bulk retry / ignore / restore for a selection of entries (B6.3). */
  batchEntries: (entryIds: string[], action: "retry" | "ignore" | "unignore") =>
    post<{ accepted: number; total: number; failed: number }>("/api/entries/batch", { entryIds, action }),
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

export const SYNC_MODE_LABELS: Record<SyncMode, string> = {
  bidirectional: "双向同步",
  "pull-only": "仅拉取（远端→本地）",
  "push-only": "仅推送（本地→远端）"
};

export const TRIGGER_LABELS: Record<SyncTrigger, string> = {
  manual: "手动",
  event: "事件",
  poll: "轮询",
  watch: "本地监听"
};

export const ERROR_CATEGORY_LABELS: Record<ErrorCategory, string> = {
  auth: "凭证失效",
  conflict: "内容冲突",
  network: "网络异常",
  permission: "权限不足",
  not_found: "资源不存在",
  rate_limit: "触发限流",
  unknown: "未知错误"
};

export const DIRECTION_LABELS: Record<Operation["direction"], string> = {
  push: "上传",
  pull: "下载",
  merge: "合并"
};

export const OPERATION_STATUS_LABELS: Record<Operation["status"], string> = {
  queued: "排队中",
  running: "同步中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消"
};

/** Notification categories shown as individual switches in the settings (B6.8). */
export const NOTIFICATION_LABELS: Record<keyof NotificationPreferences, { label: string; hint: string }> = {
  conflict: { label: "冲突提醒", hint: "出现需要人工裁决的内容冲突时弹出提示" },
  failure: { label: "同步失败提醒", hint: "条目同步失败并耗尽自动重试时提示" },
  credential: { label: "凭证异常提醒", hint: "飞书凭证失效需要重新授权时提示" }
};

/** Fallback used before config.json resolves; mirrors the server default. */
export const DEFAULT_NOTIFICATIONS: NotificationPreferences = { conflict: true, failure: true, credential: true };

/** Per-method remote API counters behind the settings-page tally (B6.2). */
export interface ApiMethodStats {
  calls: number;
  failures: number;
  rateLimited: number;
  totalDurationMs: number;
}

export interface ApiStats {
  provider: string;
  startedAt: string;
  calls: number;
  failures: number;
  rateLimited: number;
  totalDurationMs: number;
  byMethod: Record<string, ApiMethodStats>;
}

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

/** Human-friendly rendering of a millisecond span (B6.6 durations, B6.2 tally). */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${Math.round(seconds % 60)} 秒`;
}

/** Elapsed between two ISO timestamps, human friendly (task/history duration). */
export function formatElapsed(startISO?: string, endISO?: string): string {
  if (!startISO || !endISO) return "—";
  const ms = new Date(endISO).getTime() - new Date(startISO).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return formatDurationMs(ms);
}
