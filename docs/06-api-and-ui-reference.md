# 06 · API / 事件 / 页面 / 配置参考

> 这是一份"查"的文档，不是"读"的文档。写前端、排障、联调时按分区索引。
>
> 端点全部在 `packages/server/src/app.ts`；WS 事件类型定义在 `packages/web/src/api.ts` 的 `ServerEvent`；错误分类在 `packages/feishu/src/errors.ts`；配置读写在 `packages/server/src/appconfig.ts` 与 `packages/storage/src/meta.ts`。

---

## 0. 通用约定

- **基址**：`http://HOST:PORT`，默认 `127.0.0.1:8787`（`HOST`/`PORT` 环境变量）。
- **前缀**：所有 REST 端点都在 `/api/` 下；实时事件走 `GET /api/events`（WebSocket）。
- **请求体**：JSON。`content-type: application/json` **只在有 body 时**才该带——无 body 的请求（尤其 DELETE）带上它会被 Fastify 以 `FST_ERR_CTP_EMPTY_JSON_BODY` 打回 400（前端 `api.ts` 的 `json<T>()` 已按此处理）。
- **错误响应统一形态**：`{ "error": "人类可读的中文/英文消息" }`。路由里手写的校验错误、以及 `setErrorHandler`（`app.ts:504`）兜底的未捕获异常都是这个形状。5xx 会同时写 `app.log.error`。
- **状态码惯例**：`200` 读/操作成功；`201` 创建 root；`204` 删除成功（无 body）；`400` 参数校验失败；`401` 凭证失效；`403` 越权/路径逃逸；`404` 资源不存在；`409` 冲突已过期（裁决时远端又变了）；`426` 对 WS 端点直接 GET（未升级）。
- **鉴权**：**无任何鉴权**——这是一个"本机/可信内网"假设下的本地服务，绑定的是本机文件系统目录。不要把它直接暴露到公网（安全提示见工作台设置页）。

---

## 1. HTTP 端点全表（46 个）

按功能分区。`runtime`/`meta`/`git`/`cred`/`remote` 代表处理逻辑落点。

### 1.1 健康与能力

| 方法 | 路径 | 作用 | 备注 |
| --- | --- | --- | --- |
| GET | `/api/health` | 返回 `{ok, provider, capabilities, authStatus, eventChannel}` | 起服务后第一个该打的点；`capabilities` 反映当前 provider 声明 |

### 1.2 凭证与设置（`CredentialStore` / `AppConfigStore`）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/settings` | 读取**脱敏后**的凭证（`credentials.redacted()`，密钥以 `mask()` 呈现）+ 事件通道状态 |
| PUT | `/api/settings` | 保存凭证输入（`CredentialInput`）；会导致 provider 热重建（`registry.rebuild()`）并广播 `settings-updated` |
| POST | `/api/settings/test-connection` | 用**给定或已存**凭证做一次连通测试，不回写 |
| GET | `/api/auth/feishu/authorize` | 生成 OAuth 授权 URL 并 302 跳转（user 模式） |
| GET | `/api/auth/feishu/callback` | OAuth 回调：校验 `state`、用 code 换 token、落盘、重建事件通道、`redirect("/?auth=ok")` |
| GET | `/api/app-config` | 读应用偏好（默认轮询间隔、日志级别、通知偏好）+ 配置文件路径 |
| PUT | `/api/app-config` | 写应用偏好；`logLevel` 在无 `SYNC_LOG_LEVEL` 覆盖时即时生效 |
| GET | `/api/api-stats` | 各端点调用计数与耗时（设置页「API 统计」，`apistats.ts`） |

### 1.3 根目录（SyncRoot）生命周期

