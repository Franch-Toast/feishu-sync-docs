# 项目代码结构详解

## 1. 顶层目录一览

```
feishu-sync-docs/
├── packages/
│   ├── core/        # 同步算法核心（零外部依赖，不依赖飞书 SDK）
│   ├── feishu/      # 飞书远端能力封装（OpenAPI + lark-cli 适配器）
│   ├── storage/     # 持久化层（isomorphic-git + JSON 文件）
│   ├── server/      # 常驻服务进程（Fastify + SyncRuntime）
│   └── web/         # 浏览器工作台（React 19 + Vite）
├── docs/            # 项目文档（本目录）
├── README.md        # 面向用户的功能说明与快速上手
├── package.json     # monorepo 根脚本（build/test/typecheck）
├── pnpm-workspace.yaml  # pnpm workspace 声明
├── pnpm-lock.yaml   # 依赖锁文件
└── tsconfig.base.ts # TypeScript 公共编译选项
```

依赖方向（单向，禁止反向引用）：

```
web  ─────────────────────►  server
server  ─────►  feishu  ─────►  core
          ─────►  storage ─────►
```

`core` 处于最底层，不依赖任何其他包。`web` 只通过 REST/WS API 与 `server` 交互，不直接引用其他包。

---

## 2. packages/core — 同步算法核心

**职责**：定义所有数据契约、实现不依赖飞书的纯算法逻辑，包括扫描、配对、合并、补丁规划。

| 文件 | 行数 | 功能说明 |
|---|---|---|
| `types.ts` | 424 | 全局接口与类型定义：`SyncRoot`、`EntryBinding`、`RemoteProvider`、`MetaStorage`、`GitStorage`、`ConflictRecord`、`OperationRecord` 等，是整个系统的契约层 |
| `sync.ts` | 1164 | **`SyncEngine`** 主类，实现 `scan()`（两阶段扫描+四级配对）和 `syncEntry()`（单条三方决策与执行）；含 `importRemoteDocument`、`ensureRemoteParent`、`governRemoteDuplicates`、`detectRename`、`prepareAssets` 等私有方法 |
| `merge.ts` | 157 | 三方合并决策：`decideSync(base, local, remote)` 返回 noop/pull/push/merge/conflict；`buildBlockPatch()` 规划块级增量补丁，仅在 Block 结构对齐时按 blockId 做 replace/insertAfter/delete，否则降级为全量 overwrite |
| `markdown.ts` | 231 | Markdown 规范化：`parseMarkdown()` 将内容切分为 `CanonicalBlock[]`（段落/标题/代码块/表格等），计算 stableId 与 contentHash；`rewriteInternalLinks/Assets` 与对应 restore 函数负责本地路径↔远端 token 的双向改写 |
| `local.ts` | 133 | `FilesystemProvider`：实现 `LocalProvider` 接口；`scan()` 递归遍历（跳过隐藏文件、node_modules、非白名单扩展名），`scanEntries()` 增量 stat 指定路径，含路径逃逸防护 |
| `names.ts` | 67 | `normalizeForMatch()`：NFC 归一化 + trim，用于标题/文件名比较；`sanitizeLocalSegment()`：NFC、非法字符替换、HTML 实体还原、Windows 保留名规避、255 字节截断，保证任意飞书文档标题均可映射到合法文件名 |
| `glob.ts` | 51 | gitignore 风格的 glob 匹配器 `matchesAnyGlob()`，供 `exclude` 模式过滤使用；与 chokidar 的 `ignored` 回调复用同一实现 |
| `hash.ts` | 9 | `sha256(content)` — 内容哈希，`normalizeText()` — CRLF 归一化，是内容等价判断的基础 |
| `index.ts` | 8 | 统一导出以上所有 public 符号 |

**测试**（`core/test/`）：`merge.test.ts`、`markdown.test.ts`、`names.test.ts`、`glob.test.ts`、`local.test.ts`，覆盖合并决策、Block 切分、文件名净化、增量扫描等纯算法部分。

---

## 3. packages/feishu — 飞书远端适配层

**职责**：将 `core.RemoteProvider` 接口对接到真实的飞书开放平台 API，屏蔽 HTTP 细节、Token 刷新与错误分类。

