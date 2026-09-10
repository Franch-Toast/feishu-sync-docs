import React, { useEffect, useMemo, useState } from "react";
import { api, ENTRY_STATUS_LABELS, formatDateTime, type Entry, type EntryDiff, type FolderBinding, type Operation, type TreeResponse } from "../api";
import { buildFileTree, filterFileTree, type FileTreeNode, type MatchRange } from "../fileTree";
import { lineDiff, type DiffRow } from "../diff";
import { MarkdownPreview } from "./MarkdownPreview";
import { HistoryTimeline } from "./HistoryTimeline";
import { Icon } from "./Icon";

interface DocsViewProps {
  tree?: TreeResponse;
  /** True while a sync round for the whole root is in flight: entries that
   *  are not individually syncing show a "scanning" badge instead of silence. */
  running?: boolean;
  /** Operations for surfacing the latest failure reason of error entries. */
  operations?: Operation[];
  selectedEntryId?: string;
  onSelectEntry: (entryId: string | undefined) => void;
  onSyncEntry?: (entryId: string) => Promise<void>;
  onRefresh: () => void;
}

type PreviewState =
  | { kind: "loading" }
  | { kind: "document"; relativePath: string; content: string }
  | { kind: "asset"; relativePath: string; url: string }
  | { kind: "error"; message: string };

/** Word-level spans for a diff row, mirroring the issue workbench renderer. */
function DiffText({ row }: { row: DiffRow }): React.JSX.Element {
  if (!row.words) return <>{row.text || " "}</>;
  return <>{row.words.map((span, index) => <span key={index} className={`word ${span.kind}`}>{span.text}</span>)}</>;
}

/** Render a name with the search matches wrapped in <mark> (B6.7). Without
 *  ranges the text is returned untouched, so the tree costs nothing when the
 *  filter box is empty. */
