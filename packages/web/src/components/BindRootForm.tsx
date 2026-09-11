import React, { useState } from "react";
import { api, ERROR_CATEGORY_LABELS, SYNC_MODE_LABELS, type SyncMode, type ValidatePathResult, type ValidateTokenResult } from "../api";
import { describeExcludePatterns, parseExcludePatterns } from "../exclude";

/** Values captured by the bind-root form. Interval is kept as raw text so
 *  typing is never fought; it is normalized/validated on submit. */
export interface BindFormValues {
  localPath: string;
  remoteToken: string;
  remoteType: "folder" | "wiki";
  intervalSec: string;
  mode: SyncMode;
  /** Raw exclude textarea; parsed into globs on submit (B6.5). */
  exclude: string;
  /** G3: what to do with a `.feishu-sync/` left behind by a deleted root.
   *  `adopt` (default) keeps history; `reset` archives it and starts clean. */
  metadataAction?: "adopt" | "reset";
}

export interface BindFormIssues {
  localPath?: string;
  remoteToken?: string;
  intervalSec?: string;
}

export interface CreateRootInput {
  localPath: string;
  remoteToken: string;
  remoteType: "folder" | "wiki";
  pollIntervalMs?: number;
  mode: SyncMode;
  exclude?: string[];
  metadataAction?: "adopt" | "reset";
}

/** Pure client-side validation for the bind form. Returns per-field issue
 *  messages; an empty object means the form is submittable. */
export function validateBindForm(values: BindFormValues): BindFormIssues {
  const issues: BindFormIssues = {};
  const path = values.localPath.trim();
  if (!path) issues.localPath = "请填写本地目录的绝对路径。";
  else if (!path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path)) issues.localPath = "本地路径需为绝对路径（以 / 或盘符开头）。";
  const token = values.remoteToken.trim();
  if (!token) issues.remoteToken = "请填写飞书文件夹 / 知识空间节点 token。";
  else if (/\s/.test(token)) issues.remoteToken = "token 不应包含空格，请确认是否复制完整。";
  if (values.intervalSec.trim() !== "") {
    const parsed = Number.parseInt(values.intervalSec, 10);
    if (!Number.isFinite(parsed) || parsed < 1) issues.intervalSec = "轮询间隔需为 ≥1 的整数秒（留空使用全局默认）。";
  }
  return issues;
}

/** Convert validated form values into the createRoot request payload. */
export function toCreateRootInput(values: BindFormValues): CreateRootInput {
  const parsed = Number.parseInt(values.intervalSec, 10);
  const exclude = parseExcludePatterns(values.exclude);
  return {
    localPath: values.localPath.trim(),
    remoteToken: values.remoteToken.trim(),
    remoteType: values.remoteType,
    pollIntervalMs: Number.isFinite(parsed) && parsed >= 1 ? parsed * 1000 : undefined,
    mode: values.mode,
    exclude: exclude.length > 0 ? exclude : undefined,
    // G3: `undefined` keeps the server's safe default (adopt the leftovers).
    metadataAction: values.metadataAction
  };
}

interface BindRootFormProps {
  defaultIntervalMs?: number;
  submitting?: boolean;
  onSubmit: (input: CreateRootInput) => Promise<void>;
  onCancel: () => void;
}

type TokenCheck = { state: "checking" } | { state: "done"; result: ValidateTokenResult };
type PathCheck = { state: "checking" } | { state: "done"; result: ValidatePathResult };

/** Explain a rejected path in the form's own language. The probe answers with
 *  structured flags plus a raw Node error string; only the flags are Chinese. */
export function describePathProblem(result: ValidatePathResult): string {
  if (result.exists === false) return "目录不存在，请检查路径";
  if (result.isDirectory === false) return "该路径不是目录";
  if (result.writable === false) return "目录不可写，同步将无法落盘";
  return result.error ?? "未知错误";
}

