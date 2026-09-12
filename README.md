# Feishu Local Sync

本地优先的后台服务:将本地 Markdown 目录与飞书 / Lark 云文档文件夹**双向同步**,并提供一个浏览器工作台完成凭证管理、任务处理、冲突解决与历史回溯。文档的唯一真相在本地 Git 仓库里,飞书只是其中一个镜像端;服务挂掉、重复重启都不会丢数据。

## 特性总览

- **双向同步**:本地文件监听(chokidar)+ 飞书长连接事件订阅 + 定时轮询兜底,任一来源变化都会触发同步;
- **三方合并**:本地内容、远端内容与上一次共同基线(git baseline)做三方对比,能自动合并的自动合并,冲突的进工作台人工裁决,永不静默覆盖任一侧;
- **任务中心语义**:条目失败后单轮内自动重试 3 次(1s/2s/4s 退避),仍失败则进入「失败待处理」队列**等待人工处理**,不再跨轮无限重试;重试 / 忽略后即移出队列;
- **OAuth 凭证**:一键飞书授权登录自动获取并持续续期 Refresh Token(需应用开通 `offline_access`),手工 Token 与应用凭证模式保留为后备;
- **增量事件同步**:飞书云盘事件(新建/更新/删除)携带 token 直达受影响条目,只对变化路径做局部 stat + 哈希,大目录下不再全量扫描;
- **Git 基线历史**:每个绑定目录初始化为 git 仓库,文档内容与版本历史全部落 git,支持「恢复到基线版本」与历史 diff;
- **浏览器工作台**:仪表盘、根详情(文档 / 冲突 / 历史)、任务中心、设置四个页面,Markdown 渲染预览、git 式分栏冲突解决都在网页内完成。

## 环境要求

- Node.js >= 20:存储层使用 `isomorphic-git`(纯 JS)+ JSON 文件,安装依赖无需编译原生模块;
- pnpm:可通过 `corepack enable` 启用;
- 当前远端范围是飞书**云盘文件夹**(`remoteType=folder`);`wiki` 类型会被适配器明确拒绝,知识库需要独立的 Wiki provider,后续可在 provider 边界内增加。

## 快速开始

```bash
pnpm install
pnpm build
pnpm dev          # 等价于 pnpm --filter @feishu-sync/server dev
```

打开 <http://127.0.0.1:8787>(默认只监听本机),然后在「设置」页配置凭证,在仪表盘添加第一个同步根目录。也可以直接调 API:

```bash
curl -X POST http://127.0.0.1:8787/api/roots \
  -H 'content-type: application/json' \
  -d '{"localPath":"/absolute/path/to/docs","remoteToken":"feishu-folder-token","remoteType":"folder","pollIntervalMs":15000}'
```

本地路径必须真实存在(否则 400);同一本地路径只允许绑定一个根目录(重复绑定返回 409)。

## 凭证配置

在「设置 → 飞书凭证」中管理,共四种方式。**输入框留空 = 保持已保存值**,不会误清已存凭证;保存后 provider 热重建,立即生效无需重启。

### 方式一:飞书授权登录(推荐,自动获取并续期 Refresh Token)

