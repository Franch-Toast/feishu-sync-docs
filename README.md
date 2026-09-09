# Feishu Local Sync

一个本地优先的后台服务，将本地 Markdown 目录与飞书/Lark 云文档目录双向同步，并提供浏览器工作台：凭证设置、联通测试、git 式冲突解决、Markdown 渲染预览与同步历史管理都在网页中完成。

当前实现的核心行为：

- 递归扫描本地 Markdown 和相对路径图片，文件监听与定时轮询同时工作；
- 保存本地文件、远端文档和上一次共同基线，按三方结果决定推送、拉取、合并或暂停冲突；
- 在 OpenAPI 能返回原生块 ID 时，对单块内容、单块插入和单块删除使用 revision-guarded 更新；无法可靠映射时自动回退为整篇 Markdown 更新；
- 将目录内已绑定的 Markdown 文档链接改写为飞书文档引用，将图片改写为远端资源引用，拉回本地时恢复为相对路径；
- 远端目录中新建的文档会按云盘相对目录导入本地；同名但未绑定的本地文件不会被静默覆盖，而是进入冲突工作台；
- 图片单独变化会使引用它的文档重新同步；远端图片变更会先下载到本地，再纳入文档比较；
- 同时修改同一块内容时不覆盖任一侧，冲突会在网页工作台中保留 base/local/remote 三个版本；解决前会再次校验远端 revision，避免使用过期内容覆盖新修改；
- 冲突支持"暂不处理"：决定会持久化到状态库，条目重新进入待评估队列，后续轮询基于最新三方数据重新判断；
- 同步失败的条目会标记为 error 并在操作日志中留痕，后续轮询会自动重试；
- 凭证保存在本地配置文件中并在浏览器设置页管理（用户 Token / 应用凭证 / lark-cli 三种模式），保存后 provider 热重建立即生效，支持一键联通测试；
- 飞书返回认证错误时自动暂停同步：顶栏徽章告警、WebSocket 广播并弹出修复引导，按认证方式深链到 API 调试台或开发者后台，粘贴新 Token 保存后自动重测并恢复。

## 环境要求

- Node.js >= 20：存储层使用 `isomorphic-git`（纯 JS）+ JSON 文件，安装依赖无需编译任何原生模块；
- pnpm：可通过 `corepack enable` 启用。

## 当前范围

第一期使用飞书云盘文件夹作为远端根目录。`remoteType=wiki` 会被适配器明确拒绝，避免把知识库节点错误地当成云盘目录处理；知识库需要独立的 Wiki provider 和节点映射策略，后续可以在 provider 边界内增加。

内容模型聚焦常见 Markdown 段落、标题、列表、引用、代码块、链接和图片。复杂富文本、表格、画板等结构如果不能安全映射，会采用整篇更新或产生错误，不会静默伪造块 ID。删除采用保守策略：本地或远端缺失先标记为 orphan；真正删除远端对象需要通过带确认字段的 API 操作。

远端实时事件推送已接入：服务通过飞书开放平台 SDK 的 WebSocket 长连接订阅云盘文件事件，远端文档变更即时触发同步；定时轮询保留作为兜底，`pollIntervalMs` 仍是网络抖动下的容错机制。远端连续修改不会让本地反复覆盖：每次同步都基于持久化基线做三方判断，冲突则暂停该文档，直到网页端解决。

## Quick start

```bash
pnpm install
pnpm build
pnpm --filter @feishu-sync/server dev
```

打开 <http://127.0.0.1:8787>。服务默认只监听本机。

### 配置飞书凭证（推荐在浏览器完成）

打开页面右上角徽章或「设置」页：

1. 选择认证方式：**用户 Token**（个人授权，粘贴 user_access_token）、**应用凭证**（App ID + App Secret，tenant_access_token 自动刷新）或 **lark-cli**（复用本地登录态）；
2. 点击「测试联通」验证凭证，返回身份与延迟；
3. 点击「保存并生效」，服务端重建 provider 并自动重测，无需重启进程。

环境变量仍然可用作为 fallback（优先级：数据库设置 > 环境变量）：

