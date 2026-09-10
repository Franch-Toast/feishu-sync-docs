import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  DEFAULT_NOTIFICATIONS,
  type ActivityItem,
  type AppConfigPatch,
  type AppConfigView,
  type Conflict,
  type CredentialPatch,
  type NotificationPreferences,
  type Operation,
  type PruneResult,
  type RedactedSettings,
  type Resolution,
  type Root,
  type RootPatch,
  type RootStats,
  type ServerEvent,
  type SyncMode,
  type SyncTrigger,
  type TestConnectionResult,
  type TreeResponse
} from "./api";
import { Dashboard } from "./components/Dashboard";
import { GuideModal } from "./components/GuideModal";
import { OnboardingWizard, QuickStartCard } from "./components/OnboardingWizard";
import { RootDetail, type DetailTab } from "./components/RootDetail";
import { SettingsView } from "./components/SettingsView";
import { TaskCenter } from "./components/TaskCenter";
import { BindRootForm, type CreateRootInput } from "./components/BindRootForm";
import { Icon, type IconName } from "./components/Icon";
import {
  computeOnboarding,
  readOnboardingDismissed,
  shouldShowOnboardingWizard,
  shouldShowQuickStart,
  writeOnboardingDismissed,
  type OnboardingSnapshot,
  type OnboardingStepId
} from "./onboarding";
import "./styles.css";

/** Primary views (nav items). The root detail page is reached from the dashboard. */
type View = "dashboard" | "detail" | "tasks" | "settings";
type NavView = "dashboard" | "tasks" | "settings";

const VIEW_LABELS: Record<NavView, string> = {
  dashboard: "仪表盘",
  tasks: "任务中心",
  settings: "设置"
};

/** Compact labels for the mobile tab bar. */
const TAB_LABELS: Record<NavView, string> = {
  dashboard: "仪表盘",
  tasks: "任务",
  settings: "设置"
};