| 方法 | 路径 | 作用 | 关键校验 / 副作用 |
| --- | --- | --- | --- |
| GET | `/api/roots` | 列出所有 root（`meta.listRoots()`） | — |
| POST | `/api/roots` | 新建 root | 校验通过后 `git.initRoot` + `meta.initRootMeta` + `runtime.startRoot`，广播 `root-updated`，返回 201 |
| PATCH | `/api/roots/:id` | 改 localPath/remoteToken/enabled/pollIntervalMs/mode/exclude | `pollIntervalMs ≥ 1000`；`localPath` 必须是已存在目录；`mode ∈ {bidirectional,pull-only,push-only}`；`exclude` 是字符串数组；改完 `restartRoot` 热应用 |
| DELETE | `/api/roots/:id` | 删除 root | 顺序：先 `stopRoot`→`meta.deleteRoot`→`git.deleteRoot`，**删除前**广播一次 `root-updated`（让订阅者还能解析 id）；返回 204 |
| GET | `/api/roots/:id/tree` | 该 root 的条目树（binding 视图） | — |
| GET | `/api/roots/:id/stats` | 汇总：`lastSyncAt`/`succeeded24h`/`failed24h`/`conflicts`/`entriesTotal`/`entriesByStatus` | 未找到 root 返回 404 |
| POST | `/api/roots/validate-token` | 绑定前轻探测远端 token（folder/document/wiki） | 经**带统计的** provider 探测；失败按错误分类映射状态码（auth→401/permission→403/not_found→404/其他→400） |
| POST | `/api/roots/validate-path` | 探测本地目录：是否存在、是否目录、首扫描会同步多少文件 | 尊重 `exclude`；返回 documents/assets/total 计数与 `writable` |

### 1.4 扫描与同步触发

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/api/roots/:id/scan` | 只跑扫描（不改内容），返回 `{entries, conflicts}`（`runtime.scanRoot`） |
| POST | `/api/roots/:id/sync` | 触发整轮同步；body 可选 `{trigger}`，非法 trigger → 400（`runtime.syncRoot`） |
| POST | `/api/roots/:id/sync-missing` | 只同步 `local-missing`/`remote-missing` 类条目（`runtime.syncMissingEntries`） |
| POST | `/api/roots/:id/pair` | 手动配对一条 `relativePath ↔ remoteToken`（body 两者必填，否则 400） |
| POST | `/api/roots/:id/stamp-identity` | **一键打标**：给该 root 所有已绑定文档补写信封，返回逐路径报告（`runtime.stampAll`）。目前无 UI 入口，见 [07 篇 §7](07-known-issues.md) |

### 1.5 条目（Entry）操作

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/entries/:id/content` | 读某条目当前内容（`runtime.readDocument`） |
| POST | `/api/entries/:id/sync` | 立即单独同步这一条（`runtime.syncEntryNow`） |
| POST | `/api/entries/:id/ignore` | 冻结/解冻这一条（body `{ignored:boolean}`）；冻结=打 `ignoredAt`，整条不参与评估 |
| POST | `/api/entries/:id/restore-base` | 把本地文件恢复到 git 基线版本（`runtime.restoreBase`） |
| GET | `/api/entries/:id/diff` | 该条目的 diff，`?against=`（默认 `baseline`） |
| POST | `/api/entries/:id/rollback` | 回滚到指定 `commit`（body `{commit}` 必填，否则 400） |
| POST | `/api/entries/:id/delete-remote` | 删除远端文档；**必须 `confirmed:true`**，否则 400（防误删） |
| POST | `/api/entries/batch` | 批量操作，body `{entryIds:[...], action:"retry"\|"ignore"\|"unignore"}`；ids 非空、action 合法否则 400 |

### 1.6 资源（图片/附件）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/roots/:id/file?path=` | 流式返回 root 内某本地文件（图片预览用）；`path` 必填；**严格路径穿越守卫**：解析后必须仍在 root 内，否则 403 |
| GET | `/api/assets/:token` | 代理下载一个**已登记为 asset** 的远端 token；跨所有 root 找 binding，只允许 `kind==="asset"`（文档 token 不能经此下载），命中后 `remote.downloadAsset`，`cache-control: public, max-age=300` |

