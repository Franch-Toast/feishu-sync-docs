# 工程标准审查（架构师视角）

审查范围：`packages/*/src/` 全部源码（约 6300 行 TS）、`test/`（约 4200 行）、构建配置与仓库结构。

---

## 1. 总体评价

**结论：整体架构设计优秀，工程化基础扎实，具备进入生产环境的条件，但若干结构性问题会在规模扩大后集中暴露，需要在下一迭代周期内安排专项重构。**

| 维度 | 评级 | 摘要 |
|---|---|---|
| 分层与依赖方向 | ★★★★★ | 五包单向依赖清晰，core 零外部依赖 |
| 接口抽象 | ★★★★★ | RemoteProvider/LocalProvider/GitStorage/MetaStorage 四大接口完整 |
| 类型安全 | ★★★★☆ | TS strict + noUncheckedIndexedAccess；部分 `as unknown as` 断言 |
| 错误处理 | ★★★★☆ | 语义分类完善；缺乏统一错误码规范与 API 错误契约 |
| 测试覆盖 | ★★★★☆ | 单测覆盖核心路径；缺端到端集成测试与压测 |
| 可观测性 | ★★★☆☆ | 结构化日志 + API 统计计数器；无 Metrics/Tracing |
| 并发安全 | ★★★★☆ | per-root 串行队列设计合理；内存队列无持久化 |
| 安全性 | ★★★★☆ | 路径穿越防护、凭证脱敏、原子写；无速率限制、无认证层 |
| 代码规模控制 | ★★☆☆☆ | sync.ts 1164行、runtime.ts 916行，god class 问题突出 |
| CI/CD | ★☆☆☆☆ | 无任何自动化构建/测试/发布流水线 |
| 文档完整性 | ★★★★☆ | 注释密度高，关键决策有 inline 说明；缺架构图与 runbook |

---

## 2. 架构设计亮点

### 2.1 本地优先的数据真相模型

文档内容、三方合并基线、版本历史全部存在用户本地的 `.git/` 中，`bindings.json` 是绑定关系的唯一真相源。飞书只是其中一个镜像端，服务挂掉/重启不丢数据，这个设计选择从工程角度极为稳健。

### 2.2 接口驱动的 Provider 扩展点

`RemoteProvider` 和 `LocalProvider` 两个接口将整个同步逻辑与具体 I/O 实现解耦，使得：
- 测试时可以注入 `FakeRemoteProvider`（已在 `server/test/helpers/fake-remote.ts` 中验证）；
- 未来新增 Notion/Confluence 只需实现接口，无需修改 `SyncEngine`；
- `ProviderRegistry` 作为代理支持凭证热重建，无需重启 watcher 与同步进程。

### 2.3 四级配对与重命名检测

`scan()` 中的 token→路径→标题→内容哈希四级递进配对链，加上 `detectRename()` 的哈希唯一匹配 re-point，覆盖了绝大多数元数据丢失场景，避免用户误操作（删 .feishu-sync 目录、重新绑定）后大量重复建文档。

### 2.4 增量快路径与降级保护

事件/watch trigger 携带 `SyncScope`，`scanEntries()` + `buildScopedRemoteTree()` 将大目录场景的扫描成本从 O(全部文件×getDocument) 降到 O(变更文件数)。任一前提失败自动回退全量扫描，**正确性优先于性能**，是工程上可靠的降级策略。

### 2.5 Echo 防护设计

`recentLocalWrites` + `recentRemotePushes` (5s TTL) 防止"pull 写本地 → watcher 触发同步 → push 写远端 → event 触发同步"的死循环，`watcherIgnore()` 过滤 `.git` 和 `.feishu-sync` 目录，这两个机制共同保证同步不会自激振荡。

---

## 3. 需要重点关注的问题

### 3.1 God Class：sync.ts 与 runtime.ts

**问题**：`SyncEngine` 1164 行，`SyncRuntime` 916 行，均超出可维护的单文件复杂度阈值。

`SyncEngine` 至少承担以下职责：
- 本地/远端树构建与缓存
- 同名副本治理
- 四级配对算法
- 远端文档导入
- 重命名检测
- 资源（图片）上传/下载与映射
- 三方决策与内容写入
- Block 映射持久化

建议拆分方案：
```
sync.ts           →  SyncEngine（编排，保留 scan() + syncEntry() 主入口）
scanner.ts        →  ScanPhase（本地扫描、binding 武装、四级配对、远端探测）
importer.ts       →  RemoteImporter（远端文档/资源导入）
rename.ts         →  RenameDetector
asset_sync.ts     →  AssetSyncHelper（prepareAssets/hydrateChangedRemoteAssets）
remote_tree.ts    →  RemoteTreeCache（缓存 + scoped tree 构建）
```

### 3.2 内存队列无持久化

**问题**：`SyncRuntime` 的任务队列是 Promise 链（`this.queues: Map<string, Promise<void>>`），进程崩溃时 in-flight 的同步任务会丢失。

