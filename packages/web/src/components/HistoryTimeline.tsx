import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api, formatDateTime, TRIGGER_LABELS, type Commit, type EntryDiff } from "../api";
import { lineDiff, type DiffRow } from "../diff";

interface HistoryTimelineProps {
  rootId: string;
  entryId: string;
  relativePath: string;
  /** Bump to force a reload (e.g. after a sync round or a rollback). */
  revision?: number;
  /** Called after a successful rollback so the caller can refresh the preview. */
  onRolledBack: () => void;
}

/** Word-level spans for a diff row, mirroring the issue workbench renderer. */
function DiffText({ row }: { row: DiffRow }): React.JSX.Element {
  if (!row.words) return <>{row.text || " "}</>;
  return <>{row.words.map((span, index) => <span key={index} className={`word ${span.kind}`}>{span.text}</span>)}</>;
}

/** Per-document version timeline (B4): lists the commits that touched a file,
 *  lets the user diff any historical version against the current working tree,
 *  and roll the file back to it (which re-arms a manual sync so Feishu follows). */
export function HistoryTimeline({ rootId, entryId, relativePath, revision, onRolledBack }: HistoryTimelineProps): React.JSX.Element {
  const [commits, setCommits] = useState<Commit[]>();
  const [loadError, setLoadError] = useState<string>();
  const [selectedHash, setSelectedHash] = useState<string>();
  const [diff, setDiff] = useState<EntryDiff>();
  const [diffLoading, setDiffLoading] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);

  const load = useCallback((): (() => void) => {
    let cancelled = false;
    setLoadError(undefined);
    api.getEntryHistory(rootId, relativePath, 50)
      .then((list) => { if (!cancelled) setCommits(list); })
      .catch((error) => { if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
  }, [rootId, relativePath]);

  useEffect(() => load(), [load, revision]);

  // Drop the selected version whenever another document is opened.
  useEffect(() => { setSelectedHash(undefined); setDiff(undefined); }, [entryId]);

  const selectCommit = (hash: string): void => {
    if (hash === selectedHash) { setSelectedHash(undefined); setDiff(undefined); return; }
    setSelectedHash(hash);
    setDiffLoading(true);
    api.getEntryDiff(entryId, hash)
      .then((result) => setDiff(result))
      .catch(() => setDiff(undefined))
      .finally(() => setDiffLoading(false));
  };

  const rows = useMemo(() => (diff ? lineDiff(diff.baseContent, diff.currentContent) : []), [diff]);
  const changed = useMemo(() => rows.some((row) => row.kind !== "same"), [rows]);

  const rollback = async (commit: Commit): Promise<void> => {
    if (rollingBack) return;
    if (!window.confirm(`将「${relativePath}」回滚到 ${formatDateTime(commit.timestamp)} 的版本？\n该历史内容会写回本地并立即触发同步，飞书文档随之更新。`)) return;
    setRollingBack(true);
    try {
      await api.rollbackEntry(entryId, commit.hash);
      setSelectedHash(undefined);
      setDiff(undefined);
      onRolledBack();
      load();
    } finally {
      setRollingBack(false);
    }
  };

  return <div className="history-timeline">
    <div className="panel-heading">
      <div><h3>历史版本</h3><span className="muted">每次同步都会为变更的文档留下一个版本，可查看差异或回滚。</span></div>
    </div>
    {loadError && <div className="form-issue">{loadError}</div>}
    {!commits && !loadError && <p className="muted empty">加载中…</p>}
    {commits && commits.length === 0 && <p className="muted empty">该文档暂无历史版本（尚未产生基线提交）。</p>}
    {commits && commits.length > 0 && <ol className="history-list">
      {commits.map((commit) => (
        <li key={commit.hash} className={`history-item${commit.hash === selectedHash ? " selected" : ""}`}>
          <button className="history-head" onClick={() => selectCommit(commit.hash)}>
            <span className="history-when">{formatDateTime(commit.timestamp)}</span>
            <span className="history-trigger">{TRIGGER_LABELS[commit.trigger] ?? commit.trigger}</span>
            <span className="history-msg" title={commit.message}>{commit.message.replace(/\s*\[trigger=[^\]]+\]\s*/, "") || commit.hash.slice(0, 8)}</span>
          </button>
          <div className="history-actions">
            <button className="link-button" onClick={() => selectCommit(commit.hash)}>{commit.hash === selectedHash ? "收起差异" : "查看差异"}</button>
            <button className="secondary" disabled={rollingBack} onClick={() => void rollback(commit)}>{rollingBack ? "回滚中…" : "回滚到此版本"}</button>
          </div>
        </li>
      ))}
    </ol>}
    {selectedHash && <div className="history-diff panel">
      <div className="diff-label">历史版本 → 当前本地</div>
      {diffLoading && <p className="muted empty">加载差异…</p>}
      {!diffLoading && diff && <>
        {!changed && <p className="muted empty">该版本与当前内容一致，无差异。</p>}
        {changed && <table className="history-diff-table">
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} className={`diff-row ${row.kind}`}>
                <td className="line-no">{row.oldNumber ?? ""}</td>
                <td className="line-no">{row.newNumber ?? ""}</td>
                <td className="line-text"><DiffText row={row} /></td>
              </tr>
            ))}
          </tbody>
        </table>}
      </>}
    </div>}
  </div>;
}
