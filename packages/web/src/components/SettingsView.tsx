import React, { useEffect, useState } from "react";
import { api, AUTH_STATUS_LABELS, EVENT_CHANNEL_LABELS, formatDateTime, formatDurationMs, NOTIFICATION_LABELS, type ApiStats, type AppConfigPatch, type AppConfigView, type CredentialMode, type CredentialPatch, type LogLevel, type NotificationPreferences, type PruneResult, type RedactedSettings, type Root, type RootPatch, type TestConnectionResult } from "../api";

/** Browser permission state labels for the notification section (B6.8). */
const PERMISSION_LABELS: Record<string, string> = {
  granted: "已授权",
  denied: "已拒绝（需在浏览器地址栏重新允许）",
  default: "未请求",
  unsupported: "当前浏览器不支持系统通知"
};

interface SettingsViewProps {
  settings?: RedactedSettings;
  appConfig?: AppConfigView;
  onSaveAppConfig: (patch: AppConfigPatch) => Promise<AppConfigView>;
  roots: Root[];
  onSaveSettings: (patch: CredentialPatch) => Promise<void>;
  onTestConnection: (patch?: CredentialPatch) => Promise<TestConnectionResult>;
  onPatchRoot: (id: string, patch: RootPatch) => Promise<void>;
  onPrune: () => Promise<PruneResult>;
  onOpenGuide: () => void;
  /** Server-side per-category notification toggles (B6.8). */
  notifications: NotificationPreferences;
  onToggleNotification: (category: keyof NotificationPreferences, enabled: boolean) => Promise<void>;
  /** Browser Notification permission, or "unsupported" where the API is absent. */
  notifyPermission: string;
  onRequestNotifyPermission: () => void;
}

const MODE_LABELS: Record<CredentialMode, string> = {
  user: "用户 Token（个人授权）",
  tenant: "应用凭证（App ID + Secret）",
  cli: "lark-cli（本地 CLI）"
};

const LOG_LEVEL_LABELS: Record<LogLevel, string> = {
  debug: "debug（最详细）",
  info: "info（默认）",
  warn: "warn（仅告警）",
  error: "error（仅错误）"
};

const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

interface RootDraft {
  enabled: boolean;
  /** Kept as raw text so typing/clearing is never fought by the component;
   *  normalized on blur and validated again on save. */
  intervalSec: string;
}

