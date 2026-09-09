import React, { useMemo, useState } from "react";
import { formatDateTime, type ActivityItem, type Operation, type PruneResult, type Root } from "../api";

interface HistoryViewProps {
  operations: Operation[];
  roots: Root[];
  /** When set (root detail tab), the root filter select is hidden. */
  root?: Root;
  syncing: boolean;
  /** Live activity feed (newest first) shown above the history table. */
  activity?: ActivityItem[];
  onRetryRoot: (rootId: string) => Promise<void>;
  /** Per-entry retry; used when the failed row is bound to an entry. */
  onRetryEntry?: (entryId: string) => Promise<void>;
  onPrune: () => Promise<PruneResult>;
  onRefresh: () => void;
}

type StatusFilter = "all" | "succeeded" | "failed" | "running" | "queued";
type DirectionFilter = "all" | "push" | "pull" | "merge";

const DIRECTION_LABELS: Record<DirectionFilter, string> = { all: "全部方向", push: "推送 →", pull: "← 拉取", merge: "合并" };
const STATUS_LABELS: Record<StatusFilter, string> = { all: "全部状态", succeeded: "成功", failed: "失败", running: "进行中", queued: "排队中" };

export function HistoryView({ operations, roots, root, syncing, activity, onRetryRoot, onRetryEntry, onPrune, onRefresh }: HistoryViewProps): React.JSX.Element {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [direction, setDirection] = useState<DirectionFilter>("all");
  const [rootId, setRootId] = useState<string>("all");
  const [needle, setNeedle] = useState("");
  const [retrying, setRetrying] = useState(false);

  const search = needle.trim().toLowerCase();
  const filtered = useMemo(() => operations.filter((operation) =>
    (status === "all" || operation.status === status)
    && (direction === "all" || operation.direction === direction)
    // Inside a root detail tab the list is already scoped to that root (the
    // root filter select is hidden); otherwise honor the dropdown filter.
    && (root ? true : (rootId === "all" || operation.rootId === rootId))
    // P5: filename search over the joined relative path.
    && (search === "" || (operation.relativePath ?? "").toLowerCase().includes(search))
  ), [operations, status, direction, rootId, root, search]);

  const rootName = (id: string | undefined) => {
    const item = roots.find((entry) => entry.id === id);
    return item ? item.localPath.split(/[\\/]/).at(-1)! : "—";
  };

  const retry = async (operation: Operation) => {
    if (retrying) return;
    setRetrying(true);
    try {
      // Prefer the per-entry retry when the row carries an entry binding;
      // fall back to a full root round otherwise.
      if (operation.entryId && onRetryEntry) await onRetryEntry(operation.entryId);
      else if (operation.rootId) await onRetryRoot(operation.rootId);
      onRefresh();
    } finally {
      setRetrying(false);
    }
  };

  return <>
    {activity && activity.length > 0 && <div className="panel activity-panel">
      <div className="panel-heading">
        <div><h3>运行动态</h3><span className="muted">实时同步活动（保留最近 {activity.length} 条）</span></div>
      </div>
      <ul className="activity-feed">
        {activity.map((item, index) => <li key={`${item.at}:${index}`} className={`activity-item ${item.kind}`}>
          <time className="muted">{formatDateTime(item.at)}</time>
          <span className="activity-kind">{item.kind}</span>
          <span className="activity-text">{item.text}</span>
        </li>)}
      </ul>
    </div>}
    <div className="filter-bar">
      <select value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)}>
        {(Object.keys(STATUS_LABELS) as StatusFilter[]).map((key) => <option key={key} value={key}>{STATUS_LABELS[key]}</option>)}
      </select>
      <select value={direction} onChange={(event) => setDirection(event.target.value as DirectionFilter)}>
        {(Object.keys(DIRECTION_LABELS) as DirectionFilter[]).map((key) => <option key={key} value={key}>{DIRECTION_LABELS[key]}</option>)}
      </select>
      {!root && <select value={rootId} onChange={(event) => setRootId(event.target.value)}>
        <option value="all">全部根目录</option>
        {roots.map((item) => <option key={item.id} value={item.id}>{item.localPath.split(/[\\/]/).at(-1)}</option>)}
      </select>}
      <input className="history-search" value={needle} onChange={(event) => setNeedle(event.target.value)} placeholder="搜索文件名…" />
      <span className="muted">共 {filtered.length} 条记录</span>
      <div className="filter-actions">
        <button className="danger-ghost" onClick={() => void onPrune()}>清理历史</button>
        <button className="secondary" onClick={() => onRefresh()}>刷新</button>
      </div>
    </div>
    <div className="panel">
      {filtered.length === 0
        ? <div className="empty-state"><div className="check">✓</div><strong>没有匹配的记录</strong><span>调整过滤条件或执行一次同步。</span></div>
        : <table className="op-table">
          <thead><tr><th>时间</th><th>根目录</th><th>文件</th><th>方向</th><th>操作</th><th>状态</th><th>错误</th><th></th></tr></thead>
          <tbody>
            {filtered.map((operation) => <tr key={operation.id}>
              <td data-label="时间" className="muted">{formatDateTime(operation.createdAt)}</td>
              <td data-label="根目录" className="muted">{rootName(operation.rootId)}</td>
              <td data-label="文件">{operation.relativePath ?? "—"}</td>
              <td data-label="方向" className="muted">{operation.direction}</td>
              <td data-label="操作">{operation.operation}</td>
              <td data-label="状态"><span className={`op-status ${operation.status}`}>{operation.status}</span></td>
              <td data-label="错误" className="op-error" title={operation.error}>{operation.error ?? ""}</td>
              <td>{operation.status === "failed" && (operation.entryId || operation.rootId) && <button className="link-button" disabled={syncing || retrying} onClick={() => void retry(operation)}>{syncing || retrying ? "…" : "重试"}</button>}</td>
            </tr>)}
          </tbody>
        </table>}
    </div>
  </>;
}
