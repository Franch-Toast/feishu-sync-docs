# 05 · 开发者指南与调试实操

> 01–04 篇讲"是什么、为什么"，本篇讲"怎么动手"。目标：让你在半小时内完成一次「改代码 → 跑测试 → 起服务看到效果」的闭环，并且知道加一个端点 / 加一个 provider 该碰哪几个文件。
>
> 本篇所有命令都在**仓库根目录** `/workspace/feishu-sync-docs` 下执行，除非另有说明。

---

## 1. 环境搭建（以及两个一定会踩的坑）

### 1.1 前置要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | **≥ 20**（`engines` 硬约束） | 用到 `fetch`、`structuredClone`、`node:test` 的稳定 API |
| pnpm | 10.32.1（`packageManager` 锁定） | **只用 pnpm，不要用 npm/yarn**——`workspace:*` 协议和锁文件是 pnpm 格式 |

### 1.2 激活正确版本的 pnpm

仓库用 corepack 管理 pnpm 版本：

```bash
corepack enable              # 只需一次，装好 corepack shim
corepack prepare pnpm@10.32.1 --activate
pnpm -v                      # 必须是 10.32.1，不是的话见下面的坑
```

> ⚠️ **坑 1：PATH 里有多个 pnpm**。如果你之前用 `npm i -g pnpm` 或发行版包管理器装过别的版本，`corepack` 的 shim 可能被排在它后面，`pnpm -v` 会显示旧版本。用 `which -a pnpm` 确认第一个命中是 corepack 的 shim（通常在 Node 安装目录下），必要时调整 PATH 顺序或直接 `corepack pnpm ...`。版本不对会导致 lockfile 被重写、`workspace:*` 解析异常。

```bash
pnpm install                 # 安装全部五包依赖（走本地 .pnpm-store 缓存会快很多）
```

### 1.3 必须先 build 再 dev（最关键的坑）

```bash
pnpm build                   # ← 第一次务必先跑这个
pnpm dev                     # 之后才能起服务
```

> ⚠️ **坑 2：`pnpm dev` 前不 `pnpm build` 会直接崩。** 五包之间用 `@feishu-sync/core`、`@feishu-sync/storage` 等**包名**互相引用，而 `server`/`storage`/`feishu` 的 `main` 字段指向各自的 `dist/`。`dev` 脚本（`tsx watch src/index.ts`）虽然用 tsx 直接跑 `server` 的 TS 源码，但它 `import "@feishu-sync/core"` 时解析到的是 core 包的 `dist/index.js`——**dist 不存在就报 `Cannot find module`**。所以首次 clone、或改过 `core`/`storage`/`feishu` 的源码之后，都要先 build 让下游 dist 就位。

`build` 脚本里的顺序是**刻意**的（根 `package.json:9`）：

```
core → storage → feishu → web → server
```

前三个是 server 的运行时依赖，必须先有 dist；web 产出静态资源到 `server/public`（`server` 的 build 脚本会把 `public/` 拷进 `dist/public`，见 `packages/server/package.json:7`），所以 web 要在 server 之前。

### 1.4 常用命令总表

| 目的 | 仓库根命令 | 展开 |
| --- | --- | --- |
| 全量构建 | `pnpm build` | 按上面的顺序 `--filter` 逐包 build |
| 起开发服务 | `pnpm dev` | `tsx watch src/index.ts`（server 包），改 server 源码热重启 |
| 全部测试 | `pnpm test` | `pnpm -r test`，逐包跑各自的 test 脚本 |
| 全部类型检查 | `pnpm typecheck` | `pnpm -r typecheck`（每包 `tsc --noEmit`） |
| 只测一个包 | `pnpm --filter @feishu-sync/core test` | 见 §3 |
| 只跑一个测试文件 | `cd packages/server && NODE_ENV=test npx tsx --test test/runtime.test.ts` | node:test 单文件 |
| 生产启动 | `pnpm --filter @feishu-sync/server start` | `node dist/index.js`（需先 build） |

`server` 起监听后，工作台在 `http://127.0.0.1:8787`（端口由 `PORT` 控制，默认见 `index.ts`；host 由 `HOST` 控制）。第一次进去会走 onboarding 引导（配凭证 → 建根 → 首同步）。

---

## 2. 改代码前的读码路线