| 文件 | 行数 | 功能说明 |
|---|---|---|
| `openapi.ts` | 458 | `FeishuOpenApiProvider`：实现 `listTree`（drive 目录递归）、`getDocument`/`createDocument`/`applyPatch`（docs_ai Markdown 原子读写）、`uploadAsset`/`uploadInlineAsset`（drive + docx 图片）、`softDelete`、`renameDocument`（page block 标题回钉）；内含 user_access_token 自动刷新逻辑（refresh token 过期前 5min 触发，带 60s 冷却防抖） |
| `errors.ts` | 111 | 飞书 API 错误码→语义分类：`categorizeError()` 返回 auth/conflict/network/permission/not_found/rate_limit/unknown；定义 `FeishuApiError`、`FeishuOAuthError`、`RETRIABLE_ERROR_CATEGORIES`；解析 HTTP 429 的 `Retry-After` 头 |
| `cli.ts` | 107 | `LarkCliProvider`：通过 `child_process.execFile` 调用本地 lark-cli 命令，支持 v1/v2 API；OpenAPI 优先，CLI 作为备选方案 |
| `ws.ts` | 5 | 导出 `@larksuiteoapi/node-sdk` 的 `WSClient`、`EventDispatcher`、`Domain` 等，供 server 的 `EventChannelService` 使用 |
| `index.ts` | 4 | 统一导出 |

**测试**（`feishu/test/`）：`openapi.test.ts` 通过 mock fetch 验证各接口的请求路径/参数与 revision 校验；`cli.test.ts` 验证 CLI 调用解析。

---

## 4. packages/storage — 持久化层

**职责**：实现 `core.GitStorage` 和 `core.MetaStorage` 两个接口，负责文档内容/历史与元数据的持久化。

| 文件 | 行数 | 功能说明 |
|---|---|---|
| `git.ts` | 299 | `GitStorageImpl`：用 `isomorphic-git` 在每个同步根目录初始化 `.git`；实现 `getBaseline()`（读 HEAD commit 的 blob）、`commitBaseline()`（将 clean 路径 stage+commit）、`readBlobAt()`/`listCommitsForPath()`（版本历史）、`detectChanges()`（git status）；写入工作树委托给 `node:fs`，git 只负责历史 |
| `meta.ts` | 643 | `JsonMetaStorage`：将同步元数据存储在各自根目录下的 `.feishu-sync/` 文件夹（JSON 文件），全局配置存储在 `~/.feishu-sync-docs/`；实现 bindings/folders/blocks/operations/conflicts/settings/states 的完整 CRUD；operations 用环形缓冲区（上限 1000 条）；所有写入走 **tmp 文件 + renameSync** 原子写 |
| `index.ts` | 2 | 导出两个实现类 |

**.feishu-sync/ 目录结构**（每个同步根）：
```
.feishu-sync/
├── bindings.json     # relativePath → EntryBinding 映射（真相源）
├── folders.json      # relativePath → remoteToken 文件夹绑定
├── assets.json       # assetPath → 引用此资源的 document entryId 列表
├── operations.json   # 操作记录环形缓冲区（≤1000条）
├── state.json        # RootState：lastSyncCommit/lastSyncAt/initialized
├── blocks/           # 每个 document 的 BlockMapping（<entryId>.json）
└── conflicts/        # 每个冲突记录（<conflictId>.json）
```

**测试**（`storage/test/`）：`storage.test.ts` 验证 GitStorage 的 initRoot/commitBaseline/getBaseline/detectChanges 和 MetaStorage 的全量 CRUD。

---

## 5. packages/server — 常驻服务进程

**职责**：加载配置、持有运行时状态、提供 REST/WS API、调度同步任务、管理凭证生命周期。