### 1.7 目录（folder）绑定

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/roots/:id/folders` | 列出该 root 的目录映射（root 不存在 404） |
| POST | `/api/roots/:id/folders/rebind` | 手动重绑目录 `relativePath ↔ remoteToken`（两者必填，否则 400） |

### 1.8 冲突工作台

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/conflicts?status=` | 列冲突，默认 `open`；`status=all` 全部、`resolved`/`aborted` 对应状态。每条 join 出 `relativePath`/`localRoot`/`rootId` |
| GET | `/api/conflicts/:id` | 单条冲突详情（含 base/local/remote 三栏内容），不存在 404 |
| POST | `/api/conflicts/:id/resolve` | 裁决：body `{resolution:"local"\|"remote"\|"merged"\|"abort", mergedContent?}`；`merged` 必须带 `mergedContent`；`abort` 走重新排队，其余走 `applyResolvedContent`。**带过期检测**：远端 revision/hash 变了返回 409。⚠️ 见 [07 篇 §1](07-known-issues.md)：identity 冲突缺 `kind` 守卫 |

### 1.9 历史与任务中心

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/roots/:id/history?path=&limit=` | 某文件（`path` 必填）的 git 版本时间线 |
| GET | `/api/operations` | 操作流水，过滤参数：`rootId`/`trigger`/`errorCategory`/`status`/`limit`/`cursor`；每条 join `relativePath` |
| GET | `/api/tasks` | 任务中心分组视图，参数 `status`/`rootId`/`limit`/`cursor` |
| POST | `/api/tasks/:id/retry` | 重试单个失败任务 |
| POST | `/api/tasks/:id/cancel` | 取消排队中的任务 |
| POST | `/api/tasks/batch-retry` | 批量重试，body `{operationIds:string[]}` |
| POST | `/api/tasks/batch-dismiss` | 批量「忽略」=从列表移除失败记录（条目本身仍参与后续同步，区别于 entry 级 ignore 冻结） |
| POST | `/api/tasks/clear-completed` | 清空已完成，body 可选 `{statuses}`（必须是 `succeeded/cancelled/failed` 子集） |

### 1.10 维护

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/api/maintenance/prune` | 手动裁剪历史，body `{keepOperations?, keepOperationHours?, resolvedConflictDays?}`；广播 `maintenance-pruned`。⚠️ 返回的 `snapshots` 恒为 0，见 [07 篇 §6](07-known-issues.md) |

### 1.11 实时事件通道（WebSocket）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/events` | **WS 升级端点**。裸 GET（不升级）返回 426 `{error:"WebSocket upgrade required"}`。升级后 `runtime.addClient(socket)`，服务端主动推 §2 的事件 |

---

## 2. WebSocket 事件（20 类）

连接 `/api/events` 后，服务端先推一条 `connected`，之后同步过程的每一步都广播。前端 `App.tsx` 收到**任意**事件都会 `refresh()`（5 秒轮询 + WS 双保险，因为事件通道可能处于 disabled/error）。

事件类型联合定义在 `web/src/api.ts` 的 `ServerEvent`（`app.ts`/`runtime.ts` 用 `broadcastEvent`/`broadcast` 发出）。

### 2.1 前端 `ServerEvent` 已声明的 19 类

