import React, { useEffect, useState } from "react";
import { AUTH_STATUS_LABELS, EVENT_CHANNEL_LABELS, formatDateTime, type CredentialMode, type CredentialPatch, type PruneResult, type RedactedSettings, type Root, type RootPatch, type TestConnectionResult } from "../api";

export const NOTIFY_STORAGE_KEY = "fsync.notify.enabled";

interface SettingsViewProps {
  settings?: RedactedSettings;
  roots: Root[];
  onSaveSettings: (patch: CredentialPatch) => Promise<void>;
  onTestConnection: (patch?: CredentialPatch) => Promise<TestConnectionResult>;
  onPatchRoot: (id: string, patch: RootPatch) => Promise<void>;
  onPrune: () => Promise<PruneResult>;
  onOpenGuide: () => void;
  notifyEnabled: boolean;
  onToggleNotify: (enabled: boolean) => void;
}

const MODE_LABELS: Record<CredentialMode, string> = {
  user: "用户 Token（个人授权）",
  tenant: "应用凭证（App ID + Secret）",
  cli: "lark-cli（本地 CLI）"
};

interface RootDraft {
  enabled: boolean;
  /** Kept as raw text so typing/clearing is never fought by the component;
   *  normalized on blur and validated again on save. */
  intervalSec: string;
}

export function SettingsView({ settings, roots, onSaveSettings, onTestConnection, onPatchRoot, onPrune, onOpenGuide, notifyEnabled, onToggleNotify }: SettingsViewProps): React.JSX.Element {
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

  const buildPatch = (): CredentialPatch => ({
    mode,
    baseUrl: baseUrl.trim(),
    accessToken,
    refreshToken: refreshToken || undefined,
    appId: appId.trim(),
    appSecret: appSecret || undefined,
    larkCliBin: larkCliBin.trim()
  });

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

  const toggleNotify = async (enabled: boolean) => {
    if (enabled && typeof Notification !== "undefined" && Notification.permission !== "granted") {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        onToggleNotify(false);
        setNotice("浏览器拒绝了通知权限，无法开启提醒。");
        return;
      }
    }
    onToggleNotify(enabled);
  };

  const authStatus = settings?.authStatus ?? "unconfigured";
  const authChecked = settings?.authCheckedAt;

  return <div className="settings-view">
    <div className="page-heading">
      <div><span className="eyebrow">WORKSPACE / SETTINGS</span><h2>设置</h2><p>凭证保存在本地 SQLite 中，保存后立即热生效，无需重启服务。</p></div>
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
        {mode !== "cli" && settings?.eventChannel && <p className="muted form-hint">实时事件推送：{EVENT_CHANNEL_LABELS[settings.eventChannel.status]}{settings.eventChannel.status === "error" && settings.eventChannel.error ? `（${settings.eventChannel.error}）` : ""}。{settings.eventChannel.status === "connected" ? "远端文档变更将即时触发同步，轮询作为兜底继续生效。" : "配置 App ID / App Secret 并在飞书开放平台开通事件订阅与云文档权限后，文档变更将实时推送，无需等待轮询。"}</p>}
        <div className="form-actions">
          <button className="secondary" disabled={busy} onClick={() => void runTest()}>测试联通</button>
          <button className="primary" disabled={busy} onClick={() => void save()}>保存并生效</button>
        </div>
        {test && <div className={`test-result ${test.ok ? "ok" : "fail"}`}>
          {test.ok ? `✓ 联通成功 · 身份：${test.identity ?? "未知"} · 延迟 ${test.latencyMs}ms` : `✗ 联通失败：${test.error ?? "未知错误"}`}
          {!test.ok && guideHintFor(test.mode, settings) && <a href={guideHintFor(test.mode, settings)} target="_blank" rel="noreferrer">前往 {test.mode === "tenant" ? "开发者后台" : "API 调试台"} ↗</a>}
        </div>}
        {notice && <div className="form-notice">{notice}</div>}
        <p className="muted form-hint">安全提示：token 以明文保存在本地数据库（{"/"}.data/sync.db），请确保该文件仅当前用户可读；API 永远不会返回完整凭证。</p>
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
      <div className="panel-heading"><div><h3>浏览器通知</h3><span className="muted">冲突与同步失败时弹出系统通知</span></div></div>
      <div className="settings-form">
        <label className="form-row checkbox-row">
          <input type="checkbox" checked={notifyEnabled} onChange={(event) => void toggleNotify(event.target.checked)} />
          <span>启用浏览器通知（冲突新增、解决、同步出错时提醒）</span>
        </label>
      </div>
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
