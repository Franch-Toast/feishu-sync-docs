# 单次同步流程详解

本文以 `SyncRuntime.scanAndSync()` 为入口，完整讲解一轮同步从触发到结束的全过程。

---

## 1. 触发来源

四种来源均可触发一轮同步，最终都汇入 `scanAndSync(root, trigger, scope?)`：

| 触发方式 | `trigger` 值 | 说明 |
|---|---|---|
| chokidar 文件监听 | `watch` | 本地 add/change/unlink 事件；携带 `scope.relativePaths` |
| 飞书云盘长连接事件 | `event` | SDK WebSocket 订阅；携带 `scope.remoteTokens` |
| 定时器轮询（pollIntervalMs） | `poll` | 无 scope，始终走全量扫描 |
| API / UI 手动点击 | `manual` | 无 scope，始终走全量扫描 |

> **增量快路径**：`watch` 和 `event` 可携带 `SyncScope`，`scan()` 只对 scope 内的路径/token 做局部探测；任一前提不满足则自动降级为全量扫描（正确性优先）。

---

## 2. 整体流程大图

```mermaid
graph TB
    Trigger["触发入口\nwatch / event / poll / manual"]
    Queue["per-root 串行队列\nenqueue(rootId, callback)"]
    ScanStarted["广播 sync-started"]
    Scan["engine.scan(root, trigger, scope)\n— 扫描阶段"]
    WhileLoop{"是否还有\npending 条目？"}
    PreQueue["批量预排队\n为每个 pending 条目\n创建 queued OperationRecord\n广播 operation-queued"]
    SyncEntry["syncEntryWithRetry()\n— 单条执行（最多3次重试）"]
    MorePending{"尝试次数\n< 3？"}
    CommitBaseline["commitBaseline()\n仅对 clean 条目提交 git"]
    NotifyConflict["广播冲突通知\n（首次出现的 ConflictRecord）"]
    SyncDone["广播 sync 完成事件"]
    AuthFail["广播 auth-invalid\n取消剩余排队任务\n提前结束本轮"]

    Trigger --> Queue --> ScanStarted --> Scan --> WhileLoop
    WhileLoop -- 否 --> CommitBaseline --> NotifyConflict --> SyncDone
    WhileLoop -- 是 --> PreQueue --> SyncEntry
    SyncEntry -- 成功 --> WhileLoop
    SyncEntry -- 认证失败 --> AuthFail
    SyncEntry -- 可重试错误 --> MorePending
    MorePending -- 是 --> SyncEntry
    MorePending -- 否 --> WhileLoop
```

---

## 3. 扫描阶段（scan）详解

`scan()` 负责构建/更新所有 `EntryBinding` 并探测两侧的改动，它**不直接写入任何内容**，只更新元数据状态。

```mermaid
graph TB
    LocalScan["① 本地文件扫描\nlocal.scan() 或 scanEntries(scope)"]
    ExcludeFreeze["② 排除冻结\n已 bind 但命中 exclude 的条目\n→ 设置 ignoredAt"]
    BindingArm["③ Binding 武装\n每个本地文件 → EntryBinding\n内容哈希变化 → status=pending"]
    RemoteTree["④ 刷新远端树快照\nrefreshRemoteTree()（全量）\n或 buildScopedRemoteTree()（增量）"]
    Govern["⑤ 同名副本治理（仅全量轮）\ngovernRemoteDuplicates()\n同名+同哈希 → 软删除 loser\n同名+异哈希 → conflict"]
    Pairing["⑥ 远端文档四级配对\n见下方配对子流程"]
    RenameDetect["⑦ 本地重命名/移动检测\ndetectRename()\n内容哈希唯一匹配 → re-point binding"]
    AssetRef["⑧ 资源引用重建\n解析每个 document 的 markdown\n→ 写 assets.json"]
    CascadeArm["⑨ 变更资产级联 pending\nasset 内容变化 → 把引用它的\ndocument 置为 pending"]
    RemoteProbe["⑩ 远端变化探测\n逐一 getDocument → canonical hash 比对\n有变化 → 更新 remoteContentHash，置 pending"]
    ScanReturn["⑪ 返回 { entries, conflicts }"]

    LocalScan --> ExcludeFreeze --> BindingArm --> RemoteTree --> Govern --> Pairing --> RenameDetect --> AssetRef --> CascadeArm --> RemoteProbe --> ScanReturn
```

### 3.1 四级配对子流程

