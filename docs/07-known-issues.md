# 07 · 已知缺陷与设计缺口

> 本篇**诚实**记录当前代码里真实存在的问题，供改代码前对照，避免重复踩。分四类：
> **A. 真·缺陷**（行为不符合预期，应修）；**B. 未实现 / 未开放**（功能缺口）；**C. 有意为之但会咬人的语义**（不是 bug，但容易被误当成 bug 或被无意破坏）；**D. 性能 / 结构限制**（当前规模可接受，规模化前要知道边界）。
>
> 每条都给了**代码位置**，可自行核对。凡我未在代码里找到硬证据的推断，都会写「⚠️ 待验证」。

---

## A. 真·缺陷

### A1. `identity` 冲突缺 `kind` 守卫——裁决会把诊断文本推进飞书文档 ★最严重

**位置**：`packages/server/src/runtime.ts` `resolveConflict`（L354-397），配合 `meta.ts` `resolveConflict`（无 kind 感知）。

`IdentityResolver` 在仲裁矩阵 #4/#6 会造出一条 `kind:"identity"` 的冲突，它的 `remoteContent` 存的是**诊断文本** `` `${token}: ${reason}` ``（`identity.ts:raiseIdentityConflict`），不是真实远端内容。它的语义是"这个 token 归谁所有有歧义，需要人去飞书/文件系统里理清"，**根本不是三方内容合并问题**。

但 `resolveConflict` 对所有冲突一视同仁：

```ts
// runtime.ts:379
const content = input.resolution === "local" ? conflict.localContent
              : input.resolution === "remote" ? conflict.remoteContent   // ← identity 冲突时这是 "${token}: ${reason}"
              : input.mergedContent;
// runtime.ts:384
await this.engine.applyResolvedContent(binding, root, content, currentRemote);  // 把它当正文推上去
```

**后果**：用户对一条 identity 冲突点「采用远端」，会把 `"doccnXXX: token doccnXXX is claimed by a.md, b.md"` 这行诊断文字**当作正文写进飞书文档并落本地**，覆盖真实内容。点「采用本地」相对安全（写回的是本地文件内容），但也没有真正解决"token 归属"这个根因。

**建议修法**：`resolveConflict` 开头加 `if (conflict.kind === "identity") { ... }` 专用分支——identity 冲突的裁决动作应是"选哪个路径持有这个 token / 丢弃其中一个 token 让其重新导入"，而不是套 content 合并。或者在冲突工作台里对 `kind==="identity"` 隐藏"采用远端/合并"三个内容按钮，只给"标记已处理 + 引导手工"的入口。**目前工作台没有按 kind 区分展示。**

---

## B. 未实现 / 未开放

### B1. 知识库（wiki）根不支持

**位置**：`packages/feishu/src/openapi.ts:95`

```ts
if (root.remoteType === "wiki") throw new Error("Wiki roots are not supported by the OpenAPI adapter yet; ...");
```

`SyncRoot.remoteType` 类型里保留了 `"wiki"`，`validate-token` 也接受 `type=wiki`，但 `listTree` 直接抛错。**当前只能同步飞书云盘文件夹**，不能同步知识库节点。要支持需实现 wiki 的节点树/文档接口映射。

### B2. 通知功能只有接口没有实现

**位置**：`packages/server/src/notify.ts`（`Notifier` 接口 + `NoopNotifier`）。

系统通知 / 飞书机器人通知的接口已预留、config 里有 `notifications` 偏好、`app-config` 端点能读写这些开关，但**实际发送是空实现**。冲突产生时引擎会调 `Notifier`，目前什么都不做。

### B3. 一键打标 `stamp-identity` 没有 UI 入口

**位置**：端点在 `app.ts:351` 存在且可用，但 `web/src/api.ts` **没有对应封装**，`SettingsView`/`RootDetail` 也没有按钮。

存量仓库要"一次性全部纳入 Tier-0 保护"目前只能 `curl -X POST /api/roots/:id/stamp-identity`。机制本身完整（`runtime.stampAll`，逐路径报告），缺的只是前端接线。

