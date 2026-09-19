# 04 · 特殊机制与设计决策

> 03 篇讲"怎么跑"，本篇讲"为什么这么设计"。每一节都是那种"看起来绕，去掉就出事"的机制。

---

## 1. frontmatter「信封」身份机制

### 1.1 要解决的问题

飞书给每篇文档一个 `document_id`（token），它在文档整个生命周期（改名、移动目录、编辑内容）里**永不变**——这是远端唯一可靠的天然主键。

但在引入信封之前，这个 token 只存在 `.feishu-sync/bindings.json` 里，键是**本地相对路径**。于是：

| 状况 | 旧机制的表现 |
| --- | --- |
| 用户本地改文件名 | 主键变了 → 绑定"丢失" → 只能靠内容哈希猜回来；猜不回就**在远端重建一篇新文档** |
| 用户删掉 `.feishu-sync/` | 所有绑定归零，全靠启发式重配对；同一篇文档可能被导入两份 |
| 远端有人"创建副本" | 副本与原文标题不同、内容相同 → 内容哈希配对可能**认亲认错对象** |
| 用户先改名再改内容 | 内容哈希也失效了，彻底没救 |

根因是一句话：**身份（token）稳定，但索引（路径）可变，而系统只有"路径 → token"的正向表。**

信封机制的解法：把 token 写进本地文件自己身上，让文档**自描述身份**。

### 1.2 长什么样

一个同步过的 `.md` 文件顶部会多出一个 YAML 块：

```markdown
---
feishu_token: doccnLiUxxxxxx
feishu_root: 7567890123456789012
---

# 我的笔记

正文内容……
```

- `feishu_token` —— 远端文档身份，权威。
- `feishu_root` —— 这对 token 属于哪个 root。**防的是"把文件从 A 目录拷到 B 目录，B 就去劫持 A 的云端文档"**：`identity.ts:91` 判定 `split.rootId !== root.id && !== root.remoteToken` 就丢进 `foreign` 桶，这个文件在本 root 里**绝不参与任何配对**。

**飞书文档上看不到任何东西。** 信封只活在磁盘上：推送前一律 `stripEnvelope`，读取后一律用 body 计算哈希（§3）。

### 1.3 三条设计约束（`frontmatter.ts` 文件头注释就是设计文档）

**约束一：只存不可变的身份。**

revision、内容哈希、同步状态全都留在 `bindings.json`。理由很硬：把每轮都变的写进文件，文件就每轮都脏一次，于是"本地变了"永远为真，同步永久自激。

**约束二：信封对同步流水线完全不可见。**

`stripEnvelope` 与 `writeSyncDocument` 必须是**精确互逆**：

```
stripEnvelope(writeSyncDocument(body, id).text) === body      // 对任何不以 --- 开头的 body
split(join(b, id)).body === b
stamp(stamp(raw)) === stamp(raw)                               // 幂等
```

哈希、三方合并、远端渲染、块映射，操作对象永远是 `body`。这条不变量是整个机制安全的前提。

**约束三：不引入 YAML 解析器。**

`core` 必须零依赖；更实际的理由是——用 YAML 库重新序列化会**重排键顺序、丢掉注释、改变引号风格**，把用户自己的 frontmatter 搞乱。所以 `setKey`（L119）只做"就地替换那一行，找不到就追加"，块内其它每一行**逐字节不动**。

### 1.4 解析规则（`splitDocument`，L139-156）

| 输入 | 处理 | 为什么 |
| --- | --- | --- |
| 首行不是 `---` | `meta=null, body=整个文件` | 未打标文件的 body 就等于原文，**哈希与引入信封之前逐字节相同** |
| 有配对的 `---` | body = 闭合 `---` 之后的所有内容 | 闭合分隔符**拥有它后面的那个换行**，这个约定让正反解析能精确互逆 |
| 有 `---` 但永不闭合 | `malformed=true`，body = 整个文件，**绝不改写这个文件** | 一个手滑留下的 `---` 不能把整篇文档吞进"元数据"——那是内容丢失 |
| 首行就是 `---` 且是用户自己的 YAML | 视为信封，身份**合并进去**而不是再叠一层 | 一个文件只有一个首部块；`setKey` 追加缺失的键，用户的 `title:`/`tags:` 原样保留 |
| 文件带 BOM | BOM 归属信封区，写回时原样放回最前 | 打标不会移动 BOM，因而不会改变哈希 |
| 值含特殊字符 | `^[A-Za-z0-9_-]+$` 之外一律 JSON 加引号 | 保证那一行仍是合法 YAML 标量 |
| 只匹配**无缩进**的 `key:` | `^feishu_token:[ \t]*(.*)$` | 块内嵌套映射里恰好同名的键不能被误认成我们的 |