| 文件 | 行数 | 功能说明 |
|---|---|---|
| `runtime.ts` | 916 | **`SyncRuntime`**：整个服务的核心调度器。管理 chokidar watcher（`startRoot/stopRoot/restartRoot`）、定时器轮询、per-root 串行队列（`enqueue`）、`scanAndSync()` 主循环（预排队+逐条重试+commitBaseline）、echo 防护（`recentLocalWrites/recentRemotePushes` 5s TTL）、任务中心视图（`listTasks`）、冲突解决、版本历史、增量事件 scope 传递、维护定时任务（pruneHistory + 凭证续期）；`watcherIgnore()` 函数防止 `.git`/`.feishu-sync` 写入触发同步死循环 |
| `app.ts` | 507 | **`buildApp()`**：Fastify 实例工厂，注册所有 REST 路由（见下表）与 WebSocket 端点；装配 storage/provider/runtime/credentials/eventchannel 各层依赖；实现路径穿越防护、根目录唯一性检查、孤儿元数据归档、批量操作、任务中心 API |
| `credentials.ts` | 382 | `CredentialStore`：读写 config.json 中的飞书凭证（支持 user/tenant/cli 三种模式）；实现 OAuth v3 授权码流程（`buildAuthorizeUrl`/`exchangeCode`）；`testConnection()` 探测 token 有效性；`maintainUserToken()` 主动续期；`redacted()` 返回脱敏视图供前端展示 |
| `appconfig.ts` | 153 | `AppConfigStore`：config.json 的读写封装，含全局偏好（defaultPollIntervalMs/logLevel/notification 开关）和 authFlag（ok/invalid）；原子写入 + chmod 0600 |
| `provider.ts` | 82 | `ProviderRegistry`：实现 `RemoteProvider` 接口的代理，delegate 可热重建（凭证保存后无需重启）；env-only 工厂 `createRemoteProvider()` 用于测试/嵌入场景 |
| `apistats.ts` | 105 | `ApiCallStats` + `instrumentRemote()`：用 Proxy 包装 RemoteProvider，统计各方法调用次数/错误数/限流命中数，供设置页「调用统计」展示 |
| `eventchannel.ts` | 200 | `EventChannelService`：通过飞书 SDK 的 `WSClient` 建立长连接订阅 drive 事件；解析 `drive.file.*` / `docx.*` 事件提取 token/parentToken；1.5s 尾部 debounce 合并突发事件；触发 `runtime.requestSync()` 执行增量同步 |
| `notify.ts` | 39 | `Notifier` 接口 + `NoopNotifier`（默认）；预留 `FeishuWebhookNotifier` 骨架；3类事件：conflict / failure / credential |
| `index.ts` | 18 | 进程入口：`buildApp()` → 加载环境变量 → `app.listen()` → 注册 SIGINT/SIGTERM 优雅退出钩子 |

**主要 API 路由**（`app.ts`）：

| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/api/health` | 服务健康与凭证状态探针 |
| GET/PUT | `/api/settings` | 飞书凭证读写（脱敏返回） |
| GET | `/api/auth/feishu/authorize` | OAuth 授权 URL 生成 |
| GET | `/api/auth/feishu/callback` | OAuth 回调换 token |
| GET/PUT | `/api/app-config` | 全局偏好读写 |
| GET | `/api/api-stats` | API 调用统计快照 |
| GET/POST/PATCH/DELETE | `/api/roots` | 同步根 CRUD |
| POST | `/api/roots/:id/scan` | 手动触发扫描 |
| POST | `/api/roots/:id/sync` | 手动触发同步 |
| GET | `/api/roots/:id/tree` | 本地文档树（含 syncing 徽标） |
| GET | `/api/roots/:id/stats` | 根目录统计 |
| GET | `/api/roots/:id/file` | 本地文件内容（路径穿越防护） |
| GET | `/api/roots/:id/history` | 文档版本时间线 |
| GET | `/api/roots/:id/folders` | 文件夹绑定列表 |
| POST | `/api/roots/:id/sync-missing` | 一键重同步缺失条目 |
| GET | `/api/entries/:id/content` | 文档内容预览 |
| POST | `/api/entries/:id/sync` | 单条强制同步 |
| POST | `/api/entries/:id/rollback` | 回滚到历史版本 |
| GET | `/api/entries/:id/diff` | 与基线/历史版本 diff |
| GET/POST | `/api/conflicts` | 冲突列表与解决 |
| GET/POST | `/api/tasks` | 任务中心队列视图与批量操作 |
| GET | `/api/operations` | 操作记录分页查询 |
| GET/WS | `/api/events` | 实时事件流（WebSocket） |

**测试**（`server/test/`）：`app.test.ts`（HTTP 路由集成）、`runtime.test.ts`（SyncRuntime 单元测试）、`sync.test.ts`（端到端引擎逻辑）、`credentials.test.ts`（凭证读写/OAuth）、`apistats.test.ts`、`appconfig.test.ts`、`assets.test.ts`；`helpers/fake-remote.ts` 提供 mock RemoteProvider。

---

## 6. packages/web — 浏览器工作台

**职责**：React 19 SPA，由 Vite 构建，构建产物 `packages/web/dist/` 被 `server` 静态托管。

| 文件/目录 | 功能说明 |
|---|---|
| `App.tsx` | 主布局（侧边栏导航 + 顶部状态栏 + 视图切换）；WebSocket 连接管理与事件分发；全局状态持有（roots/settings/auth/eventchannel）；Onboarding 向导逻辑 |
| `api.ts` | REST API 封装（类型安全 fetch）；所有服务端类型（`Root`/`EntryBinding`/`Conflict`/`Operation`/`ServerEvent` 等）的前端镜像 |
| `components/Dashboard.tsx` | 仪表盘：全局健康统计卡片 + 各根目录卡片（状态徽章、立即同步/暂停按钮） |
| `components/RootDetail.tsx` | 根详情页容器，Tab 切换：文档 / 冲突 / 历史 |
| `components/DocsView.tsx` | 文档树视图：文件搜索、Markdown 渲染预览、恢复到基线版本、单条重试/忽略 |
| `components/IssuesView.tsx` | 冲突工作台：git 式分栏（BASE/LOCAL/REMOTE 三栏）、hunk 级采用/撤回、合并编辑器 |
| `components/HistoryView.tsx` | 历史操作记录（按状态/方向过滤），失败一键重试 |
| `components/HistoryTimeline.tsx` | 文档版本时间线（git log），支持 diff 与回滚 |
| `components/TaskCenter.tsx` | 任务中心：进行中（排队中/同步中）/ 失败待处理 / 已完成；批量重试/移除/清空 |
| `components/SettingsView.tsx` | 设置页：凭证配置（OAuth/手动/tenant/CLI）、联通测试、事件通道、同步计划、维护、API 统计 |
| `components/BindRootForm.tsx` | 新建同步根目录表单：路径验证、token 验证、模式与 exclude 选项 |
| `components/OnboardingWizard.tsx` | 首次使用引导向导 |
| `components/GuideModal.tsx` | 飞书后台权限配置指引弹窗 |
| `components/MarkdownPreview.tsx` | Markdown 渲染（markdown-it，html:false 防 XSS） |
| `components/Icon.tsx` | SVG 图标集合 |
| `diff.ts` | 分栏 diff 计算封装（基于 jsdiff） |
| `fileTree.ts` | 将扁平 binding 列表构建为树形结构供 DocsView 渲染 |
| `exclude.ts` | exclude 模式的 UI 编辑逻辑 |
| `markdown.ts` | 前端 Markdown 解析辅助（代码高亮、内部链接处理） |
| `onboarding.ts` | Onboarding 步骤计算与 localStorage 持久化 |

---

## 7. 跨层数据流示意

```
本地文件系统                飞书云盘
    │                          │
    │ FilesystemProvider       │ FeishuOpenApiProvider
    │ (core/local.ts)          │ (feishu/openapi.ts)
    │                          │
    └──────────┬───────────────┘
               │ LocalProvider / RemoteProvider
          SyncEngine(core/sync.ts)
               │
     ┌─────────┴──────────┐
     │                    │
GitStorage           MetaStorage
(storage/git.ts)    (storage/meta.ts)
  .git/              .feishu-sync/*.json
                     ~/.feishu-sync-docs/roots.json
               │
          SyncRuntime(server/runtime.ts)
               │ 任务队列/重试/echo防护/broadcast
          Fastify HTTP+WS API(server/app.ts)
               │
          React SPA(web/App.tsx)
```