```bash
export FEISHU_ACCESS_TOKEN="..."
# 或使用应用身份
export FEISHU_APP_ID="..."
export FEISHU_APP_SECRET="..."


export PATH=/sandbox/.tools/node-v24.10.0-linux-x64/bin:$PATH
```

Token 失效时同步自动暂停：顶栏徽章变红并弹出修复引导，按认证方式深链到飞书 API 调试台（user）或开发者后台凭证页（tenant），粘贴新 Token 保存后自动重测并恢复同步。引导链接可在设置中自定义。

默认使用原生 OpenAPI provider：基于飞书新版文档 Markdown API（docs_ai，与官方 lark-cli v2 一致）提供整篇 Markdown 的原子读写、revision 并发控制和块级命令。也可以选择 lark-cli 模式：

```bash
# 设置页选择「lark-cli」并填写可执行文件路径
export LARK_CLI_BIN=lark-cli
```

CLI 路径支持 `LARK_CLI_BIN`（优先）或旧名 `LARK_CLI_PATH`。

### 实时事件推送配置

配置应用凭证（App ID + App Secret）后，服务会自动尝试与飞书建立长连接订阅云盘文件事件；连接状态显示在设置页与 `/api/health` 中。完整分步指引也可在「设置 → 飞书凭证」的事件通道提示区点击「查看配置指引」打开：

