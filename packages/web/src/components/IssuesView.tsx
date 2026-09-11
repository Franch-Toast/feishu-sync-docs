import React, { useEffect, useMemo, useState } from "react";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import CodeMirror from "@uiw/react-codemirror";
import { api, formatDateTime, type Conflict, type Entry, type Resolution } from "../api";
import { applyHunks, clashingHunkIndices, computeHunks, lineDiff, type DiffRow, type Hunk } from "../diff";
import { MarkdownPreview } from "./MarkdownPreview";

type WorkspaceMode = "compare" | "edit" | "preview";
/** Issue groups: two-side conflicts, remote-missing, local-missing, ignored. */
export type IssueGroup = "conflicts" | "remote-missing" | "local-missing" | "ignored";

const GROUP_LABELS: Record<IssueGroup, string> = {
  conflicts: "双边冲突",
  "remote-missing": "远端缺失",
  "local-missing": "本地缺失",
  ignored: "已忽略"
};

const GROUP_EMPTY: Record<IssueGroup, { title: string; hint: string }> = {
  conflicts: { title: "当前没有冲突", hint: "本地和飞书同时修改的文档会停在这里。" },
  "remote-missing": { title: "没有远端缺失条目", hint: "飞书侧被删除的文档会出现在这里，可一键重新创建。" },
  "local-missing": { title: "没有本地缺失条目", hint: "本地被删除的文档会出现在这里，可从飞书一键拉回。" },
  ignored: { title: "没有已忽略条目", hint: "在异常列表中忽略的条目会出现在这里，可随时恢复评估。" }
};

interface IssuesViewProps {
  /** Open conflicts, already filtered to this root. */
  conflicts: Conflict[];
  /** All entries of this root (from the tree API) for missing/ignored groups. */
  entries: Entry[];
  rootId: string;
  /** Group to open first (driven by RootDetail's initialTab). */
  initialGroup?: IssueGroup;
  selected?: Conflict;
  onSelect: (conflict: Conflict | undefined) => void;
  onResolve: (id: string, resolution: Resolution, mergedContent?: string) => Promise<void>;
  onSyncEntry: (entryId: string) => Promise<void>;
  onIgnoreEntry: (entryId: string, ignored: boolean) => Promise<void>;
  /** One-click resync of every missing entry; returns the processed count. */
  onSyncMissing: () => Promise<number>;
  onRefresh: () => void;
}

interface KeyedHunk extends Hunk {
  key: string;
}

function describeHunk(hunk: Hunk): string {
  if (hunk.baseCount === 0) return `插入 ${hunk.lines.length} 行`;
  if (hunk.lines.length === 0) return `删除 ${hunk.baseCount} 行`;
  if (hunk.lines.length === hunk.baseCount) return `替换 ${hunk.baseCount} 行`;
  return `将 ${hunk.baseCount} 行替换为 ${hunk.lines.length} 行`;
}

function LineText({ row }: { row: DiffRow }): React.JSX.Element {
  if (!row.words) return <>{row.text || " "}</>;
  return <>{row.words.map((span, index) => <span key={index} className={`word ${span.kind}`}>{span.text}</span>)}</>;
}

function SplitPane({ base, target, side, label }: { base: string; target: string; side: "local" | "remote"; label: string }): React.JSX.Element {
  const rows = useMemo(() => lineDiff(base, target), [base, target]);
  return <div className={`diff-pane split ${side}`}>
    <div className="diff-label">{label}</div>
    <table className="split-table">
      <tbody>
        {rows.map((row, index) => (
          <tr key={index} className={`diff-row ${row.kind}`}>
            <td className="line-no">{row.kind === "del" ? "" : row.newNumber ?? ""}</td>
            <td className="line-text"><LineText row={row} /></td>
          </tr>
        ))}
        {rows.length === 0 && <tr><td className="line-no" /><td className="line-text muted">(空文档)</td></tr>}
      </tbody>
    </table>
  </div>;
}