| type | 载荷 | 触发时机 |
| --- | --- | --- |
| `connected` | — | 握手成功后服务端首推 |
| `sync-started` | `{rootId, trigger, mode?}` | 一轮同步开始（跑条进度文案） |
| `sync` | `{rootId}` | 一轮同步结束 |
| `scan` | `{rootId}` | 一次扫描完成（不写内容的探测轮） |
| `operation-queued` | `{rootId, operation}` | 一条 pending 拿到 `OperationRecord(queued)` |
| `operation-started` | `{rootId, operation}` | 记录翻到 running（`startedAt` 此刻才填） |
| `operation-completed` | `{rootId, operation}` | 成功 |
| `operation-failed` | `{rootId, operation}` | 终态失败（含重试耗尽） |
| `operation-retrying` | `{rootId, operation, delayMs, retryCount}` | 一次自动重试前 |
| `rate-limited` | `{rootId, operationId, retryAfterMs, retryCount}` | 命中 429，退避下限取 Retry-After |
| `operation-cancelled` | `{rootId, operation}` | 被取消（auth fail-fast 时剩余 queued 批量取消） |
| `error` | `{rootId?, entryId?, error}` | 通用错误广播 |
| `auth-invalid` | — | 凭证失效（fail-fast 提前结束本轮） |
| `auth-restored` | — | 凭证恢复 |
| `settings-updated` | — | 凭证/偏好变更后广播 |
| `root-updated` | `{rootId}` | root 新建/更新/删除 |
| `conflict-resolved` | `{conflict:{id}}` | 冲突被裁决 |
| `conflict-aborted` | `{conflict:{id}}` | 冲突被中止（重新排队） |
| `maintenance-pruned` | `{operations, conflicts, snapshots}` | 历史裁剪完成 |

### 2.2 服务端发出但前端类型未声明的 1 类

| type | 载荷 | 说明 |
| --- | --- | --- |
| `identity-stamped` | `{rootId, ...}`（`runtime.ts:627`） | `stamp-identity` 完成后广播，但 **`ServerEvent` 联合里没有它**——前端不会因类型收不到编译告警，但也就不会针对性处理。属已知不一致，见 [07 篇 §5](07-known-issues.md) |

> 因此"事件总数"取决于口径：前端类型 19 类，服务端实际会广播 20 类。

---

## 3. 错误分类（`feishu/src/errors.ts`）

引擎和任务中心靠这个把"网络抖一下"和"需要人来处理"分开。

### 3.1 传输层分类 `classifyFeishuFailure`

| 分类 | 判定依据 |
| --- | --- |
| `auth` | envelope code ∈ `{99991661, 99991663, 99991664, 99991668, 99991679}`（**只收录无歧义的这 5 个**）；或 HTTP 401；或 CLI 消息命中 `/token\|auth\|认证\|登录\|unauthorized\|401/i` |
| `permission` | HTTP 403 或消息命中 `权限\|forbidden\|access denied` |
| `rate_limit` | HTTP 429 或 `too many\|限流` |
| `not_found` | HTTP 404 或 `notexisted\|deleted` |
| `network` | fetch 抛异常（DNS/refused/aborted） |
| `unknown` | 其余（`other` 折叠而来） |

### 3.2 是否自动重试

```
RETRIABLE_ERROR_CATEGORIES = { network, rate_limit, unknown }
```

- **可重试**：`network`/`rate_limit`/`unknown` —— 最多 3 次，指数退避 1s/2s/4s；`rate_limit` 的退避**不低于**服务端返回的 `Retry-After`。
- **不重试**：`auth`（需用户动作，且触发 `auth-invalid` fail-fast，取消本轮剩余 queued）、`permission`（需授权）、`conflict`（需人裁决）、`not_found`（本轮无解）。

### 3.3 状态优先于分类

`categorizeError(error, entryStatus)` 第一行：`if (entryStatus === "conflict") return "conflict"`。条目处于 conflict 时，**无论传输层是什么错**都归为 conflict，避免把一个需要人裁决的失败标成 unknown 让用户以为"再点重试就好"。

---

## 4. 凭证机制（`CredentialStore` / `openapi.ts`）

### 4.1 三种模式 `CredentialMode = "user" | "tenant" | "cli"`

| 模式 | 拿什么 token | 典型场景 |
| --- | --- | --- |
| `user` | 用户级 access/refresh token（OAuth v3 授权码流） | 以个人身份读写其云盘，最常见的 UI 授权路径 |
| `tenant` | `tenant_access_token`（appId+appSecret 内部接口） | 应用身份，无需用户授权；README 里提到的"手工 token"归在此类的无 refresh 变体 |
| `cli` | 委托本地 `lark-cli` 二进制 | 无法直连 OpenAPI 或需要 CLI 特定行为时；能力受 CLI 版本限制（`LARK_CLI_API_VERSION=v2` 才支持块级） |

