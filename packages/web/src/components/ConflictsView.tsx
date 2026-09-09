import React, { useEffect, useMemo, useState } from "react";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import CodeMirror from "@uiw/react-codemirror";
import { api, ENTRY_STATUS_LABELS, formatDateTime, type Conflict, type Resolution } from "../api";
import { applyHunks, clashingHunkIndices, computeHunks, lineDiff, type DiffRow, type Hunk } from "../diff";
import { MarkdownPreview } from "./MarkdownPreview";

type WorkspaceMode = "compare" | "edit" | "preview";
type ListTab = "open" | "history";

interface ConflictsViewProps {
  conflicts: Conflict[];
  rootId?: string;
  selected?: Conflict;
  onSelect: (conflict: Conflict | undefined) => void;
  onResolve: (id: string, resolution: Resolution, mergedContent?: string) => Promise<void>;
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

export function ConflictsView({ conflicts, selected, onSelect, onResolve, onRefresh }: ConflictsViewProps): React.JSX.Element {
  const [tab, setTab] = useState<ListTab>("open");
  const [history, setHistory] = useState<Conflict[]>([]);
  const [mode, setMode] = useState<WorkspaceMode>("compare");
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [showBase, setShowBase] = useState(false);
  const [editorValue, setEditorValue] = useState("");
  const [expandedHistory, setExpandedHistory] = useState<string | undefined>();

  useEffect(() => {
    api.listConflicts("all").then((list) => setHistory(list.filter((item) => item.status !== "open"))).catch(() => setHistory([]));
  }, [onRefresh, conflicts.length]);

  // Reset the workspace whenever another conflict is opened.
  useEffect(() => {
    setApplied(new Set());
    setMode("compare");
    setShowBase(false);
    setExpandedHistory(undefined);
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

  if (!selected) {
    const list = tab === "open" ? conflicts : history;
    return <>
      <div className="page-heading">
        <div><span className="eyebrow">WORKSPACE / CONFLICTS</span><h2>冲突工作台</h2><p>本地和飞书同时修改的文档会停在这里，解决后才会继续同步。</p></div>
        <div className="heading-actions"><button className="secondary" onClick={() => onRefresh()}>刷新状态</button></div>
      </div>
      <div className="root-tabs">
        <button className={tab === "open" ? "active" : ""} onClick={() => setTab("open")}>待处理 ({conflicts.length})</button>
        <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>已解决历史 ({history.length})</button>
      </div>
      <div className="panel">
        <div className="panel-heading"><div><h3>{tab === "open" ? "待解决冲突" : "已解决冲突"}</h3><span className="muted">{tab === "open" ? "选择一个文档开始合并" : "点击展开当时的对比"}</span></div></div>
        {list.length === 0
          ? <div className="empty-state"><div className="check">✓</div><strong>{tab === "open" ? "当前没有冲突" : "还没有解决记录"}</strong><span>{tab === "open" ? "后台会持续检查本地目录和飞书文档。" : "解决冲突后会出现在这里，可回溯当时的版本差异。"}</span></div>
          : <div className="conflict-list">
            {list.map((conflict) => (
              <div key={conflict.id}>
                <button className="conflict-row" onClick={() => tab === "open" ? onSelect(conflict) : setExpandedHistory(expandedHistory === conflict.id ? undefined : conflict.id)}>
                  <span className="conflict-icon">{tab === "open" ? "!" : "✓"}</span>
                  <span className="conflict-info">
                    <strong>{conflict.relativePath ?? conflict.id.slice(0, 12)}</strong>
                    <small>{tab === "open"
                      ? `产生于 ${formatDateTime(conflict.createdAt)}`
                      : `${conflict.status === "aborted" ? "已搁置" : "已解决"} · ${formatDateTime(conflict.resolvedAt)}`}</small>
                  </span>
                  <span className="arrow">{tab === "open" ? "→" : expandedHistory === conflict.id ? "↑" : "↓"}</span>
                </button>
                {tab === "history" && expandedHistory === conflict.id && (
                  <div className="history-detail">
                    <div className="diff-grid two">
                      <SplitPane base={conflict.baseContent} target={conflict.status === "aborted" ? conflict.localContent : conflict.mergedContent ?? conflict.localContent} side="local" label="BASE / 当时基线" />
                      <SplitPane base={conflict.baseContent} target={conflict.mergedContent ?? conflict.localContent} side="remote" label={conflict.status === "aborted" ? "LOCAL / 本地版本" : "MERGED / 当时采用的结果"} />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>}
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
              {clashedKeys.has(hunk.key) && <span className="hunk-warning">与另一侧重叠，后采用的会覆盖</span>}
              <button className="secondary" onClick={() => toggleHunk(hunk.key)}>{applied.has(hunk.key) ? "撤回" : "采用"}</button>
            </div>
          ))}
        </div>
      </div>}
      <div className="diff-grid two">
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
      </div>
      <CodeMirror value={editorValue} height="380px" extensions={[markdown(), oneDark]} onChange={setEditorValue} theme="dark" />
    </div>}

    {mode === "preview" && <div className="panel preview-panel">
      <div className="panel-heading"><div><h3>合并结果预览</h3><span className="muted">文档内相对路径图片通过服务端代理加载</span></div></div>
      <MarkdownPreview source={resolutionContent} rootId={selected.rootId} className="padded" />
    </div>}

    <div className="resolve-bar">
      <button className="secondary" onClick={() => void onResolve(selected.id, "local")}>全部采用本地</button>
      <button className="secondary" onClick={() => void onResolve(selected.id, "remote")}>全部采用飞书</button>
      <button className="primary" onClick={() => void onResolve(selected.id, "merged", resolutionContent)}>解决并同步{appliedHunks.length > 0 ? `（已合并 ${appliedHunks.length} 块）` : ""}</button>
    </div>
  </div>;
}

export const STATUS_LABELS = ENTRY_STATUS_LABELS;