const VIEW_ICONS: Record<NavView, IconName> = {
  dashboard: "dashboard",
  tasks: "tasks",
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
  const [addSubmitting, setAddSubmitting] = useState(false);
  const [live, setLive] = useState(false);
  /** Browser Notification permission, or "unsupported" where the API is absent (B6.8). */
  const [notifyPermission, setNotifyPermission] = useState(() => (typeof Notification === "undefined" ? "unsupported" : Notification.permission));
  /** Live 429 backoff window surfaced as a topbar badge (B6.2). */
  const [rateLimit, setRateLimit] = useState<{ rootId: string; retryAfterMs: number; until: number }>();
  /** Re-read every second while the badge is up so its countdown actually ticks. */
  const [rateLimitNow, setRateLimitNow] = useState(() => Date.now());
  /** First-run wizard dismissal, persisted per browser (B6.1). */
  const [onboardingDismissed, setOnboardingDismissed] = useState(() => readOnboardingDismissed(window.localStorage));
  const [wizardOpen, setWizardOpen] = useState(false);
  /** Bumped on every operation-* socket event so the task center refetches. */
  const [taskRevision, setTaskRevision] = useState(0);
  /** Roots with a sync round in flight (from sync-started until sync/error). */
  const [runningRoots, setRunningRoots] = useState<ReadonlySet<string>>(new Set());
  /** Trigger + mode of the in-flight round per root, for the running-bar wording. */
  const [runningMeta, setRunningMeta] = useState<Record<string, { trigger: SyncTrigger; mode?: SyncMode }>>({});
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
  // Notification switches live server-side (B6.8); the ref keeps `notify`
  // referentially stable so the socket effect is not torn down on every poll.
  const notifications = appConfig?.preferences.notifications ?? DEFAULT_NOTIFICATIONS;
  const notificationsRef = useRef(notifications);
  useEffect(() => { notificationsRef.current = notifications; }, [notifications]);
  const conflictCountRef = useRef(0);

  const notify = useCallback((category: keyof NotificationPreferences, title: string, body: string) => {
    if (!notificationsRef.current[category]) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
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
          api.listOperations({ limit: 100 }).catch(() => [] as Operation[])
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
        notify("conflict", "发现新冲突", fresh?.relativePath ? `${fresh.relativePath} 需要处理` : "冲突工作台有待处理项");
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
        setRunningMeta((current) => ({ ...current, [payload.rootId]: { trigger: payload.trigger, mode: payload.mode } }));
        pushActivity({ kind: "sync-started", text: `根目录 ${shortRootId(payload.rootId)} 开始${payload.mode === "pull-only" ? "拉取远端变更" : payload.mode === "push-only" ? "推送本地变更" : "检测远端变更与本地差异"}` });
      }
      if (payload.type === "sync") {
        setRootRunning(payload.rootId, false);
        pushActivity({ kind: "sync", text: `根目录 ${shortRootId(payload.rootId)} 一轮同步结束` });
      }
      if (payload.type === "scan") {
        setRootRunning(payload.rootId, false);
        pushActivity({ kind: "scan", text: `根目录 ${shortRootId(payload.rootId)} 完成远端检测` });
      }
      if (
        payload.type === "operation-queued"
        || payload.type === "operation-started"
        || payload.type === "operation-completed"
        || payload.type === "operation-failed"
        || payload.type === "operation-retrying"
        || payload.type === "operation-cancelled"
      ) {
        // Any operation lifecycle change refreshes the task center groups.
        setTaskRevision((value) => value + 1);
      }
      if (payload.type === "operation-failed") {
        pushActivity({ kind: "error", text: `任务失败：${shortRootId(payload.operation.entryId ?? payload.operation.id)}${payload.operation.errorCategory ? `（${payload.operation.errorCategory}）` : ""}` });
        notify("failure", "同步失败", `${payload.operation.relativePath ?? shortRootId(payload.operation.entryId ?? payload.operation.id)}：${payload.operation.error ?? "未知错误"}`);
      }
      if (payload.type === "operation-retrying") {
        pushActivity({ kind: "sync", text: `任务重试：${shortRootId(payload.operation.entryId ?? payload.operation.id)} 第 ${payload.retryCount} 次，${Math.round(payload.delayMs / 1000)}s 后重试` });
      }
      // 429 backoff: keep the announced window visible until it elapses (B6.2).
      if (payload.type === "rate-limited") {
        setRateLimit({ rootId: payload.rootId, retryAfterMs: payload.retryAfterMs, until: Date.now() + payload.retryAfterMs });
        pushActivity({ kind: "rate-limit", text: `飞书限流：根目录 ${shortRootId(payload.rootId)} 第 ${payload.retryCount} 次重试将在 ${Math.round(payload.retryAfterMs / 1000)}s 后自动进行` });
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
        notify("credential", "飞书凭证已失效", "同步已暂停，点击页面顶部徽章更新凭证");
      }
      if (payload.type === "auth-restored") notify("credential", "飞书凭证已恢复", "同步继续进行");
      if (payload.type === "conflict-resolved") notify("conflict", "冲突已解决", "合并结果已写入本地与飞书");
      if (payload.type === "error") notify("failure", "同步出错", payload.error);
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

  const createRoot = async (input: CreateRootInput) => {
    setAddSubmitting(true);
    try {
      const root = await api.createRoot(input);
      setAddOpen(false);
      await refresh();
      openRoot(root.id);
    } catch (error) {
      // Re-throw so BindRootForm surfaces the message inline next to the form.
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      setAddSubmitting(false);
    }
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

  /** Task center「清空已完成」: deletes the finished records right away, unlike
   *  pruneHistory whose retention window means nothing is usually old enough. */
  const clearCompletedTasks = async (): Promise<{ cleared: number }> => {
    const result = await api.clearCompletedTasks();
    setTaskRevision((current) => current + 1);
    await refresh();
    return result;
  };

  /** Persist one notification category server-side; it now follows the
   *  installation instead of a single browser's localStorage (B6.8). */
  const toggleNotification = async (category: keyof NotificationPreferences, enabled: boolean) => {
    const saved = await api.saveAppConfig({ notifications: { [category]: enabled } });
    setAppConfig(saved);
  };

  const requestNotifyPermission = () => {
    if (typeof Notification === "undefined") return;
    void Notification.requestPermission().then((permission) => setNotifyPermission(permission));
  };

  /** 「不再显示」— persisted per browser; only hides the modal wizard (B6.1). */
  const dismissOnboarding = () => {
    writeOnboardingDismissed(window.localStorage, true);
    setOnboardingDismissed(true);
    setWizardOpen(false);
  };

  /** Route a wizard / quick-start step to the screen that satisfies it (B6.1). */
  const runOnboardingStep = (stepId: OnboardingStepId) => {
    setWizardOpen(false);
    if (stepId === "credential") { setView("settings"); return; }
    if (stepId === "bind-root") { closeRoot(); setAddOpen(true); return; }
    closeRoot();
  };

  const inspectedRoot = view === "detail" ? roots.find((root) => root.id === selectedRootId) : undefined;
  const detailConflicts = inspectedRoot ? conflicts.filter((item) => item.rootId === inspectedRoot.id) : [];
  const detailOperations = inspectedRoot ? operations.filter((item) => item.rootId === inspectedRoot.id) : [];
  const authBadge = settings ? AUTH_BADGE[settings.authStatus] : undefined;
  const countdown = settings?.authStatus === "invalid" ? "凭证失效 · 同步受阻" : undefined;
  const topbarTitle = view === "detail" && inspectedRoot ? rootName(inspectedRoot) : VIEW_LABELS[view === "detail" ? "dashboard" : view];
  const dashboardActive = view === "dashboard" || view === "detail";

  // First-run guided flow (B6.1): credentials → bind a root → first sync.
  const onboardingSnapshot = useMemo<OnboardingSnapshot>(() => ({
    credentialReady: settings?.authStatus === "ok",
    rootBound: roots.length > 0,
    synced: Object.values(rootStats).some((item) => item.lastSyncAt !== undefined) || operations.some((item) => item.status === "succeeded")
  }), [settings?.authStatus, roots.length, rootStats, operations]);
  const onboarding = useMemo(() => computeOnboarding(onboardingSnapshot), [onboardingSnapshot]);
  const workspaceLoaded = settings !== undefined;

  // Open the welcome wizard once per visit, as soon as the workspace state
  // resolves with steps still pending. It is advisory: closing without
  // dismissing simply reopens it on the next visit.
  const wizardAutoOpened = useRef(false);
  useEffect(() => {
    if (wizardAutoOpened.current) return;
    if (!shouldShowOnboardingWizard({ snapshot: onboardingSnapshot, dismissed: onboardingDismissed, loaded: workspaceLoaded })) return;
    wizardAutoOpened.current = true;
    setWizardOpen(true);
  }, [onboardingSnapshot, onboardingDismissed, workspaceLoaded]);

  // Count the rate-limit badge down to zero, then drop it once the announced
  // backoff window elapsed (B6.2). A single timeout left the label frozen on the
  // original Retry-After value, so "25s 后重试" never became "24s".
  useEffect(() => {
    if (!rateLimit) return;
    const remaining = rateLimit.until - Date.now();
    if (remaining <= 0) { setRateLimit(undefined); return; }
    setRateLimitNow(Date.now());
    const tick = window.setInterval(() => setRateLimitNow(Date.now()), 1000);
    const timer = window.setTimeout(() => setRateLimit(undefined), remaining);
    return () => { window.clearInterval(tick); window.clearTimeout(timer); };
  }, [rateLimit]);

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">⇄</span>
        <div><span className="eyebrow">LOCAL-FIRST SYNC</span><h1>Feishu Local Sync</h1></div>
      </div>
      <nav className="side-nav">
        {NAV_VIEWS.map((key) => (
          <button key={key} className={`nav-item${(key === "dashboard" ? dashboardActive : view === key) ? " active" : ""}`} onClick={() => { if (key === "dashboard") closeRoot(); else setView(key); }}>
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
          {rateLimit && <span
            className="rate-limit-badge"
            title="飞书返回 429，同步已按 Retry-After 退避，到点自动重试"
          >限流 · {Math.max(0, Math.round((rateLimit.until - rateLimitNow) / 1000))}s 后重试</span>}
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
          quickStart={shouldShowQuickStart({ snapshot: onboardingSnapshot, loaded: workspaceLoaded })
            ? <QuickStartCard
              state={onboarding}
              onStepAction={runOnboardingStep}
              onDismiss={dismissOnboarding}
              onReopenWizard={() => setWizardOpen(true)}
            />
            : undefined}
        />}
        {view === "detail" && inspectedRoot && <RootDetail
          root={inspectedRoot}
          tree={tree}
          stats={stats}
          conflicts={detailConflicts}
          operations={detailOperations}
          running={runningRoots.has(inspectedRoot.id)}
          runningTrigger={runningMeta[inspectedRoot.id]?.trigger}
          runningMode={runningMeta[inspectedRoot.id]?.mode}
          initialTab={initialTab}
          activity={activity}
          syncing={syncing}
          onBack={closeRoot}
          onSyncNow={(rootId) => syncNow(rootId)}
          onToggleRoot={toggleRoot}
          onPatchRoot={patchRoot}
          onResolve={resolveConflict}
          onSyncEntry={syncEntryNow}
          onIgnoreEntry={setEntryIgnored}
          onSyncMissing={syncMissing}
          onPrune={pruneHistory}
          onRefresh={() => void refresh()}
        />}
        {view === "tasks" && <TaskCenter
          roots={roots}
          revision={taskRevision}
          syncing={syncing}
          onOpenSettings={() => setView("settings")}
          onOpenIssues={(rootId) => openRoot(rootId, "issues-conflicts")}
          onClearCompleted={clearCompletedTasks}
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
          notifications={notifications}
          onToggleNotification={toggleNotification}
          notifyPermission={notifyPermission}
          onRequestNotifyPermission={requestNotifyPermission}
        />}
      </main>
    </div>

    <nav className="tabbar">
      {NAV_VIEWS.map((key) => <button key={key} className={`tab${(key === "dashboard" ? dashboardActive : view === key) ? " active" : ""}`} onClick={() => { if (key === "dashboard") closeRoot(); else setView(key); }}>
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
        <BindRootForm
          defaultIntervalMs={appConfig?.preferences.defaultPollIntervalMs}
          submitting={addSubmitting}
          onSubmit={createRoot}
          onCancel={() => setAddOpen(false)}
        />
      </div>
    </div>}

    {guideOpen && settings && <GuideModal settings={settings} onClose={() => setGuideOpen(false)} onSaved={() => void refresh()} />}

    {wizardOpen && <OnboardingWizard
      state={onboarding}
      onStepAction={runOnboardingStep}
      onClose={() => setWizardOpen(false)}
      onDismiss={dismissOnboarding}
    />}
  </div>;
}