/** Render the local-directory probe as one line (B5: 目录 + 文件数). */
export function describePathCheck(result: ValidatePathResult): string {
  if (!result.ok) return `✗ 无法使用：${describePathProblem(result)}`;
  const parts = [`${result.documents ?? 0} 篇 Markdown`];
  if ((result.assets ?? 0) > 0) parts.push(`${result.assets} 张图片`);
  const excluded = (result.exclude ?? []).length > 0 ? `，已按 ${result.exclude!.length} 条规则排除` : "";
  return `✓ 目录可用 · ${parts.join("、")}${excluded}${result.writable === false ? "（⚠ 不可写，同步将无法落盘）" : ""}`;
}

/** Explain a rejected token the same way: the probe's semantic `category` maps
 *  to the shared Chinese vocabulary, while `error` is the raw upstream message
 *  (kept as a hover tooltip) and only surfaces when no category was assigned. */
export function describeTokenProblem(result: ValidateTokenResult): string {
  if (result.category) return ERROR_CATEGORY_LABELS[result.category];
  return result.error ?? "未知错误";
}

/** G6: everything the probe learned about what the directory already carries —
 *  an existing git repo, an ignored-or-not metadata folder, a previous binding.
 *  Returned as plain Chinese lines so the form can list them verbatim. */
export function describeBindHints(result: ValidatePathResult): string[] {
  const hints: string[] = [];
  if (result.boundRootId) hints.push("该目录已经绑定过：提交后将直接切换到现有绑定，不会新建第二个根目录。");
  if (result.hasGit) hints.push(result.gitBranch ? `检测到 git 仓库（当前分支 ${result.gitBranch}）：基线提交写入该仓库，不会改变工作区文件。` : "检测到 git 仓库：基线提交写入该仓库，不会改变工作区文件。");
  if (result.hasGit && result.metaIgnored === false) hints.push("元数据尚未被 .gitignore 忽略：绑定时会自动追加 .feishu-sync/，并取消已跟踪的元数据。");
  if (result.orphanMeta) hints.push(`检测到上一次绑定遗留的元数据${result.metaRootId ? `（${result.metaRootId.slice(0, 8)}）` : ""}，可选择接管历史或归档后重新开始。`);
  return hints;
}

/** G3: the 「接管 / 重新绑定」 choice only appears for orphaned metadata that no
 *  live root owns; anything else takes the server default. */
export function needsMetaChoice(result: ValidatePathResult): boolean {
  return result.orphanMeta === true && !result.boundRootId;
}

/** Three-group bind form (📁 本地 / ☁️ 远端 / ⚙️ 高级) reusing the settings
 *  `.form-row` visual language. Both the local path and the remote token are
 *  probed on blur so mistakes surface before the root is created. */