当前影响：
- 服务重启后正在运行的 `scanAndSync()` 中断，OperationRecord 停在 `running` 状态；
- 下次启动后 `startRoot()` 立即触发一轮 `manual` 扫描恢复，因此功能上可自愈；
- 但如果崩溃恰好发生在 `applyPatch()` 与 `setBinding()` 之间，binding 状态与远端不一致。

建议：
- 启动时扫描 `status=running` 的 OperationRecord，将其置为 `cancelled`；
- 崩溃窗口的一致性问题目前可以接受（远端有 revision guard 保证写入原子，重启后下轮 scan 会发现 remoteContentHash 不匹配并重新 pull）；
- 长期考虑：引入轻量任务表（SQLite）持久化待执行操作，但需要权衡引入原生模块编译依赖的代价。

### 3.3 JSON 存储的并发与性能

**问题**：`JsonMetaStorage` 的每次 `listRoots()` 读取完整 `roots.json`，每次 `addOperation()` 读改整个 `operations.json`（≤1000条），`listOperations(10_000)` 实际读 1000 条再过滤。

影响场景：
- 大目录（500+文档）的 `scan()` 阶段调用 `listBindings()` 约 10 次（每次全读文件）；
- `buildLinkMaps()` 和 `prepareAssets()` 在 syncEntry 中调用 `listBindings()`，N 个条目 → O(N²) 次文件读；
- operations.json 单次写入需序列化整个数组。

建议短期优化：
- 在 SyncEngine 实例级别缓存 binding 快照，scan 结束后 invalidate；
- 考虑将 bindings.json 按 rootId 分文件，避免单文件膨胀。

建议中期：
- 替换为 SQLite（通过 `node:sqlite`，Node 22+ 内置，避免 better-sqlite3 的编译问题）；
- 迁移路径：`MetaStorage` 接口不变，只需新增 `SqliteMetaStorage` 实现。

### 3.4 缺少 Fastify Schema 验证

**问题**：所有 API 路由使用泛型（`app.post<{ Body: {...} }>`）做编译时类型约束，但**运行时没有 JSON Schema 验证**，非法输入依赖手写 if 检查。

当前防护：关键路径（`pollIntervalMs < 1000`、`mode` 枚举、`entryIds` 非空数组）都有手写检查，覆盖度尚可。

风险：新增路由时容易遗漏校验；错误消息不统一（有的返回中文，有的英文）；无 OpenAPI 规范文档。

建议：
- 为核心写接口（POST /api/roots、PUT /api/settings、POST /api/conflicts/:id/resolve）补充 Fastify JSON Schema；
- 配合 `@fastify/swagger` 生成 OpenAPI 文档，供前端类型生成和 API 测试使用。

### 3.5 Web 类型手动镜像

**问题**：`packages/web/src/api.ts` 手动复制了服务端的 `Root`、`Entry`、`Conflict`、`Operation`、`ServerEvent` 等类型定义。双端类型不一致时只能在运行时发现。

建议：将共享类型提取到 `packages/core/src/types.ts` 的独立导出子集，`web` 包通过 `import type` 引用；或引入 `openapi-typescript` 从服务端 Schema 自动生成。

### 3.6 无 CI/CD 流水线

**问题**：仓库中没有 `.github/workflows`，`pnpm build / test / typecheck` 全部依赖本地手动执行。

风险：
- PR 合并前无自动化门控，测试回归只能靠人工；
- 无法保证产物（`server/dist/`）与源码的一致性；
- 版本发布无流水线触发。

建议：优先添加 GitHub Actions（或当前 git 托管平台对应）的 CI 配置：
```yaml
# 最小可行 CI
on: [push, pull_request]
jobs:
  verify:
    steps:
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm typecheck
      - run: pnpm -r test
```

### 3.7 可观测性不完整

**现状好的方面**：
- `SyncRuntime` 有结构化日志（Fastify pino logger，注入的 `logger?.[level](data, message)`）；
- `ApiCallStats` 提供内存 API 计数器（次数/错误/限流）。

**缺失的方面**：
- 无 Prometheus metrics（同步耗时分布、pending 队列深度、API 延迟 P50/P99）；
- 无分布式追踪（一次 sync 从 watcher 到 applyPatch 的完整调用链 traceId）；
- 日志无轮转策略（当前写 stdout，适合容器化场景，本地部署需用户自行处理）；
- 无健康探针指标（`/api/health` 只返回静态状态，不含 last sync time / queue depth）。

---

## 4. 安全性审查

| 检查项 | 状态 | 说明 |
|---|---|---|
| 路径穿越防护 | ✅ 已实现 | `local.ts:safePath()`、`app.ts:/api/roots/:id/file` resolve 后检查是否在 base 内 |
| 凭证脱敏 | ✅ 已实现 | `credentials.ts:redacted()` 前6后4；日志中不输出完整 token |
| 配置文件权限 | ✅ 已实现 | `appconfig.ts` 写入后 `chmodSync(0o600)` |
| SQL 注入 | N/A | 无 SQL 层，JSON 文件存储 |
| XSS（Markdown 渲染） | ✅ 已实现 | markdown-it `html:false`，内嵌 HTML 被转义 |
| CSRF | ⚠️ 未防护 | 服务默认只监听 127.0.0.1，局域网场景需反向代理+认证，README 已说明；无 SameSite/CORS 配置 |
| API 速率限制 | ❌ 缺失 | 本地场景可接受，局域网/公网部署需补充 |
| 认证层 | ❌ 缺失 | 当前设计为本地单人使用，无 token/cookie 认证；多人场景前必须加 |
| WebSocket 认证 | ❌ 缺失 | `/api/events` WS 连接无握手验证 |

