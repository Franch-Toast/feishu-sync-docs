import React, { useEffect, useMemo, useState } from "react";
import {
  formatDateTime,
  formatDuration,
  type ActivityItem,
  type Conflict,
  type Operation,
  type PruneResult,
  type Resolution,
  type Root,
  type RootStats,
  type TreeResponse
} from "../api";
import { DocsView } from "./DocsView";
import { HistoryView } from "./HistoryView";
import { Icon } from "./Icon";
import { IssuesView, type IssueGroup } from "./IssuesView";

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
  /** Tab requested by the navigation (dashboard metric shortcuts included). */
  initialTab: DetailTab;
  /** Live activity feed (newest first). */
  activity: ActivityItem[];
  syncing: boolean;
  onBack: () => void;
  onSyncNow: (rootId: string) => Promise<void>;
  onToggleRoot: (rootId: string, enabled: boolean) => Promise<void>;
  onResolve: (id: string, resolution: Resolution, mergedContent?: string) => Promise<void>;
  onRetryRoot: (rootId: string) => Promise<void>;
  onSyncEntry: (entryId: string) => Promise<void>;
  onIgnoreEntry: (entryId: string, ignored: boolean) => Promise<void>;
  onSyncMissing: (rootId: string) => Promise<number>;
  onPrune: () => Promise<PruneResult>;
  onRefresh: () => void;
}

export function RootDetail({ root, tree, stats, conflicts, operations, running, initialTab, activity, syncing, onBack, onSyncNow, onToggleRoot, onResolve, onRetryRoot, onSyncEntry, onIgnoreEntry, onSyncMissing, onPrune, onRefresh }: RootDetailProps): React.JSX.Element {
  const [tab, setTab] = useState<DetailTab>(initialTab);
  const [selectedEntryId, setSelectedEntryId] = useState<string | undefined>();
  const [selectedConflict, setSelectedConflict] = useState<Conflict | undefined>();
  const [now, setNow] = useState(() => Date.now());

  // Reset the inner workspace when another root is opened.
  useEffect(() => {
    setTab(initialTab);
    setSelectedEntryId(undefined);
    setSelectedConflict(undefined);
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
  const issueBadge = conflicts.length + missingCount;

  const resolveConflict = async (id: string, resolution: Resolution, mergedContent?: string) => {
    await onResolve(id, resolution, mergedContent);
    setSelectedConflict(undefined);
  };

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
        <button className="secondary" disabled={syncing} onClick={() => void onToggleRoot(root.id, !root.enabled)}>{root.enabled ? "暂停同步" : "恢复同步"}</button>
        <button className="primary" disabled={syncing || running} onClick={() => void onSyncNow(root.id)}><Icon name="sync" size={14} />{running ? "检测中…" : syncing ? "同步中…" : "立即同步"}</button>
      </div>
    </div>

    {running && <div className="running-bar"><span className="running-spinner" />正在检测远端变更与本地差异…</div>}

    <div className="overview-grid">
      <div className="metric"><span>上次同步</span><strong>{formatDateTime(stats?.lastSyncAt)}</strong></div>
      <div className="metric"><span>下次自动同步</span><strong>{nextPoll === undefined ? "已暂停" : formatDuration(nextPoll)}</strong></div>
      <div className="metric"><span>24h 成功</span><strong>{stats?.succeeded24h ?? 0}</strong></div>
      <div className="metric"><span>24h 失败</span><strong>{stats?.failed24h ?? 0}</strong></div>
      <div className="metric"><span>同步条目</span><strong>{stats?.entriesTotal ?? 0}</strong></div>
      <div className="metric"><span>冲突条目</span><strong>{byStatus.conflict ?? 0}</strong></div>
      <div className="metric"><span>异常条目</span><strong>{errorEntries}</strong></div>
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
      syncing={syncing}
      activity={activity}
      onRetryRoot={onRetryRoot}
      onRetryEntry={onSyncEntry}
      onPrune={onPrune}
      onRefresh={onRefresh}
    />}
  </div>;
}