### B4. `identity-stamped` 事件前端不认

**位置**：`runtime.ts:627` 广播 `type:"identity-stamped"`，但 `web/src/api.ts` 的 `ServerEvent` 联合里**没有这个成员**。

前端收到会走 `default`（只 `refresh()`），不报错但也不会针对性提示"打标完成，共 X 条"。要接 B3 的 UI 时顺带补这个类型。

### B5. `IdentityReconcileReport` 没有暴露端点

`reconcile()` 每轮都算 `{backfilled, rootCompleted, rekeyed, conflicts, malformed, unchanged}`，信息量比 stampAll 报告更大（覆盖矩阵全部动作），但**没有任何 REST 端点或 WS 事件把它吐出来**。想做"身份健康度"面板，这是现成数据源，只差一个读取口。

### B6. 任务队列不持久化，重启即"取消"

**位置**：`TaskQueue`（`task_queue.ts`）纯内存；`recoverStaleOperations`（启动时）把上次进程遗留的 `queued`/`running` 记录一律改 `cancelled`。

因为车道是内存 Promise 链，进程一死这些记录永远不会再完成，不清就变任务中心的幽灵。代价：**重启会丢失"正在排队"这一批任务的自动续跑**，用户得在任务中心对 `cancelled` 记录手动重试。`OperationRecord` 本身是落 `operations.json` 的，所以历史不丢，丢的是"自动继续执行"的语义。

---

## C. 有意为之、但会咬人的语义

### C1. ★ 用户自己的 YAML frontmatter 不再被推到飞书

**这不是 bug，是信封机制的直接后果，但一定会有人当成 bug 提 issue。**

`stripEnvelope` 剥的是**整个首部 `---` YAML 块**（`frontmatter.ts`）。于是用户在 `.md` 顶部自己写的 `title:` / `tags:` / 任何 frontmatter，在推送前也会被一起剥掉——**飞书文档里再也看不到这些字段**。

更具体的升级冲击：**存量绑定在升级到信封机制后的第一轮同步**，会把远端文档里原本作为正文一部分的 YAML 块**抹掉**（因为 base/local 都用 body 比对，远端那份带 YAML 的旧内容被判定为"要更新成不含 YAML 的 body"）。

缓解现状：未打标文件的 `body===raw`，只有**已打标**或**首轮被回填信封**的文件才触发这个剥离。如果用户确实需要在飞书展示 frontmatter 内容，目前没有保留通道。⚠️ 这条的"存量首轮抹掉 YAML"具体影响面建议在飞书沙箱实测确认（是否所有块级/overwrite 路径都一致）。

### C2. 哈希字段有多套基准，改判定前必须逐处确认

系统里同时存在：

- `LocalFile.contentHash` = `.md` 的 `sha256(body)`（**同步判定用这个**）
- `LocalFile.rawHash` = `sha256(整文件含信封)`（仅诊断）
- `EntryBinding.remoteContentHash` = `sha256(canonicalRemote)`（还原链接/资源后的远端内容）
- `RemoteDocument.contentHash` = 远端原始内容哈希

它们**故意不同**（信封不脏哈希、canonical 才可比）。风险是新人写新判定逻辑时**拿错基准**——比如拿 `rawHash` 去和 `remoteContentHash` 比，那永远不等，每篇都判"变了"。改任何 hash 比较前，先确认两边是不是同一基准。`[04 篇 §3](04-special-mechanisms.md)` 有三方判定的基准对齐表，可对照。

### C3. `error` 状态的条目不会自动复活

**位置**：`sync.ts` binding 武装段（status 粘性）。

一条因**非重试类错误**（如 permission）失败的条目停在 `error`，之后每轮 poll **不会**自动把它重新置 pending——除非**内容真的变了**，或**用户在任务中心点重试**。这是刻意设计（避免永久失败条目每 15 秒刷屏重试）。副作用：权限恢复后，存量 `error` 条目**不会自动重跑**，需要用户手动批量重试。设计正确，但运营上要意识到"恢复了权限≠旧失败自动重做"。

