import React, { useState } from "react";
import { api, authGuideUrl, type RedactedSettings } from "../api";

interface GuideModalProps {
  settings: RedactedSettings;
  onClose: () => void;
  onSaved: () => void;
}

/** Step-by-step dialog shown when credentials are missing or rejected:
 *  explains where to renew the token, deep-links there, and accepts a
 *  pasted replacement which is saved and re-probed immediately. */
export function GuideModal({ settings, onClose, onSaved }: GuideModalProps): React.JSX.Element {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<string>();

  const guideUrl = authGuideUrl(settings);
  const mode = settings.mode;

  const submitToken = async () => {
    if (!token.trim() || saving) return;
    setSaving(true);
    setResult(undefined);
    try {
      const saved = await api.saveSettings({ accessToken: token.trim() });
      if (saved.test.ok) {
        onSaved();
        onClose();
      } else {
        setResult(saved.test.error ?? "校验失败，请确认 token 是否复制完整");
      }
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return <div className="modal-backdrop" onClick={onClose}>
    <div className="modal" onClick={(event) => event.stopPropagation()}>
      <div className="modal-heading">
        <div>
          <h3>{settings.authStatus === "invalid" ? "飞书凭证已失效" : "配置飞书凭证"}</h3>
          <span className="muted">同步已暂停依赖此凭证，更新后立即恢复，无需重启服务</span>
        </div>
        <button className="secondary" onClick={onClose}>关闭</button>
      </div>

      {mode === "user" && <>
        <ol className="guide-steps">
          <li>点击下方按钮打开 <strong>飞书开放平台 API 调试台</strong>，使用飞书账号登录。</li>
          <li>在左侧接口列表选择「获取用户信息 <code>user_info</code>」（或任意使用 user_access_token 的接口）。</li>
          <li>调试台会自动生成当前账号的 <strong>user_access_token</strong>，点击复制。</li>
          <li>把 token 粘贴到下方输入框，保存后服务端会立即重测联通并恢复同步。</li>
        </ol>
        <div className="guide-paste">
          <input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="粘贴新的 user_access_token" />
          <button className="primary" disabled={saving || !token.trim()} onClick={() => void submitToken()}>{saving ? "校验中…" : "保存并重测"}</button>
        </div>
      </>}

      {mode === "tenant" && <>
        <ol className="guide-steps">
          <li>点击下方按钮打开 <strong>开发者后台</strong> 中当前应用的「凭证与基础信息」页面。</li>
          <li>复制 App ID 与 App Secret（如已过期需要重置 App Secret）。</li>
          <li>回到 <strong>设置</strong> 页，在「应用凭证」模式下粘贴并保存。</li>
        </ol>
        {settings.appId && <p className="muted">当前 App ID：{settings.appId}</p>}
      </>}

      {mode === "cli" && <>
        <ol className="guide-steps">
          <li>在终端运行 <code>lark-cli auth login</code> 重新完成登录授权。</li>
          <li>确认本服务使用的 lark-cli 可执行文件路径正确（可在设置页修改）。</li>
          <li>保存设置后服务端会重新加载 CLI provider。</li>
        </ol>
      </>}

      {mode !== "cli" && <div className="guide-actions">
        <a className="primary as-link" href={guideUrl} target="_blank" rel="noreferrer">前往{mode === "user" ? " API 调试台" : "开发者后台"} ↗</a>
        <span className="muted">{guideUrl}</span>
      </div>}
      {result && <div className="test-result fail">✗ {result}</div>}
    </div>
  </div>;
}