如果你要动同步逻辑，**不要从 `runtime.ts`（1036 行）硬啃**。按这个顺序读，认知负担最低：

```mermaid
flowchart LR
    A["types.ts<br/>先认清所有数据结构"] --> B["frontmatter.ts + merge.ts<br/>两个纯函数模块，可单测"]
    B --> C["identity.ts<br/>仲裁矩阵"]
    C --> D["sync.ts scan()/syncEntry()<br/>编排主流程"]
    D --> E["runtime.ts scanAndSync()<br/>车道/重试/广播"]
    E --> F["app.ts<br/>端点装配"]
```

- **纯函数优先**：`frontmatter.ts`、`merge.ts`、`markdown.ts`、`names.ts`、`sync_paths.ts`、`glob.ts`、`hash.ts` 全部无副作用，是理解语义 + 写单测的最佳入口。改这些风险最低。
- **看到 `this.xxx()` 是单行转发就去协作者里找**：`sync.ts` 里那批 private 一行方法（`buildLinkMaps`、`detectRename`…）真实实现在 `importer.ts`/`rename.ts`/`name_align.ts`/`remote_tree.ts`（详见 [02 篇 §2](02-code-structure.md)）。
- **`core` 里绝不允许出现飞书字样**：任何 `import "@feishu-sync/feishu"`、任何硬编码 `open.feishu.cn`、任何 HTTP 调用都是架构违规，远端能力只能经 `RemoteProvider` 接口进来。

---

## 3. 测试怎么写、怎么跑

测试分两套体系，跑法不同：

| 包 | 框架 | 命令 | 位置 |
| --- | --- | --- | --- |
| core / storage / feishu / server | **`node:test` + `node:assert/strict`** | `tsx --test test/*.test.ts` | `packages/*/test/` |
| web | **vitest** | `vitest run` | `packages/web/src/*.test.ts` |

### 3.1 端到端测试的脚手架：`FakeRemote`

`packages/server/test/helpers/fake-remote.ts`（186 行）是**整个 server 测试体系的地基**。它是一个内存版 `RemoteProvider`，不仅实现了正常读写，还预埋了一堆**故障注入钩子**，用来在没有真实飞书沙箱的情况下覆盖各种失败路径：

```ts
const remote = new FakeRemote();
remote.simulateH1Title = true;        // 让远端把标题推导自 H1（复刻飞书真实行为）
remote.failNextWrite();               // 下一次 applyPatch 抛错（一次性）
remote.failWritesTimes(2);            // 接下来 2 次写抛瞬时报错，用来验证退避重试在同轮内恢复
remote.failWritesAuth = true;         // applyPatch 抛 auth 错——auth 绝不自动重试，必须 fail-fast
remote.failWritesRateLimit(3, 1500);  // 3 次 429 且带 Retry-After，验证退避下限取 Retry-After
remote.failCreatesTimes(1);           // createDocument 服务端已建但 ack 丢失，验证不会重复建
remote.getDocumentError = new Error("..."); // getDocument 抛错，验证权限/网络分类
remote.edit(token, "新内容");          // 模拟"有人在飞书上改了这篇"——驱动 pull 分支
```

写新测试时**优先复用这些钩子**而不是自己造 provider。

### 3.2 标准场景装配：`createScenario()`

`runtime.test.ts:32-46` 的 `createScenario()` 是样板，直接抄：

```ts
function createScenario(options?: { delays?: number[] }): Scenario {
  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-runtime-")); // 独立的本地仓库
  const globalDir = mkdtempSync(join(tmpdir(), "feishu-sync-global-"));   // 独立的全局配置目录
  const gitStorage = new GitStorageImpl();
  const metaStorage = new JsonMetaStorage(globalDir);
  const remote = new FakeRemote();
  // 关键：注入零延迟 sleep，让 1s/2s/4s 退避不真的等；
  // 传 delays 数组则把每次退避时长记录下来，供断言（如验证 Retry-After 下限）。
  const sleep = options?.delays
    ? async (ms: number) => { options.delays!.push(ms); }
    : async () => {};
  const runtime = new SyncRuntime(gitStorage, metaStorage, new FilesystemProvider(),
    remote, undefined, undefined, undefined, undefined, { sleep });
  return { gitStorage, metaStorage, remote, runtime, directory, globalDir };
}
```