1. **创建企业自建应用**：在 [飞书开发者后台](https://open.feishu.cn/app) 创建企业自建应用，记录 App ID / App Secret；
2. **开通云空间文档权限**：在「权限管理」中申请云文档读写权限（如 `docx:document`、`drive:drive`）；
3. **事件订阅选「长连接」并订阅 drive 文件事件**：在「事件与回调」页将接收方式切换为「使用长连接接收事件」，订阅云文档 drive 文件事件（`drive.file.*` 系列），无需公网回调地址；
4. **发布版本**：在「版本管理与发布」中创建版本并发布应用，事件订阅只有发布后才会生效；
5. **回填 App ID / App Secret**：回到设置页填写并保存，服务自动建立长连接；状态变为「已连接」即成功，轮询仍作为兜底继续运行。

事件通道异常时（状态 `error`），设置页会按错误内容给出排查建议：常见原因包括事件未订阅、应用版本未发布、云文档权限未开通与服务器网络受限。未配置应用凭证或选择 lark-cli 模式时事件通道保持 `disabled`，同步完全由文件监听与轮询驱动，不影响功能。

当前本地 CLI 适配器兼容旧版 CLI 的整篇 Markdown 更新；只有安装了支持 v2 文档命令的 CLI 时才设置 `LARK_CLI_API_VERSION=v2`，并由 CLI 适配器尝试块级命令。图片上传和远端目录遍历优先使用 OpenAPI provider。

在网页中添加本地目录和云盘文件夹 token，本地路径必须真实存在，否则 API 返回 400。也可以直接调用 API：

```bash
curl -X POST http://127.0.0.1:8787/api/roots \
  -H 'content-type: application/json' \
  -d '{"localPath":"/absolute/path/to/docs","remoteToken":"feishu-folder-token","remoteType":"folder","pollIntervalMs":15000}'
```

### 浏览器工作台

侧边栏五页：**仪表盘** / **文档** / **冲突工作台** / **历史** / **设置**，顶栏常驻连接状态、凭证徽章与全局「立即同步」。

- **仪表盘**：健康统计（上次同步时间、下次自动同步倒计时、24h 成功/失败数）与条目状态表，可直接跳转预览；
- **文档**：同步条目浏览与文件名搜索，Markdown 文档在浏览器内渲染（代码高亮、表格、引用；文档内相对路径图片通过 `GET /api/roots/:id/file` 代理展示），图片资源直接预览；非干净条目可一键**恢复到基线版本**；
- **冲突工作台**：git 式分栏对比 —— LOCAL/REMOTE 双栏（可展开 BASE 基线列），行级差异着色 + 词级高亮；按变更块（hunk）逐一「采用/撤回」，与另一侧重叠的块会警示覆盖关系；也可切换到编辑模式手动合并或预览渲染结果；已解决冲突保留完整历史可回溯；
- **历史**：按状态/方向/根目录过滤操作记录，失败操作一键重试；支持清理过期历史；
- **设置**：凭证管理与联通测试；同步计划可视管理（启停、轮询间隔热生效，无需重启）；浏览器通知开关（冲突与失败时系统提醒）；维护操作与安全提示。

运行时配置：

- `SYNC_CONFIG_PATH`：全局配置文件（凭证 + 偏好）路径，默认 `~/.feishu-sync-docs/config.json`；
- `SYNC_LOG_LEVEL`：日志级别（`debug`/`info`/`warn`/`error`），优先于设置页中保存的全局偏好；
- `FEISHU_BASE_URL`：飞书或 Lark API 地址，默认 `https://open.feishu.cn`；
- `HOST`、`PORT`：服务监听地址和端口，默认 `127.0.0.1:8787`；
- 凭证类环境变量（`FEISHU_ACCESS_TOKEN`、`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`LARK_CLI_BIN` 及旧名 `LARK_CLI_PATH`）仍作为 fallback 生效，浏览器设置页保存的配置优先于环境变量。

每个绑定的本地目录会被初始化为一个 Git 仓库（`.git/`），文档内容与版本历史存储在 Git 中；同步元数据（bindings、blocks、operations、conflicts）保存在同目录下的 `.feishu-sync/` JSON 文件中，`.gitignore` 会自动忽略该目录。

## 安全与数据

- 凭证（user token、app secret）以明文保存在本地配置文件 `~/.feishu-sync-docs/config.json` 中（权限 0600），这是本地优先设计的取舍：请确保该目录仅当前用户可读，必要时通过 `SYNC_CONFIG_PATH` 将其置于用户私有目录；
- 所有 API 返回的凭证均为脱敏形式（token 仅显示前 6 后 4 位），完整凭证不会回显到浏览器，也不会写入日志；
- 服务默认只监听 `127.0.0.1:8787`，如需局域网访问请自行置于反向代理并增加认证；
- 本地文件端点 `GET /api/roots/:id/file` 严格防路径穿越：resolve 后必须仍在对应根目录内，否则返回 403；
- 远端资产代理端点 `GET /api/assets/:token` 只接受已绑定条目中登记过的资源 token；
- Markdown 渲染默认转义内嵌 HTML（markdown-it `html:false`），文档内相对路径图片经服务端代理展示。

## Architecture

```text
local watcher + poller       web UI / REST / WebSocket
            \                 /
             sync runtime queue
                      |
       core: model, Markdown, hash, merge, policy
             /                         \
   filesystem + GitStorage      RemoteProvider
   (isomorphic-git + JSON)       /          \
                         Feishu OpenAPI   lark-cli
```

`packages/core` 不依赖飞书 SDK，负责规范化、哈希、三方合并、资源引用和块补丁规划。`packages/storage` 基于 `isomorphic-git` 管理文档内容与版本历史（GitStorage），并以 JSON 文件存储 bindings、blocks、operations、conflicts 等同步元数据（MetaStorage）。`packages/feishu` 只实现远端能力。`packages/server` 负责常驻进程（支持 SIGINT/SIGTERM 优雅退出）、文件监听、任务串行化、API 和冲突生命周期；凭证由 `CredentialStore` 统一管理（配置文件优先于环境变量），远端 provider 经由注册表按需热重建，设置变更后无需重启进程。后续增加其他远端或本地来源时，优先新增 provider，不修改同步核心。

## Development

```bash
pnpm test
pnpm typecheck
pnpm build
```

测试覆盖 Markdown 解析和引用改写、三方合并和块补丁规划、GitStorage/MetaStorage 持久化、OpenAPI 请求与 revision 校验、飞书错误码到 `FeishuApiError` 的语义分类（auth/permission/rate_limit/network）、CLI 适配器、资源绑定、同步运行时和 HTTP API（含设置读写与脱敏、联通测试、根目录 PATCH 热生效、本地文件端点路径穿越拒绝、资产代理、统计与基线恢复）。浏览器端使用 vitest 覆盖 diff 封装（行级/词级分块、hunk 合并与重叠检测）和 Markdown 渲染（代码高亮、相对图片代理重写）。生产环境还应补充飞书租户权限、限流、超大文档和复杂富文本的集成测试。