export function SettingsView({ settings, appConfig, onSaveAppConfig, roots, onSaveSettings, onTestConnection, onPatchRoot, onPrune, onOpenGuide, notifications, onToggleNotification, notifyPermission, onRequestNotifyPermission }: SettingsViewProps): React.JSX.Element {
  const [mode, setMode] = useState<CredentialMode>("user");
  const [baseUrl, setBaseUrl] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [larkCliBin, setLarkCliBin] = useState("");
  const [test, setTest] = useState<TestConnectionResult>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [rootDrafts, setRootDrafts] = useState<Record<string, RootDraft>>({});
  const [guideUrl, setGuideUrl] = useState<string>();
  // Collapsible step-by-step guide for the drive event subscription (P2).
  const [eventGuideOpen, setEventGuideOpen] = useState(false);
  // Global preferences draft: kept as raw text so typing is never fought,
  // normalized on save. Seeded once per config path.
  const [prefDraft, setPrefDraft] = useState<{ intervalSec: string; logLevel: LogLevel }>({ intervalSec: "15", logLevel: "info" });
  const [prefSeededFor, setPrefSeededFor] = useState<string>();
  const [prefBusy, setPrefBusy] = useState(false);
  const [prefNotice, setPrefNotice] = useState<string>();
  /** Category currently being persisted, so its switch shows a pending state. */
  const [notifyBusy, setNotifyBusy] = useState<keyof NotificationPreferences>();
  const [notifyNotice, setNotifyNotice] = useState<string>();
  /** Lightweight remote API call tally, refreshed on demand (B6.2). */
  const [apiStats, setApiStats] = useState<ApiStats>();
  const [statsBusy, setStatsBusy] = useState(false);
  const [statsNotice, setStatsNotice] = useState<string>();

  // Seed the form once settings arrive; afterwards the user's edits win.
  const [seededFor, setSeededFor] = useState<string>();
  useEffect(() => {
    if (!settings || seededFor === settings.mode + settings.baseUrl) return;
    setMode(settings.mode);
    setBaseUrl(settings.baseUrl);
    setAppId(settings.appId ?? "");
    setLarkCliBin(settings.larkCliBin ?? "");
    setSeededFor(settings.mode + settings.baseUrl);
  }, [settings, seededFor]);

  useEffect(() => {
    setRootDrafts(Object.fromEntries(roots.map((root) => [root.id, { enabled: root.enabled, intervalSec: String(Math.round(root.pollIntervalMs / 1000)) }])));
  }, [roots]);

  // Seed the preferences form once per resolved config path; afterwards the
  // user's edits win over server refreshes.
  useEffect(() => {
    if (!appConfig || prefSeededFor === appConfig.paths.config) return;
    setPrefDraft({
      intervalSec: String(Math.round(appConfig.preferences.defaultPollIntervalMs / 1000)),
      logLevel: appConfig.preferences.logLevel
    });
    setPrefSeededFor(appConfig.paths.config);
  }, [appConfig, prefSeededFor]);

  const savePreferences = async () => {
    setPrefBusy(true);
    setPrefNotice(undefined);
    try {
      const parsed = Number.parseInt(prefDraft.intervalSec, 10);
      const saved = await onSaveAppConfig({
        defaultPollIntervalMs: Number.isFinite(parsed) && parsed >= 1 ? parsed * 1000 : undefined,
        logLevel: prefDraft.logLevel
      });
      setPrefDraft({
        intervalSec: String(Math.round(saved.preferences.defaultPollIntervalMs / 1000)),
        logLevel: saved.preferences.logLevel
      });
      setPrefNotice("全局偏好已保存并立即生效。");
    } catch (error) {
      setPrefNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setPrefBusy(false);
    }
  };

  const buildPatch = (): CredentialPatch => ({
    mode,
    baseUrl: baseUrl.trim(),
    accessToken,
    refreshToken: refreshToken || undefined,
    appId: appId.trim(),
    appSecret: appSecret || undefined,
    larkCliBin: larkCliBin.trim()
  });

  /** Persist one notification category server-side (B6.8): the preference now
   *  follows the installation instead of a single browser's localStorage. */
  const toggleNotification = async (category: keyof NotificationPreferences, enabled: boolean) => {
    setNotifyBusy(category);
    setNotifyNotice(undefined);
    try {
      await onToggleNotification(category, enabled);
      setNotifyNotice(`「${NOTIFICATION_LABELS[category].label}」已${enabled ? "开启" : "关闭"}，已保存到服务端。`);
    } catch (error) {
      setNotifyNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setNotifyBusy(undefined);
    }
  };

  /** Fetch the in-memory API tally; counters reset when the service restarts. */
  const loadApiStats = async () => {
    setStatsBusy(true);
    setStatsNotice(undefined);
    try {
      setApiStats(await api.getApiStats());
    } catch (error) {
      setStatsNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setStatsBusy(false);
    }
  };

  useEffect(() => { void loadApiStats(); }, []);

  const runTest = async () => {
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await onTestConnection(buildPatch());
      setTest(result);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setNotice(undefined);
    try {
      await onSaveSettings(buildPatch());
      setAccessToken("");
      setRefreshToken("");
      setAppSecret("");
      setNotice("已保存并热生效，服务端已自动重测联通。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const prune = async () => {
    if (!window.confirm("清理过期的操作记录与已解决冲突？（保留最近 1000 条操作，30 天内的已解决冲突）")) return;
    try {
      const result = await onPrune();
      setNotice(`已清理 ${result.operations} 条操作记录、${result.conflicts} 条冲突、${result.snapshots} 个孤儿快照。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const saveRoot = async (root: Root) => {
    const draft = rootDrafts[root.id];
    if (!draft) return;
    const intervalSec = Math.max(1, Number.parseInt(draft.intervalSec, 10) || Math.round(root.pollIntervalMs / 1000));
    try {
      await onPatchRoot(root.id, { enabled: draft.enabled, pollIntervalMs: intervalSec * 1000 });
      setRootDrafts((current) => ({ ...current, [root.id]: { ...draft, intervalSec: String(intervalSec) } }));
      setNotice(`同步计划已更新：${root.localPath}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const authStatus = settings?.authStatus ?? "unconfigured";
  const authChecked = settings?.authCheckedAt;

  return <div className="settings-view">
    <div className="page-heading">
      <div><span className="eyebrow">WORKSPACE / SETTINGS</span><h2>设置</h2><p>凭证与全局偏好保存在 ~/.feishu-sync-docs/，保存后立即热生效，无需重启服务。</p></div>
      {settings && authStatus !== "ok" && <button className="danger-ghost" onClick={onOpenGuide}>{authStatus === "invalid" ? "凭证已失效，打开修复引导" : "配置凭证引导"}</button>}
    </div>

    <div className="panel settings-panel">
      <div className="panel-heading">
        <div><h3>飞书凭证</h3><span className="muted">{AUTH_STATUS_LABELS[authStatus]}{authChecked ? ` · 上次检测 ${formatDateTime(authChecked)}` : ""}</span></div>
        {settings && <span className={`auth-badge ${authStatus}`}>{authStatus === "ok" ? "正常" : authStatus === "invalid" ? "失效" : "未配置"}</span>}
      </div>
      <div className="settings-form">
        <label className="form-row">
          <span>认证方式</span>
          <select value={mode} onChange={(event) => setMode(event.target.value as CredentialMode)}>
            {(Object.keys(MODE_LABELS) as CredentialMode[]).map((key) => <option key={key} value={key}>{MODE_LABELS[key]}</option>)}
          </select>
        </label>
        {mode !== "cli" && <label className="form-row">
          <span>API 地址</span>
          <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://open.feishu.cn" />
        </label>}
        {mode === "user" && <>
          <label className="form-row">
            <span>User Access Token</span>
            <input type="password" value={accessToken} onChange={(event) => setAccessToken(event.target.value)} placeholder={settings?.hasAccessToken ? `已保存（${settings.accessToken}）` : "粘贴从飞书开放平台获取的 user token"} />
          </label>
          <label className="form-row">
            <span>Refresh Token（可选，启用自动刷新）</span>
            <input type="password" value={refreshToken} onChange={(event) => setRefreshToken(event.target.value)} placeholder={settings?.hasRefreshToken ? `已保存（${settings.refreshToken}）` : "粘贴 OAuth 获取的 refresh_token，user token 过期前将自动续期"} />
          </label>
          <label className="form-row">
            <span>App ID（自动刷新用）</span>
            <input value={appId} onChange={(event) => setAppId(event.target.value)} placeholder="cli_xxxx（配套 refresh token 使用）" />
          </label>
          <label className="form-row">
            <span>App Secret（自动刷新用）</span>
            <input type="password" value={appSecret} onChange={(event) => setAppSecret(event.target.value)} placeholder={settings?.hasAppSecret ? "已保存（留空则不修改）" : "应用密钥"} />
          </label>
          {settings?.hasRefreshToken && settings.refreshSupported && <p className="muted form-hint">自动刷新已就绪{settings.refreshTokenExpiresAt ? `，当前 refresh token 过期于 ${formatDateTime(settings.refreshTokenExpiresAt)}（每次刷新自动续期 7 天；若服务停摆超过 7 天需重新授权）` : "，首次刷新后会记录有效期"}。</p>}
          {settings?.hasRefreshToken && !settings.refreshSupported && <p className="muted form-hint">已保存 refresh token，但缺少 App ID / App Secret，暂无法自动刷新；请补充应用凭证（应用需开通 offline_access 权限）。</p>}
        </>}
        {mode === "tenant" && <>
          <label className="form-row">
            <span>App ID</span>
            <input value={appId} onChange={(event) => setAppId(event.target.value)} placeholder="cli_xxxx" />
          </label>
          <label className="form-row">
            <span>App Secret</span>
            <input type="password" value={appSecret} onChange={(event) => setAppSecret(event.target.value)} placeholder={settings?.hasAppSecret ? "已保存（留空则不修改）" : "应用密钥"} />
          </label>
        </>}
        {mode === "cli" && <label className="form-row">
          <span>lark-cli 可执行文件</span>
          <input value={larkCliBin} onChange={(event) => setLarkCliBin(event.target.value)} placeholder={settings?.larkCliBin || "留空使用 PATH 中的 lark-cli"} />
        </label>}
        {settings && (settings.envFallback.hasAccessToken || settings.envFallback.hasAppCredentials || settings.envFallback.hasRefreshToken) && (
          <p className="muted form-hint">检测到环境变量凭证（{[settings.envFallback.hasAccessToken ? "FEISHU_ACCESS_TOKEN" : "", settings.envFallback.hasRefreshToken ? "FEISHU_REFRESH_TOKEN" : "", settings.envFallback.hasAppCredentials ? "FEISHU_APP_ID/SECRET" : ""].filter(Boolean).join("、")}）。此处保存的设置优先于环境变量。</p>
        )}
        {mode !== "cli" && settings?.eventChannel && <>
          <p className="muted form-hint">
            实时事件推送：{EVENT_CHANNEL_LABELS[settings.eventChannel.status]}{settings.eventChannel.status === "error" && settings.eventChannel.error ? `（${settings.eventChannel.error}）` : ""}。{settings.eventChannel.status === "connected" ? "远端文档变更将即时触发同步，轮询作为兜底继续生效。" : "配置 App ID / App Secret 并在飞书开放平台开通事件订阅与云文档权限后，文档变更将实时推送，无需等待轮询。"}
            {" "}<button className="link-button" onClick={() => setEventGuideOpen((open) => !open)}>{eventGuideOpen ? "收起配置指引" : "查看配置指引"}</button>
          </p>
          {settings.eventChannel.status === "error" && eventErrorHints(settings.eventChannel.error).length > 0 && <ul className="event-troubleshoot">
            {eventErrorHints(settings.eventChannel.error).map((hint, index) => <li key={index}>{hint}</li>)}
          </ul>}
          {eventGuideOpen && <ol className="event-guide">
            <li><strong>创建企业自建应用</strong>：进入 <a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer">飞书开发者后台 ↗</a>，创建一个企业自建应用并记录 App ID / App Secret。</li>
            <li><strong>开通云空间文档权限</strong>：在应用的「权限管理」中申请云文档相关权限（如 <code>docx:document</code>、<code>drive:drive</code>），供读取与写入文档使用。</li>
            <li><strong>事件订阅选「长连接」并订阅 drive 文件事件</strong>：在「事件与回调」页将接收方式切换为<strong>使用长连接接收事件</strong>，并订阅云文档 drive 文件事件（drive.file.* 系列），无需公网回调地址。</li>
            <li><strong>发布版本</strong>：在「版本管理与发布」中创建版本并发布应用；事件订阅只有在版本发布后才会生效。</li>
            <li><strong>回填 App ID / App Secret</strong>：回到本页填写并「保存并生效」，服务会自动建立长连接；状态变为「已连接」即配置成功，轮询仍作为兜底继续运行。</li>
          </ol>}
        </>}
        <div className="form-actions">
          <button className="secondary" disabled={busy} onClick={() => void runTest()}>测试联通</button>
          <button className="primary" disabled={busy} onClick={() => void save()}>保存并生效</button>
        </div>
        {test && <div className={`test-result ${test.ok ? "ok" : "fail"}`}>
          {test.ok ? `✓ 联通成功 · 身份：${test.identity ?? "未知"} · 延迟 ${test.latencyMs}ms` : `✗ 联通失败：${test.error ?? "未知错误"}`}
          {!test.ok && guideHintFor(test.mode, settings) && <a href={guideHintFor(test.mode, settings)} target="_blank" rel="noreferrer">前往 {test.mode === "tenant" ? "开发者后台" : "API 调试台"} ↗</a>}
        </div>}
        {notice && <div className="form-notice">{notice}</div>}
        <p className="muted form-hint">安全提示：token 以明文保存在本地配置文件（~/.feishu-sync-docs/config.json，权限 0600），请确保该目录仅当前用户可读；API 永远不会返回完整凭证。</p>
      </div>
    </div>

    <div className="panel settings-panel">
      <div className="panel-heading"><div><h3>全局偏好</h3><span className="muted">保存在 config.json，对所有根目录默认生效</span></div></div>
      <div className="settings-form">
        <label className="form-row">
          <span>默认轮询间隔（秒）</span>
          <input
            className="interval-input"
            type="number"
            min={1}
            value={prefDraft.intervalSec}
            onChange={(event) => setPrefDraft((current) => ({ ...current, intervalSec: event.target.value }))}
            onBlur={(event) => {
              // Normalize only when the field is left: empty or invalid input
              // falls back to the server-side default.
              const fallback = appConfig ? String(Math.round(appConfig.preferences.defaultPollIntervalMs / 1000)) : "15";
              const parsed = Number.parseInt(event.target.value, 10);
              const normalized = Number.isFinite(parsed) && parsed >= 1 ? String(parsed) : fallback;
              if (event.target.value === normalized) return;
              setPrefDraft((current) => ({ ...current, intervalSec: normalized }));
            }}
          />
        </label>
        <label className="form-row">
          <span>日志级别</span>
          <select value={prefDraft.logLevel} onChange={(event) => setPrefDraft((current) => ({ ...current, logLevel: event.target.value as LogLevel }))}>
            {LOG_LEVELS.map((level) => <option key={level} value={level}>{LOG_LEVEL_LABELS[level]}</option>)}
          </select>
        </label>
        <p className="muted form-hint">SYNC_LOG_LEVEL 环境变量优先于这里的日志级别；绑定根目录时留空轮询间隔将使用默认值。配置文件：{appConfig?.paths.config ?? "~/.feishu-sync-docs/config.json"}。</p>
        <div className="form-actions">
          <button className="primary" disabled={prefBusy} onClick={() => void savePreferences()}>保存偏好</button>
        </div>
        {prefNotice && <div className="form-notice">{prefNotice}</div>}
      </div>
    </div>

    <div className="panel settings-panel">
      <div className="panel-heading"><div><h3>同步计划</h3><span className="muted">修改间隔或启停后立即对监听与轮询生效，无需重启</span></div></div>
      {roots.length === 0 ? <div className="empty-state"><div className="check">✓</div><strong>还没有同步根目录</strong><span>在仪表盘绑定根目录后，可以在这里调整同步节奏。</span></div>
        : <table className="op-table">
          <thead><tr><th>本地目录</th><th>启用</th><th>轮询间隔（秒）</th><th>操作</th></tr></thead>
          <tbody>
            {roots.map((root) => {
              const draft = rootDrafts[root.id];
              return <tr key={root.id}>
                <td data-label="本地目录">{root.localPath}<small className="muted"> ↔ {root.remoteToken}</small></td>
                <td data-label="启用"><input type="checkbox" checked={draft?.enabled ?? root.enabled} onChange={(event) => setRootDrafts((current) => ({ ...current, [root.id]: { ...(current[root.id] ?? { intervalSec: String(Math.round(root.pollIntervalMs / 1000)), enabled: root.enabled }), enabled: event.target.checked } }))} /></td>
                <td data-label="轮询间隔（秒）"><input
                  className="interval-input"
                  type="number"
                  min={1}
                  value={draft?.intervalSec ?? String(Math.round(root.pollIntervalMs / 1000))}
                  onChange={(event) => setRootDrafts((current) => ({ ...current, [root.id]: { ...(current[root.id] ?? { enabled: root.enabled, intervalSec: String(Math.round(root.pollIntervalMs / 1000)) }), intervalSec: event.target.value } }))}
                  onBlur={(event) => {
                    // Normalize only when the field is left: empty or invalid
                    // input falls back to the current server-side value.
                    const parsed = Number.parseInt(event.target.value, 10);
                    const fallback = String(Math.round(root.pollIntervalMs / 1000));
                    const normalized = Number.isFinite(parsed) && parsed >= 1 ? String(parsed) : fallback;
                    if (event.target.value === normalized) return;
                    setRootDrafts((current) => ({ ...current, [root.id]: { ...(current[root.id] ?? { enabled: root.enabled, intervalSec: normalized }), intervalSec: normalized } }));
                  }}
                /></td>
                <td><button className="secondary" onClick={() => void saveRoot(root)}>应用</button></td>
              </tr>;
            })}
          </tbody>
        </table>}
    </div>

    <div className="panel settings-panel">
      <div className="panel-heading"><div><h3>通知偏好</h3><span className="muted">按类别开关，保存在服务端 config.json，换浏览器也跟随生效</span></div></div>
      <div className="settings-form">
        {(Object.keys(NOTIFICATION_LABELS) as Array<keyof NotificationPreferences>).map((category) => (
          <label className="form-row checkbox-row" key={category}>
            <input
              type="checkbox"
              checked={notifications[category]}
              disabled={notifyBusy === category}
              onChange={(event) => void toggleNotification(category, event.target.checked)}
            />
            <span>{NOTIFICATION_LABELS[category].label}<small className="muted">{NOTIFICATION_LABELS[category].hint}</small></span>
          </label>
        ))}
        <div className="form-row">
          <span className="form-label">浏览器系统通知权限</span>
          <div className="rebind-row">
            <span className={`notify-permission ${notifyPermission}`}>{PERMISSION_LABELS[notifyPermission] ?? notifyPermission}</span>
            {notifyPermission !== "granted" && notifyPermission !== "unsupported" && <button className="secondary" onClick={onRequestNotifyPermission}>请求通知权限</button>}
          </div>
          <span className="muted">关闭某一类后，该类事件不再弹出系统通知；页面内的徽章、任务中心与异常工作台仍会展示。本版本不提供通知声音。</span>
        </div>
        {notifyNotice && <div className="form-notice">{notifyNotice}</div>}
      </div>
    </div>

    <div className="panel settings-panel">
      <div className="panel-heading">
        <div><h3>API 调用统计</h3><span className="muted">自服务启动以来的飞书接口调用计数，用于判断是否正在被限流</span></div>
        <button className="secondary" disabled={statsBusy} onClick={() => void loadApiStats()}>{statsBusy ? "刷新中…" : "刷新"}</button>
      </div>
      {apiStats && <div className="api-stats">
        <div className="overview-grid">
          <div className="metric"><span>调用总数</span><strong>{apiStats.calls}</strong><small>{apiStats.provider}</small></div>
          <div className="metric"><span>失败</span><strong>{apiStats.failures}</strong></div>
          <div className={`metric${apiStats.rateLimited > 0 ? " warning" : ""}`}><span>429 限流</span><strong>{apiStats.rateLimited}</strong><small>命中后按 Retry-After 退避重试</small></div>
          <div className="metric"><span>累计耗时</span><strong className="metric-time">{formatDurationMs(apiStats.totalDurationMs)}</strong></div>
        </div>
        {Object.keys(apiStats.byMethod).length > 0
          ? <table className="op-table">
            <thead><tr><th>接口</th><th>调用</th><th>失败</th><th>限流</th><th>累计耗时</th></tr></thead>
            <tbody>
              {Object.entries(apiStats.byMethod).map(([method, stats]) => (
                <tr key={method}>
                  <td data-label="接口"><code>{method}</code></td>
                  <td data-label="调用" className="muted">{stats.calls}</td>
                  <td data-label="失败" className="muted">{stats.failures}</td>
                  <td data-label="限流" className="muted">{stats.rateLimited}</td>
                  <td data-label="累计耗时" className="muted">{formatDurationMs(stats.totalDurationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          : <p className="muted form-hint">尚未调用过飞书接口。绑定根目录并执行一次同步后，这里会按接口列出调用次数、失败数与耗时。</p>}
        <p className="muted form-hint">统计仅保存在内存中，服务重启后归零；本轮计数开始于 {formatDateTime(apiStats.startedAt)}。限流发生时顶栏会出现徽章，任务中心与历史页会记录退避重试。</p>
      </div>}
      {!apiStats && <p className="muted form-hint">{statsNotice ? "统计读取失败，请点击右上角「刷新」重试。" : "正在读取 API 调用统计…"}</p>}
      {statsNotice && <div className="form-notice">{statsNotice}</div>}
    </div>

    <div className="panel settings-panel">
      <div className="panel-heading"><div><h3>维护</h3><span className="muted">历史记录保留策略可控制数据库体积</span></div></div>
      <div className="settings-form">
        <div className="form-actions">
          <button className="danger-ghost" onClick={() => void prune()}>清理历史记录</button>
          <button className="secondary" onClick={onOpenGuide}>查看凭证修复引导</button>
        </div>
        {notice && <div className="form-notice">{notice}</div>}
      </div>
    </div>
  </div>;
}

function guideHintFor(mode: CredentialMode, settings?: RedactedSettings): string | undefined {
  if (!settings) return undefined;
  if (mode === "tenant") return settings.guideUrls.tenant;
  if (mode === "user") return settings.guideUrls.user;
  return undefined;
}

/** Troubleshooting hints for a failed event channel, derived from the error
 *  message so the most likely cause is listed first (P2). */
export function eventErrorHints(error?: string): string[] {
  const message = (error ?? "").toLowerCase();
  const hints: string[] = [];
  if (/subscri|事件未订阅|no event|not.*event/.test(message)) hints.push("应用可能尚未订阅云文档 drive 文件事件：在开发者后台「事件与回调」中订阅 drive.file.* 事件并重新发布版本。");
  if (/permission|权限|forbidden|denied/.test(message)) hints.push("云文档权限可能未开通：检查应用的 drive / docx 权限范围，开通后需重新发布版本。");
  if (/publish|发布|version|not exist|不存在|notexist/.test(message)) hints.push("应用或事件订阅可能尚未发布：事件订阅需要在版本发布后才会生效。");
  if (/app_id|app_secret|invalid|unauthorized|凭证|secret/.test(message)) hints.push("App ID / App Secret 校验失败：确认凭证来自同一个企业自建应用且未被重置。");
  if (/network|fetch|timeout|econn|socket|dns|超时|网络/.test(message)) hints.push("服务无法连接飞书长连接网关：检查服务器网络、代理与防火墙出站规则。");
  if (hints.length === 0) hints.push("请依次检查：事件是否已订阅、应用版本是否已发布、App ID / App Secret 是否正确、服务器网络是否能访问飞书。");
  return hints;
}