1. 填写 **App ID / App Secret** 并保存(企业自建应用,在[开发者后台](https://open.feishu.cn/app)创建);
2. 在飞书后台「安全设置 → 重定向 URL」登记回调地址:`http://127.0.0.1:8787/api/auth/feishu/callback`(以实际访问地址为准;反向代理场景可用设置项 `feishu.oauthRedirectUri` 或环境变量 `FEISHU_OAUTH_REDIRECT_URI` 覆盖);
3. 在「权限管理」中开通文档读写权限,并确保应用支持 `offline_access`(否则拿不到 refresh_token);
4. 回到设置页点击「飞书授权登录」,在飞书完成授权后自动跳回,refresh token 即保存完成。

> 排障:若点击授权后飞书提示**「重定向 URL 有误」**,几乎都是登记地址与实际发起授权的地址不一致——飞书对 `redirect_uri` 做**逐字符精确匹配**,登记了 `127.0.0.1` 却通过 `localhost` 访问服务(或端口不同)都会报错。用与登记地址完全相同的 host 访问服务、修改登记地址、或用 `FEISHU_OAUTH_REDIRECT_URI` 显式指定即可。

之后 user_access_token 由服务端**自动续期**:每次刷新自动顺延约 7 天有效期;若服务停摆超过 7 天导致 refresh token 过期,重新点一次授权即可。手工粘贴 Token 的输入框降级为「高级选项」,通常无需填写。

### 方式二:手工 User Access Token

粘贴从飞书开放平台获取的 `user_access_token`(「高级选项」中也可手工粘贴 refresh token,配合 App ID/Secret 自动刷新)。适合临时验证,token 过期需手工更换。

### 方式三:应用凭证(tenant_access_token)

App ID + App Secret,以应用身份访问,tenant token 由服务端自动刷新。适合无人值守场景,但只能访问应用有权限的文档。

### 方式四:lark-cli

复用本地 lark-cli 登录态:设置页选择「lark-cli」并填写可执行文件路径,或 `export LARK_CLI_BIN=lark-cli`(旧名 `LARK_CLI_PATH` 兼容)。CLI 路径支持 `LARK_CLI_API_VERSION=v2` 启用块级命令;图片上传与目录遍历优先走 OpenAPI。

### 存储与脱敏

- 凭证以明文保存在 `~/.feishu-sync-docs/config.json`(权限 0600,原子写入)——本地优先设计的取舍,请确保该目录仅当前用户可读,必要时用 `SYNC_CONFIG_PATH` 指到私有目录;
- 所有 API 返回的凭证均为脱敏形式(前 6 后 4),完整凭证不回显到浏览器、不写入日志;
- 飞书返回认证错误时同步自动暂停:顶栏徽章告警、WebSocket 广播修复引导,按认证方式深链到 API 调试台或开发者后台,重新授权/换 Token 保存后自动重测并恢复。

## 同步语义

### 匹配算法(binding 优先,只增不改)

`.feishu-sync/bindings.json` 中的 `relativePath ↔ remoteToken` 是真相源。每轮同步按以下优先级配对两侧条目:

1. **remoteToken 精确配对**(权威,已绑定条目直接走增量流程);
2. **路径配对**:远端相对路径(经文件名净化)与本地路径一致;
3. **标题配对**:本地文件基名(去 `.md`)与远端节点名归一化(NFC + trim)后相等且**唯一**;
4. **内容哈希配对**:两侧内容哈希一致的唯一候选自动绑定,多候选进冲突;
5. 仍未配对:远端有 → 导入本地;本地有 → 推送创建;双方都有但配不上 → 冲突工作台。

文件名净化(`sanitizeLocalSegment`)统一处理 NFC 归一化、非法字符替换、HTML 实体残留、Windows 保留名与 255 字符截断,保证「远端文档名 = H1 标题 ≠ 本地文件名」这类差异也能重新配对,而不是重复建文档。

### 同名副本治理

同一远端父目录下出现多个同名副本时:已绑定者胜出;其余副本与胜者**内容哈希一致则自动清理**(软删除 + 广播 + activity 提示),不一致则置 conflict 留人工裁决;全部未绑定时保留 updatedAt 最早者。不再出现"改名后重试"的死锁提示。

### 失败重试与「失败待处理」队列

- 单轮内失败条目自动重试 3 次(1s/2s/4s 退避),防级联风暴;auth 类错误快速失败不重试;
- 仍失败的条目进入任务中心「失败待处理」,**后续轮询不会自动重试**——需要人工「重试」(重新入队,出现在「进行中」)或「忽略」(标记后移出);
- 已忽略、或内容变化已恢复为 pending/clean 的失败记录不再出现在失败队列;同一条目只保留最新一条失败记录;
- 支持 selection 批量重试 / 忽略。

### 冲突工作台

git 式分栏对比:LOCAL / REMOTE 双栏(可展开 BASE),行级差异着色 + 词级高亮;按 hunk 逐一「采用 / 撤回」,与另一侧重叠的块警示覆盖关系;也可切换编辑模式手动合并或预览渲染。「暂不处理」会把决定持久化,条目重新进入待评估队列。解决前会再次校验远端 revision,避免用过期内容覆盖新修改。

### 重绑定与删除根目录

- 绑定同一 `localPath` 到新远端文件夹时,`.git` 历史与 baseline 自然延续:同步会按路径 / 标题匹配存量文档并**重新绑定,不产生重复文档**;重绑定到全新文件夹则本地内容全量推送;
- 添加根目录时若发现孤儿 `.feishu-sync/` 元数据(服务重启等场景残留),会先归档为 `.feishu-sync.bak-<timestamp>` 再初始化,防止错绑旧 token;
- 删除根目录会清理 `.feishu-sync` 元数据,**保留 `.git` 与文档**,历史可回溯。

### 增量事件同步

配置应用凭证后,服务经飞书开放平台 SDK 的 WebSocket 长连接订阅云盘文件事件(配置步骤见设置页「查看配置指引」):新建/更新事件携带 token 直达受影响条目,本地只对变化路径做局部 stat + 哈希、远端只拉取最小子树;任一前提不满足自动回退全量扫描,语义正确优先。定时轮询保留为兜底,429 限流有独立退避与顶栏倒计时徽章。

## 浏览器工作台

侧边栏三页 + 根详情页:

- **仪表盘**:全局健康统计(metric 卡片可点击跳转)、各根目录卡片(状态徽章、统计、立即同步 / 暂停);
- **根详情**(点卡片进入):**文档**(同步条目树、文件名搜索、Markdown 渲染预览、相对路径图片经服务端代理展示、恢复到基线版本)、**冲突**(冲突工作台)、**历史**(按状态 / 方向过滤的操作记录,失败一键重试);
- **任务中心**:全局任务队列,按「进行中 / 失败待处理 / 已完成」分组,失败展示语义化错误分类(auth / permission / rate_limit / network…)+ 完整堆栈,支持批量重试 / 忽略与「清空已完成」;
- **设置**:凭证管理(OAuth 一键授权)、联通测试、同步计划(启停、轮询间隔热生效)、事件通道状态与指引、维护操作与安全提示。

## 通知(暂未开放,接口已预留)

系统通知与浏览器提醒**暂未开放**。服务端已预留 `Notifier` 接口(`packages/server/src/notify.ts`):冲突、失败、凭证失效三类事件都会调用注入的 `Notifier`(当前为 `NoopNotifier` 静默实现),未来接入飞书机器人或系统通知只需替换实现,无需改动同步逻辑。设置页中的通知偏好区块展示占位说明,`config.json` 中的偏好保留不动。

## 运行时配置

环境变量作为 fallback 生效,优先级:**config.json(设置页)> 环境变量**。

| 变量 | 说明 |
| --- | --- |
| `HOST` / `PORT` | 服务监听地址与端口,默认 `127.0.0.1:8787` |
| `SYNC_CONFIG_PATH` | 全局配置文件路径,默认 `~/.feishu-sync-docs/config.json` |
| `SYNC_LOG_LEVEL` | 日志级别(`debug`/`info`/`warn`/`error`),优先于设置页保存的偏好 |
| `FEISHU_BASE_URL` | 飞书 / Lark API 地址,默认 `https://open.feishu.cn` |
| `FEISHU_ACCESS_TOKEN` | 用户 token fallback |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 应用凭证 fallback |
| `FEISHU_OAUTH_REDIRECT_URI` | 覆盖 OAuth 回调地址(反代场景;设置项 `feishu.oauthRedirectUri` 优先) |
| `FEISHU_PROVIDER` | `openapi`(默认)或 `cli` |
| `LARK_CLI_BIN` / `LARK_CLI_PATH` | lark-cli 可执行文件 |
| `LARK_CLI_API_VERSION` | `v2` 时 CLI 适配器尝试块级命令 |

## 数据与安全

- 每个绑定目录初始化为 git 仓库(`.git/`),文档内容与历史存于 git;同步元数据(bindings / blocks / operations / conflicts)存于同目录 `.feishu-sync/`,`.gitignore` 自动忽略;
- 凭证明文存储的取舍见上文「存储与脱敏」;服务默认只监听 `127.0.0.1`,局域网访问请置于反向代理并加认证;
- 本地文件端点 `GET /api/roots/:id/file` 严格防路径穿越(resolve 后必须仍在根目录内,否则 403);远端资产代理 `GET /api/assets/:token` 只接受已绑定条目登记过的资源 token;
- Markdown 渲染默认转义内嵌 HTML(markdown-it `html:false`);
- 删除采用保守策略:本地或远端缺失先标记 orphan,真正删除远端对象需通过带确认字段的 API 操作。

## 架构

```text
chokidar watcher + poller        web UI (React + Vite)
        \                          /        |
         \                      REST / WebSocket / events
          +--------->  server: runtime, task queue,
          |            credential store, event channel
          |
   core: names / markdown / hash / 3-way merge / block patches
        /                          \
filesystem + GitStorage        RemoteProvider
(isomorphic-git + JSON)         /          \
                        Feishu OpenAPI    lark-cli
```

pnpm monorepo 五包:

| 包 | 职责 |
| --- | --- |
| `packages/core` | 不依赖飞书 SDK:文件名净化与匹配归一化、Markdown 规范化、哈希、三方合并、资源引用改写、块补丁规划、增量扫描 |
| `packages/feishu` | 远端能力:OpenAPI provider(Markdown 原子读写、revision 并发控制、目录列举、长连接事件)、lark-cli 适配器 |
| `packages/storage` | GitStorage(isomorphic-git 文档内容与历史)+ MetaStorage(bindings / blocks / operations / conflicts JSON) |
| `packages/server` | 常驻进程(SIGINT/SIGTERM 优雅退出)、文件监听、任务串行化与重试、REST/WS API、凭证与设置热生效、Notifier 接口 |
| `packages/web` | React 工作台(仪表盘 / 根详情 / 任务中心 / 设置),构建产物直接由 server 静态托管 |

新增远端或本地来源时优先新增 provider,不修改同步核心。

## 开发与测试

```bash
pnpm build       # 按依赖序构建(core → storage/feishu → web → server)
pnpm -r test     # core/feishu/storage: tsx --test;server: NODE_ENV=test tsx --test;web: vitest
pnpm typecheck
```

测试覆盖:文件名净化与匹配归一化(names)、增量扫描(scanEntries 过滤与逃逸拒绝)、Markdown 解析与引用改写、三方合并与块补丁规划、GitStorage/MetaStorage 持久化、OpenAPI 请求与 revision 校验、飞书错误码语义分类(auth / permission / rate_limit / network)、CLI 适配器、同步引擎匹配与同名副本治理、失败不跨轮复活、任务中心过滤、凭证空串语义与 OAuth 交换、HTTP API(设置读写与脱敏、根目录唯一性与孤儿归档、路径穿越拒绝、资产代理、统计与基线恢复),以及浏览器端 diff 封装与 Markdown 渲染。生产环境还应补充飞书租户权限、限流、超大文档与复杂富文本的集成测试。
