import React, { useEffect, useMemo, useState } from "react";
import {
  formatDateTime,
  formatDuration,
  SYNC_MODE_LABELS,
  TRIGGER_LABELS,
  type ActivityItem,
  type Conflict,
  type Operation,
  type PruneResult,
  type Resolution,
  type Root,
  type RootPatch,
  type RootStats,
  type SyncMode,
  type SyncTrigger,
  type TreeResponse
} from "../api";
import { DocsView } from "./DocsView";
import { HistoryView } from "./HistoryView";
import { Icon } from "./Icon";
import { IssuesView, type IssueGroup } from "./IssuesView";
import { describeExcludePatterns, formatExcludePatterns, parseExcludePatterns } from "../exclude";

/** Tabs of the detail page. The issue workbench opens on a specific group
 *  when reached from a dashboard metric shortcut. */
export type DetailTab = "docs" | "issues-conflicts" | "issues-missing" | "history";

const TAB_LABELS: Record<DetailTab, string> = {
  docs: "目录与文档",
  "issues-conflicts": "异常工作台",
  "issues-missing": "异常工作台",
  history: "同步历史"
};

interface RootDetailProps {
  root: Root;
  tree?: TreeResponse;
  stats?: RootStats;
  /** Open conflicts, already filtered to this root. */
  conflicts: Conflict[];
  /** Operations, already filtered to this root. */
  operations: Operation[];
  /** True while a sync round for this root is in flight (sync-started → sync). */
  running: boolean;
  /** What kicked off the in-flight round, for the running-bar wording. */
  runningTrigger?: SyncTrigger;
  /** Direction policy of the in-flight round, for the running-bar wording. */
  runningMode?: SyncMode;
  /** Tab requested by the navigation (dashboard metric shortcuts included). */
  initialTab: DetailTab;
  /** Live activity feed (newest first). */
  activity: ActivityItem[];
  syncing: boolean;
  onBack: () => void;
  onSyncNow: (rootId: string) => Promise<void>;
  onToggleRoot: (rootId: string, enabled: boolean) => Promise<void>;
  onPatchRoot: (id: string, patch: RootPatch) => Promise<void>;
  onResolve: (id: string, resolution: Resolution, mergedContent?: string) => Promise<void>;
  onSyncEntry: (entryId: string) => Promise<void>;
  onIgnoreEntry: (entryId: string, ignored: boolean) => Promise<void>;
  onSyncMissing: (rootId: string) => Promise<number>;
  onPrune: () => Promise<PruneResult>;
  onRefresh: () => void;
}