默认模式推断（`credentials.ts:106`）：`FEISHU_PROVIDER=cli`→cli；否则有 appId/appSecret→tenant；再否则→user。

### 4.2 token 生命周期要点

- **OAuth 端点域名是 `accounts.feishu.cn`，不是 `open.feishu.cn`**（`accountsBaseUrl()` 做替换）。这是最容易配错的地方。
- **提前 5 分钟续期** + **60 秒续期冷却**（`refreshCooldownUntil`）+ **single-flight**（`this.tokenRequest`）：并发调用共享同一个刷新 Promise，因为 refresh token 是一次性轮换的，并发刷新会让后到的请求拿已失效的旧 token。
- **先落盘再返回**（`await onTokenRefresh`）：旧 refresh token 此刻已在服务端作废，崩溃窗口无法彻底消除（飞书机制固有）。
- **瞬时失败降级用旧 token**：断网/5xx 且旧 token 未真过期时，不刷挂调用方。

---

## 5. 环境变量（19 个）

全部经 `process.env` 读取；除标注外均为可选，凭证也能改由 config.json / UI 提供。

### 5.1 服务

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址 |
| `PORT` | `8787` | 监听端口 |
| `NODE_ENV` | — | `test` 时测试脚本用它切换行为 |
| `SYNC_CONFIG_PATH` | `~/.feishu-sync-docs/config.json` | 覆盖配置文件位置 |
| `SYNC_LOG_LEVEL` | 取自 app-config | 设定后**优先于** UI 的 logLevel |

### 5.2 飞书 provider

| 变量 | 作用 |
| --- | --- |
| `FEISHU_PROVIDER` | `openapi`（默认）\| `cli` |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 应用凭证 |
| `FEISHU_ACCESS_TOKEN` | 静态 access token（视为不过期的降级路径） |
| `FEISHU_REFRESH_TOKEN` | 用于 OAuth v3 续期 |
| `FEISHU_BASE_URL` | OpenAPI 基址（私有化/测试覆盖） |
| `FEISHU_OAUTH_REDIRECT_URI` | 显式指定回调（登记地址必须逐字符匹配，见根 README 排障提示） |
| `LARK_CLI_PATH` / `LARK_CLI_BIN` | lark-cli 可执行文件位置 |
| `LARK_CLI_API_VERSION` | `v2` 才启用块级能力 |

### 5.3 维护与保留策略（`numberFromEnv`，`runtime.ts`）

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `SYNC_RETENTION_OPERATIONS` | 1000 | 操作记录保留条数 |
| `SYNC_RETENTION_OPERATION_HOURS` | 24 | 操作记录保留小时数 |
| `SYNC_RETENTION_CONFLICT_DAYS` | 30 | 已解决冲突保留天数 |
| `SYNC_MAINTENANCE_INTERVAL_MS` | 3600000（1 小时） | 维护任务周期（定时器 `unref()`，不拖住进程退出） |

> 另有 `HOME`（Windows 上 `USERPROFILE`）被用于推导默认配置目录，属系统变量，不由用户设置。

---

## 6. 配置文件布局

无外部数据库，全是 JSON + Git。

### 6.1 全局（`~/.feishu-sync-docs/`，可被 `SYNC_CONFIG_PATH` 改）

| 文件 | 内容 | 读写方 |
| --- | --- | --- |
| `config.json` | 凭证 + 应用偏好（默认轮询间隔、日志级别、通知开关） | `appconfig.ts`（原子写：tmp+rename，`chmod 0600`） |
| `roots.json` | 所有 `SyncRoot` | `meta.ts` |
| `settings.json` | 全局设置项 | `meta.ts` |

### 6.2 每 root（`<localPath>/.feishu-sync/`，随仓库走）