function BasePane({ content }: { content: string }): React.JSX.Element {
  const rows = content === "" ? [] : content.replace(/\n$/, "").split("\n");
  return <div className="diff-pane base">
    <div className="diff-label">BASE / 上次一致版本</div>
    <table className="split-table">
      <tbody>
        {rows.map((line, index) => <tr key={index} className="diff-row same"><td className="line-no">{index + 1}</td><td className="line-text">{line || " "}</td></tr>)}
        {rows.length === 0 && <tr><td className="line-no" /><td className="line-text muted">(空文档)</td></tr>}
      </tbody>
    </table>
  </div>;
}

export function IssuesView({ conflicts, entries, rootId, initialGroup, selected, onSelect, onResolve, onSyncEntry, onIgnoreEntry, onSyncMissing, onRefresh }: IssuesViewProps): React.JSX.Element {
  const [group, setGroup] = useState<IssueGroup>(initialGroup ?? "conflicts");
  const [mode, setMode] = useState<WorkspaceMode>("compare");
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [showBase, setShowBase] = useState(false);
  const [editorValue, setEditorValue] = useState("");
  const [busyEntry, setBusyEntry] = useState<string | undefined>();
  const [missingBusy, setMissingBusy] = useState(false);
  /** Checked entry ids for the bulk toolbar of the current group (B6.3);
   *  named apart from the `selected` conflict prop. */
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchNotice, setBatchNotice] = useState<string>();

  // Follow the requested group when the detail page re-opens with a target.
  useEffect(() => {
    if (initialGroup) setGroup(initialGroup);
  }, [initialGroup, rootId]);

  const remoteMissing = useMemo(() => entries.filter((entry) => entry.status === "remote-missing" && !entry.ignoredAt), [entries]);
  const localMissing = useMemo(() => entries.filter((entry) => entry.status === "local-missing" && !entry.ignoredAt), [entries]);
  const ignored = useMemo(() => entries.filter((entry) => entry.ignoredAt), [entries]);
  const missingCount = remoteMissing.length + localMissing.length;

  /** Entries listed by a group; the conflict group has no bulk actions. */
  const groupEntries = (key: IssueGroup): Entry[] =>
    key === "remote-missing" ? remoteMissing : key === "local-missing" ? localMissing : key === "ignored" ? ignored : [];

  // Switching group or root drops a selection that no longer maps to visible rows.
  useEffect(() => { setCheckedIds(new Set()); setBatchNotice(undefined); }, [group, rootId]);

  const toggleSelect = (id: string, on: boolean) => setCheckedIds((current) => {
    const next = new Set(current);
    if (on) next.add(id); else next.delete(id);
    return next;
  });

  const toggleSelectAll = (items: Entry[], on: boolean) => setCheckedIds((current) => {
    const next = new Set(current);
    for (const item of items) { if (on) next.add(item.entryId); else next.delete(item.entryId); }
    return next;
  });

  /** Apply one bulk action to the selected entries of the open group (B6.3). */
  const runBatch = async (action: "retry" | "ignore" | "unignore") => {
    const ids = groupEntries(group).filter((entry) => checkedIds.has(entry.entryId)).map((entry) => entry.entryId);
    if (ids.length === 0) return;
    if (action !== "retry" && !window.confirm(`${action === "ignore" ? "忽略" : "恢复"}选中的 ${ids.length} 个条目？`)) return;
    setBatchBusy(true);
    setBatchNotice(undefined);
    try {
      const result = await api.batchEntries(ids, action);
      const verb = action === "retry" ? "已重新同步" : action === "ignore" ? "已忽略" : "已恢复";
      setBatchNotice(`${verb} ${result.accepted}/${result.total} 个条目${result.failed > 0 ? `，${result.failed} 个失败` : ""}。`);
      setCheckedIds(new Set());
      onRefresh();
    } catch (error) {
      setBatchNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBatchBusy(false);
    }
  };

  // Reset the workspace whenever another conflict is opened.
  useEffect(() => {
    setApplied(new Set());
    setMode("compare");
    setShowBase(false);
  }, [selected?.id]);

  const localHunks = useMemo<KeyedHunk[]>(() => {
    if (!selected) return [];
    return computeHunks(selected.baseContent, selected.localContent, "local").map((hunk, index) => ({ ...hunk, key: `local:${index}` }));
  }, [selected?.id, selected?.baseContent, selected?.localContent]);

  const remoteHunks = useMemo<KeyedHunk[]>(() => {
    if (!selected) return [];
    return computeHunks(selected.baseContent, selected.remoteContent, "remote").map((hunk, index) => ({ ...hunk, key: `remote:${index}` }));
  }, [selected?.id, selected?.baseContent, selected?.remoteContent]);

  const allHunks = useMemo(() => [...localHunks, ...remoteHunks], [localHunks, remoteHunks]);
  const appliedHunks = useMemo(() => allHunks.filter((hunk) => applied.has(hunk.key)), [allHunks, applied]);
  const clashedKeys = useMemo(() => {
    const clashes = clashingHunkIndices(appliedHunks);
    const keys = new Set<string>();
    appliedHunks.forEach((hunk, index) => { if (clashes.has(index)) keys.add(hunk.key); });
    return keys;
  }, [appliedHunks]);
  const mergedContent = useMemo(
    () => (selected ? applyHunks(selected.baseContent, appliedHunks) : ""),
    [selected?.baseContent, appliedHunks]
  );

  const runEntryAction = async (entryId: string, action: () => Promise<void>) => {
    setBusyEntry(entryId);
    try {
      await action();
      onRefresh();
    } finally {
      setBusyEntry(undefined);
    }
  };

  const runSyncMissing = async () => {
    setMissingBusy(true);
    try {
      await onSyncMissing();
      onRefresh();
    } finally {
      setMissingBusy(false);
    }
  };

  if (!selected) {
    const groupCounts: Record<IssueGroup, number> = {
      conflicts: conflicts.length,
      "remote-missing": remoteMissing.length,
      "local-missing": localMissing.length,
      ignored: ignored.length
    };
    const missingEntries = group === "remote-missing" ? remoteMissing : group === "local-missing" ? localMissing : [];
    const selectable = groupEntries(group);
    const selectedCount = selectable.filter((entry) => checkedIds.has(entry.entryId)).length;
    return <>
      <div className="page-heading">
        <div><span className="eyebrow">WORKSPACE / ISSUES</span><h2>异常工作台</h2><p>冲突与缺失条目集中在这里：逐个解决，或勾选后批量处理。</p></div>
        <div className="heading-actions"><button className="secondary" onClick={() => onRefresh()}>刷新状态</button></div>
      </div>
      <div className="root-tabs">
        {(Object.keys(GROUP_LABELS) as IssueGroup[]).map((key) => (
          <button key={key} className={group === key ? "active" : ""} onClick={() => setGroup(key)}>
            {GROUP_LABELS[key]} ({groupCounts[key]})
          </button>
        ))}
      </div>
      <div className="panel">
        <div className="panel-heading">
          <div>
            <h3>{GROUP_LABELS[group]}</h3>
            <span className="muted">{
              group === "conflicts" ? "选择一个文档开始合并"
              : group === "ignored" ? "恢复后重新参与扫描与同步"
              : "单条同步或忽略，也可以勾选后批量处理"}</span>
          </div>
          {selectable.length > 0 && <div className="batch-bar">
            <label className="select-all">
              <input
                type="checkbox"
                aria-label="全选当前分组"
                checked={selectable.every((entry) => checkedIds.has(entry.entryId))}
                onChange={(event) => toggleSelectAll(selectable, event.target.checked)}
              />
              全选
            </label>
            <span className="muted">已选 {selectedCount} 项</span>
            {group !== "ignored" && <button className="secondary" disabled={batchBusy || selectedCount === 0} onClick={() => void runBatch("retry")}>{batchBusy ? "处理中…" : "批量同步"}</button>}
            {group !== "ignored" && <button className="danger-ghost" disabled={batchBusy || selectedCount === 0} onClick={() => void runBatch("ignore")}>批量忽略</button>}
            {group === "ignored" && <button className="secondary" disabled={batchBusy || selectedCount === 0} onClick={() => void runBatch("unignore")}>{batchBusy ? "处理中…" : "批量恢复"}</button>}
            {selectedCount > 0 && <button className="link-button" onClick={() => setCheckedIds(new Set())}>取消选择</button>}
          </div>}
          {(group === "remote-missing" || group === "local-missing") && missingEntries.length > 0 &&
            <button className="primary" disabled={missingBusy} onClick={() => void runSyncMissing()}>{missingBusy ? "同步中…" : "一键同步全部缺失"}</button>}
        </div>
        {batchNotice && <div className="form-notice">{batchNotice}</div>}
        {group === "conflicts" && (conflicts.length === 0
          ? <div className="empty-state"><div className="check">✓</div><strong>{GROUP_EMPTY[group].title}</strong><span>{GROUP_EMPTY[group].hint}</span></div>
          : <div className="conflict-list">
            {conflicts.map((conflict) => (
              <button key={conflict.id} className="conflict-row" onClick={() => onSelect(conflict)}>
                <span className="conflict-icon">!</span>
                <span className="conflict-info">
                  <strong>{conflict.relativePath ?? conflict.id.slice(0, 12)}</strong>
                  <small>{conflict.collidingToken ? "远端同名文档已被占用" : "本地与飞书同时修改"} · 产生于 {formatDateTime(conflict.createdAt)}</small>
                </span>
                <span className="arrow">→</span>
              </button>
            ))}
          </div>)}
        {(group === "remote-missing" || group === "local-missing") && (missingEntries.length === 0
          ? <div className="empty-state"><div className="check">✓</div><strong>{GROUP_EMPTY[group].title}</strong><span>{GROUP_EMPTY[group].hint}</span></div>
          : <div className="conflict-list">
            {missingEntries.map((entry) => (
              <div key={entry.entryId} className={`conflict-row issue-row${checkedIds.has(entry.entryId) ? " selected" : ""}`}>
                <input
                  type="checkbox"
                  className="row-select"
                  aria-label={`选择 ${entry.relativePath}`}
                  checked={checkedIds.has(entry.entryId)}
                  onChange={(event) => toggleSelect(entry.entryId, event.target.checked)}
                />
                <span className="conflict-icon">{group === "remote-missing" ? "☁" : "💻"}</span>
                <span className="conflict-info">
                  <strong>{entry.relativePath}</strong>
                  <small>{group === "remote-missing" ? "飞书侧已不存在，同步将重新创建远端文档" : "本地文件已不存在，同步将从飞书拉回"}</small>
                </span>
                <span className="issue-row-actions">
                  <button className="secondary" disabled={busyEntry === entry.entryId} onClick={() => void runEntryAction(entry.entryId, () => onSyncEntry(entry.entryId))}>{busyEntry === entry.entryId ? "同步中…" : "同步"}</button>
                  <button className="danger-ghost" disabled={busyEntry === entry.entryId} onClick={() => void runEntryAction(entry.entryId, () => onIgnoreEntry(entry.entryId, true))}>忽略</button>
                </span>
              </div>
            ))}
          </div>)}
        {group === "ignored" && (ignored.length === 0
          ? <div className="empty-state"><div className="check">✓</div><strong>{GROUP_EMPTY[group].title}</strong><span>{GROUP_EMPTY[group].hint}</span></div>
          : <div className="conflict-list">
            {ignored.map((entry) => (
              <div key={entry.entryId} className={`conflict-row issue-row${checkedIds.has(entry.entryId) ? " selected" : ""}`}>
                <input
                  type="checkbox"
                  className="row-select"
                  aria-label={`选择 ${entry.relativePath}`}
                  checked={checkedIds.has(entry.entryId)}
                  onChange={(event) => toggleSelect(entry.entryId, event.target.checked)}
                />
                <span className="conflict-icon">⊘</span>
                <span className="conflict-info">
                  <strong>{entry.relativePath}</strong>
                  <small>忽略于 {formatDateTime(entry.ignoredAt)} · 当前状态 {entry.status}</small>
                </span>
                <span className="issue-row-actions">
                  <button className="secondary" disabled={busyEntry === entry.entryId} onClick={() => void runEntryAction(entry.entryId, () => onIgnoreEntry(entry.entryId, false))}>{busyEntry === entry.entryId ? "恢复中…" : "恢复"}</button>
                </span>
              </div>
            ))}
          </div>)}
      </div>
    </>;
  }

  const toggleHunk = (key: string) => {
    setApplied((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const switchMode = (next: WorkspaceMode) => {
    if (next === "edit" && mode !== "edit") setEditorValue(mergedContent);
    setMode(next);
  };

  const resolutionContent = mode === "edit" ? editorValue : mergedContent;

  // B4: a title collision is not a content conflict — the remote document is
  // owned by another entry, so the merge workbench would be misleading. Offer
  // the three actions the user can actually take instead of throwing.
  if (selected.collidingToken) {
    return <div className="conflict-view">
      <div className="conflict-toolbar">
        <button className="back" onClick={() => onSelect(undefined)}>← 返回列表</button>
        <div>
          <strong>{selected.relativePath ?? `冲突 ${selected.id.slice(0, 8)}`}</strong>
          <span className="badge conflict-badge">同名冲突</span>
        </div>
        <button className="danger-ghost" onClick={() => void onResolve(selected.id, "abort")}>暂不处理</button>
      </div>
      <div className="panel collision-panel">
        <div className="panel-heading">
          <div><h3>飞书目标文件夹里已有同名文档</h3><span className="muted">{selected.reason || `远端文档（${selected.collidingToken}）已绑定到另一个条目，同步不猜测归属，也不会自动删除任何一侧。`}</span></div>
        </div>
        <ol className="collision-options">
          <li>
            <div className="collision-option-head"><strong>重命名本地文件后重新推送</strong><span className="badge ok-badge">推荐</span></div>
            <span className="muted">远端标题由文件名推导。把本地 <code>{selected.relativePath}</code> 改成别的名字，再点「已重命名，重新检测」，碰撞会自然消失。</span>
            <div className="collision-option-actions"><button className="secondary" onClick={() => onRefresh()}>已重命名，重新检测</button></div>
          </li>
          <li>
            <div className="collision-option-head"><strong>采用该远端文档</strong></div>
            <span className="muted">把那份飞书文档改绑到当前条目（本地文件内容会被远端内容覆盖）；原本持有它的条目下一轮会按自己的文件名重新创建文档，不会丢内容。</span>
            <div className="collision-option-actions"><button className="secondary" onClick={() => void onResolve(selected.id, "remote")}>采用该远端文档</button></div>
          </li>
          <li>
            <div className="collision-option-head"><strong>忽略</strong></div>
            <span className="muted">不再评估该条目，也会离开「失败待处理」队列；可在「已忽略」分组随时恢复。</span>
            <div className="collision-option-actions"><button className="danger-ghost" onClick={() => void runEntryAction(selected.entryId, () => onIgnoreEntry(selected.entryId, true))}>忽略该条目</button></div>
          </li>
        </ol>
      </div>
    </div>;
  }

  return <div className="conflict-view">
    <div className="conflict-toolbar">
      <button className="back" onClick={() => onSelect(undefined)}>← 返回列表</button>
      <div>
        <strong>{selected.relativePath ?? `冲突 ${selected.id.slice(0, 8)}`}</strong>
        <span className="badge">需要处理</span>
      </div>
      <button className="danger-ghost" onClick={() => void onResolve(selected.id, "abort")}>暂不处理</button>
    </div>

    <div className="root-tabs">
      <button className={mode === "compare" ? "active" : ""} onClick={() => switchMode("compare")}>分栏对比</button>
      <button className={mode === "edit" ? "active" : ""} onClick={() => switchMode("edit")}>编辑合并结果</button>
      <button className={mode === "preview" ? "active" : ""} onClick={() => switchMode("preview")}>预览渲染</button>
    </div>

    {mode === "compare" && <>
      {allHunks.length > 0 && <div className="panel hunk-panel">
        <div className="panel-heading">
          <div><h3>变更块</h3><span className="muted">逐块采用某一侧的修改，也可以进入编辑模式手动合并</span></div>
          <div className="heading-actions"><button className="secondary" onClick={() => setApplied(new Set())}>全部还原</button></div>
        </div>
        <div className="hunk-list">
          {allHunks.map((hunk) => (
            <div key={hunk.key} className={`hunk-item${applied.has(hunk.key) ? " applied" : ""}${clashedKeys.has(hunk.key) ? " clash" : ""}`}>
              <span className={`hunk-side ${hunk.side}`}>{hunk.side === "local" ? "本地" : "飞书"}</span>
              <span className="hunk-desc">@ 第 {hunk.baseStart + 1} 行 · {describeHunk(hunk)}</span>
              {clashedKeys.has(hunk.key) && <span className="hunk-warning">与另一侧重叠</span>}
              <button className="secondary" onClick={() => toggleHunk(hunk.key)}>{applied.has(hunk.key) ? "撤回" : "采用"}</button>
            </div>
          ))}
        </div>
      </div>}
      <div className={showBase ? "diff-grid three" : "diff-grid two"}>
        {showBase && <BasePane content={selected.baseContent} />}
        <SplitPane base={selected.baseContent} target={selected.localContent} side="local" label="LOCAL / 本地版本" />
        <SplitPane base={selected.baseContent} target={selected.remoteContent} side="remote" label="REMOTE / 飞书版本" />
      </div>
      <div className="conflict-baseline">
        <button className="secondary" onClick={() => setShowBase((value) => !value)}>{showBase ? "隐藏基线列" : "显示基线列"}</button>
        <span className="muted">行内高亮显示词级差异；绿色为该侧新增，红色为相对基线删除。</span>
      </div>
    </>}

    {mode === "edit" && <div className="merge-panel">
      <div className="merge-heading">
        <div><h3>合并结果</h3><span className="muted">已应用 {appliedHunks.length} / {allHunks.length} 个变更块；编辑结果会同时写入本地和飞书</span></div>
        <div className="heading-actions">
          <button className="secondary" onClick={() => { setEditorValue(selected.baseContent); setApplied(new Set()); }}>基于基线重新编辑</button>
        </div>
      </div>
      <CodeMirror value={editorValue} height="380px" extensions={[markdown(), oneDark]} onChange={setEditorValue} theme="dark" />
    </div>}

    {mode === "preview" && <div className="panel preview-panel">
      <div className="panel-heading"><div><h3>合并结果预览</h3><span className="muted">文档内相对路径图片通过服务端代理加载</span></div></div>
      <MarkdownPreview source={resolutionContent} rootId={rootId} className="padded" />
    </div>}

    <div className="resolve-bar">
      <button className="secondary" onClick={() => void onResolve(selected.id, "local")}>全部采用本地</button>
      <button className="secondary" onClick={() => void onResolve(selected.id, "remote")}>全部采用飞书</button>
      <button className="primary" onClick={() => void onResolve(selected.id, "merged", resolutionContent)}>解决并同步{appliedHunks.length > 0 ? `（已合并 ${appliedHunks.length} 块）` : ""}</button>
    </div>
  </div>;
}