扫描阶段对每个**未绑定的远端文档节点**执行以下递进配对，命中任意一级即停止：

```mermaid
graph LR
    Node["远端未绑定文档节点"]
    L1["第1级：token 精确匹配\nbinding.remoteToken == node.token"]
    L2["第2级：路径匹配\nremoteRelativePath(node)\n== binding.relativePath"]
    L3["第3级：标题匹配\nnormalizeForMatch(node.name)\n== normalizeForMatch(basename) 且唯一"]
    L4["第4级：内容哈希匹配\nnode.contentHash 或\ncanonical(getDocument) 哈希\n与 unboundLocalFiles 唯一匹配"]
    Import["导入远端文档\nimportRemoteDocument()\n本地写入 canonical 内容"]

    Node --> L1
    L1 -- 未命中 --> L2
    L2 -- 未命中 --> L3
    L3 -- 未命中 --> L4
    L4 -- 未命中 --> Import
```

> **重复导入防护**：若远端文档的 canonical 内容与任意本地文档相同但名字不同，引擎跳过导入，避免为旧版按 H1 命名的重复副本创建新本地文件。

---

## 4. 单条执行阶段（syncEntry）详解

`scanAndSync()` 的 while 循环里，对每个 `status=pending` 的条目调用 `engine.syncEntry(binding, root)`：

```mermaid
graph TB
    Start["syncEntry(binding, root)"]
    IsAsset{"kind == asset？"}
    SyncAsset["syncAsset()\nhash 不同则 uploadAsset()\n→ status=clean"]
    ReadLocal["读取本地内容\nlocal.readText()"]
    BuildLinkMaps["构建链接映射\nbuildLinkMaps(forward/reverse)"]
    HasToken{"有 remoteToken？"}
    CreateBranch["创建分支"]
    PushPullBranch["增量决策分支"]

    Start --> IsAsset
    IsAsset -- 是 --> SyncAsset
    IsAsset -- 否 --> ReadLocal --> BuildLinkMaps --> HasToken

    HasToken -- 否/404 --> CreateBranch
    HasToken -- 是 --> PushPullBranch
```

### 4.1 创建分支（无 remoteToken 或远端已 404）

```mermaid
graph TB
    PullOnly{"mode == pull-only？"}
    Skip["不创建，直接返回"]
    EnsureParent["ensureRemoteParent()\n逐级创建/查找远端文件夹"]
    DupCheck{"同 parent 下有同名文档？"}
    AdoptDup["尝试认领：内容相同则 rebind\n内容不同则 raise conflict"]
    CreateDoc["remote.createDocument()\n携带文件名作为 title 建空文档"]
    UploadAssets["prepareAssets(uploadInline=true)\n上传变更的图片资源"]
    OverwriteContent["remote.applyPatch(overwrite)\n写入 Markdown 内容"]
    PinTitle["ensureRemoteTitle()\n标题漂移回钉"]
    Clean["status=clean\n更新 binding + block mapping"]

    PullOnly -- 是 --> Skip
    PullOnly -- 否 --> EnsureParent --> DupCheck
    DupCheck -- 是 --> AdoptDup
    DupCheck -- 否 --> CreateDoc --> UploadAssets --> OverwriteContent --> PinTitle --> Clean
```

### 4.2 增量决策分支（有 remoteToken）

```mermaid
graph TB
    FetchRemote["getDocument(remoteToken)"]
    NotFound{"远端 404？"}
    RemoteMissing["status=remote-missing\n直接返回"]
    PrepareAssets["prepareAssets()\n构建图片资源映射"]
    HydrateAssets["hydrateChangedRemoteAssets()\n远端图片更新则下载回本地"]
    AssetConflict{"图片冲突？"}
    ConflictRecord1["创建/更新 ConflictRecord\nstatus=conflict 返回"]
    CanonicalRemote["canonicalRemote =\nrestoreLinks + restoreAssets"]
    GetBaseline["baseline = git.getBaseline(path)"]
    Decide["decideSync(base, local, remote)"]
    ModeOverride{"mode 覆盖？\npull-only / push-only"}
    ForcePull["action 强制 = pull"]
    ForcePush["action 强制 = push"]
    Action{"action 类型"}
    Noop["noop：无需动作"]
    Pull["pull：写本地文件"]
    PushOrMerge["push/merge：\nbuildBlockPatch → applyPatch"]
    ConflictAction["conflict：创建 ConflictRecord\nstatus=conflict"]
    UpdateClean["status=clean\n更新 remoteContentHash/Revision"]

    FetchRemote --> NotFound
    NotFound -- 是 --> RemoteMissing
    NotFound -- 否 --> PrepareAssets --> HydrateAssets --> AssetConflict
    AssetConflict -- 是 --> ConflictRecord1
    AssetConflict -- 否 --> CanonicalRemote --> GetBaseline --> Decide --> ModeOverride
    ModeOverride -- pull-only 非 pull --> ForcePull --> Action
    ModeOverride -- push-only 非 push --> ForcePush --> Action
    ModeOverride -- 正常 --> Action
    Action -- noop --> Noop --> UpdateClean
    Action -- pull --> Pull --> UpdateClean
    Action -- push或merge --> PushOrMerge --> UpdateClean
    Action -- conflict --> ConflictAction
```