> ⚠️ **一个真实的语义变化**：因为 `stripEnvelope` 剥的是**整个首部 YAML 块**，用户自己写的 `title:` / `tags:` 等 frontmatter 也不会再被推到飞书。存量绑定在升级到本机制后的第一轮同步，会把远端文档里那个 YAML 块抹掉。详见 [07 篇 §2](07-known-issues.md)。

### 1.5 打标的四个时机

| 时机 | 代码位置 | 顺序要求 |
| --- | --- | --- |
| 创建远端文档成功之后 | `sync.ts:629` | **必须在 `setBinding` 之后** |
| 推送/合并/成功轮结束之后 | `sync.ts:702` | 覆盖所有"可能刚建立/刚验证了配对"的成功路径 |
| 导入远端文档时 | `importer.ts:125`（`writeSyncDocument` 直接组合） | 落盘即带信封，所以导入的文件天生 Tier-0 可识别 |
| pull 写本地时 | `sync.ts:530-532`（`withBody` 保留原信封后再 `writeSyncDocument`） | 新内容来自远端，但身份属于本地文件 |

**"落库之后才打标"这个顺序是刻意的**。反过来（先打标后落库）一旦中间崩溃，磁盘上有一个声称持有 token T 的文件而数据库一无所知；正过来的崩溃窗口（落库成功、打标没跑完）由矩阵 #2 在下一轮自动回填。

打标被拒（`malformed`）时**静默跳过**——binding 里照样存着 token，同步照常跑，只是这个文件暂时享受不到"删掉 `.feishu-sync` 也能找回"的好处。

### 1.6 一键打标 `POST /api/roots/:id/stamp-identity`

`runtime.stampAll()`（L568）。它就是把矩阵 #2 的回填**从"扫描时顺带做"变成"你现在就给我做完"**，并且给一份逐路径报告：

| 报告字段 | 含义 |
| --- | --- |
| `stamped` | 本次真正写入了信封的 |
| `alreadyOk` | 已经带正确信封，没动（幂等） |
| `skippedUnbound` | 没有 `remoteToken`（从没同步过）或本地文件已消失 —— **无从知道该写什么 token** |
| `malformed` | 首部块没闭合 —— 拒绝改写 |
| `conflicts` | R2 预检：一个 token 被两条 binding 记录持有，或条目处于 conflict —— **只报告不动手** |

它跑在该 root 的车道上（`enqueueResult`），所以绝不会和正在进行的同步抢同一批文件；每次写盘前 `registerLocalWrite`，免得 watcher 把这当成用户编辑。**这是"一次性把存量仓库全部纳入 Tier-0 保护"的运维入口**（目前**没有 UI 按钮**，只能 curl，见 [07 篇 §7](07-known-issues.md)）。

---

## 2. ★ 双身份源仲裁矩阵

系统现在有两个身份存储：文件的信封、`bindings.json` 的 `remoteToken`。它们**一定会漂移**（改名、崩溃、用户手改、从别的仓库拷贝文件过来）。`IdentityResolver.reconcile()`（`identity.ts:110-215`）用一张固定矩阵仲裁，保证它们永远不会**静默**不一致。

