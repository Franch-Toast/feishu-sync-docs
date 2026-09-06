import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import CodeMirror from "@uiw/react-codemirror";
import "./styles.css";

type Conflict = { id: string; entryId: string; status: string; baseContent: string; localContent: string; remoteContent: string; createdAt: string; relativePath?: string; localRoot?: string };
type Root = { id: string; localPath: string; remoteToken: string; enabled: boolean };
type Entry = { id: string; rootId: string; relativePath: string; kind: string; status: string; remoteToken?: string; updatedAt: string };
type Operation = { id: string; entryId?: string; direction: string; operation: string; status: string; error?: string; createdAt: string; completedAt?: string };
type TreeResponse = { root: Root; entries: Entry[] };
type View = "overview" | "conflicts" | "operations";

const STATUS_LABELS: Record<string, string> = { clean: "已同步", pending: "待同步", conflict: "冲突", orphan: "远端已删除", error: "失败" };

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { headers: { "content-type": "application/json" }, ...init });
  if (!response.ok) throw new Error((await response.json()).error ?? response.statusText);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function App(): React.JSX.Element {
  const [view, setView] = useState<View>("overview");
  const [roots, setRoots] = useState<Root[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [tree, setTree] = useState<TreeResponse>();
  const [operations, setOperations] = useState<Operation[]>([]);
  const [selected, setSelected] = useState<Conflict | undefined>();
  const [selectedRootId, setSelectedRootId] = useState<string>();
  const [merged, setMerged] = useState("");
  const [message, setMessage] = useState("正在连接服务...");
  const [newLocalPath, setNewLocalPath] = useState("");
  const [newRemoteToken, setNewRemoteToken] = useState("");

  // Keep poll-critical values in refs so `refresh` stays referentially stable;
  // depending on them directly recreated the callback on every poll and tore
  // down/reopened the WebSocket (a reconnect storm).
  const selectedRef = useRef<Conflict | undefined>(undefined);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  const viewRef = useRef<View>("overview");
  useEffect(() => { viewRef.current = view; }, [view]);
  const selectedRootRef = useRef<string | undefined>(undefined);
  useEffect(() => { selectedRootRef.current = selectedRootId; }, [selectedRootId]);

  const refresh = useCallback(async () => {
    try {
      const currentView = viewRef.current;
      const [nextRoots, nextConflicts, nextTree, nextOperations] = await Promise.all([
        json<Root[]>("/api/roots"),
        json<Conflict[]>("/api/conflicts"),
        currentView === "overview" && selectedRootRef.current ? json<TreeResponse>(`/api/roots/${selectedRootRef.current}/tree`) : Promise.resolve(undefined),
        currentView === "operations" ? json<Operation[]>("/api/operations") : Promise.resolve(undefined)
      ]);
      setRoots(nextRoots);
      setConflicts(nextConflicts);
      setMessage("服务正常");
      if (nextTree) setTree(nextTree);
      if (nextOperations) setOperations(nextOperations);
      if (!selectedRootRef.current && nextRoots[0]) setSelectedRootId(nextRoots[0].id);
      const current = selectedRef.current;
      if (current) {
        const stillOpen = nextConflicts.find((item) => item.id === current.id);
        setSelected(stillOpen);
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }, []);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 5000); return () => window.clearInterval(timer); }, [refresh]);
  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/events`);
    socket.onmessage = () => void refresh();
    socket.onopen = () => setMessage("实时连接已建立");
    socket.onclose = () => setMessage("实时连接已断开，使用轮询");
    return () => socket.close();
  }, [refresh]);
  // Reload view-specific data when the view or the inspected root changes.
  useEffect(() => { if (view === "overview" && selectedRootId) void refresh(); }, [view, selectedRootId, refresh]);
  useEffect(() => { if (selected) setMerged(selected.remoteContent); }, [selected?.id]);

  const selectedTitle = useMemo(() => selected ? (selected.relativePath ?? `冲突 ${selected.id.slice(0, 8)}`) : "选择一个冲突", [selected]);
  const switchView = (next: View) => { setView(next); setSelected(undefined); };
  const addRoot = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newLocalPath || !newRemoteToken) return;
    try {
      await json("/api/roots", { method: "POST", body: JSON.stringify({ localPath: newLocalPath, remoteToken: newRemoteToken }) });
      setNewLocalPath(""); setNewRemoteToken(""); await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };
  const resolve = async (resolution: "local" | "remote" | "merged" | "abort") => {
    if (!selected) return;
    try {
      await json(`/api/conflicts/${selected.id}/resolve`, { method: "POST", body: JSON.stringify({ resolution, mergedContent: resolution === "merged" ? merged : undefined }) });
      setSelected(undefined); await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };
  const syncRootNow = async (rootId: string) => {
    try {
      await json(`/api/roots/${rootId}/sync`, { method: "POST" });
      setMessage("同步完成");
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };
  const pruneHistory = async () => {
    try {
      const result = await json<{ operations: number; conflicts: number; snapshots: number }>("/api/maintenance/prune", { method: "POST", body: JSON.stringify({}) });
      setMessage(`已清理 ${result.operations} 条操作记录、${result.conflicts} 条冲突、${result.snapshots} 个孤儿快照`);
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const entries = tree?.entries ?? [];
  const activeRoot = tree?.root;
  const troubleCount = entries.filter((entry) => entry.status === "error" || entry.status === "orphan").length;

  return <div className="app-shell">
    <header className="topbar"><div><span className="eyebrow">LOCAL-FIRST DOCUMENT SYNC</span><h1>Feishu Local Sync</h1></div><div className="connection"><span className="status-dot" />{message}</div></header>
    <main className="layout">
      <aside className="sidebar">
        <section>
          <div className="section-label">工作区</div>
          <div className={`nav-item${view === "overview" ? " active" : ""}`} onClick={() => switchView("overview")}>同步总览 <span>{entries.length}</span></div>
          <div className={`nav-item${view === "conflicts" ? " active" : ""}`} onClick={() => switchView("conflicts")}>冲突工作台 <span className="badge">{conflicts.length}</span></div>
          <div className={`nav-item${view === "operations" ? " active" : ""}`} onClick={() => switchView("operations")}>操作日志 <span>{operations.length}</span></div>
        </section>
        <section className="root-section"><div className="section-label">同步根目录</div>{roots.map((root) => <div className={`root-item${root.id === selectedRootId ? " selected" : ""}`} key={root.id} onClick={() => { setSelectedRootId(root.id); setView("overview"); setSelected(undefined); }}><strong>{root.localPath.split(/[\\/]/).at(-1)}</strong><small>{root.localPath}</small><small className="muted">↔ {root.remoteToken}</small></div>)}{roots.length === 0 && <p className="muted empty">还没有同步根目录</p>}</section>
        <form className="add-root" onSubmit={addRoot}><div className="section-label">添加映射</div><input value={newLocalPath} onChange={(event) => setNewLocalPath(event.target.value)} placeholder="本地目录绝对路径" /><input value={newRemoteToken} onChange={(event) => setNewRemoteToken(event.target.value)} placeholder="飞书文件夹 token" /><button type="submit">绑定根目录</button></form>
      </aside>
      <section className="content">
        {view === "overview" && <>
          <div className="page-heading"><div><span className="eyebrow">WORKSPACE / OVERVIEW</span><h2>同步总览</h2><p>本地目录与飞书空间的实时映射状态，异常条目会在这里第一时间暴露。</p></div><div className="heading-actions">{activeRoot && <button className="secondary" onClick={() => void syncRootNow(activeRoot.id)}>立即同步</button>}<button className="secondary" onClick={() => void refresh()}>刷新状态</button></div></div>
          {roots.length > 1 && <div className="root-tabs">{roots.map((root) => <button key={root.id} className={root.id === selectedRootId ? "active" : ""} onClick={() => setSelectedRootId(root.id)}>{root.localPath.split(/[\\/]/).at(-1)}</button>)}</div>}
          <div className="overview-grid">
            <div className="metric"><span>同步根目录</span><strong>{roots.length}</strong></div>
            <div className="metric warning"><span>待解决冲突</span><strong>{conflicts.length}</strong></div>
            <div className="metric"><span>同步条目</span><strong>{entries.length}</strong></div>
            <div className="metric warning"><span>异常条目</span><strong>{troubleCount}</strong></div>
          </div>
          <div className="panel"><div className="panel-heading"><div><h3>条目状态</h3><span className="muted">{activeRoot ? activeRoot.localPath : "尚未选择根目录"}</span></div></div>
            {entries.length === 0 ? <div className="empty-state"><div className="check">✓</div><strong>暂无条目</strong><span>绑定根目录并执行同步后，文档会出现在这里。</span></div>
              : <table className="entry-table"><thead><tr><th>文件</th><th>类型</th><th>状态</th><th>远端 Token</th><th>更新时间</th></tr></thead><tbody>{entries.map((entry) => <tr key={entry.id}><td>{entry.relativePath}</td><td className="muted">{entry.kind === "document" ? "文档" : "资源"}</td><td><span className={`status-badge ${entry.status}`}>{STATUS_LABELS[entry.status] ?? entry.status}</span></td><td className="muted">{entry.remoteToken ? entry.remoteToken.slice(0, 14) : "—"}</td><td className="muted">{new Date(entry.updatedAt).toLocaleString()}</td></tr>)}</tbody></table>}
          </div>
        </>}
        {view === "conflicts" && <>
          <div className="page-heading"><div><span className="eyebrow">WORKSPACE / CONFLICTS</span><h2>冲突工作台</h2><p>本地和飞书同时修改的文档会停在这里，解决后才会继续同步。</p></div><button className="secondary" onClick={() => void refresh()}>刷新状态</button></div>
          {!selected && <div className="panel"><div className="panel-heading"><div><h3>待解决冲突</h3><span className="muted">选择一个文档开始合并</span></div></div>{conflicts.length === 0 ? <div className="empty-state"><div className="check">✓</div><strong>当前没有冲突</strong><span>后台会持续检查本地目录和飞书文档。</span></div> : <div className="conflict-list">{conflicts.map((conflict) => <button className="conflict-row" key={conflict.id} onClick={() => setSelected(conflict)}><span className="conflict-icon">!</span><span className="conflict-info"><strong>{conflict.relativePath ?? conflict.id.slice(0, 12)}</strong><small>{conflict.id.slice(0, 12)} · 产生于 {new Date(conflict.createdAt).toLocaleString()}</small></span><span className="arrow">→</span></button>)}</div>}</div>}
          {selected && <div className="conflict-view"><div className="conflict-toolbar"><button className="back" onClick={() => setSelected(undefined)}>← 返回列表</button><div><strong>{selectedTitle}</strong><span className="badge">需要处理</span></div><button className="danger-ghost" onClick={() => void resolve("abort")}>暂不处理</button></div><div className="diff-grid"><DiffPane label="BASE / 上次一致版本" content={selected.baseContent} /><DiffPane label="LOCAL / 本地版本" content={selected.localContent} accent="local" /><DiffPane label="REMOTE / 飞书版本" content={selected.remoteContent} accent="remote" /></div><div className="merge-panel"><div className="merge-heading"><div><h3>合并结果</h3><span className="muted">编辑结果会同时写入本地和飞书</span></div><div className="actions"><button className="secondary" onClick={() => setMerged(selected.localContent)}>采用本地</button><button className="secondary" onClick={() => setMerged(selected.remoteContent)}>采用飞书</button><button className="primary" onClick={() => void resolve("merged")}>解决并同步</button></div></div><CodeMirror value={merged} height="320px" extensions={[markdown(), oneDark]} onChange={setMerged} theme="dark" /></div></div>}
        </>}
        {view === "operations" && <>
          <div className="page-heading"><div><span className="eyebrow">WORKSPACE / OPERATIONS</span><h2>操作日志</h2><p>同步引擎的每次推送、拉取与合并都会留下记录，便于排查失败原因。</p></div><div className="heading-actions"><button className="danger-ghost" onClick={() => void pruneHistory()}>清理历史</button><button className="secondary" onClick={() => void refresh()}>刷新</button></div></div>
          <div className="panel"><div className="panel-heading"><div><h3>最近操作</h3><span className="muted">共 {operations.length} 条记录</span></div></div>
            {operations.length === 0 ? <div className="empty-state"><div className="check">✓</div><strong>暂无操作记录</strong><span>执行同步后这里会显示引擎的操作历史。</span></div>
              : <table className="op-table"><thead><tr><th>时间</th><th>方向</th><th>操作</th><th>状态</th><th>错误</th></tr></thead><tbody>{operations.map((operation) => <tr key={operation.id}><td className="muted">{new Date(operation.createdAt).toLocaleString()}</td><td className="muted">{operation.direction}</td><td>{operation.operation}</td><td><span className={`op-status ${operation.status}`}>{operation.status}</span></td><td className="op-error">{operation.error ?? ""}</td></tr>)}</tbody></table>}
          </div>
        </>}
      </section>
    </main>
  </div>;
}

function DiffPane({ label, content, accent }: { label: string; content: string; accent?: "local" | "remote" }): React.JSX.Element {
  return <div className={`diff-pane ${accent ?? ""}`}><div className="diff-label">{label}</div><pre>{content || "(空文档)"}</pre></div>;
}

createRoot(document.getElementById("root")!).render(<App />);
