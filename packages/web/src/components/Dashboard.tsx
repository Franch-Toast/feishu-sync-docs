import React from "react";
import { AUTH_STATUS_LABELS, formatDateTime, type AuthStatus, type Root, type RootStats } from "../api";
import { Icon } from "./Icon";
import type { DetailTab } from "./RootDetail";

interface DashboardProps {
  roots: Root[];
  /** Per-root stats fetched by App for the card summaries. */
  rootStats: Record<string, RootStats>;
  /** Global open-conflict count. */
  conflictsCount: number;
  syncing: boolean;
  authStatus?: AuthStatus;
  /** F4: roots with a sync round in flight, for the「本轮同步进度」card (A4). */
  activeRounds?: number;
  /** Optional tab so metric shortcuts land on the right workbench. */
  onOpenRoot: (rootId: string, tab?: DetailTab) => void;
  onOpenAdd: () => void;
  onDeleteRoot: (root: Root) => Promise<void>;
  onToggleRoot: (rootId: string, enabled: boolean) => Promise<void>;
  onSyncNow: (rootId: string) => Promise<void>;
  onRefresh: () => void;
  /** Quick-start card shown while first-run steps remain (B6.1). */
  quickStart?: React.ReactNode;
}

function rootName(root: Root): string {
  return root.localPath.split(/[\\/]/).at(-1) ?? root.localPath;
}

export function Dashboard({ roots, rootStats, conflictsCount, syncing, authStatus, activeRounds = 0, onOpenRoot, onOpenAdd, onDeleteRoot, onToggleRoot, onSyncNow, onRefresh, quickStart }: DashboardProps): React.JSX.Element {
  // Exception statistic: hard failures plus both missing flavors (and legacy
  // orphans before their reclassification round).
  const errorEntries = Object.values(rootStats).reduce(
    (sum, stats) => sum
      + (stats.entriesByStatus.error ?? 0)
      + (stats.entriesByStatus["local-missing"] ?? 0)
      + (stats.entriesByStatus["remote-missing"] ?? 0)
      + (stats.entriesByStatus.orphan ?? 0),
    0
  );

  // First root holding conflicts / anomalies, for the clickable metrics.
  const conflictRoot = roots.find((root) => (rootStats[root.id]?.conflicts ?? 0) > 0);
  const issueRoot = roots.find((root) => {
    const byStatus = rootStats[root.id]?.entriesByStatus ?? {};
    return (byStatus.error ?? 0) + (byStatus["local-missing"] ?? 0) + (byStatus["remote-missing"] ?? 0) + (byStatus.orphan ?? 0) > 0;
  });
  const issueRootHasMissing = issueRoot ? ((rootStats[issueRoot.id]?.entriesByStatus["local-missing"] ?? 0) + (rootStats[issueRoot.id]?.entriesByStatus["remote-missing"] ?? 0)) > 0 : false;

  return <div className="dashboard">
    <div className="page-heading">
      <div><span className="eyebrow">WORKSPACE / OVERVIEW</span><h2>仪表盘</h2><p>全局同步状态一览；点击根目录卡片进入详情，管理目录文档、冲突与历史。</p></div>
      <div className="heading-actions"><button className="secondary" onClick={onRefresh}>刷新</button></div>
    </div>

    {quickStart}

    <div className="overview-grid">
      <div className="metric"><span>同步根目录</span><strong>{roots.length}</strong></div>
      {conflictRoot
        ? <button className="metric metric-link" title="打开第一个存在冲突的根目录" onClick={() => onOpenRoot(conflictRoot.id, "issues-conflicts")}><span>待解决冲突</span><strong>{conflictsCount}</strong></button>
        : <div className="metric"><span>待解决冲突</span><strong>{conflictsCount}</strong></div>}
      {issueRoot
        ? <button className="metric metric-link" title="打开第一个存在异常条目的根目录" onClick={() => onOpenRoot(issueRoot.id, issueRootHasMissing ? "issues-missing" : "issues-conflicts")}><span>异常条目</span><strong>{errorEntries}</strong></button>
        : <div className="metric"><span>异常条目</span><strong>{errorEntries}</strong></div>}
      <div className="metric"><span>凭证状态</span><strong>{authStatus ? AUTH_STATUS_LABELS[authStatus] : "—"}</strong></div>
      {/* F4/A4: one round per root is always visible, so “nothing running” is a
          fact worth showing rather than an absent card. */}
      <div className={`metric${activeRounds > 0 ? " metric-active" : ""}`}><span>本轮同步</span><strong>{activeRounds > 0 ? `${activeRounds} 个根目录进行中` : "空闲"}</strong><small>{activeRounds > 0 ? "可在任务中心查看整轮同步进度" : "等待下一次轮询或文件变动"}</small></div>
    </div>

    <section className="panel roots-panel">
      <div className="panel-heading">
        <div><h3>同步根目录</h3><span className="muted">一个本地目录 ↔ 一个飞书文件夹；点击卡片进入根目录详情</span></div>
        <button className="primary" onClick={onOpenAdd}><Icon name="plus" size={14} />绑定根目录</button>
      </div>
      {roots.length === 0
        ? <div className="empty-state"><div className="check">✓</div><strong>还没有绑定同步根目录</strong><span>点击右上角「绑定根目录」，把本地目录和飞书文件夹连接起来。</span></div>
        : <div className="root-cards">
          {roots.map((root) => {
            const stats = rootStats[root.id];
            const byStatus = stats?.entriesByStatus ?? {};
            const conflictEntries = byStatus.conflict ?? 0;
            const missingEntries = (byStatus["local-missing"] ?? 0) + (byStatus["remote-missing"] ?? 0);
            return (
              <div key={root.id} className="root-card">
                <button className="root-card-main" onClick={() => onOpenRoot(root.id)}>
                  <div className="root-card-title">
                    <strong>{rootName(root)}</strong>
                    {root.enabled
                      ? <span className="badge ok-badge">同步中</span>
                      : <span className="badge paused-badge">已暂停</span>}
                    {conflictEntries > 0 && <span className="badge conflict-badge">冲突 {conflictEntries}</span>}
                    {missingEntries > 0 && <span className="badge missing-badge">缺失 {missingEntries}</span>}
                  </div>
                  <span className="root-card-path">{root.localPath}</span>
                  <span className="root-card-token">↔ {root.remoteToken}</span>
                  <div className="root-card-stats">
                    <span>上次同步 {formatDateTime(stats?.lastSyncAt)}</span>
                    <span>条目 {stats?.entriesTotal ?? 0}</span>
                    <span>24h 成功 {stats?.succeeded24h ?? 0}</span>
                    <span>24h 失败 {stats?.failed24h ?? 0}</span>
                    <span>冲突 {conflictEntries}</span>
                  </div>
                </button>
                <div className="root-card-actions">
                  <button className="secondary" disabled={syncing} onClick={() => void onSyncNow(root.id)}><Icon name="sync" size={13} />{syncing ? "同步中…" : "立即同步"}</button>
                  <button className="secondary" disabled={syncing} onClick={() => void onToggleRoot(root.id, !root.enabled)}>{root.enabled ? "暂停" : "恢复"}</button>
                  <button className="danger-ghost" onClick={() => void onDeleteRoot(root)}>放弃同步</button>
                </div>
              </div>
            );
          })}
        </div>}
    </section>
  </div>;
}
