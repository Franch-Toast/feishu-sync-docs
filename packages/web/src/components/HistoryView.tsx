import React, { useEffect, useMemo, useState } from "react";
import { api, formatDateTime, formatElapsed, DIRECTION_LABELS as OPERATION_DIRECTION_LABELS, ERROR_CATEGORY_LABELS, OPERATION_STATUS_LABELS, TRIGGER_LABELS, type ActivityItem, type Operation, type PruneResult, type Root, type SyncTrigger } from "../api";

interface HistoryViewProps {
  operations: Operation[];
  roots: Root[];
  /** When set (root detail tab), the root filter select is hidden. */
  root?: Root;
  /** Live activity feed (newest first) shown above the history table. */
  activity?: ActivityItem[];
  onPrune: () => Promise<PruneResult>;
  onRefresh: () => void;
}

type StatusFilter = "all" | Operation["status"];
type DirectionFilter = "all" | Operation["direction"];
type TriggerFilter = "all" | SyncTrigger;

// Filters and cells share one vocabulary with the task center, so the same
// operation never reads "push"/"failed" here and 「上传」/「失败」 there.
const DIRECTION_LABELS: Record<DirectionFilter, string> = { all: "全部方向", ...OPERATION_DIRECTION_LABELS };
const STATUS_LABELS: Record<StatusFilter, string> = { all: "全部状态", ...OPERATION_STATUS_LABELS };
const TRIGGER_FILTER_LABELS: Record<TriggerFilter, string> = { all: "全部触发源", ...TRIGGER_LABELS };
/** Internal operation names as the user reads them; unknown names pass through. */
const OPERATION_LABELS: Record<string, string> = { "sync-entry": "同步条目" };

/** Server page size for cursor-based "load more" of older records. */
const PAGE = 100;

export function HistoryView({ operations, roots, root, activity, onPrune, onRefresh }: HistoryViewProps): React.JSX.Element {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [direction, setDirection] = useState<DirectionFilter>("all");
  const [trigger, setTrigger] = useState<TriggerFilter>("all");
  const [rootId, setRootId] = useState<string>("all");
  const [needle, setNeedle] = useState("");
  // Cursor pagination: `operations` is the freshest page from the shell; older
  // pages loaded on demand accumulate here and survive the 5s refresh.
  const [extra, setExtra] = useState<Operation[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // Reset paged-in older records when the inspected root scope changes.
  useEffect(() => { setExtra([]); setHasMore(true); }, [root?.id]);

  const all = useMemo(() => {
    const map = new Map<string, Operation>();
    for (const operation of operations) map.set(operation.id, operation);
    for (const operation of extra) if (!map.has(operation.id)) map.set(operation.id, operation);
    return [...map.values()];
  }, [operations, extra]);

  const search = needle.trim().toLowerCase();
  const filtered = useMemo(() => all.filter((operation) =>
    (status === "all" || operation.status === status)
    && (direction === "all" || operation.direction === direction)
    && (trigger === "all" || operation.trigger === trigger)
    // Inside a root detail tab the list is already scoped to that root (the
    // root filter select is hidden); otherwise honor the dropdown filter.
    && (root ? true : (rootId === "all" || operation.rootId === rootId))
    // P5: filename search over the joined relative path.
    && (search === "" || (operation.relativePath ?? "").toLowerCase().includes(search))
  ), [all, status, direction, trigger, rootId, root, search]);

  const rootName = (id: string | undefined) => {
    const item = roots.find((entry) => entry.id === id);
    return item ? item.localPath.split(/[\\/]/).at(-1)! : "—";
  };

  const loadMore = async () => {
    const cursor = all[all.length - 1]?.id;
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const more = await api.listOperations({ limit: PAGE, cursor, rootId: root?.id });
      setExtra((current) => [...current, ...more]);
      setHasMore(more.length === PAGE);
    } catch { /* surfaced by the shell's global error message */ }
    finally { setLoadingMore(false); }
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
      <select value={trigger} onChange={(event) => setTrigger(event.target.value as TriggerFilter)}>
        {(Object.keys(TRIGGER_FILTER_LABELS) as TriggerFilter[]).map((key) => <option key={key} value={key}>{TRIGGER_FILTER_LABELS[key]}</option>)}
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
        : <>
          <table className="op-table">
            <thead><tr><th>时间</th><th>根目录</th><th>文件</th><th>方向</th><th>触发源</th><th>操作</th><th>状态</th><th>耗时</th><th>错误</th></tr></thead>
            <tbody>
              {filtered.map((operation) => <tr key={operation.id}>
                <td data-label="时间" className="muted">{formatDateTime(operation.createdAt)}</td>
                <td data-label="根目录" className="muted">{rootName(operation.rootId)}</td>
                <td data-label="文件">{operation.relativePath ?? "—"}</td>
                <td data-label="方向" className="muted">{DIRECTION_LABELS[operation.direction]}</td>
                <td data-label="触发源" className="muted">{operation.trigger ? TRIGGER_LABELS[operation.trigger] : "—"}</td>
                <td data-label="操作">{OPERATION_LABELS[operation.operation] ?? operation.operation}</td>
                <td data-label="状态"><span className={`op-status ${operation.status}`}>{STATUS_LABELS[operation.status]}</span></td>
                {/* B6.6: wall-clock duration from queueing to completion. */}
                <td data-label="耗时" className="muted op-elapsed">{formatElapsed(operation.createdAt, operation.completedAt)}</td>
                {/* Name the semantic category like the task center does; the raw
                  *  upstream message stays one hover away. */}
                <td data-label="错误" className="op-error" title={operation.error}>{operation.errorCategory ? ERROR_CATEGORY_LABELS[operation.errorCategory] : operation.error ?? ""}</td>
              </tr>)}
            </tbody>
          </table>
          {hasMore && all.length >= PAGE && <div className="load-more">
            <button className="secondary" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "加载中…" : "加载更多历史记录"}</button>
          </div>}
        </>}
    </div>
  </>;
}