export function RootDetail({ root, tree, stats, conflicts, operations, running, runningTrigger, runningMode, initialTab, activity, syncing, onBack, onSyncNow, onToggleRoot, onPatchRoot, onResolve, onSyncEntry, onIgnoreEntry, onSyncMissing, onPrune, onRefresh }: RootDetailProps): React.JSX.Element {
  const [tab, setTab] = useState<DetailTab>(initialTab);
  const [selectedEntryId, setSelectedEntryId] = useState<string | undefined>();
  const [selectedConflict, setSelectedConflict] = useState<Conflict | undefined>();
  const [now, setNow] = useState(() => Date.now());
  /** Raw exclude textarea; parsed into globs on save (B6.5). */
  const [excludeText, setExcludeText] = useState(() => formatExcludePatterns(root.exclude));
  const [excludeBusy, setExcludeBusy] = useState(false);
  const [excludeNotice, setExcludeNotice] = useState<string>();

  // Reset the inner workspace when another root is opened.
  useEffect(() => {
    setTab(initialTab);
    setSelectedEntryId(undefined);
    setSelectedConflict(undefined);
    setExcludeText(formatExcludePatterns(root.exclude));
    setExcludeNotice(undefined);
  }, [root.id, initialTab]);

  // 1s tick for the next-poll countdown.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const nextPoll = useMemo(() => {
    if (!root.enabled) return undefined;
    if (!stats?.lastSyncAt) return 0;
    const elapsed = now - new Date(stats.lastSyncAt).getTime();
    return Math.max(0, root.pollIntervalMs - elapsed);
  }, [root.enabled, root.pollIntervalMs, stats?.lastSyncAt, now]);

  const entries = tree?.entries ?? [];
  const missingCount = entries.filter((entry) => (entry.status === "local-missing" || entry.status === "remote-missing") && !entry.ignoredAt).length;
  const byStatus = stats?.entriesByStatus ?? {};
  // Exception statistic: hard failures plus both missing flavors.
  const errorEntries = (byStatus.error ?? 0) + (byStatus["local-missing"] ?? 0) + (byStatus["remote-missing"] ?? 0) + (byStatus.orphan ?? 0);
  const conflictCount = byStatus.conflict ?? 0;
  // Merged "待处理" metric keeps the overview grid at six cards (no orphan row).
  const pendingCount = conflictCount + errorEntries;
  const issueBadge = conflicts.length + missingCount;

  const resolveConflict = async (id: string, resolution: Resolution, mergedContent?: string) => {
    await onResolve(id, resolution, mergedContent);
    setSelectedConflict(undefined);
  };

  /** Persist the exclude globs; the next scan and the watcher pick them up. */
  const saveExclude = async () => {
    setExcludeBusy(true);
    setExcludeNotice(undefined);
    try {
      const patterns = parseExcludePatterns(excludeText);
      await onPatchRoot(root.id, { exclude: patterns });
      setExcludeText(formatExcludePatterns(patterns));
      setExcludeNotice(patterns.length > 0
        ? `已保存 ${patterns.length} 条排除规则，下一轮扫描生效。`
        : "已清空排除规则，下一轮扫描会重新纳入这些路径。");
    } catch (error) {
      setExcludeNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setExcludeBusy(false);
    }
  };

  const excludeDirty = parseExcludePatterns(excludeText).join("\n") !== (root.exclude ?? []).join("\n");

  // Running-bar wording reflects what triggered the round and its direction.
  const runningText = (() => {
    const triggerLabel = runningTrigger ? TRIGGER_LABELS[runningTrigger] : "手动";
    const modePart = runningMode === "pull-only" ? "拉取远端变更" : runningMode === "push-only" ? "推送本地变更" : "检测远端变更与本地差异";
    return `${triggerLabel}触发 · 正在${modePart}…`;
  })();

  return <div className="root-detail">
    <div className="detail-header">
      <button className="secondary back-button" onClick={onBack}><Icon name="back" size={15} />返回仪表盘</button>
      <div className="detail-heading">
        <h2>{root.localPath.split(/[\\/]/).at(-1)}</h2>
        <p>{root.localPath}</p>
      </div>
      <span className="muted detail-token">↔ {root.remoteToken}</span>
      {!root.enabled && <span className="badge">已暂停</span>}
      <div className="heading-actions">
        <label className="mode-picker">
          <span className="muted">同步方向</span>
          <select value={root.mode ?? "bidirectional"} disabled={syncing} onChange={(event) => void onPatchRoot(root.id, { mode: event.target.value as SyncMode })}>
            {(Object.keys(SYNC_MODE_LABELS) as SyncMode[]).map((key) => <option key={key} value={key}>{SYNC_MODE_LABELS[key]}</option>)}
          </select>
        </label>
        <button className="secondary" disabled={syncing} onClick={() => void onToggleRoot(root.id, !root.enabled)}>{root.enabled ? "暂停同步" : "恢复同步"}</button>
        <button className="primary" disabled={syncing || running} onClick={() => void onSyncNow(root.id)}><Icon name="sync" size={14} />{running ? "检测中…" : syncing ? "同步中…" : "立即同步"}</button>
      </div>
    </div>

    {running && <div className="running-bar"><span className="running-spinner" />{runningText}</div>}

    <details className="exclude-editor">
      <summary>
        <span className="exclude-title">排除规则</span>
        <span className="muted">{describeExcludePatterns(root.exclude)}</span>
        {excludeDirty && <span className="badge">未保存</span>}
      </summary>
      <div className="exclude-body">
        <textarea
          className="exclude-input"
          rows={3}
          value={excludeText}
          placeholder={"drafts\ntmp-*.md\n**/*.draft.md"}
          onChange={(event) => setExcludeText(event.target.value)}
        />
        <div className="form-actions">
          <button className="secondary" disabled={excludeBusy || !excludeDirty} onClick={() => void saveExclude()}>{excludeBusy ? "保存中…" : "保存排除规则"}</button>
          <button className="link-button" disabled={excludeBusy || !excludeDirty} onClick={() => { setExcludeText(formatExcludePatterns(root.exclude)); setExcludeNotice(undefined); }}>还原</button>
        </div>
        {excludeNotice && <div className="form-notice">{excludeNotice}</div>}
        <p className="muted form-hint">每行一个 glob（也可用逗号分隔）。命中的目录会整体跳过本地扫描与文件监听；已同步过的文件被新规则命中时会标记为「已忽略」，不会删除远端文档。</p>
      </div>
    </details>

    <div className="overview-grid">
      <div className="metric"><span>上次同步</span><strong>{formatDateTime(stats?.lastSyncAt)}</strong></div>
      <div className="metric"><span>下次自动同步</span><strong>{nextPoll === undefined ? "已暂停" : formatDuration(nextPoll)}</strong></div>
      <div className="metric"><span>24h 成功</span><strong>{stats?.succeeded24h ?? 0}</strong></div>
      <div className="metric"><span>24h 失败</span><strong>{stats?.failed24h ?? 0}</strong></div>
      <div className="metric"><span>同步条目</span><strong>{stats?.entriesTotal ?? 0}</strong></div>
      <div className={`metric${pendingCount > 0 ? " warning" : ""}`}><span>待处理</span><strong>{pendingCount}</strong><small>冲突 {conflictCount} · 异常 {errorEntries}</small></div>
    </div>

    <div className="detail-tabs root-tabs">
      {(Object.keys(TAB_LABELS) as DetailTab[]).filter((key) => key !== "issues-missing").map((key) => (
        <button key={key} className={tab === key || (key === "issues-conflicts" && tab === "issues-missing") ? "active" : ""} onClick={() => setTab(key)}>
          {TAB_LABELS[key]}
          {key === "issues-conflicts" && issueBadge > 0 && <span className="tab-inline-badge">{issueBadge}</span>}
        </button>
      ))}
    </div>

    {tab === "docs" && <DocsView
      tree={tree}
      running={running}
      operations={operations}
      selectedEntryId={selectedEntryId}
      onSelectEntry={setSelectedEntryId}
      onSyncEntry={onSyncEntry}
      onRefresh={onRefresh}
    />}
    {(tab === "issues-conflicts" || tab === "issues-missing") && <IssuesView
      conflicts={conflicts}
      entries={entries}
      rootId={root.id}
      initialGroup={tab === "issues-missing" && missingCount === 0 && conflicts.length > 0 ? "conflicts" : tab === "issues-missing" ? "local-missing" : "conflicts"}
      selected={selectedConflict}
      onSelect={setSelectedConflict}
      onResolve={resolveConflict}
      onSyncEntry={onSyncEntry}
      onIgnoreEntry={onIgnoreEntry}
      onSyncMissing={() => onSyncMissing(root.id)}
      onRefresh={onRefresh}
    />}
    {tab === "history" && <HistoryView
      operations={operations}
      roots={[root]}
      root={root}
      activity={activity}
      onPrune={onPrune}
      onRefresh={onRefresh}
    />}
  </div>;
}