| # | 文件信封 | binding(path) | token 在远端存在 | 动作 | 代码 |
| --- | --- | --- | --- | --- | --- |
| **R2** | T 被 **≥2 个**文件声明 | — | — | 每个声明者各起一条 `kind:"identity"` 冲突，**从不自动裁决** | L117-126 |
| **#2** | 无 | T | 是 | **回填信封**（自愈，也是崩溃恢复路径） | L128-138 |
| **#1** | T | T | 是 | 稳态；只补一个缺失的 `feishu_root` | L146-153 |
| **#3** | T | T′ | **T 在远端存在** | **文件侧胜出**：把 T 的 binding 记录 re-key 到本路径（`lostToken` 记下 T′ 供审计） | L155-166 |
| **#4** | T | T′ | **T 不在远端** | **冻结成冲突**。绝不覆盖或删除用户手里的 id | L167-172 |
| **#5** | T | 该路径无 binding，但 T 在 P′ 有记录 | 是 | **本地改名/移动**：把 binding 从 P′ 搬到 P | L183-191 |
| **#5′** | T | 该路径无 binding，且全库无人持有 T | 是 | 新建记录 claiming T（`.feishu-sync` 被删的恢复路径），交给 Tier-0 配对 | L192-208 |
| — | T | 无 | 否 | **原样不动**。远端可能只是这一轮挂了；R1 禁止用启发式去猜 | L176-182 |

两条铁律（矩阵在结构上强制它们）：

- **R1**：带 `feishu_token` 的文件**永不被启发式重绑**。落到代码是 `sync.ts:207` 那句 `continue`——声明了 token（或属于别的 root）的文件不进 `unboundTitlePaths`/`unboundLocalFiles` 候选池，标题层和内容哈希层看不见它。
- **R2**：一个 token 只属于一个路径。任何多声明都升级成人可见的 `kind:"identity"` 冲突，**不做猜测**。

矩阵 #3 值得多说一句：**为什么"文件侧胜出"而不是"DB 胜出"？** 因为信封的语义是"我这篇文档**就是** T"，而 binding 的键是路径——路径可变、信封跟着文件走。用户手动把 `a.md` 里的 token 改成另一个真实存在的文档，是明确的人工意图表达，比一条可能来自旧路径的记录更权威。但 **#4** 是它的对偶：文件声称的 T 在远端根本不存在（手抖打错了、或者文档被删），这时候既不能信文件也不能拿 DB 覆盖它，只能冻住等人。

### `IdentityStampReport` 之外还有一份 `IdentityReconcileReport`

`reconcile()` 返回 `{backfilled, rootCompleted, rekeyed, conflicts, malformed, unchanged}`，每轮 scan 都在算，**但目前没有端点暴露它**（只有 `stamp-identity` 返回 stampAll 的报告）。想加统计面板的话，这是现成的数据源。

---

## 3. ★ 哈希基准切换（本机制不产生回归的关键）

引入信封最大的风险是：**给文件加了 4 行之后，所有已有的哈希都不等了**，于是每一篇存量文档都会被判定成"本地变了"，触发一次全库 overwrite 推送到飞书——轻则限流刷屏，重则把别人在飞书上的新改动覆盖掉。

解法是把"参与比较的哈希"从整文件切到 body：

```ts
// local.ts + types.ts:44-49
contentHash: .md → sha256(body)      // ← 所有同步判定用这个
rawHash:     .md → sha256(整个文件)   // 仅诊断
             非 .md → sha256(整个文件)

// sync.ts:543
const localContent = readSyncDocument(await this.local.readText(...), path).body;

// sync.ts:502  基线同样要剥
private async baselineBody(rootId, relativePath) {
  const stored = await this.gitStorage.getBaseline(rootId, relativePath);
  return stored === undefined ? undefined : stripEnvelope(stored);
}
```

三方判定的三个输入因此**同基准**：

```
base   = stripEnvelope(git baseline)
local  = stripEnvelope(working tree)      == body
remote = sha256(canonicalRemote)
```

**向后兼容的证明**：没有信封时 `body === raw`（只去掉 BOM），所以 `contentHash === rawHash === sha256(整个文件)`，与机制引入之前**逐字节等价**。这条被固化成测试：`identity.test.ts` 的「an untagged file hashes to its exact bytes, so legacy behaviour is unchanged」，用 `createHash("sha256")` 直接比磁盘字节。

### 三条人工复核过的性质（改代码时必须保持）

| 性质 | 检查方法 |
| --- | --- |
| **信封绝不进哈希** | 全仓 `sha256(` 有 30 处调用点，逐个确认参数是 body / canonicalRemote / 二进制内容，没有一处吃 `raw` |
| **信封绝不发到飞书** | `renderRemoteContent` 共 5 处调用（`createDocument`、创建后补写、push/merge、`applyResolvedContent`、导入碰撞），每一处的入参都是已经 `stripEnvelope`/`readSyncDocument().body` 的内容 |
| **三方判定两侧同基准** | `decideSync` 唯一调用点在 `sync.ts:656`，`base`/`localContent` 都来自 `baselineBody`/`readSyncDocument` |

