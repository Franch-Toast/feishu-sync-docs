import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import CodeMirror from "@uiw/react-codemirror";
import "./styles.css";

type Conflict = { id: string; entryId: string; status: string; baseContent: string; localContent: string; remoteContent: string; createdAt: string; relativePath?: string; localRoot?: string };
type Root = { id: string; localPath: string; remoteToken: string; enabled: boolean };

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { headers: { "content-type": "application/json" }, ...init });
  if (!response.ok) throw new Error((await response.json()).error ?? response.statusText);
  return response.json() as Promise<T>;
}

function App(): React.JSX.Element {
  const [roots, setRoots] = useState<Root[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [selected, setSelected] = useState<Conflict | undefined>();
  const [merged, setMerged] = useState("");
  const [message, setMessage] = useState("正在连接服务...");
  const [newLocalPath, setNewLocalPath] = useState("");
  const [newRemoteToken, setNewRemoteToken] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [nextRoots, nextConflicts] = await Promise.all([json<Root[]>("/api/roots"), json<Conflict[]>("/api/conflicts")]);
      setRoots(nextRoots); setConflicts(nextConflicts); setMessage("服务正常");
      if (selected) setSelected(nextConflicts.find((item) => item.id === selected.id));
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }, [selected]);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 5000); return () => window.clearInterval(timer); }, [refresh]);
  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/events`);
    socket.onmessage = () => void refresh();
    socket.onopen = () => setMessage("实时连接已建立");
    socket.onclose = () => setMessage("实时连接已断开，使用轮询");
    return () => socket.close();
  }, [refresh]);
  useEffect(() => { if (selected) setMerged(selected.remoteContent); }, [selected?.id]);

  const selectedTitle = useMemo(() => selected ? (selected.relativePath ?? `冲突 ${selected.id.slice(0, 8)}`) : "选择一个冲突", [selected]);
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

  return <div className="app-shell">
    <header className="topbar"><div><span className="eyebrow">LOCAL-FIRST DOCUMENT SYNC</span><h1>Feishu Local Sync</h1></div><div className="connection"><span className="status-dot" />{message}</div></header>
    <main className="layout">
      <aside className="sidebar">
        <section><div className="section-label">工作区</div><div className="nav-item active">同步总览 <span>{roots.length}</span></div><div className="nav-item">冲突工作台 <span className="badge">{conflicts.length}</span></div><div className="nav-item">操作日志</div></section>
        <section className="root-section"><div className="section-label">同步根目录</div>{roots.map((root) => <div className="root-item" key={root.id}><strong>{root.localPath.split(/[\\/]/).at(-1)}</strong><small>{root.localPath}</small><small className="muted">↔ {root.remoteToken}</small></div>)}{roots.length === 0 && <p className="muted empty">还没有同步根目录</p>}</section>
        <form className="add-root" onSubmit={addRoot}><div className="section-label">添加映射</div><input value={newLocalPath} onChange={(event) => setNewLocalPath(event.target.value)} placeholder="本地目录绝对路径" /><input value={newRemoteToken} onChange={(event) => setNewRemoteToken(event.target.value)} placeholder="飞书文件夹 token" /><button type="submit">绑定根目录</button></form>
      </aside>
      <section className="content"><div className="page-heading"><div><span className="eyebrow">WORKSPACE / CONFLICTS</span><h2>冲突工作台</h2><p>本地和飞书同时修改的文档会停在这里，解决后才会继续同步。</p></div><button className="secondary" onClick={() => void refresh()}>刷新状态</button></div>
        {!selected && <div className="overview-grid"><div className="metric"><span>同步根目录</span><strong>{roots.length}</strong></div><div className="metric warning"><span>待解决冲突</span><strong>{conflicts.length}</strong></div><div className="metric"><span>同步策略</span><strong>三方合并</strong></div></div>}
        {!selected && <div className="panel"><div className="panel-heading"><div><h3>待解决冲突</h3><span className="muted">选择一个文档开始合并</span></div></div>{conflicts.length === 0 ? <div className="empty-state"><div className="check">✓</div><strong>当前没有冲突</strong><span>后台会持续检查本地目录和飞书文档。</span></div> : <div className="conflict-list">{conflicts.map((conflict) => <button className="conflict-row" key={conflict.id} onClick={() => setSelected(conflict)}><span className="conflict-icon">!</span><span className="conflict-info"><strong>{conflict.relativePath ?? conflict.id.slice(0, 12)}</strong><small>{conflict.id.slice(0, 12)} · 产生于 {new Date(conflict.createdAt).toLocaleString()}</small></span><span className="arrow">→</span></button>)}</div>}</div>}
        {selected && <div className="conflict-view"><div className="conflict-toolbar"><button className="back" onClick={() => setSelected(undefined)}>← 返回列表</button><div><strong>{selectedTitle}</strong><span className="badge">需要处理</span></div><button className="danger-ghost" onClick={() => void resolve("abort")}>暂不处理</button></div><div className="diff-grid"><DiffPane label="BASE / 上次一致版本" content={selected.baseContent} /><DiffPane label="LOCAL / 本地版本" content={selected.localContent} accent="local" /><DiffPane label="REMOTE / 飞书版本" content={selected.remoteContent} accent="remote" /></div><div className="merge-panel"><div className="merge-heading"><div><h3>合并结果</h3><span className="muted">编辑结果会同时写入本地和飞书</span></div><div className="actions"><button className="secondary" onClick={() => setMerged(selected.localContent)}>采用本地</button><button className="secondary" onClick={() => setMerged(selected.remoteContent)}>采用飞书</button><button className="primary" onClick={() => void resolve("merged")}>解决并同步</button></div></div><CodeMirror value={merged} height="320px" extensions={[markdown(), oneDark]} onChange={setMerged} theme="dark" /></div></div>}
      </section>
    </main>
  </div>;
}

function DiffPane({ label, content, accent }: { label: string; content: string; accent?: "local" | "remote" }): React.JSX.Element {
  return <div className={`diff-pane ${accent ?? ""}`}><div className="diff-label">{label}</div><pre>{content || "(空文档)"}</pre></div>;
}

createRoot(document.getElementById("root")!).render(<App />);