### C4. `pruneHistory` 返回的 `snapshots` 恒为 0

**位置**：`meta.ts:552` `return { ..., snapshots: 0 }`。

快照表早已被 git 基线取代，`snapshots` 字段只为兼容前端 `maintenance-pruned` 事件的类型而保留。**前端文案若还提"清理了 N 个孤儿快照"就是误导**（永远是 0）。属小瑕疵，建议要么去掉该字段与相关文案，要么让它真正反映被清理的旧记录数。

---

## D. 性能 / 结构限制（当前规模可用，规模化前须知）

### D1. 远端树遍历是串行 DFS

**位置**：`openapi.ts:262` `walkDrive` —— `for (const node of await this.listFolderChildren(...)) { ... await this.walkDrive(...) }`，逐目录、逐分页**串行**。

大目录/深层级的首次全量扫描会明显慢（每个 `listFolderChildren` 一次 HTTP 往返）。可优化为按层并发（受 `rate_limit` 约束的并发池），但需处理飞书限流。

### D2. `findBindingById(entryId)` 跨所有 metaDir 线性扫

**位置**：`meta.ts:174`。它没有全局 `entryId → root` 索引，`conflicts`/`operations` 的 join 会调它。root 多、binding 多时是热点。`bindingsCache` 缓解了"按 root 反复整表读"，但没有解决"按 entryId 跨 root 找"。

### D3. 前端类型是服务端的手抄副本，无编译期保证

**位置**：`web/src/api.ts` 顶部自己 `interface` 了一套 `SyncRoot`/`EntryBinding`/`ServerEvent`……

改服务端返回结构时，TS **不会**报错提醒你改前端，漂移只会在运行时体现。理想做法是共享类型包或从 Fastify schema 生成客户端类型。当前靠人工纪律（提交清单第 5 条）。

### D4. `refresh token` 存在无法消除的崩溃窗口

**位置**：`openapi.ts` `await onTokenRefresh`（先落盘再返回）。

旧 refresh token 在刷新成功那一刻已在飞书服务端作废。若进程正好在"拿到新 token → 写盘完成"之间被杀，refresh token 丢失，**必须重新走一次用户授权**。这是飞书一次性轮换机制固有的，代码已把窗口压到最小（先落盘），但不能归零。运维上意味着：别在同步高峰期强杀进程。

### D5. 增量轮的作用域脆弱性

**位置**：`sync.ts` 增量条件（L86）、`LocalNameAligner` 仅全量轮。

增量轮（watch/event 带 scope）只处理作用域内条目；改名、首次命名对齐、同名副本治理**只在全量轮做**。所以"刚建的新文件没被规范化命名"是正常的——下一轮 poll 补。不是漏同步，是"稳定 > 及时"的取舍。排查"为什么这个文件命名没对齐"先看它是不是只跑过增量轮。

---

## 附：如何安全地推进这些修复

- 动 **A1**（identity 冲突裁决）前，先读 `[04 篇 §2](04-special-mechanisms.md)` 仲裁矩阵与 `[03 篇](03-sync-pipeline.md)` 的 `applyResolvedContent` 路径，理解"内容合并"与"身份归属"是两套正交的解决动作。
- 补 **B3/B4/B5**（打标 UI / 事件 / 报告端点）是一组低风险增量：后端已就绪，只是前端接线 + 一个只读端点，记得同步更新 [06 篇](06-api-and-ui-reference.md) 的端点/事件表。
- **C1** 若要给"保留用户 frontmatter"开洞，唯一安全的做法是**把用户 YAML 与信封块分离存储/解析**（只认 `feishu_token`/`feishu_root` 两行为信封，其余首部原样保留并参与推送）。这会改动 `splitDocument`/`stripEnvelope` 的边界，务必先跑 `frontmatter.test.ts` 的往返与幂等断言确认不破。
- **D 系列**在数据量真上来之前都不必动，但**别在文档/代码里承诺"支持超大目录/万级文档"**，除非先做了并发与索引优化。