三个必须照做的点：

1. **`mkdtempSync` 开临时目录**，绝不在真实仓库上测；`cleanup()` 里 `runtime.stop()` + `rmSync(..., {recursive:true, force:true})` 收尾，放在 `finally`。
2. **`sleep` 一定注入**。`SyncRuntime` 构造签名里预留了 `sleep`（最后一个 options 参数），不注入的话重试退避会真的睡 1/2/4 秒，测试套件跑不完。这是"依赖注入为了可测性"的典型：`sleep` 可注入是它出现在构造参数里的唯一理由。
3. **root 用 `enabled: false` 建**（`createRoot` helper，L48-54），避免 watcher / poll 定时器在测试期间自己触发同步干扰断言；测试里**显式 `await runtime.syncRoot(root.id)`** 驱动一轮，拿返回的 `{ entries }` 断言。

### 3.3 一个完整断言长什么样

```ts
test("pushes a new local document and records a baseline", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario, "shared line\n");
    const result = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    const entry = result.entries[0]!;
    assert.equal(entry.status, "clean");
    assert.ok(entry.remoteToken);
    assert.equal(scenario.remote.documents.get(entry.remoteToken!)?.content, "shared line\n");
    // 基线里存的是带信封的文件，比对时要 stripEnvelope 还原成 body
    const baseline = await scenario.gitStorage.getBaseline(root.id, "notes.md");
    assert.equal(baseline === undefined ? baseline : stripEnvelope(baseline), "shared line\n");
  } finally {
    cleanup(scenario);
  }
});
```

注意最后两行：`.git` 里存的**是带信封的整文件**（版本历史需要身份），但断言关心的是同步内容，所以比较前 `stripEnvelope`。这个"基线含信封、判定用 body"的区别在 [04 篇 §3](04-special-mechanisms.md) 有完整解释。

### 3.4 测纯函数更快

改 `frontmatter`/`merge`/`markdown`/`names` 时，直接在 `packages/core/test/` 下加 `node:test`，不需要 FakeRemote 也不需要临时目录——它们是纯输入输出。跑：

```bash
pnpm --filter @feishu-sync/core test
# 单文件：
cd packages/core && npx tsx --test test/frontmatter.test.ts
```

`frontmatter.test.ts` 里有一组**必须永远为真**的往返断言（`stripEnvelope(writeSyncDocument(b,id).text)===b`、打标幂等、未打标文件哈希等于原始字节）。改信封逻辑时先看这些测试有没有被你弄红——它们是安全网。

---

## 4. 手工调试：跑一段真代码看行为

单元测试之外，经常需要"拿真实 provider / 真实本地目录跑一小段流程"来观察。推荐用一次性 TS 脚本 + tsx。

### 4.1 调试脚本模板（注意执行目录）

workspace 包名（`@feishu-sync/core` 等）**只有在某个包的目录下**才能被解析到——仓库根没有 `node_modules/@feishu-sync/*`。所以脚本要放进某个包目录里跑：

```bash
# 把临时脚本放进 server 包（它能同时看到 core/storage/feishu）
cp /tmp/dbg.mts packages/server/dbg.mts
cd packages/server && npx tsx ./dbg.mts
rm dbg.mts     # 别忘了删，或加进 .gitignore
```

> 直接把脚本放在 `/workspace` 或仓库根跑会报 `Cannot find package '@feishu-sync/core'`。这不是配置错，是 pnpm 的隔离式 node_modules 结构决定的——依赖挂在声明它的那个包目录下。

`dbg.mts` 里可以像测试一样手搓一个 `SyncRuntime`（或用 `createRemoteProvider()` 从环境变量拿真 provider），调 `engine.scan()` 单独看扫描结果，而不必起整个 HTTP 服务。

### 4.2 起真服务 + 观察实时事件

```bash
# 用环境变量直接喂凭证（跳过 UI 授权），provider 用真实飞书
export FEISHU_APP_ID=cli_xxx
export FEISHU_APP_SECRET=xxx
export FEISHU_PROVIDER=openapi        # 或 cli 走 lark-cli
export PORT=8787
pnpm build && pnpm dev
```

起来后：