---

## 4. 标题钉回（`ensureRemoteTitle`）

**问题**：`docs_ai` 的 Markdown 导入管线会用文档**首个 H1 重写页面标题**。于是"本地文件叫 `notes.md`、正文第一行是 `# 我的笔记`"的文档，写完正文之后云盘里显示的名字就变成了「我的笔记」。同名守卫、路径配对、Tier-2 标题配对全部依赖"远端名 == 本地基名"，标题一漂移整条链就断。

**解法**：每次内容写入之后，比较 `doc.name` 与 `documentTitle(relativePath)`，漂了就调一次 page-block 改名：

```ts
// rename.ts:26
if (doc.name === expected || !remote.renameDocument) return doc;
await remote.renameDocument(doc.token, expected);   // PATCH docx/blocks/{token}
```

三个连带效果：

1. `renameDocument` 是**可选**能力（lark-cli v1 就没有），provider 不实现就静默 no-op。
2. 因为标题现在由文件名单方面决定，**同名额守卫只按文件名匹配**。两个文件共享同一个 H1 不再报 `Remote folder already has a document named …`——只有远端真的存在同名额文档时才阻断。
3. 存量文档（旧版按 H1 命名的）**不自动改名**，重新同步一次就按新规则处理。

---

## 5. 文件名净化与统一比较键

三层工具，别混：

| 函数 | 用途 | 规则 |
| --- | --- | --- |
| `sanitizeLocalSegment` | 远端标题 → **可写的本地文件名** | 解码常见 HTML 实体 → 替换 Windows 非法字符 `\/:*?"<>\|` 与控制字符为 `-` → **240 字节安全截断**（subarray 可能劈开码点，重新解码并丢 `\uFFFD`）→ 去首尾空白/点号 → Windows 保留名（`CON`/`NUL`/`COM1-9`/`LPT1-9`）前加 `_` → 空则 `Untitled` |
| `normalizeForMatch` | 两侧**比较归一** | `NFC` + `trim`。macOS 存 NFD、别处存 NFC，不归一化标题配对必挂 |
| `titleToLocalSegmentKey` | 标题↔文件名配对的**唯一比较键** | `normalizeForMatch(sanitizeLocalSegment(x))` |

**为什么必须是第三个**：标题 `a/b` 落盘时净化成了 `a-b`。如果配对时一边比 `normalizeForMatch("a/b")` 一边比 `normalizeForMatch("a-b")`，永不相等，于是每轮重新导入一份。让两侧都过同一个 `sanitize → normalize` 键，就对上了；对已经干净的名字它是幂等的，无副作用。

碰撞消歧 `uniqueLocalPath` 追加 `-2/-3`（在扩展名**之前**）。⚠️ 后缀依赖 `tree.nodes` 的迭代顺序 = Drive 返回顺序，顺序变了后缀就可能变，是已知稳定性瑕疵（B10）。

---

## 6. 同名副本治理（`governRemoteDuplicates`）

只在**全量轮**、远端树完整时执行。按 `父token|归一化标题` 分组，组内 ≥2 个文档时：

```
winner = 已被绑定的那个 ?? updatedAt 最早的那个
对每个 loser:
  ├─ loser.contentHash == winner.contentHash → softDelete(loser, "docx") + 从内存树里摘掉
  └─ 内容不同 → winner 已绑定 ? 在 winner 的 entry 上起 conflict
                : 不动（先让 winner 被导入，下一轮全量再处理）
```

三个保守选择：

- **拿不到内容的副本不删**（`getDocument` 失败就 `continue`）。宁可留一个重复副本，也不能凭猜删别人的文档。
- **内容不一致时不自动删**，交人工。
- **全未绑定时选 `updatedAt` 最早者**（不是最新者）——最早的那篇通常是"原件"，后面的是复制出来的。

这解决了"改名后重试死锁"这个历史问题：以前同名就报错要用户改名，现在同名且同内容直接清理掉。

