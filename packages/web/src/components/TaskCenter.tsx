import React, { useCallback, useEffect, useState } from "react";
import {
  api,
  DIRECTION_LABELS,
  ERROR_CATEGORY_LABELS,
  formatDateTime,
  formatElapsed,
  OPERATION_STATUS_LABELS,
  TRIGGER_LABELS,
  type ErrorCategory,
  type Root,
  type TaskView
} from "../api";
import { Icon } from "./Icon";
import type { RoundSummary } from "../api";

interface TaskCenterProps {
  roots: Root[];
  /** Bumped by the shell whenever an operation-* event arrives, to refetch. */
  revision: number;
  syncing: boolean;
  onOpenSettings: () => void;
  /** Jump to a root's issue workbench (conflicts / missing). */
  onOpenIssues: (rootId: string) => void;
  /** Delete the finished records behind「清空已完成」and report how many went. */
  onClearCompleted: () => Promise<{ cleared: number }>;
}

const PAGE = 25;

/** A4: counters rendered as badges on a `sync-round` row. Zero-valued buckets
 *  are dropped so a quiet round stays readable. */
const ROUND_SUMMARY_LABELS: Array<{ key: keyof RoundSummary; label: string; tone?: string }> = [
  { key: "scanned", label: "扫描 {n}" },
  { key: "pushed", label: "推送 {n}", tone: "ok-badge" },
  { key: "pulled", label: "拉取 {n}", tone: "ok-badge" },
  { key: "merged", label: "合并 {n}", tone: "ok-badge" },
  { key: "conflicts", label: "冲突 {n}", tone: "conflict-badge" },
  { key: "failed", label: "失败 {n}", tone: "conflict-badge" },
  { key: "skipped", label: "跳过 {n}", tone: "paused-badge" }
];

function roundSummary(task: TaskView): React.JSX.Element | null {
  const summary = task.summary;
  if (!summary) return null;
  const items = ROUND_SUMMARY_LABELS
    .map((item) => ({ ...item, value: summary[item.key] }))
    .filter((item) => item.value > 0);
  if (items.length === 0) return <span className="badge paused-badge">无变更</span>;
  return <span className="round-summary">{items.map((item) => <span key={item.key} className={`badge ${item.tone ?? ""}`}>{item.label.replace("{n}", String(item.value))}</span>)}</span>;
}

/** Guidance for a failed task, derived from its semantic error category. */
interface Guidance {
  /** Button label; absent renders no primary action. */
  action?: string;
  onAction?: () => void;
  /** Inline hint text shown under the error category. */
  hint?: string;
  /** Whether the raw error stack can be expanded. */
  expandable?: boolean;
}

function guidanceFor(task: TaskView, handlers: { openSettings: () => void; openIssues: (rootId: string) => void; retry: () => void }): Guidance {
  const category: ErrorCategory = task.errorCategory ?? "unknown";
  switch (category) {
    case "auth":
      return { action: "前往设置修复凭证", onAction: handlers.openSettings, hint: "飞书凭证已失效，同步受阻；更新凭证后自动恢复。" };
    case "permission":
      return { action: "重试", onAction: handlers.retry, hint: "应用缺少该资源的读写权限，请在开发者后台补齐权限后重试。", expandable: true };
    case "conflict":
    case "not_found":
      return {
        action: task.rootId ? "打开异常工作台" : undefined,
        onAction: task.rootId ? () => handlers.openIssues(task.rootId!) : undefined,
        hint: category === "conflict" ? "本地与远端同时改动，需在异常工作台三方裁决。" : "远端或本地资源已不存在，请在工作台确认处理方式。",
        expandable: true
      };
    case "rate_limit":
      return { hint: "已触发飞书限流，系统按指数退避自动重试，无需手动干预。", expandable: true };
    default:
      return { action: "重试", onAction: handlers.retry, hint: "网络或未知错误，可手动重试。", expandable: true };
  }
}