function Highlighted({ text, ranges }: { text: string; ranges?: MatchRange[] }): React.JSX.Element {
  if (!ranges || ranges.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.start > cursor) parts.push(text.slice(cursor, range.start));
    parts.push(<mark key={index} className="search-hit">{text.slice(range.start, range.end)}</mark>);
    cursor = range.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

/** "同步结果" pane (B4): line-level diff of the working tree against baseline. */
function ResultPane({ diff, loading }: { diff?: EntryDiff; loading: boolean }): React.JSX.Element {
  const rows = useMemo(() => (diff ? lineDiff(diff.baseContent, diff.currentContent) : []), [diff]);
  const changed = rows.some((row) => row.kind !== "same");
  if (loading) return <div className="empty-state"><span>加载中…</span></div>;
  if (!diff) return <div className="empty-state"><strong>无法加载同步结果</strong><span>请稍后重试。</span></div>;
  return <div className="panel preview-panel">
    <div className="panel-heading"><div><h3>同步结果</h3><span className="muted">当前本地内容与上次一致版本（基线）的行级差异。</span></div></div>
    {!changed && <p className="muted empty">本地内容与基线一致，没有未同步的改动。</p>}
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
  </div>;
}

export function DocsView({ tree, running, operations, selectedEntryId, onSelectEntry, onSyncEntry, onRefresh }: DocsViewProps): React.JSX.Element {
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [preview, setPreview] = useState<PreviewState>();
  const [restoring, setRestoring] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [previewTab, setPreviewTab] = useState<"render" | "result" | "history">("render");
  const [resultDiff, setResultDiff] = useState<EntryDiff>();
  const [resultLoading, setResultLoading] = useState(false);
  const [historyRevision, setHistoryRevision] = useState(0);
  /** Bumped when an action rewrote the file on disk (rollback / restore base) so
   *  the preview refetches instead of keeping the stale content on screen. */
  const [contentRevision, setContentRevision] = useState(0);
  /** One-line result banner for the destructive preview actions. */
  const [notice, setNotice] = useState<string>();
  const [folderBindings, setFolderBindings] = useState<FolderBinding[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string>();
  const [rebindToken, setRebindToken] = useState("");
  const [rebinding, setRebinding] = useState(false);

  const entries = tree?.entries;
  const rootId = tree?.root.id;
  const needle = filter.trim().toLowerCase();
  // Folder bindings drive the “已绑定/未绑定” badge on directory nodes (B3).
  const boundFolders = useMemo(() => new Set(folderBindings.map((folder) => folder.relativePath)), [folderBindings]);
  // Filesystem-like hierarchy; while searching only matching subtrees remain
  // and every level is forced open.
  const nodes = useMemo(() => {
    const built = buildFileTree(entries ?? [], boundFolders);
    return needle ? filterFileTree(built, needle) : built;
  }, [entries, needle, boundFolders]);
  const filterActive = needle.length > 0;

  // Reload folder bindings whenever the root changes or the tree is refreshed
  // (a sync round may have just persisted new folder mappings).
  useEffect(() => {
    if (!rootId) { setFolderBindings([]); return; }
    let cancelled = false;
    api.listFolders(rootId)
      .then((folders) => { if (!cancelled) setFolderBindings(folders); })
      .catch(() => { if (!cancelled) setFolderBindings([]); });
    return () => { cancelled = true; };
  }, [rootId, entries]);

  // Newest failed operation per entry: powers the failure hint in the preview.
  const lastFailures = useMemo(() => {
    const map: Record<string, { error?: string; at?: string }> = {};
    (operations ?? []).forEach((operation) => {
      if (!operation.entryId || operation.status !== "failed") return;
      const known = map[operation.entryId];
      if (!known || !known.at || (operation.completedAt ?? operation.createdAt) > known.at) {
        map[operation.entryId] = { error: operation.error, at: operation.completedAt ?? operation.createdAt };
      }
    });
    return map;
  }, [operations]);

  const statusBadge = (entry: Entry) => (
    <span className={`status-badge ${entry.ignoredAt ? "ignored" : entry.syncing ? "syncing" : running ? "scanning" : entry.status}`}>
      {entry.ignoredAt ? "已忽略" : entry.syncing ? "同步中" : running ? "检测中" : ENTRY_STATUS_LABELS[entry.status] ?? entry.status}
    </span>
  );

  const countFiles = (folder: Extract<FileTreeNode, { kind: "folder" }>): number =>
    folder.children.reduce((sum, child) => sum + (child.kind === "folder" ? countFiles(child) : 1), 0);

  const toggleFolder = (path: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderNodes = (input: FileTreeNode[], depth: number): React.ReactNode[] =>
    input.map((node) => {
      if (node.kind === "folder") {
        const open = filterActive || !collapsed.has(node.path);
        const bound = node.bound ?? false;
        return <React.Fragment key={`dir:${node.path}`}>
          <button
            className={`tree-row${open ? "" : " collapsed"}${selectedFolder === node.path ? " selected" : ""}`}
            style={{ paddingLeft: 12 + depth * 18 }}
            onClick={() => { setSelectedFolder(node.path); setRebindToken(""); onSelectEntry(undefined); }}
            title={node.path}
          >
            <span className="tree-toggle" onClick={(event) => { event.stopPropagation(); toggleFolder(node.path); }}>▸</span>
            <span className="tree-name"><Highlighted text={node.name} ranges={node.hits} /></span>
            <span className={`folder-badge${bound ? " bound" : ""}`}>{bound ? "已绑定" : "未绑定"}</span>
            <small className="tree-count">{countFiles(node)}</small>
          </button>
          {open && renderNodes(node.children, depth + 1)}
        </React.Fragment>;
      }
      const entry = node.entry;
      return <button
        key={entry.entryId}
        className={`docs-item${entry.entryId === selectedEntryId ? " selected" : ""}`}
        style={{ paddingLeft: 12 + depth * 18 }}
        onClick={() => { setSelectedFolder(undefined); onSelectEntry(entry.entryId); }}
        title={entry.relativePath}
      >
        <span className="docs-name"><Highlighted text={node.name} ranges={node.hits} /></span>
        <span className="docs-meta">
          {statusBadge(entry)}
          <small>{formatDateTime(entry.updatedAt)}</small>
        </span>
      </button>;
    });

  const selected = entries?.find((entry) => entry.entryId === selectedEntryId);
  const selectedFailure = selected ? lastFailures[selected.entryId] : undefined;
  const activeFolder = selectedFolder ? folderBindings.find((folder) => folder.relativePath === selectedFolder) : undefined;
  const folderChildCount = (path: string): number => (entries ?? []).filter((entry) => entry.relativePath.startsWith(`${path}/`)).length;

  useEffect(() => {
    setPreviewTab("render");
    setResultDiff(undefined);
    if (!selected) {
      setPreview(undefined);
      return;
    }
    if (selected.kind === "asset") {
      setPreview({ kind: "asset", relativePath: selected.relativePath, url: rootId ? api.fileUrl(rootId, selected.relativePath) : "" });
      return;
    }
    setPreview({ kind: "loading" });
    let cancelled = false;
    api.getEntryContent(selected.entryId)
      .then((content) => { if (!cancelled) setPreview({ kind: "document", relativePath: content.relativePath, content: content.content }); })
      .catch((error) => { if (!cancelled) setPreview({ kind: "error", message: error instanceof Error ? error.message : String(error) }); });
    return () => { cancelled = true; };
  }, [selected?.entryId, selected?.kind, selected?.relativePath, rootId, contentRevision]);

  // An action notice belongs to the document it was raised on, not to the next
  // one the user clicks.
  useEffect(() => { setNotice(undefined); }, [selectedEntryId, selectedFolder]);

  // Lazily load the baseline diff when the "同步结果" tab is opened.
  useEffect(() => {
    if (previewTab !== "result" || !selected || selected.kind !== "document") return;
    let cancelled = false;
    setResultLoading(true);
    api.getEntryDiff(selected.entryId, "baseline")
      .then((result) => { if (!cancelled) setResultDiff(result); })
      .catch(() => { if (!cancelled) setResultDiff(undefined); })
      .finally(() => { if (!cancelled) setResultLoading(false); });
    return () => { cancelled = true; };
  }, [previewTab, selected?.entryId, selected?.kind, historyRevision]);

  const restoreBase = async () => {
    if (!selected || restoring) return;
    if (!window.confirm(`将「${selected.relativePath}」本地内容恢复为上次一致版本（基线），并立即触发同步？`)) return;
    setRestoring(true);
    try {
      await api.restoreBase(selected.entryId);
      setContentRevision((value) => value + 1);
      setNotice(`已将「${selected.relativePath}」本地内容恢复为上次一致版本（基线）。`);
      onRefresh();
    } finally {
      setRestoring(false);
    }
  };

  const retrySelected = async () => {
    if (!selected || !onSyncEntry || retrying) return;
    setRetrying(true);
    try {
      await onSyncEntry(selected.entryId);
      onRefresh();
    } finally {
      setRetrying(false);
    }
  };

  const rebind = async () => {
    const token = rebindToken.trim();
    if (!rootId || !selectedFolder || !token || rebinding) return;
    setRebinding(true);
    try {
      await api.rebindFolder(rootId, selectedFolder, token);
      setRebindToken("");
      setFolderBindings(await api.listFolders(rootId));
      setNotice(`目录「${selectedFolder}」已重新绑定到 ${token}。`);
      onRefresh();
    } finally {
      setRebinding(false);
    }
  };

  return <div className="docs-view">
    {(entries ?? []).length === 0
      ? <div className="empty-state"><div className="check">✓</div><strong>暂无条目</strong><span>绑定根目录并执行同步后，文档会出现在这里。</span></div>
      : <div className={`docs-layout${selected || selectedFolder ? " has-selection" : ""}`}>
        <div className="docs-list panel">
          <div className="docs-filter">
            <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="搜索文件名…" />
          </div>
          <div className="docs-items">
            {renderNodes(nodes, 0)}
            {nodes.length === 0 && <p className="muted empty">没有匹配的文件</p>}
          </div>
        </div>
        <div className="docs-preview">
          {!selected && selectedFolder && <div className="panel preview-panel folder-detail">
            <div className="panel-heading"><div><h3>目录详情</h3><span className="muted">{selectedFolder}</span></div></div>
            {notice && <div className="form-notice">{notice}</div>}
            <dl className="folder-meta">
              <div><dt>本地路径</dt><dd>{selectedFolder}</dd></div>
              <div><dt>远端 token</dt><dd>{activeFolder ? <code>{activeFolder.remoteToken}</code> : <span className="muted">未绑定</span>}</dd></div>
              <div><dt>绑定时间</dt><dd>{activeFolder ? formatDateTime(activeFolder.createdAt) : <span className="muted">—</span>}</dd></div>
              <div><dt>子文件数</dt><dd>{activeFolder ? activeFolder.childCount : folderChildCount(selectedFolder)}</dd></div>
            </dl>
            <div className="form-row">
              <label htmlFor="rebind-token">手动重新绑定远端目录 token</label>
              <div className="rebind-row">
                <input id="rebind-token" value={rebindToken} onChange={(event) => setRebindToken(event.target.value)} placeholder="输入飞书云空间目录 token" />
                <button className="secondary" disabled={rebinding || !rebindToken.trim()} onClick={() => void rebind()}>{rebinding ? "绑定中…" : "重新绑定"}</button>
              </div>
              <span className="muted">当远端目录被重建或映射失效时，填入新的目录 token 即可恢复绑定。</span>
            </div>
          </div>}
          {!selected && !selectedFolder && <div className="empty-state"><div className="check">📄</div><strong>选择左侧文档</strong><span>支持 Markdown 渲染与图片预览。</span></div>}
          {selected && <>
            <div className="preview-toolbar">
              <button className="back-to-list" onClick={() => onSelectEntry(undefined)}><Icon name="back" size={15} />返回列表</button>
              <div className="preview-title"><strong>{selected.relativePath}</strong>{statusBadge(selected)}</div>
              <div className="heading-actions">
                {selected.kind === "document" && selected.status !== "clean" && <button className="danger-ghost" disabled={restoring} onClick={() => void restoreBase()}>{restoring ? "恢复中…" : "恢复到基线版本"}</button>}
                {selected.status === "error" && onSyncEntry && <button className="secondary" disabled={retrying} onClick={() => void retrySelected()}>{retrying ? "重试中…" : "重试同步"}</button>}
              </div>
            </div>
            {notice && <div className="form-notice">{notice}</div>}
            {selected.status === "error" && selectedFailure?.error && <div className="failure-hint">上次失败原因：{selectedFailure.error}</div>}
            {selected.kind === "document" && <div className="root-tabs">
              <button className={previewTab === "render" ? "active" : ""} onClick={() => setPreviewTab("render")}>渲染预览</button>
              <button className={previewTab === "result" ? "active" : ""} onClick={() => setPreviewTab("result")}>同步结果</button>
              <button className={previewTab === "history" ? "active" : ""} onClick={() => setPreviewTab("history")}>历史版本</button>
            </div>}
            {preview?.kind === "asset" && <div className="panel preview-panel"><div className="asset-frame"><img src={preview.url} alt={preview.relativePath} /></div></div>}
            {selected.kind === "document" && previewTab === "render" && <>
              {preview?.kind === "loading" && <div className="empty-state"><span>加载中…</span></div>}
              {preview?.kind === "error" && <div className="empty-state"><strong>无法读取内容</strong><span>{preview.message}</span></div>}
              {preview?.kind === "document" && <MarkdownPreview source={preview.content} rootId={rootId} className="panel preview-panel padded" />}
            </>}
            {selected.kind === "document" && previewTab === "result" && <ResultPane diff={resultDiff} loading={resultLoading} />}
            {selected.kind === "document" && previewTab === "history" && rootId && <HistoryTimeline rootId={rootId} entryId={selected.entryId} relativePath={selected.relativePath} revision={historyRevision} onRolledBack={() => { setHistoryRevision((value) => value + 1); setContentRevision((value) => value + 1); setPreviewTab("render"); setNotice(`已将「${selected.relativePath}」回滚到所选历史版本，本地已写回并触发同步。`); onRefresh(); }} />}
          </>}
        </div>
      </div>}
  </div>;
}