---

## 5. 测试覆盖分析

### 5.1 各包测试统计

| 包 | 测试文件数 | 主要覆盖 |
|---|---|---|
| core | 5 | 合并决策、Markdown 切分、文件名净化、glob、增量扫描 |
| feishu | 2 | OpenAPI 请求路径/revision 校验、CLI 适配器解析 |
| storage | 1 | GitStorage 生命周期、MetaStorage 全量 CRUD |
| server | 6（+helpers） | HTTP 路由集成、SyncRuntime 逻辑、端到端同步引擎、凭证、apistats、appconfig |
| web | 4（vitest） | diff 封装、bindForm 验证、fileTree 构建、markdown 渲染 |

### 5.2 缺失的测试类型

| 类型 | 说明 |
|---|---|
| **真实 API 集成测试** | 当前用 mock fetch；需要飞书沙箱租户的 E2E 用例（revision 并发、图片上传、429 限流） |
| **并发安全测试** | 多根同时触发 sync 时的 git index 竞争、JSON 文件读写竞争 |
| **大规模性能测试** | 500/1000/5000 文档下的 scan 耗时、内存占用 |
| **故障注入测试** | syncEntry 中途进程崩溃、applyPatch 网络超时、binding 持久化失败回滚 |
| **前端 E2E 测试** | Playwright/Cypress 覆盖关键路径（OAuth 流程、冲突解决） |

### 5.3 测试访问私有成员的模式

`runtime.test.ts` 和 `sync.test.ts` 使用 `as unknown as {...}` 断言访问 `SyncRuntime.enqueue`、`SyncEngine.lastDirections` 等私有成员。这是合理的白盒测试手法，但说明部分逻辑（如队列管理、方向记录）难以通过公共接口验证，提示需要重构暴露面。

---

## 6. 工程规范细节

### 6.1 TypeScript 规范

✅ `tsconfig.base.json`：`strict: true` + `noUncheckedIndexedAccess: true`，是当前 TS 最严格的组合之一。  
⚠️ 无 ESLint 配置：`package.json` 中未声明 eslint 依赖，风格依赖开发者自觉。建议至少引入 `@typescript-eslint/recommended`。  
⚠️ 无 Prettier：代码格式无统一保证，多文件风格有差异（双引号 vs 反引号混用）。

### 6.2 注释质量

整体注释密度高且质量好，关键设计决策（同名豁免、标题钉回、同轮预排队、Echo 防护）都有 inline 注释解释"为什么"，而非"做了什么"。无 TODO/FIXME 残留。

### 6.3 命名规范

包名 `@feishu-sync/*` 统一，接口/类名 PascalCase，函数/变量 camelCase。路由路径 kebab-case，与 REST 规范一致。

### 6.4 构建流程

`pnpm build` 按依赖顺序：core → storage/feishu → web → server，正确。  
`server` 的 build 脚本中 `cp -R public dist/public` 将 web 构建产物复制进来，依赖 `web` 先构建完成，顺序在根 package.json 的 `build` 脚本中保证，但若单独 `pnpm --filter server build` 则可能找不到 `dist/public`。

---

## 7. 改进建议优先级排序

| 优先级 | 项目 | 工作量估计 | 风险缓解 |
|---|---|---|---|
| **立即** | 补充 CI（build+typecheck+test） | 0.5 天 | 防止回归合并 |
| **高** | 拆分 sync.ts（scanner/asset/rename 子模块） | 2-3 天 | 降低认知复杂度，提升可测性 |
| **高** | 拆分 runtime.ts（task queue/echo guard 独立） | 1-2 天 | 同上 |
| **高** | 启动时恢复 running OperationRecord → cancelled | 0.5 天 | 防止任务中心幽灵状态 |
| **中** | 核心路由补充 Fastify JSON Schema | 1-2 天 | 运行时输入校验规范化 |
| **中** | 引入 ESLint + Prettier | 0.5 天（一次性配置） | 统一风格，自动发现潜在 bug |
| **中** | Binding 快照缓存减少 listBindings() 调用次数 | 1 天 | 大目录 O(N²) 读问题 |
| **中** | 补充并发/故障注入测试用例 | 2 天 | 提升高可用场景信心 |
| **低** | web 类型改为从 core 引用或代码生成 | 1 天 | 消除手动镜像漂移风险 |
| **低** | 接入 Prometheus metrics（/metrics 端点） | 2 天 | 运维可观测性 |
| **低** | 局域网部署场景的 Basic Auth + CSRF token | 1-2 天 | 安全加固 |
