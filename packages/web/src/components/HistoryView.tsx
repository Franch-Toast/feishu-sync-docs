import React, { useMemo, useState } from "react";
import { formatDateTime, type Operation, type PruneResult, type Root } from "../api";

interface HistoryViewProps {
  operations: Operation[];
  roots: Root[];
  /** When set (root detail tab), the root filter select is hidden. */
  root?: Root;
  syncing: boolean;
  onRetryRoot: (rootId: string) => Promise<void>;
  onPrune: () => Promise<PruneResult>;
  onRefresh: () => void;
}

type StatusFilter = "all" | "succeeded" | "failed" | "running" | "queued";
type DirectionFilter = "all" | "push" | "pull" | "merge";

const DIRECTION_LABELS: Record<DirectionFilter, string> = { all: "全部方向", push: "推送 →", pull: "← 拉取", merge: "合并" };
const STATUS_LABELS: Record<StatusFilter, string> = { all: "全部状态", succeeded: "成功", failed: "失败", running: "进行中", queued: "排队中" };

export function HistoryView({ operations, roots, root, syncing, onRetryRoot, onPrune, onRefresh }: HistoryViewProps): React.JSX.Element {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [direction, setDirection] = useState<DirectionFilter>("all");
  const [rootId, setRootId] = useState<string>("all");

  const filtered = useMemo(() => operations.filter((operation) =>
    (status === "all" || operation.status === status)
    && (direction === "all" || operation.direction === direction)
    // Inside a root detail tab the list is already scoped to that root (the
    // root filter select is hidden); otherwise honor the dropdown filter.
    && (root ? true : (rootId === "all" || operation.rootId === rootId))
  ), [operations, status, direction, rootId, root]);

  const rootName = (id: string | undefined) => {
    const root = roots.find((item) => item.id === id);
    return root ? root.localPath.split(/[\\/]/).at(-1)! : "—";
  };

  return <>
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
              <td>{operation.status === "failed" && operation.rootId && <button className="link-button" disabled={syncing} onClick={() => void onRetryRoot(operation.rootId!)}>{syncing ? "…" : "重试"}</button>}</td>
            </tr>)}
          </tbody>
        </table>}
    </div>
  </>;
}
