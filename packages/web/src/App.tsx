import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type ActivityItem,
  type AppConfigPatch,
  type AppConfigView,
  type Conflict,
  type CredentialPatch,
  type Operation,
  type PruneResult,
  type RedactedSettings,
  type Resolution,
  type Root,
  type RootPatch,
  type RootStats,
  type ServerEvent,
  type TestConnectionResult,
  type TreeResponse
} from "./api";
import { Dashboard } from "./components/Dashboard";
import { GuideModal } from "./components/GuideModal";
import { RootDetail, type DetailTab } from "./components/RootDetail";
import { NOTIFY_STORAGE_KEY, SettingsView } from "./components/SettingsView";
import { Icon, type IconName } from "./components/Icon";
import "./styles.css";

/** Primary views (nav items). The root detail page is reached from the dashboard. */
type View = "dashboard" | "detail" | "settings";
type NavView = "dashboard" | "settings";

const VIEW_LABELS: Record<NavView, string> = {
  dashboard: "仪表盘",
  settings: "设置"
};

/** Compact labels for the mobile tab bar. */
const TAB_LABELS: Record<NavView, string> = {
  dashboard: "仪表盘",
  settings: "设置"
};

const VIEW_ICONS: Record<NavView, IconName> = {
  dashboard: "dashboard",
  settings: "settings"
};

const NAV_VIEWS = Object.keys(VIEW_LABELS) as NavView[];

const AUTH_BADGE: Record<string, { label: string; className: string }> = {
  ok: { label: "凭证正常", className: "ok" },
  invalid: { label: "凭证失效", className: "invalid" },
  unconfigured: { label: "未配置", className: "unconfigured" }
};

function rootName(root: Root): string {
  return root.localPath.split(/[\\/]/).at(-1) ?? root.localPath;
}

/** Short display form for ids inside activity texts. */
function shortRootId(id: string): string {
  return id.slice(0, 8);
}

