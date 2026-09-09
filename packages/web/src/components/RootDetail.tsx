import React, { useEffect, useMemo, useState } from "react";
import {
  formatDateTime,
  formatDuration,
  type Conflict,
  type Operation,
  type PruneResult,
  type Resolution,
  type Root,
  type RootStats,
  type TreeResponse
} from "../api";
import { ConflictsView } from "./ConflictsView";
import { DocsView } from "./DocsView";
import { HistoryView } from "./HistoryView";
import { Icon } from "./Icon";

type DetailTab = "docs" | "conflicts" | "history";

const TAB_LABELS: Record<DetailTab, string> = {
  docs: "目录与文档",
  conflicts: "冲突工作台",
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
  syncing: boolean;
  onBack: () => void;
  onSyncNow: (rootId: string) => Promise<void>;
  onToggleRoot: (rootId: string, enabled: boolean) => Promise<void>;
  onResolve: (id: string, resolution: Resolution, mergedContent?: string) => Promise<void>;
  onRetryRoot: (rootId: string) => Promise<void>;
  onPrune: () => Promise<PruneResult>;
  onRefresh: () => void;
}

export function RootDetail({ root, tree, stats, conflicts, operations, syncing, onBack, onSyncNow, onToggleRoot, onResolve, onRetryRoot, onPrune, onRefresh }: RootDetailProps): React.JSX.Element {
  const [tab, setTab] = useState<DetailTab>("docs");
  const [selectedEntryId, setSelectedEntryId] = useState<string | undefined>();
  const [selectedConflict, setSelectedConflict] = useState<Conflict | undefined>();
  const [now, setNow] = useState(() => Date.now());

  // Reset the inner workspace when another root is opened.
  useEffect(() => {
    setTab("docs");
    setSelectedEntryId(undefined);
    setSelectedConflict(undefined);
  }, [root.id]);

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

  const byStatus = stats?.entriesByStatus ?? {};
  const errorEntries = (byStatus.error ?? 0) + (byStatus.orphan ?? 0);

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
        <button className="primary" disabled={syncing} onClick={() => void onSyncNow(root.id)}><Icon name="sync" size={14} />{syncing ? "同步中…" : "立即同步"}</button>
      </div>
    </div>

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
      {(Object.keys(TAB_LABELS) as DetailTab[]).map((key) => (
        <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>
          {TAB_LABELS[key]}
          {key === "conflicts" && conflicts.length > 0 && <span className="tab-inline-badge">{conflicts.length}</span>}
        </button>
      ))}
    </div>

    {tab === "docs" && <DocsView
      tree={tree}
      selectedEntryId={selectedEntryId}
      onSelectEntry={setSelectedEntryId}
      onRefresh={onRefresh}
    />}
    {tab === "conflicts" && <ConflictsView
      conflicts={conflicts}
      rootId={root.id}
      selected={selectedConflict}
      onSelect={setSelectedConflict}
      onResolve={resolveConflict}
      onRefresh={onRefresh}
    />}
    {tab === "history" && <HistoryView
      operations={operations}
      roots={[root]}
      root={root}
      syncing={syncing}
      onRetryRoot={onRetryRoot}
      onPrune={onPrune}
      onRefresh={onRefresh}
    />}
  </div>;
}