## 6.1 重复导入防护

`findDuplicateLocalDocument`（`rename.ts:160`）：要导入一个未绑定的远端文档前，先看它的 canonical 内容是否**已经等于某个本地文档**（名字不同）。是则跳过导入——那通常是旧版按 H1 命名时代留下的重复副本，导入等于给用户凭空造一个第二份本地文件。远端副本保留，由用户在飞书里手动删。

副作用要知道：一个真的"创建副本"（内容与原文完全一致）也会被这条防护跳过。`identity.test.ts` 里那条测试的副本内容因此刻意做了一点差异（`"# Notes copy\n\nlocal body\n"`），注释写明了这是 duplicate-import 守卫的既定语义，不是测试在绕路。

---

## 7. 远端树缓存与增量作用域

| 机制 | 参数 | 目的 |
| --- | --- | --- |
| `RemoteTreeCache` TTL | **60 秒**/root | 一轮同步里同名守卫、`ensureRemoteParent`、配对循环都要看树，不能每次都 DFS |
| single-flight | `jobs` Map | 并发 `listTree` 只发一次请求 |
| `invalidate(rootId)` | 重试前**必须**调 | 上一轮"API 报错但文档建成了"，用陈旧缓存会再建一份 |
| `cacheNode(root, node)` | 新建节点当场塞进缓存树 | Drive 列表有延迟，本轮后续要能看见刚建的东西 |
| `buildScoped` | 增量最小树 | 只读公告 token；未绑定 token 必须在公告的父目录里能单层列出，**否则返回 undefined 降级全量** |
| `folders.json` | 持久化目录 token | 重启后不重复建目录（`ensureRemoteParent` 先查它，全命中就一次远端请求都不发） |

`ensureRemoteParent`（`sync.ts:890`）还有个小而重要的过滤：丢掉 `""`、`.`、`..` 占位段——`posix.dirname("a.md")` 是 `"."`，根级文档根本没有远端文件夹要建。新建的目录 token **立刻 `setFolderBinding` 持久化**，同一目录下的第二篇文档就不用再走一遍远端查找。

---

## 8. 链接与资源的双向改写

本地 Markdown 和飞书 Markdown 用两套语法表达"引用"，推送和拉取时必须互转，且必须**逐字节可逆**（否则哈希永远不等，自激同步）。

| 方向 | 内部链接 | 图片 |
| --- | --- | --- |
| 本地 → 远端（`rewrite*`） | `[文字](./other.md)` → `<cite type="doc" doc-id="tokXXX"/>` | `![说明](img.png)` → `<img src="assetTok" caption="说明"/>` |
| 远端 → 本地（`restore*`） | 反向：按 `reverseMap` 还原成相对路径 | 反向 |

四道防护：

1. **围栏内不动**：`replaceOutsideFences` / `isInsideFence` 追踪 ``` 与 ~~~ 的开合，代码块里的假链接不会被改。
2. **外链不碰**：`https?:`、`mailto:`、`#锚点`、`data:`、`file:` 直接跳过。
3. **属性转义**：`escapeAttribute` 处理 `& " < >`。
4. **还原失败保持原样**：映射表里没有这个 token 时返回整段原文（`return whole`），**绝不留下半截标签**。

映射表来自 binding 表本身（`importer.ts:26` `buildLinkMaps`）：`relativePath ↔ remoteToken`，正反向各一份；`prepareAssets` 再叠一层"这篇文档用的是哪个 asset 版本"的 `AssetBinding`。

### 图片的两条通道

| 通道 | API | 用途 |
| --- | --- | --- |
| 云盘文件 | `uploadAsset(parentToken,…)`，`parent_type=explorer` | 图片作为独立 asset 条目存在于同步目录里，可被多篇文档引用 |
| 内联图 | `uploadInlineAsset(documentToken,…)`，`parent_type=docx_image` | 推送正文时把变化的图片传成这篇文档的内联资源，拿到的 token 才能填进 `<img src>` |

`prepareAssets(..., uploadInline)` 的 `changed` 返回值很重要：`decideSync` 可能判 `noop`（正文一个字没改），但**图片换了**。所以有 `action = decision.action === "noop" && assetMaps.changed ? "push" : decision.action`（`sync.ts:657`）。少了这个，"只换图片不改文字"永远同步不上去。