export function BindRootForm({ defaultIntervalMs, submitting, onSubmit, onCancel }: BindRootFormProps): React.JSX.Element {
  const [localPath, setLocalPath] = useState("");
  const [remoteToken, setRemoteToken] = useState("");
  const [remoteType, setRemoteType] = useState<"folder" | "wiki">("folder");
  const [intervalSec, setIntervalSec] = useState("");
  const [mode, setMode] = useState<SyncMode>("bidirectional");
  const [exclude, setExclude] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [issues, setIssues] = useState<BindFormIssues>({});
  const [tokenCheck, setTokenCheck] = useState<TokenCheck>();
  const [pathCheck, setPathCheck] = useState<PathCheck>();
  const [error, setError] = useState<string>();
  /** G3: how to treat orphaned metadata found by the path probe. */
  const [metadataAction, setMetadataAction] = useState<"adopt" | "reset">("adopt");

  const values: BindFormValues = { localPath, remoteToken, remoteType, intervalSec, mode, exclude, metadataAction };
  const defaultHint = defaultIntervalMs ? Math.round(defaultIntervalMs / 1000) : 15;

  /** Blur handler for the local path: client-side shape check first, then a
   *  server probe that reports whether the directory exists and how many files
   *  the first scan would pick up with the current exclude patterns. */
  const checkLocalPath = async (pathOverride?: string, excludeOverride?: string) => {
    const candidate = { ...values, localPath: pathOverride ?? localPath, exclude: excludeOverride ?? exclude };
    const issue = validateBindForm(candidate).localPath;
    setIssues((current) => ({ ...current, localPath: issue }));
    if (issue) { setPathCheck(undefined); return; }
    setPathCheck({ state: "checking" });
    try {
      setPathCheck({ state: "done", result: await api.validatePath(candidate.localPath.trim(), parseExcludePatterns(candidate.exclude)) });
    } catch (err) {
      // Only a body-less failure lands here: a rejected path is answered with a
      // structured 4xx body that api.validatePath hands back untouched.
      setPathCheck({ state: "done", result: { ok: false, path: candidate.localPath.trim(), error: err instanceof Error ? err.message : String(err) } });
    }
  };

  const checkToken = async () => {
    const token = remoteToken.trim();
    if (!token) { setTokenCheck(undefined); return; }
    setTokenCheck({ state: "checking" });
    try {
      const result = await api.validateToken(token, remoteType);
      setTokenCheck({ state: "done", result });
    } catch (err) {
      // Only a body-less failure lands here; an unreachable token is answered
      // with a structured 4xx body carrying its error category.
      setTokenCheck({ state: "done", result: { ok: false, type: remoteType, token, error: err instanceof Error ? err.message : String(err) } });
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const found = validateBindForm(values);
    setIssues(found);
    if (Object.keys(found).length > 0) return;
    setError(undefined);
    try {
      await onSubmit(toCreateRootInput(values));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // The server-side probe is authoritative: a path it rejected must not stay
  // submittable, or the root gets created and every sync round fails on it.
  const pathRejected = pathCheck?.state === "done" && !pathCheck.result.ok;
  const submittable = localPath.trim() !== "" && remoteToken.trim() !== "" && !pathRejected && Object.keys(validateBindForm(values)).length === 0;

  return <form className="bind-root-form" onSubmit={(event) => void submit(event)}>
    <fieldset className="form-group">
      <legend>📁 本地目录</legend>
      <label className="form-row">
        <span>绝对路径</span>
        <input
          value={localPath}
          onChange={(event) => setLocalPath(event.target.value)}
          onBlur={() => void checkLocalPath()}
          placeholder="/home/me/docs"
          autoComplete="off"
        />
      </label>
      {issues.localPath && <p className="form-issue">{issues.localPath}</p>}
      {pathCheck?.state === "checking" && <div className="test-result ok">正在检查目录…</div>}
      {pathCheck?.state === "done" && <div className={`test-result ${pathCheck.result.ok ? "ok" : "fail"}`}>{describePathCheck(pathCheck.result)}</div>}
      {pathCheck?.state === "done" && describeBindHints(pathCheck.result).length > 0 && <ul className="bind-hints">
        {describeBindHints(pathCheck.result).map((hint, index) => <li key={index}>{hint}</li>)}
      </ul>}
      {pathCheck?.state === "done" && needsMetaChoice(pathCheck.result) && <div className="form-row meta-choice">
        <span className="form-label">遗留元数据</span>
        <div className="radio-column">
          <label className="radio-row">
            <input type="radio" name="meta-action" checked={metadataAction === "adopt"} onChange={() => setMetadataAction("adopt")} />
            <span>接管（推荐）<small className="muted">保留历史绑定、操作记录与 git 基线，下一轮直接续用</small></span>
          </label>
          <label className="radio-row">
            <input type="radio" name="meta-action" checked={metadataAction === "reset"} onChange={() => setMetadataAction("reset")} />
            <span>重新绑定<small className="muted">把现有 .feishu-sync/ 整份移入 backup-时间戳/ 备份目录后重建（不删文件，不动 .git）</small></span>
          </label>
        </div>
      </div>}
      <p className="muted form-hint">同步会在此目录内创建 <code>.feishu-sync</code> 元数据与 <code>.git</code> 基线仓库，请确保可写。删除绑定不会删除本地文件与 git 历史。</p>
    </fieldset>

    <fieldset className="form-group">
      <legend>☁️ 远端目标</legend>
      <label className="form-row">
        <span>远端类型</span>
        <select value={remoteType} onChange={(event) => { setRemoteType(event.target.value as "folder" | "wiki"); setTokenCheck(undefined); }}>
          <option value="folder">云空间文件夹</option>
          <option value="wiki">知识空间（Wiki）节点</option>
        </select>
      </label>
      <label className="form-row">
        <span>{remoteType === "wiki" ? "Wiki 节点 token" : "文件夹 token"}</span>
        <input
          value={remoteToken}
          onChange={(event) => setRemoteToken(event.target.value)}
          onBlur={() => void checkToken()}
          placeholder={remoteType === "wiki" ? "知识空间节点 token" : "飞书文件夹 token"}
          autoComplete="off"
        />
      </label>
      {issues.remoteToken && <p className="form-issue">{issues.remoteToken}</p>}
      <div className="form-actions">
        <button type="button" className="secondary" disabled={remoteToken.trim() === "" || tokenCheck?.state === "checking"} onClick={() => void checkToken()}>
          {tokenCheck?.state === "checking" ? "校验中…" : "测试连接"}
        </button>
      </div>
      {tokenCheck?.state === "done" && <div
        className={`test-result ${tokenCheck.result.ok ? "ok" : "fail"}`}
        // The raw upstream message stays one hover away for debugging.
        title={tokenCheck.result.ok ? undefined : tokenCheck.result.error}>
        {tokenCheck.result.ok
          ? `✓ 可访问「${tokenCheck.result.name ?? tokenCheck.result.token}」${typeof tokenCheck.result.children === "number" ? ` · ${tokenCheck.result.children} 个子项` : ""}`
          : `✗ 无法访问：${describeTokenProblem(tokenCheck.result)}`}
      </div>}
      <p className="muted form-hint">token 获取：在飞书云空间打开目标文件夹（或知识空间打开节点），复制地址栏末尾的 token。</p>
    </fieldset>

    <fieldset className="form-group">
      <legend>
        <button type="button" className="link-button" onClick={() => setAdvancedOpen((open) => !open)}>
          ⚙️ 高级选项 {advancedOpen ? "▾" : "▸"}
        </button>
      </legend>
      {advancedOpen && <>
        <label className="form-row">
          <span>轮询间隔（秒）</span>
          <input
            className="interval-input"
            type="number"
            min={1}
            value={intervalSec}
            onChange={(event) => setIntervalSec(event.target.value)}
            placeholder={`默认 ${defaultHint}`}
          />
        </label>
        {issues.intervalSec && <p className="form-issue">{issues.intervalSec}</p>}
        <label className="form-row">
          <span>同步方向</span>
          <select value={mode} onChange={(event) => setMode(event.target.value as SyncMode)}>
            {(Object.keys(SYNC_MODE_LABELS) as SyncMode[]).map((key) => <option key={key} value={key}>{SYNC_MODE_LABELS[key]}</option>)}
          </select>
        </label>
        <p className="muted form-hint">仅拉取：远端改动同步到本地，本地改动不上传；仅推送：本地改动上传，远端改动不拉回。留空轮询间隔则使用全局默认值。</p>
        <label className="form-row form-row-stacked">
          <span className="form-label">排除规则（glob）</span>
          <textarea
            className="exclude-input"
            rows={3}
            value={exclude}
            onChange={(event) => setExclude(event.target.value)}
            onBlur={() => void checkLocalPath(undefined, exclude)}
            placeholder={"drafts\ntmp-*.md\n**/*.draft.md"}
          />
        </label>
        <p className="muted form-hint">每行一个模式，也可用逗号分隔；当前 {describeExcludePatterns(parseExcludePatterns(exclude))}。命中的目录会整体跳过本地扫描与文件监听。</p>
      </>}
    </fieldset>

    {error && <div className="form-notice">{error}</div>}
    <div className="form-actions">
      <button type="button" className="secondary" onClick={onCancel}>取消</button>
      <button type="submit" className="primary" disabled={!submittable || submitting}>{submitting ? "绑定中…" : "绑定根目录"}</button>
    </div>
  </form>;
}