| 文件/目录 | 内容 |
| --- | --- |
| `bindings.json` | `relativePath → EntryBinding`（含 `remoteToken`、status、hash…）。**身份的第二存储**（第一是文件信封） |
| `folders.json` | 目录映射 |
| `operations.json` | 操作流水环形缓冲（`MAX_OPERATIONS=1000`） |
| `assets.json` | 资源引用映射（本地路径 ↔ 远端 token） |
| `state.json` | root 级状态 |
| `blocks/<entryId>.json` | 块映射（块级补丁用） |
| `conflicts/<id>.json` | 冲突记录（base/local/remote 三栏 + kind） |
| `.git/` | 基线历史（三方合并的 base 来源），由 `GitStorageImpl`（isomorphic-git）管理 |

> `.feishu-sync/` 与 `initRoot` 写的 `.gitignore` 让元数据/依赖不进版本库。**删掉 `.feishu-sync/` 不再等于丢身份**——信封机制能从文件本身恢复（矩阵 #5′），这是引入信封前做不到的，详见 [04 篇 §2](04-special-mechanisms.md)。

---

## 7. 前端页面清单（`packages/web`）

无路由库，`App.tsx` 用一个 `View` 联合（`"dashboard"|"detail"|"tasks"|"settings"`）条件渲染。

| 视图/组件 | 文件 | 干什么 |
| --- | --- | --- |
| 外壳 / 路由 / WS / 轮询 | `src/App.tsx`（614 行） | 唯一入口，持 WS 连接、5 秒轮询、全局 toast；`View` 切换 |
| 引导向导 | `src/onboarding.ts` + `components/OnboardingWizard.tsx` + `GuideModal.tsx` | 首次三步（凭证→建根→首同步）与飞书后台配置指引 |
| 仪表盘 | `src/App.tsx`(dashboard) + `components/RootDetail.tsx` | root 卡片 + 详情外壳（文档/冲突/历史 tab） |
| 文档树 | `components/DocsView.tsx`（325 行）+ `src/fileTree.ts` | 条目树、搜索、Markdown 预览、图片经 `/api/roots/:id/file` 代理、恢复到基线 |
| 冲突工作台 | `components/IssuesView.tsx`（401 行）+ `src/diff.ts` | LOCAL/REMOTE 分栏（可展开 BASE）、行级+词级高亮、逐 hunk 采用/撤回、CodeMirror 手改、渲染预览；调 `/api/conflicts*` |
| 任务中心 | `components/TaskCenter.tsx`（341 行） | 进行中/失败待处理/已完成，错误分类展示，批量重试/忽略/清空；调 `/api/tasks*` |
| 历史 | `components/HistoryView.tsx` + `HistoryTimeline.tsx` | 操作记录列表（状态/方向过滤、失败一键重试）与单文档版本时间线 |
| 绑定表单 | `components/BindRootForm.tsx`（270 行） | 增改 root（含 exclude 编辑、validate-token/validate-path 探测） |
| 设置 | `components/SettingsView.tsx`（456 行） | 凭证管理、OAuth 授权、连通测试、同步计划、事件通道、维护操作、安全提示、API 统计 |
| Markdown 渲染 | `src/markdown.ts` + `components/MarkdownPreview.tsx` | `markdown-it`，**`html:false`**（转义内嵌 HTML 防 XSS） |
| 图标 | `components/Icon.tsx` | 内联 SVG 图标集（无图标库依赖） |

**刷新策略**：`App.tsx` 是"5 秒固定轮询 **+** 每条 WS 消息到达后立刻 `refresh()`"。不是 WS 替代轮询，而是"WS 让刷新及时、轮询兜住丢事件"（事件通道可能 `disabled`/`error`）。

**已知前端缺口**：`api.ts` 缺 `stamp-identity` 等少数端点的封装（只能 curl）；类型是服务端的手抄副本，无编译期保证。见 [07 篇 §4/§5](07-known-issues.md)。