export function App(): React.JSX.Element {
  const [view, setView] = useState<View>("dashboard");
  const [roots, setRoots] = useState<Root[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [tree, setTree] = useState<TreeResponse>();
  const [operations, setOperations] = useState<Operation[]>([]);
  const [settings, setSettings] = useState<RedactedSettings>();
  const [appConfig, setAppConfig] = useState<AppConfigView>();
  const [stats, setStats] = useState<RootStats>();
  const [rootStats, setRootStats] = useState<Record<string, RootStats>>({});
  const [selectedRootId, setSelectedRootId] = useState<string | undefined>();
  const [initialTab, setInitialTab] = useState<DetailTab>("docs");
  const [message, setMessage] = useState("正在连接服务...");
  const [syncing, setSyncing] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [live, setLive] = useState(false);
  const [notifyEnabled, setNotifyEnabled] = useState(() => window.localStorage.getItem(NOTIFY_STORAGE_KEY) === "1");
  const [newLocalPath, setNewLocalPath] = useState("");
  const [newRemoteToken, setNewRemoteToken] = useState("");
  const [newRemoteType, setNewRemoteType] = useState<"folder" | "wiki">("folder");
  const [newIntervalSec, setNewIntervalSec] = useState("");
  /** Roots with a sync round in flight (from sync-started until sync/error). */
  const [runningRoots, setRunningRoots] = useState<ReadonlySet<string>>(new Set());
  /** Live activity feed shown in the issue workbench and history tab. */
  const [activity, setActivity] = useState<ActivityItem[]>([]);

  const pushActivity = useCallback((item: Omit<ActivityItem, "at">) => {
    setActivity((current) => [{ ...item, at: new Date().toISOString() }, ...current].slice(0, 50));
  }, []);

  const setRootRunning = useCallback((rootId: string, running: boolean) => {
    setRunningRoots((current) => {
      if (running === current.has(rootId)) return current;
      const next = new Set(current);
      if (running) next.add(rootId); else next.delete(rootId);
      return next;
    });
  }, []);

  // Poll-critical values live in refs so `refresh` stays referentially stable
  // (a changing callback used to tear down / reopen the WebSocket in a loop).
  const viewRef = useRef<View>(view);
  useEffect(() => { viewRef.current = view; }, [view]);
  const selectedRootRef = useRef<string | undefined>(undefined);
  useEffect(() => { selectedRootRef.current = selectedRootId; }, [selectedRootId]);
  const notifyEnabledRef = useRef(notifyEnabled);
  useEffect(() => { notifyEnabledRef.current = notifyEnabled; }, [notifyEnabled]);
  const conflictCountRef = useRef(0);

  const notify = useCallback((title: string, body: string) => {
    if (!notifyEnabledRef.current || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    try { new Notification(title, { body }); } catch { /* some browsers require SW */ }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const currentView = viewRef.current;
      const currentRoot = selectedRootRef.current;
      const [nextRoots, nextConflicts, nextSettings, nextAppConfig] = await Promise.all([
        api.listRoots(),
        api.listConflicts("open"),
        api.getSettings(),
        api.getAppConfig().catch(() => undefined)
      ]);
      setRoots(nextRoots);
      setConflicts(nextConflicts);
      setSettings(nextSettings);
      if (nextAppConfig) setAppConfig(nextAppConfig);
      setMessage("服务正常");

      if (currentView === "detail" && currentRoot) {
        // Detail page: tree + stats + operations for the three tabs.
        const [nextTree, nextStats, nextOperations] = await Promise.all([
          api.getTree(currentRoot).catch(() => undefined),
          api.getRootStats(currentRoot).catch(() => undefined),
          api.listOperations().catch(() => [] as Operation[])
        ]);
        if (nextTree) setTree(nextTree);
        if (nextStats) setStats(nextStats);
        setOperations(nextOperations);
      } else if (currentView === "dashboard") {
        // Dashboard: per-root card summaries (no tree needed).
        const entries = await Promise.all(nextRoots.map(async (root) => {
          try { return [root.id, await api.getRootStats(root.id)] as const; } catch { return undefined; }
        }));
        const map: Record<string, RootStats> = {};
        entries.forEach((item) => { if (item) map[item[0]] = item[1]; });
        setRootStats(map);
      }

      // Browser notification when the open-conflict count grows.
      if (nextConflicts.length > conflictCountRef.current) {
        const fresh = nextConflicts[nextConflicts.length - 1];
        notify("发现新冲突", fresh?.relativePath ? `${fresh.relativePath} 需要处理` : "冲突工作台有待处理项");
      }
      conflictCountRef.current = nextConflicts.length;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [notify]);

  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 5000); return () => window.clearInterval(timer); }, [refresh]);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/events`);
    socket.onmessage = (event) => {
      let payload: ServerEvent | undefined;
      try { payload = JSON.parse(String(event.data)) as ServerEvent; } catch { /* ignore */ }
      void refresh();
      if (!payload) return;
      if (payload.type === "sync-started") {
        setRootRunning(payload.rootId, true);
        pushActivity({ kind: "sync-started", text: `根目录 ${shortRootId(payload.rootId)} 开始检测远端变更与本地差异` });
      }
      if (payload.type === "sync") {
        setRootRunning(payload.rootId, false);
        pushActivity({ kind: "sync", text: `根目录 ${shortRootId(payload.rootId)} 一轮同步结束` });
      }
      if (payload.type === "scan") {
        setRootRunning(payload.rootId, false);
        pushActivity({ kind: "scan", text: `根目录 ${shortRootId(payload.rootId)} 完成远端检测` });
      }
      if (payload.type === "error") {
        if (payload.rootId) setRootRunning(payload.rootId, false);
        pushActivity({ kind: "error", text: payload.entryId ? `条目 ${shortRootId(payload.entryId)} 同步失败：${payload.error}` : `同步出错：${payload.error}` });
      }
      if (payload.type === "maintenance-pruned") {
        pushActivity({ kind: "pruned", text: `维护清理完成：${payload.operations} 条操作、${payload.conflicts} 条冲突、${payload.snapshots} 个快照` });
      }
      if (payload.type === "conflict-resolved") pushActivity({ kind: "conflict", text: "冲突已解决，合并结果写入本地与飞书" });
      if (payload.type === "conflict-aborted") pushActivity({ kind: "conflict", text: "冲突已搁置，等待下次变更重新评估" });
      if (payload.type === "auth-invalid") {
        setGuideOpen(true);
        notify("飞书凭证已失效", "同步已暂停，点击页面顶部徽章更新凭证");
      }
      if (payload.type === "auth-restored") notify("飞书凭证已恢复", "同步继续进行");
      if (payload.type === "conflict-resolved") notify("冲突已解决", "合并结果已写入本地与飞书");
      if (payload.type === "error") notify("同步出错", payload.error);
    };
    socket.onopen = () => { setLive(true); setMessage("实时连接已建立"); };
    socket.onclose = () => { setLive(false); setMessage("实时连接已断开，使用轮询"); };
    return () => socket.close();
  }, [refresh, notify, pushActivity, setRootRunning]);

  // Reload view-specific data when the view or inspected root changes.
  useEffect(() => { void refresh(); }, [view, selectedRootId, refresh]);

  // If the inspected root disappears (e.g. deleted elsewhere), fall back to the dashboard.
  useEffect(() => {
    if (view === "detail" && selectedRootId && !roots.some((root) => root.id === selectedRootId)) {
      setSelectedRootId(undefined);
      setView("dashboard");
    }
  }, [view, selectedRootId, roots]);

  const openRoot = (rootId: string, tab: DetailTab = "docs") => {
    // Drop stale detail data from a previously inspected root.
    setTree(undefined);
    setStats(undefined);
    setOperations([]);
    setInitialTab(tab);
    setSelectedRootId(rootId);
    setView("detail");
  };

  const closeRoot = () => {
    setSelectedRootId(undefined);
    setTree(undefined);
    setStats(undefined);
    setOperations([]);
    setView("dashboard");
  };

  const addRoot = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newLocalPath || !newRemoteToken) return;
    const interval = Number.parseInt(newIntervalSec, 10);
    try {
      const root = await api.createRoot({
        localPath: newLocalPath,
        remoteToken: newRemoteToken,
        remoteType: newRemoteType,
        pollIntervalMs: Number.isFinite(interval) && interval >= 1 ? interval * 1000 : undefined
      });
      setNewLocalPath("");
      setNewRemoteToken("");
      setNewIntervalSec("");
      setAddOpen(false);
      await refresh();
      openRoot(root.id);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const syncEntryNow = async (entryId: string) => {
    try {
      await api.syncEntry(entryId);
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const setEntryIgnored = async (entryId: string, ignored: boolean) => {
    try {
      await api.setEntryIgnored(entryId, ignored);
      pushActivity({ kind: "ignored", text: `条目 ${shortRootId(entryId)} ${ignored ? "已忽略，不再评估" : "已恢复评估"}` });
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const syncMissing = async (rootId: string): Promise<number> => {
    try {
      const result = await api.syncMissing(rootId);
      setMessage(`已同步 ${result.synced}/${result.total} 条缺失条目`);
      await refresh();
      return result.synced;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      return 0;
    }
  };

  const resolveConflict = async (id: string, resolution: Resolution, mergedContent?: string) => {
    try {
      await api.resolveConflict(id, resolution, mergedContent);
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const syncNow = async (rootId?: string) => {
    const targets = rootId ? [rootId] : roots.map((root) => root.id);
    if (targets.length === 0) return;
    setSyncing(true);
    try {
      await Promise.all(targets.map((id) => api.syncRoot(id)));
      setMessage("同步完成");
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setSyncing(false); }
  };

  const deleteRoot = async (root: Root) => {
    if (!window.confirm(`放弃同步「${root.localPath}」？本地文件会保留，但服务端将删除该根目录及其同步记录。`)) return;
    try {
      await api.deleteRoot(root.id);
      if (selectedRootRef.current === root.id) closeRoot();
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const toggleRoot = async (rootId: string, enabled: boolean) => {
    try {
      await api.patchRoot(rootId, { enabled });
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const saveSettings = async (patch: CredentialPatch) => {
    const saved = await api.saveSettings(patch);
    setSettings(saved);
  };

  const saveAppConfig = async (patch: AppConfigPatch): Promise<AppConfigView> => {
    const saved = await api.saveAppConfig(patch);
    setAppConfig(saved);
    return saved;
  };

  const testConnection = (patch?: CredentialPatch): Promise<TestConnectionResult> => api.testConnection(patch);

  const patchRoot = async (id: string, patch: RootPatch) => {
    await api.patchRoot(id, patch);
    await refresh();
  };

  const pruneHistory = async (): Promise<PruneResult> => {
    const result = await api.prune();
    await refresh();
    return result;
  };

  const toggleNotify = (enabled: boolean) => {
    setNotifyEnabled(enabled);
    window.localStorage.setItem(NOTIFY_STORAGE_KEY, enabled ? "1" : "0");
  };

  const inspectedRoot = view === "detail" ? roots.find((root) => root.id === selectedRootId) : undefined;
  const detailConflicts = inspectedRoot ? conflicts.filter((item) => item.rootId === inspectedRoot.id) : [];
  const detailOperations = inspectedRoot ? operations.filter((item) => item.rootId === inspectedRoot.id) : [];
  const authBadge = settings ? AUTH_BADGE[settings.authStatus] : undefined;
  const countdown = settings?.authStatus === "invalid" ? "凭证失效 · 同步受阻" : undefined;
  const topbarTitle = view === "detail" && inspectedRoot ? rootName(inspectedRoot) : VIEW_LABELS[view === "detail" ? "dashboard" : view];
  const dashboardActive = view === "dashboard" || view === "detail";

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">⇄</span>
        <div><span className="eyebrow">LOCAL-FIRST SYNC</span><h1>Feishu Local Sync</h1></div>
      </div>
      <nav className="side-nav">
        {NAV_VIEWS.map((key) => (
          <button key={key} className={`nav-item${(key === "dashboard" ? dashboardActive : view === key) ? " active" : ""}`} onClick={() => { if (key === "dashboard") closeRoot(); else setView("settings"); }}>
            <Icon name={VIEW_ICONS[key]} />
            <span>{VIEW_LABELS[key]}</span>
            {key === "dashboard" && conflicts.length > 0 && <span className="badge">{conflicts.length}</span>}
          </button>
        ))}
      </nav>
      <p className="side-footnote muted">在仪表盘绑定本地目录与飞书文件夹，点击卡片进入根目录详情。</p>
    </aside>

    <div className="main-column">
      <header className="topbar">
        <div className="topbar-brand"><span className="brand-mark small">⇄</span><span>Feishu Local Sync</span></div>
        <h2 className="topbar-title">{topbarTitle}</h2>
        <div className="connection">
          {authBadge && <button className={`auth-badge ${authBadge.className}`} title="点击打开凭证引导" onClick={() => setGuideOpen(true)}>{authBadge.label}</button>}
          <span className={`status-dot${live ? "" : " off"}`} />
          <span className="status-text">{countdown ?? message}</span>
          <button className="secondary sync-button" disabled={syncing || roots.length === 0} onClick={() => void syncNow()}>
            <Icon name="sync" size={14} />{syncing ? "同步中…" : "同步"}
          </button>
        </div>
      </header>

      <main className="content">
        {view === "dashboard" && <Dashboard
          roots={roots}
          rootStats={rootStats}
          conflictsCount={conflicts.length}
          syncing={syncing}
          authStatus={settings?.authStatus}
          onOpenRoot={openRoot}
          onOpenAdd={() => setAddOpen(true)}
          onDeleteRoot={deleteRoot}
          onToggleRoot={toggleRoot}
          onSyncNow={(rootId) => syncNow(rootId)}
          onRefresh={() => void refresh()}
        />}
        {view === "detail" && inspectedRoot && <RootDetail
          root={inspectedRoot}
          tree={tree}
          stats={stats}
          conflicts={detailConflicts}
          operations={detailOperations}
          running={runningRoots.has(inspectedRoot.id)}
          initialTab={initialTab}
          activity={activity}
          syncing={syncing}
          onBack={closeRoot}
          onSyncNow={(rootId) => syncNow(rootId)}
          onToggleRoot={toggleRoot}
          onResolve={resolveConflict}
          onRetryRoot={(rootId) => syncNow(rootId)}
          onSyncEntry={syncEntryNow}
          onIgnoreEntry={setEntryIgnored}
          onSyncMissing={syncMissing}
          onPrune={pruneHistory}
          onRefresh={() => void refresh()}
        />}
        {view === "settings" && <SettingsView
          settings={settings}
          appConfig={appConfig}
          onSaveAppConfig={saveAppConfig}
          roots={roots}
          onSaveSettings={saveSettings}
          onTestConnection={testConnection}
          onPatchRoot={patchRoot}
          onPrune={pruneHistory}
          onOpenGuide={() => setGuideOpen(true)}
          notifyEnabled={notifyEnabled}
          onToggleNotify={toggleNotify}
        />}
      </main>
    </div>

    <nav className="tabbar">
      {NAV_VIEWS.map((key) => <button key={key} className={`tab${(key === "dashboard" ? dashboardActive : view === key) ? " active" : ""}`} onClick={() => { if (key === "dashboard") closeRoot(); else setView("settings"); }}>
        <span className="tab-icon">
          <Icon name={VIEW_ICONS[key]} size={21} />
          {key === "dashboard" && conflicts.length > 0 && <i className="tab-badge">{conflicts.length > 9 ? "9+" : conflicts.length}</i>}
        </span>
        <span>{TAB_LABELS[key]}</span>
      </button>)}
    </nav>

    {addOpen && <div className="modal-backdrop" onClick={() => setAddOpen(false)}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-heading">
          <div><h3>绑定同步根目录</h3><span className="muted">一个本地目录 ↔ 一个飞书文件夹/知识空间节点</span></div>
          <button className="secondary" onClick={() => setAddOpen(false)}>关闭</button>
        </div>
        <form className="add-root-form" onSubmit={addRoot}>
          <input value={newLocalPath} onChange={(event) => setNewLocalPath(event.target.value)} placeholder="本地目录绝对路径，如 /home/me/docs" />
          <div className="add-root-row">
            <select value={newRemoteType} onChange={(event) => setNewRemoteType(event.target.value as "folder" | "wiki")}>
              <option value="folder">云空间文件夹</option>
              <option value="wiki">知识空间（Wiki）节点</option>
            </select>
            <input
              className="interval-input"
              type="number"
              min={1}
              value={newIntervalSec}
              onChange={(event) => setNewIntervalSec(event.target.value)}
              placeholder={`轮询秒数（默认 ${appConfig?.preferences.defaultPollIntervalMs ? Math.round(appConfig.preferences.defaultPollIntervalMs / 1000) : 15}）`}
            />
          </div>
          <input value={newRemoteToken} onChange={(event) => setNewRemoteToken(event.target.value)} placeholder={newRemoteType === "wiki" ? "Wiki 节点 token（wiki space node）" : "飞书文件夹 token"} />
          <p className="muted form-hint">
            token 获取：在飞书云空间打开目标文件夹，或知识空间打开目标节点，复制浏览器地址栏末尾的 token；
            也可用 <a href="https://open.feishu.cn/api-explorer/" target="_blank" rel="noreferrer">API 调试台 ↗</a> 调用「获取根文件夹元信息 / 获取知识空间列表」查询。轮询间隔留空则使用设置页中的全局默认值。
          </p>
          <button className="primary" type="submit" disabled={!newLocalPath || !newRemoteToken}>绑定根目录</button>
        </form>
      </div>
    </div>}

    {guideOpen && settings && <GuideModal settings={settings} onClose={() => setGuideOpen(false)} onSaved={() => void refresh()} />}
  </div>;
}