`hydrateChangedRemoteAssets` 处理反向情形：远端把内联图换了、本地同时改了这个文件 → 逐张比 hash，**只有 asset 自身没有本地分歧时才下载回本地**，否则报 conflict。

---

## 9. 凭证与错误处理

- **提前 5 分钟续期**（`USER_TOKEN_REFRESH_MARGIN_MS`）、**失败后 60 秒冷却**、**single-flight**（`tokenRequest`）。三者配合避免并发刷新把一次性轮换的 refresh token 打废。
- 不透明 token（非 JWT）→ `Infinity` → "用到飞书拒绝为止"，符合手工粘贴 token 的真实体验。
- **`AUTH_CODES` 只收录了无歧义的 5 个码**（`99991661/63/64/68/79`）；`PERMANENT_REFRESH_OAUTH_CODES` 收录 6 个（`20002/20026/20037/20064/20073/20074`）标记"重试永不可能成功，必须重新授权"。分类保守是故意的：**把可恢复错误误判成 auth 会中断整轮同步**，代价远大于多试一次。
- `remoteEvents: false` 是 provider 的诚实声明：事件由 server 的 `EventChannelService` 独立拿，`core` 不能指望 provider 推。所以**轮询永远是兜底**，事件只是加速器。
- 1770040/1770032 之类的错误码目前会被归成 `other → unknown`（会重试 3 次然后 error）。它们的真实含义多为**文件夹权限未开通**，理想处理是给可操作的授权引导而不是裸 error——待改进。

---

## 10. 设计决策总表

| 决策 | 备选方案 | 为什么选现在这个 |
| --- | --- | --- |
| 信封只存不可变身份 | 把 revision/hash/status 也写进文件 | 写进去 = 每轮弄脏文件 = 永久"本地已变" = 自激同步 |
| 自己解析 YAML 首部块 | 用 `js-yaml` | core 必须零依赖；重序列化会重排键、丢注释、改格式，破坏逐字节可逆 |
| token 写在**文件**里而不是 DB | 只加一张 `token→path` 反向索引 | 文件是**跟着内容走**的：改名、移动、拷贝、甚至删掉整个 `.feishu-sync/`，身份都还在 |
| 多声明一律冲突，不自动裁决 | 按 updatedAt/mtime 挑一个 | 猜错的代价是"两个文件抢同一篇云端文档"，静默且不可逆 |
| 已 token 绑定的条目不进模糊配对 | 内容匹配兜底更"聪明" | 一个远端重复副本就能偷走活绑定 —— 聪明的代价是数据错乱 |
| 基线只提交 clean 条目 | 整树提交更简单 | 整树提交会把未同步的本地编辑吸收成 base，下一轮判定 `base==local` → pull → **静默抹掉用户编辑** |
| canonical 化后再比哈希 | 直接比 raw markdown | 两侧表达不同（token vs 路径），直接比永不相等 → 每轮误判"远端变了" |
| 只在全量轮做命名对齐/同名治理 | 增量轮也做，更快收敛 | 增量轮作用域按旧路径 key；不完整的树做"按父目录分组"会误删 |
| per-root 串行、跨 root 并发 | 全并发 + 文件锁 | 同一份 `bindings.json` 和 `.git` 不能交叠读写；root 之间无共享状态，没必要串行 |
| `error` 状态跨轮保持 | 每轮重新武装 pending | 永久失败的条目会变成每 15 秒一次的无限重试风暴，且任务中心刷屏 |
| `Retry-After` 作退避**下限** | 直接照抄 / 忽略 | 照抄会绕过自己的策略，忽略会在限流窗口里继续 hammer |
| 用 git 当存储 | SQLite / 自研快照表 | 用户本来就要 git；`git log`/`git diff` 直接可用；isomorphic-git 纯 JS 免编译原生模块 |
| JSON 文件存元数据 | 数据库 | 可读、可手改、可 diff；代价是 O(N²) 整文件读写，靠 bindingsCache 缓解 |
| 前端类型手抄 | 共享类型包 | web 用 Vite、server 用 tsc，跨包共享 d.ts 会让前端构建依赖后端构建顺序。代价是漂移风险（已知） |
