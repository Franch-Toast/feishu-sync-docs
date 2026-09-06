# Feishu Local Sync

一个本地优先的后台服务，将本地 Markdown 目录与飞书/Lark 云文档目录双向同步，并提供浏览器冲突处理界面。

当前实现的核心行为：

- 递归扫描本地 Markdown 和相对路径图片，文件监听与定时轮询同时工作；
- 保存本地文件、远端文档和上一次共同基线，按三方结果决定推送、拉取、合并或暂停冲突；
- 在 OpenAPI 能返回原生块 ID 时，对单块内容、单块插入和单块删除使用 revision-guarded 更新；无法可靠映射时自动回退为整篇 Markdown 更新；
- 将目录内已绑定的 Markdown 文档链接改写为飞书文档引用，将图片改写为远端资源引用，拉回本地时恢复为相对路径；
- 远端目录中新建的文档会按云盘相对目录导入本地；同名但未绑定的本地文件不会被静默覆盖，而是进入冲突工作台；
- 图片单独变化会使引用它的文档重新同步；远端图片变更会先下载到本地，再纳入文档比较；
- 同时修改同一块内容时不覆盖任一侧，冲突会在网页工作台中保留 base/local/remote 三个版本；解决前会再次校验远端 revision，避免使用过期内容覆盖新修改；
- 冲突支持"暂不处理"：决定会持久化到状态库，条目重新进入待评估队列，后续轮询基于最新三方数据重新判断；
- 同步失败的条目会标记为 error 并在操作日志中留痕，后续轮询会自动重试。

## 环境要求

- Node.js >= 23.4：状态存储使用 Node 内置 `node:sqlite` 模块，安装依赖无需编译任何原生模块；
- pnpm：可通过 `corepack enable` 启用。

## 当前范围

第一期使用飞书云盘文件夹作为远端根目录。`remoteType=wiki` 会被适配器明确拒绝，避免把知识库节点错误地当成云盘目录处理；知识库需要独立的 Wiki provider 和节点映射策略，后续可以在 provider 边界内增加。

内容模型聚焦常见 Markdown 段落、标题、列表、引用、代码块、链接和图片。复杂富文本、表格、画板等结构如果不能安全映射，会采用整篇更新或产生错误，不会静默伪造块 ID。删除采用保守策略：本地或远端缺失先标记为 orphan；真正删除远端对象需要通过带确认字段的 API 操作。

远端实时事件接口暂未接入，服务目前使用本地文件事件加定时轮询；因此 `pollIntervalMs` 是必要的容错机制。远端连续修改不会让本地反复覆盖：每次同步都基于持久化基线做三方判断，冲突则暂停该文档，直到网页端解决。

## Quick start

```bash
pnpm install
pnpm build
pnpm --filter @feishu-sync/server dev
```

打开 <http://127.0.0.1:8787>。服务默认只监听本机。

配置飞书访问方式：

```bash
export FEISHU_ACCESS_TOKEN="..."
# 或使用应用身份
export FEISHU_APP_ID="..."
export FEISHU_APP_SECRET="..."
```

默认使用原生 OpenAPI provider：基于飞书新版文档 Markdown API（docs_ai，与官方 lark-cli v2 一致）提供整篇 Markdown 的原子读写、revision 并发控制和块级命令；应用身份（`FEISHU_APP_ID`/`FEISHU_APP_SECRET`）下 tenant_access_token 会在过期前自动刷新。也可以设置 `FEISHU_PROVIDER=cli` 使用本地 `lark-cli`：

```bash
export FEISHU_PROVIDER=cli
export LARK_CLI_BIN=lark-cli
```

CLI 路径支持 `LARK_CLI_BIN`（优先）或旧名 `LARK_CLI_PATH`。

当前本地 CLI 适配器兼容旧版 CLI 的整篇 Markdown 更新；只有安装了支持 v2 文档命令的 CLI 时才设置 `LARK_CLI_API_VERSION=v2`，并由 CLI 适配器尝试块级命令。图片上传和远端目录遍历优先使用 OpenAPI provider。

在网页中添加本地目录和云盘文件夹 token，本地路径必须真实存在，否则 API 返回 400。也可以直接调用 API：

```bash
curl -X POST http://127.0.0.1:8787/api/roots \
  -H 'content-type: application/json' \
  -d '{"localPath":"/absolute/path/to/docs","remoteToken":"feishu-folder-token","remoteType":"folder","pollIntervalMs":15000}'
```

运行时配置：

- `SYNC_DB_PATH`：SQLite 状态库路径，默认 `.data/sync.db`；
- `FEISHU_BASE_URL`：飞书或 Lark API 地址，默认 `https://open.feishu.cn`；
- `HOST`、`PORT`：服务监听地址和端口，默认 `127.0.0.1:8787`。

## Architecture

```text
local watcher + poller       web UI / REST / WebSocket
            \                 /
             sync runtime queue
                      |
       core: model, Markdown, hash, merge, policy
             /                         \\
   filesystem + SQLite          RemoteProvider
                                  /          \\
                         Feishu OpenAPI   lark-cli
```

`packages/core` 不依赖飞书 SDK，负责规范化、哈希、三方合并、资源引用和块补丁规划。`packages/storage` 负责基于 Node 内置 `node:sqlite` 的 SQLite 持久化。`packages/feishu` 只实现远端能力。`packages/server` 负责常驻进程（支持 SIGINT/SIGTERM 优雅退出）、文件监听、任务串行化、API 和冲突生命周期。后续增加其他远端或本地来源时，优先新增 provider，不修改同步核心。

## Development

```bash
pnpm test
pnpm typecheck
pnpm build
```

测试覆盖 Markdown 解析和引用改写、三方合并和块补丁规划、SQLite 状态迁移、OpenAPI 请求与 revision 校验、CLI 适配器、资源绑定、同步运行时和 HTTP API。生产环境还应补充飞书租户权限、限流、超大文档和复杂富文本的集成测试。
