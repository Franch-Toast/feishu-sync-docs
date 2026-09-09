import React, { useEffect, useMemo, useState } from "react";
import { api, ENTRY_STATUS_LABELS, formatDateTime, type Entry, type TreeResponse } from "../api";
import { buildFileTree, filterFileTree, type FileTreeNode } from "../fileTree";
import { MarkdownPreview } from "./MarkdownPreview";
import { Icon } from "./Icon";

interface DocsViewProps {
  tree?: TreeResponse;
  selectedEntryId?: string;
  onSelectEntry: (entryId: string | undefined) => void;
  onRefresh: () => void;
}

type PreviewState =
  | { kind: "loading" }
  | { kind: "document"; relativePath: string; content: string }
  | { kind: "asset"; relativePath: string; url: string }
  | { kind: "error"; message: string };

export function DocsView({ tree, selectedEntryId, onSelectEntry, onRefresh }: DocsViewProps): React.JSX.Element {
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [preview, setPreview] = useState<PreviewState>();
  const [restoring, setRestoring] = useState(false);

  const entries = tree?.entries;
  const rootId = tree?.root.id;
  const needle = filter.trim().toLowerCase();
  // Filesystem-like hierarchy; while searching only matching subtrees remain
  // and every level is forced open.
  const nodes = useMemo(() => {
    const built = buildFileTree(entries ?? []);
    return needle ? filterFileTree(built, needle) : built;
  }, [entries, needle]);
  const filterActive = needle.length > 0;

  const statusBadge = (entry: Entry) => (
    <span className={`status-badge ${entry.syncing ? "syncing" : entry.status}`}>
      {entry.syncing ? "同步中" : ENTRY_STATUS_LABELS[entry.status] ?? entry.status}
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
        return <React.Fragment key={`dir:${node.path}`}>
          <button
            className={`tree-row${open ? "" : " collapsed"}`}
            style={{ paddingLeft: 12 + depth * 18 }}
            onClick={() => toggleFolder(node.path)}
            title={node.path}
          >
            <span className="tree-toggle">▸</span>
            <span className="tree-name">{node.name}</span>
            <small className="tree-count">{countFiles(node)}</small>
          </button>
          {open && renderNodes(node.children, depth + 1)}
        </React.Fragment>;
      }
      const entry = node.entry;
      return <button
        key={entry.id}
        className={`docs-item${entry.id === selectedEntryId ? " selected" : ""}`}
        style={{ paddingLeft: 12 + depth * 18 }}
        onClick={() => onSelectEntry(entry.id)}
        title={entry.relativePath}
      >
        <span className="docs-name">{node.name}</span>
        <span className="docs-meta">
          {statusBadge(entry)}
          <small>{formatDateTime(entry.updatedAt)}</small>
        </span>
      </button>;
    });

  const selected = entries?.find((entry) => entry.id === selectedEntryId);

  useEffect(() => {
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
    api.getEntryContent(selected.id)
      .then((content) => { if (!cancelled) setPreview({ kind: "document", relativePath: content.relativePath, content: content.content }); })
      .catch((error) => { if (!cancelled) setPreview({ kind: "error", message: error instanceof Error ? error.message : String(error) }); });
    return () => { cancelled = true; };
  }, [selected?.id, selected?.kind, selected?.relativePath, rootId]);

  const restoreBase = async () => {
    if (!selected || restoring) return;
    if (!window.confirm(`将「${selected.relativePath}」本地内容恢复为上次一致版本（基线），并立即触发同步？`)) return;
    setRestoring(true);
    try {
      await api.restoreBase(selected.id);
      onRefresh();
    } finally {
      setRestoring(false);
    }
  };

  return <div className="docs-view">
    {(entries ?? []).length === 0
      ? <div className="empty-state"><div className="check">✓</div><strong>暂无条目</strong><span>绑定根目录并执行同步后，文档会出现在这里。</span></div>
      : <div className={`docs-layout${selected ? " has-selection" : ""}`}>
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
          {!selected && <div className="empty-state"><div className="check">📄</div><strong>选择左侧文档</strong><span>支持 Markdown 渲染与图片预览。</span></div>}
          {selected && <>
            <div className="preview-toolbar">
                          <button className="back-to-list" onClick={() => onSelectEntry(undefined)}><Icon name="back" size={15} />返回列表</button>
              <div className="preview-title"><strong>{selected.relativePath}</strong>{statusBadge(selected)}</div>
              <div className="heading-actions">
                {selected.kind === "document" && selected.status !== "clean" && <button className="danger-ghost" disabled={restoring} onClick={() => void restoreBase()}>{restoring ? "恢复中…" : "恢复到基线版本"}</button>}
              </div>
            </div>
            {preview?.kind === "loading" && <div className="empty-state"><span>加载中…</span></div>}
            {preview?.kind === "error" && <div className="empty-state"><strong>无法读取内容</strong><span>{preview.message}</span></div>}
            {preview?.kind === "asset" && <div className="panel preview-panel"><div className="asset-frame"><img src={preview.url} alt={preview.relativePath} /></div></div>}
            {preview?.kind === "document" && <MarkdownPreview source={preview.content} rootId={rootId} className="panel preview-panel padded" />}
          </>}
        </div>
      </div>}
  </div>;
}