---

## 5. 三方合并决策（decideSync）

`decideSync(base, local, remote)` 是纯函数，基于三方向内容（Block 粒度）做判断：

| base vs local | base vs remote | 结论 |
|---|---|---|
| local == remote | — | `noop` |
| local == base | remote ≠ base | `pull`（远端单方变化） |
| remote == base | local ≠ base | `push`（本地单方变化） |
| 双方都变，但变更 Block 不重叠 | — | `merge`（自动合并） |
| 双方都变，且变更同一 Block | — | `conflict`（人工裁决） |

合并粒度为 Markdown Block（段落/标题/代码块等），Block 内文本用行级 changedRange 做二次合并。

---

## 6. 失败与重试策略

```mermaid
graph TB
    EntryFail["syncEntry 抛异常"]
    Categorize["categorizeError(error)\n→ auth/conflict/network/\npermission/not_found/rate_limit/unknown"]
    IsAuth{"auth 或 permission？"}
    FailFast["OperationRecord → failed\n广播 operation-failed\n通知 Notifier\n中断整轮\n剩余排队任务 → cancelled"]
    IsRetriable{"network / rate_limit / unknown\n且 retryCount < 3？"}
    Backoff["1s → 2s → 4s 退避\nOperationRecord → queued\n广播 operation-retrying\nrate_limit 时读 Retry-After 头"]
    EntryError["OperationRecord → failed\nEntryBinding.status → error\n广播 operation-failed\n等待人工重试或忽略"]

    EntryFail --> Categorize --> IsAuth
    IsAuth -- 是 --> FailFast
    IsAuth -- 否 --> IsRetriable
    IsRetriable -- 是 --> Backoff --> EntryFail
    IsRetriable -- 否 --> EntryError
```

- `auth`/`permission`/`not_found`/`conflict` 快速失败，**不跨轮自动重试**；
- `network`/`rate_limit`/`unknown` 单轮内最多重试 3 次，超过后 entry 置 error；
- entry 的 `status=error` 跨轮保持，直到内容变化或用户在任务中心点「重试」。

---

## 7. 操作记录生命周期

每个 `pending` 条目在 `scanAndSync()` 的 while 循环**开始时**就批量预创建 `OperationRecord(status=queued)`，执行时转为 `running`，结束时转为终态：

```
queued  ──►  running  ──►  succeeded
                         ──►  failed     （auth/permission/超过重试）
            queued（自环，退避重试）
                         ──►  cancelled  （auth 中断整轮，取消剩余条目）
```

`scanAndSync()` 结束后，只对本轮达到 `status=clean` 的条目执行 `commitBaseline()`，将工作树提交为新的 git 基线，作为下轮三方合并的 base。

---

## 8. 关键设计决策

| 设计点 | 决策 | 原因 |
|---|---|---|
| 远端树缓存 | 每 root 60s TTL；retry 时 invalidate | 避免同轮多次 listTree，同时防止写入后缓存陈旧导致重复建文档 |
| 文件夹绑定持久化 | `folders.json` 缓存 token | 重启后不重复创建远端文件夹 |
| 标题钉回 | 每次内容写入后检查并 renameDocument | docs_ai 的 Markdown 导入会用 H1 重写标题，需保证「云端名=本地文件名」恒成立 |
| Echo 防护 | recentLocalWrites + recentRemotePushes (5s TTL) | 防止 pull 写入本地触发 watcher、push 写入远端触发 event 形成同步死循环 |
| 同路径豁免 | 同 entryId 或同 relativePath 的已有 binding 不视为 external duplicate | 防止元数据重建后自家文档自撞报 "already has a document named..." |