- 工作台：`http://127.0.0.1:8787`
- 健康检查（含 provider 能力、auth 状态、事件通道状态）：`curl -s localhost:8787/api/health | jq`
- 实时事件流（WS）：`websocat ws://127.0.0.1:8787/api/events`（或任意 WS 客户端）。**同步过程发生的几乎每一步都会往这里广播**（`sync-started`/`operation-*`/`rate-limited`/`auth-invalid`…），是观察一轮同步最直接的窗口，事件清单见 [06 篇 §2](06-api-and-ui-reference.md)。
- 用 curl 手动触发一轮：`curl -X POST localhost:8787/api/roots/<rootId>/sync -H 'content-type: application/json' -d '{"trigger":"manual"}'`

### 4.3 一次性给整个仓库打信封标

存量仓库升级信封机制后，想立刻全部纳入 Tier-0 保护：

```bash
curl -X POST localhost:8787/api/roots/<rootId>/stamp-identity | jq
```

返回逐路径报告（`stamped`/`alreadyOk`/`skippedUnbound`/`malformed`/`conflicts`）。目前**没有 UI 按钮**，只能这样调（见 [07 篇 §7](07-known-issues.md)）。

---

## 5. 如何加一个 HTTP 端点

改动面很集中，三步：

### 第 1 步：在 `app.ts` 注册路由

`buildApp()` 里所有依赖（`runtime`、`metaStorage`、`gitStorage`、`credentials`、`remote`、`eventChannel`、`appConfig`）都已闭包可见，直接写：

```ts
// packages/server/src/app.ts，放在其它 app.xxx 注册之间
app.get<{ Params: { id: string }; Querystring: { verbose?: string } }>(
  "/api/roots/:id/my-new-view",
  async (request, reply) => {
    const root = await metaStorage.getRoot(request.params.id);
    if (!root) return reply.code(404).send({ error: "root not found" });
    // 业务逻辑尽量放进 runtime / core，路由层只做参数校验 + 编排 + 序列化
    return runtime.myNewView(request.params.id, request.query.verbose === "1");
  }
);
```

约定（照抄现有端点的风格，别自创）：

- **用泛型标注 `Params`/`Querystring`/`Body`**，Fastify 5 靠它做类型与校验。
- **参数校验在路由层做，早返回 400**，错误体统一是 `{ error: "人话" }`（见 `app.ts` 里满地的 `reply.code(400).send({ error: ... })`）。未捕获异常由 `setErrorHandler`（L504）兜底成 `{ error: message }` + 对应状态码。
- **能落到 runtime 的就别写在路由里**：路由要保持薄，逻辑进 `SyncRuntime` 方法或 core，这样能被单测覆盖（`app.test.ts` 直接 `app.inject()` 打请求测）。
- **动了 root/binding 状态要 `runtime.broadcastEvent({ type: "root-updated", rootId })`**，前端靠它即时刷新。

> WS 端点是特例：它必须像 `app.ts:496-503` 那样包在一个 **deferred 子插件**里用 `events.route({ method, url, handler, wsHandler })` 注册。原因注释写得很清楚——`@fastify/websocket` 的 `onRoute` 钩子在声明时同步改写 handler，先于插件 boot 注册会把它留成普通 HTTP 路由，浏览器握手拿到 426 而非 101，实时事件全丢。加 WS 一定照这个模板。

### 第 2 步：在 `web/src/api.ts` 加前端封装 + 手抄类型

⚠️ **前端类型是服务端类型的手工副本**（`api.ts` 顶部自己 `interface SyncRoot {...}` 等），没有共享类型包、没有代码生成。加了返回结构变化的端点，**必须记得同步手抄**，否则前后端类型会悄悄漂移——这是已知风险，见 [07 篇 §4](07-known-issues.md)。

```ts
// packages/web/src/api.ts
export async function myNewView(id: string, verbose = false): Promise<MyView> {
  return json<MyView>(`/api/roots/${id}/my-new-view${verbose ? "?verbose=1" : ""}`);
}
```

`json<T>()` 封装（`api.ts:293`）已经处理了"无 body 的请求不带 content-type"这个坑（否则 DELETE 会被 Fastify 以 `FST_ERR_CTP_EMPTY_JSON_BODY` 打回），新调用一律走它，别裸用 `fetch`。

### 第 3 步：补测试