export function TaskCenter({ roots, revision, syncing, onOpenSettings, onOpenIssues, onClearCompleted }: TaskCenterProps): React.JSX.Element {
  const [active, setActive] = useState<TaskView[]>([]);
  const [failed, setFailed] = useState<TaskView[]>([]);
  const [done, setDone] = useState<TaskView[]>([]);
  const [failedCursor, setFailedCursor] = useState<string>();
  const [doneCursor, setDoneCursor] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  /** Selected failed-task ids for the bulk retry / ignore toolbar (B6.3). */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const rootName = useCallback((id?: string) => {
    const item = roots.find((root) => root.id === id);
    return item ? item.localPath.split(/[\\/]/).at(-1)! : "—";
  }, [roots]);

  const markBusy = useCallback((id: string, on: boolean) => {
    setBusy((current) => {
      const next = new Set(current);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }, []);

  // First page of every group. Re-runs on revision bumps (operation-* events).
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [activePage, failedPage, donePage] = await Promise.all([
        api.listTasks({ status: "active", limit: PAGE }),
        api.listTasks({ status: "failed", limit: PAGE }),
        api.listTasks({ status: "succeeded", limit: PAGE })
      ]);
      setActive(activePage.tasks);
      setFailed(failedPage.tasks);
      setFailedCursor(failedPage.nextCursor);
      setDone(donePage.tasks);
      setDoneCursor(donePage.nextCursor);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load, revision]);
  // Light polling so the center stays fresh even without socket events.
  useEffect(() => { const timer = window.setInterval(() => void load(), 5000); return () => window.clearInterval(timer); }, [load]);

  const loadMoreFailed = async () => {
    if (!failedCursor) return;
    const page = await api.listTasks({ status: "failed", limit: PAGE, cursor: failedCursor });
    setFailed((current) => [...current, ...page.tasks]);
    setFailedCursor(page.nextCursor);
  };

  const loadMoreDone = async () => {
    if (!doneCursor) return;
    const page = await api.listTasks({ status: "succeeded", limit: PAGE, cursor: doneCursor });
    setDone((current) => [...current, ...page.tasks]);
    setDoneCursor(page.nextCursor);
  };

  const retry = async (task: TaskView) => {
    if (busy.has(task.id)) return;
    markBusy(task.id, true);
    setNotice(undefined);
    try {
      await api.retryTask(task.id);
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      markBusy(task.id, false);
    }
  };

  const cancel = async (task: TaskView) => {
    if (busy.has(task.id)) return;
    markBusy(task.id, true);
    setNotice(undefined);
    try {
      await api.cancelTask(task.id);
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      markBusy(task.id, false);
    }
  };

  const clearCompleted = async () => {
    if (!window.confirm("清空「最近完成」分组里的操作记录？失败任务会保留。")) return;
    setNotice(undefined);
    try {
      const result = await onClearCompleted();
      setNotice(`已清理 ${result.cleared} 条操作记录。`);
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const toggleExpand = (id: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const toggleSelected = (id: string, on: boolean) => setSelected((current) => {
    const next = new Set(current);
    if (on) next.add(id); else next.delete(id);
    return next;
  });

  const toggleSelectAll = (tasks: TaskView[], on: boolean) => setSelected((current) => {
    const next = new Set(current);
    for (const task of tasks) { if (on) next.add(task.id); else next.delete(task.id); }
    return next;
  });

  /** Bulk retry the selected failed tasks (B6.3). */
  const batchRetry = async () => {
    const ids = failed.filter((task) => selected.has(task.id)).map((task) => task.id);
    if (ids.length === 0) return;
    setBusy(new Set(ids));
    setNotice(undefined);
    try {
      const result = await api.batchRetryTasks(ids);
      setNotice(`已重新入队 ${result.accepted}/${result.total} 条任务。`);
      setSelected(new Set());
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(new Set());
    }
  };

  /** Bulk ignore the entries behind the selected failed tasks (B6.3): the
   *  workbench stops evaluating them until the user restores them. */
  const batchIgnore = async () => {
    const entryIds = failed.filter((task) => selected.has(task.id) && task.entryId).map((task) => task.entryId!);
    if (entryIds.length === 0) { setNotice("选中的任务没有对应条目，无法忽略。"); return; }
    if (!window.confirm(`忽略选中的 ${entryIds.length} 个条目？忽略后不再参与同步评估，并会离开「失败待处理」队列，可在异常工作台恢复。`)) return;
    setBusy(new Set(entryIds));
    setNotice(undefined);
    try {
      const result = await api.batchEntries(entryIds, "ignore");
      setNotice(`已忽略 ${result.accepted}/${result.total} 个条目${result.failed > 0 ? `，${result.failed} 个失败` : ""}。`);
      setSelected(new Set());
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(new Set());
    }
  };

  const selectedFailed = failed.filter((task) => selected.has(task.id));

  /** B6.6: wall-clock duration from queueing to completion, backoff included. */
  const elapsed = (task: TaskView) => formatElapsed(task.createdAt, task.completedAt);
  const retryLabel = (task: TaskView) => {
    const max = task.maxRetries ?? 3;
    return task.retryCount > 0 ? `${task.retryCount}/${max}` : "—";
  };

  const row = (task: TaskView, group: "active" | "failed" | "done"): React.JSX.Element => {
    const guidance = group === "failed" ? guidanceFor(task, { openSettings: onOpenSettings, openIssues: onOpenIssues, retry: () => void retry(task) }) : undefined;
    const isOpen = expanded.has(task.id);
    return <React.Fragment key={task.id}>
      <tr className={selected.has(task.id) ? "selected" : undefined}>
        {group === "failed" && <td data-label="选择" className="select-cell">
          <input type="checkbox" aria-label={`选择 ${task.relativePath ?? task.id}`} checked={selected.has(task.id)} onChange={(event) => toggleSelected(task.id, event.target.checked)} />
        </td>}
        <td data-label="文件" className="task-file">
          {task.relativePath
            ? <>{task.relativePath}{task.kind === "asset" && <small className="muted"> · 附件</small>}</>
            : <><span className="muted">整轮同步 · {rootName(task.rootId)}</span>{roundSummary(task)}</>}
        </td>
        <td data-label="根目录" className="muted">{rootName(task.rootId)}</td>
        <td data-label="方向" className="muted">{DIRECTION_LABELS[task.direction] ?? task.direction}</td>
        <td data-label="触发源" className="muted">{task.trigger ? TRIGGER_LABELS[task.trigger] : "—"}</td>
        <td data-label="状态"><span className={`op-status ${task.status}`}>{OPERATION_STATUS_LABELS[task.status] ?? task.status}</span></td>
        <td data-label="耗时" className="muted">{elapsed(task)}</td>
        <td data-label="重试" className="muted">{retryLabel(task)}</td>
        <td data-label="错误" className="task-error">
          {group === "failed"
            ? <>
              <span className={`error-category ${task.errorCategory ?? "unknown"}`}>{ERROR_CATEGORY_LABELS[task.errorCategory ?? "unknown"]}</span>
              {guidance?.hint && <small className="muted task-hint">{guidance.hint}</small>}
            </>
            : <span className="muted">—</span>}
        </td>
        <td data-label="操作" className="task-actions">
          {group === "active" && <button className="link-button" disabled={syncing || busy.has(task.id)} onClick={() => void cancel(task)}>{busy.has(task.id) ? "…" : "取消"}</button>}
          {group === "failed" && guidance?.action && <button className="link-button" disabled={syncing || busy.has(task.id)} onClick={guidance.onAction}>{busy.has(task.id) ? "…" : guidance.action}</button>}
          {guidance?.expandable && task.error && <button className="link-button" onClick={() => toggleExpand(task.id)}>{isOpen ? "收起详情" : "错误详情"}</button>}
        </td>
      </tr>
      {isOpen && task.error && <tr className="task-stack-row"><td colSpan={10}><pre className="task-stack">{task.error}</pre></td></tr>}
    </React.Fragment>;
  };

  const table = (tasks: TaskView[], group: "active" | "failed" | "done", emptyText: string): React.JSX.Element => (
    tasks.length === 0
      ? <div className="empty-state"><div className="check">✓</div><strong>{emptyText}</strong></div>
      : <table className="op-table task-table">
        <thead><tr>
          {group === "failed" && <th className="select-cell">
            <input
              type="checkbox"
              aria-label="全选失败任务"
              checked={tasks.every((task) => selected.has(task.id))}
              onChange={(event) => toggleSelectAll(tasks, event.target.checked)}
            />
          </th>}
          <th>文件</th><th>根目录</th><th>方向</th><th>触发源</th><th>状态</th><th>耗时</th><th>重试</th><th>错误类别</th><th></th>
        </tr></thead>
        <tbody>{tasks.map((task) => row(task, group))}</tbody>
      </table>
  );

  return <div className="task-center">
    <div className="page-heading">
      <div><span className="eyebrow">WORKSPACE / TASKS</span><h2>任务中心</h2><p>每一轮同步都会以「整轮同步」任务出现在进行中；失败的任务自动重试 3 次后停在失败待处理，直到你重试或忽略。</p></div>
      <div className="heading-actions">
        <button className="secondary" disabled={loading} onClick={() => void load()}><Icon name="sync" size={14} />{loading ? "刷新中…" : "刷新"}</button>
        <button className="danger-ghost" disabled={done.length === 0} onClick={() => void clearCompleted()}>清空已完成</button>
      </div>
    </div>

    {notice && <div className="form-notice">{notice}</div>}

    <div className="panel task-group">
      <div className="panel-heading"><div><h3>进行中</h3><span className="muted">排队与正在同步的任务，含本轮整轮同步（{active.length}）</span></div></div>
      {table(active, "active", "当前没有进行中的任务")}
    </div>

    <div className="panel task-group">
      <div className="panel-heading">
        <div><h3>失败待处理</h3><span className="muted">每个条目只保留一条，重试或忽略后立即离开本队列（{failed.length}）</span></div>
        {failed.length > 0 && <div className="batch-bar">
          <span className="muted">已选 {selectedFailed.length} 项</span>
          <button className="secondary" disabled={selectedFailed.length === 0} onClick={() => void batchRetry()}>批量重试</button>
          <button className="danger-ghost" disabled={selectedFailed.length === 0} onClick={() => void batchIgnore()}>批量忽略</button>
          {selectedFailed.length > 0 && <button className="link-button" onClick={() => setSelected(new Set())}>取消选择</button>}
        </div>}
      </div>
      {table(failed, "failed", "没有失败的任务，一切正常")}
      {failedCursor && <div className="load-more"><button className="secondary" onClick={() => void loadMoreFailed()}>加载更多失败任务</button></div>}
    </div>

    <div className="panel task-group">
      <div className="panel-heading"><div><h3>最近完成</h3><span className="muted">最近成功的同步任务（{done.length}）· 最早 {done.length > 0 ? formatDateTime(done[done.length - 1]!.createdAt) : "—"}</span></div></div>
      {table(done, "done", "还没有完成的任务")}
      {doneCursor && <div className="load-more"><button className="secondary" onClick={() => void loadMoreDone()}>加载更多已完成任务</button></div>}
    </div>
  </div>;
}