在 `app.test.ts` 加一条 `app.inject({ method:"GET", url:"/api/roots/.../my-new-view" })`，断言状态码与响应体。跑 `pnpm --filter @feishu-sync/server test`。

---

## 6. 如何加一个新的远端 provider（接 Notion / Confluence）

架构把"远端是谁"完全抽象在 `RemoteProvider` 接口后面（`core` 一行不用改），加新远端的步骤：

### 6.1 实现 `RemoteProvider`

接口签名（`core/src/types.ts`，`RemoteProvider`）：

```ts
interface RemoteProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;         // 声明你支持什么
  listTree(root: SyncRoot): Promise<RemoteTree>;
  getDocument(token: string): Promise<RemoteDocument>;
  createFolder(parentToken: string, name: string): Promise<RemoteNode>;
  createDocument(parentToken: string, name: string, content: string): Promise<RemoteDocument>;
  applyPatch(token: string, patch: DocumentPatch): Promise<MutationResult>;
  uploadAsset(parentToken: string, name: string, content: Uint8Array, mimeType: string): Promise<RemoteAsset>;
  downloadAsset(token: string): Promise<Uint8Array>;
  softDelete(token: string, type?: "docx" | "folder" | "file"): Promise<void>;
  // 可选——不实现引擎自动降级：
  uploadInlineAsset?(...): Promise<RemoteAsset>;
  listFolderChildren?(parentToken: string): Promise<RemoteNode[]>;
  renameDocument?(token: string, title: string): Promise<void>;
}
```

`capabilities`（`{blockPatch, revisionGuard, assetUpload, remoteEvents}`）决定引擎走哪条路：`blockPatch:false` → 永不发块级补丁，一律整篇 overwrite；`revisionGuard:false` → 不校验 `expectedRevisionId`。**诚实声明**，引擎依赖它做退化，谎报会导致写入被静默丢弃（参考 `openapi.ts` 的 `remoteEvents:false`——provider 本身确实不推事件）。

放在新包（如 `packages/notion/`）或 `packages/feishu` 里都行，只要实现接口并在 `package.json` 依赖 `@feishu-sync/core`。

### 6.2 在 `ProviderRegistry` 里挂上

`packages/server/src/credentials.ts` 的 `buildProvider()` 是"根据配置选哪个 provider"的唯一决策点。加一个分支返回你的新实例即可；`ProviderRegistry`（`provider.ts:17`）本身是个**委托壳**——所有方法转发给 `this.current`，`rebuild()` 时热替换，所以换 provider 不用重启 watcher/引擎。

如果是纯 env 驱动的直连场景（不经 UI），`createRemoteProvider()`（`provider.ts:9`）里也照 `FEISHU_PROVIDER` 的分模式加一个值。

### 6.3 给新 provider 写单测

复制 `FakeRemote` 的思路：做一个假 HTTP（或直接 mock `fetch`），断言 `createDocument` 两步语义、错误分类映射到你的 `classify*`。真实 `openapi.ts` 的测试在 `packages/feishu/test/openapi.test.ts`（362 行），是最好的参照。

---

## 7. 提交前检查清单

改完代码，push 之前按顺序过一遍：

```bash
pnpm typecheck   # 五包全部 tsc --noEmit，零错误
pnpm test        # 全部用例绿（当前 290 个：core/storage/feishu/server 211 + web 79）
pnpm build       # 确认生产构建能过（web 产物拷进 server/dist/public）
```

另外自查：

- [ ] 动到 `core`：没有引入任何运行时依赖、没有 import 飞书、没有硬编码 URL。
- [ ] 动到信封/哈希逻辑：`frontmatter.test.ts` 的往返与幂等断言仍绿。
- [ ] 动到判定：`contentHash` 算的仍是 **body**，不是 raw（除非你确实要整文件哈希，那用 `rawHash`）。
- [ ] 加了/改了远端写入：内容送出前经过 `stripEnvelope`/`renderRemoteContent`，信封不会发到飞书。
- [ ] 改了返回结构：`web/src/api.ts` 的手抄类型同步了。
- [ ] 新增强制行为时同步写了测试（本项目严重依赖测试兜住同步语义的正确性）。

> 关于 git：本仓库遵循"只在被明确要求时才 commit"。文档类改动与代码类改动建议**分开提交**，方便 review。
