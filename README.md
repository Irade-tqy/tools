# Tools — 云剪贴板 + DeepSeek 对话

静态站点（GitHub Pages）+ Supabase 的工具箱，线上地址 **https://irade-tqy.github.io/tools/** 。

- **云剪贴板**：共享模式。密码来自服务端允许列表，验证后拿到临时令牌；所有已验证用户看到同一份内容。文本明文存储，文件在浏览器内用 AES-GCM 加密后再上传。条目默认保留 7 天，访问时顺带清理过期项。
- **DeepSeek 对话**：转发通道（常驻进程 / Edge Function，同一份代码）用 DeepSeek 官网自己的会话协议转发，流式回传；**支持同一个会话继续追问，也可以一键新开会话**。界面显示首字延迟、排队时间、相对上游的额外耗时，以及「已调用工具」标记（官网调了搜索/打开页面时）。
- **后台**：线上默认不显示。只有 URL 带 `?admin=1` 才会出现「后台」标签页（DeepSeek 登录态输入框、队列计数、自托管覆盖项）。

代码是公开的，里面只有**公开值**：Supabase 地址、anon key、Edge Function 名已内置在 `src/lib/defaults.ts`（anon key 本来就是客户端公开凭据，数据边界是 RLS；`tests/defaults.test.ts` 会拦住误提交的非 anon key）。真正的密钥 —— service role key、数据库密码、剪贴板密码、管理令牌、DeepSeek 登录态 —— 不进仓库。

## 当前状态

| 部分 | 状态 |
| --- | --- |
| 数据库（迁移 / RPC / RLS / 限流 / TTL / 登录态 / 转发心跳 / 队列） | 已应用到线上项目，**99 项**端到端检查通过（`npm run test:db`） |
| 单元测试 | **163 项**通过（`npm test`），含录制的 DeepSeek 真实流回放（含上游自己报「服务器暂时不可用」那段）与转发的落库语义 |
| 转发通道（relay） | **已上线**：`tools-relay.service`（systemd user + linger）常驻，**17 项**端到端检查通过（`npm run test:worker`，真实上游 + 真实队列）；**8 项**拔服务演练通过（`npm run test:live:outage`：无人领取时告知用户、排队不丢、重启后补答） |
| Edge Function（Deno） | 代码完成，本地用 Deno 跑通 **23 项**端到端检查（`npm run test:function`）；线上未部署 —— 缺一个 Supabase access token，部署后与常驻 relay 互为备份 |
| 前端（剪贴板 / 对话 / 隐藏后台） | 已上线，真实浏览器 **49 项**检查通过（`npm run test:browser`，含故意乱序投递的块流、上游拒答后同一会话仍能续聊），另有 **39 项**直接打线上站点（`npm run test:live`，含五种登录态字符串格式粘贴、跨设备共享剪贴板、5s 延迟预算、登录态失效演练、手机视口触控尺寸） |
| Pages | **已上线**，push main 即由 Actions 构建发布 |
| CI（干净 runner，不靠这台机器） | **全绿**：生成物校验 + typecheck + 构建 + 单测，加上对真项目的 `db-push` / `db-test` **99/99** 与 Playwright 冒烟 **49/49**（走 session pooler 的 IPv4，见「本地开发」里的 IPv6 说明） |
| DeepSeek 上游 | **已跑通**：登录态已拿到并存进数据库；实测上游首字 ~0.6s、整轮 ~1.2s（见「延迟实测」） |

线上还差的只有一件事：把 `supabase/functions/deepseek-chat` 推上去（`npm run functions:deploy` 或 `gh variable set SUPABASE_DEPLOY --body on`，都需要一个 Supabase 个人访问令牌 `sbp_…`）。**不影响可用性** —— 转发通道已经在跑（见下节）。没 token 时先跑 `npm run functions:deploy -- --dry-run`：它用 `deno check` 校验函数、并报出源码体积（当前 106.8 KB，限额 4 MB），部署前能查的都查完。

## DeepSeek 转发

### 上游协议（逆向结果）

DeepSeek 官网用的不是公开的 `/v1/chat/completions`，而是自己的会话接口（`supabase/functions/_shared/web-client.ts` 按此实现，`tests/web-stream.test.ts` 用录制的真实流回放）：

```
POST /api/v0/chat/create_pow_challenge   {target_path}                 → PoW 挑战
POST /api/v0/chat_session/create         {}                            → chat_session.id
POST /api/v0/chat/completion             {chat_session_id, parent_message_id, prompt,
                                          model_type, thinking_enabled, search_enabled, …}
     header x-ds-pow-response: base64({algorithm,challenge,salt,answer,signature,target_path})
     SSE: event: ready | update_session | title | close + JSON 补丁
```

几个必须踩准的点（都已写成测试）：

- **登录态不在 Cookie 里**，在 `localStorage.userToken`，请求用 `Authorization: Bearer <userToken>`。Cookie 只是可选补充。
- **`chat_session_id` 不能为 null** —— 新会话必须先 `chat_session/create` 拿到 UUID 再发。
- **PoW 必须当场算**：挑战是一次性的，难度 144000。算法是 SHA3-256(`prefix || challenge || 十进制answer`)，直接跑官网那颗 26KB 的 wasm（`scripts/vendor/sha3_wasm_bg.wasm`，零 import，~20ms 解出），由 `scripts/pow-vendor.mjs` 以 base64 内联进函数，`tests/pow.test.ts` 钉住字节哈希和一组真实挑战/答案。
- **一个 RPC 只能有一个签名**：PostgREST 遇到重载直接 PGRST203「无法选出最佳候选」。0006 加宽 `deepseek_ask/claim` 时留了旧签名，凡是省略尾部参数的调用全部失败 —— 线上前端每次都传全参数所以看不出来，dev 脚本的 `drainDeepseekQueue()` 反而把 PGRST203 读成「队列是空的」，积压就此产生（0007 清掉旧签名，`npm run test:db` 里断言没有任何重载）。
- **一条回复由多个 fragment 组成**，类型有 `RESPONSE / THINK / SEARCH / TOOL_SEARCH / TOOL_OPEN / TOOL_FIND / TIP / FILE`。只有 `RESPONSE` 是答案；把全部内容拼起来会把工具噪音混进正文，还会丢每个新 fragment 的首块。
- **`[citation:N]` 按 `cite_index` 查**，不是按数组顺序（官网的 `convertCiteIndexToListIndex` 同理）。前端不渲染引用，只在合适位置显示「已调用工具：网页搜索 · 6 个结果」。
- **`WIP` 是正常终态**（停止或纯工具回答），不能当失败。
- **seq 不能当「已渲染」的水位线用**：同一个客户端由三条通道同时喂（Realtime、轮询兜底、Edge SSE），块会乱序到达。原先 `seq <= lastSeq` 直接丢弃，而订阅建立时 seq 0（工具块）往往已经写完了，于是 seq 1 先到、seq 0 永远不再被提供 —— 线上「已调用工具」标记就此消失。现在按 seq 重排：只应用连续前缀，早到的块进缓冲，游标用 `nextSeq - 1` 向服务端要缺口；终态或缺口 3 轮没补上就 `flushPending` 放尾巴（`tests/chat-reducer.test.ts` 钉住这几种到达顺序）。

### 转发通道（relay）：两个宿主，一份协议

浏览器只做两件事：`deepseek_ask()` 排队，然后从 `deepseek_chunk` 读答案（Realtime，带轮询兜底，SSE 只是加速）。**转发进程不需要被外界访问**，只要有出站 HTTPS —— 所以同一份协议可以跑在两种宿主上，代码都在 `supabase/functions/_shared/relay.ts`：

| 宿主 | 入口 | 状态 |
| --- | --- | --- |
| 常驻进程（node） | `scripts/deepseek-worker.mjs` → `tools-relay.service` | **线上正在服务** |
| Supabase Edge Function（Deno） | `supabase/functions/deepseek-chat/index.ts` | 待部署，部署后自动多一个通道 |

```bash
npm run relay:install    # 写 systemd user unit + enable --now + linger（重启后自己在）
npm run relay:status     # systemctl --user status tools-relay
npm run relay:logs       # .tmp/relay.log 尾部
npm run relay:stop       # 停（前端会明确说「没有通道在领取任务」）
```

转发进程每轮重新读一次数据库里的登录态，所以**换登录态不用重启转发**。

**心跳（0004）**：`deepseek_worker` 表一行一个通道，`deepseek_claim` 本身就是心跳 —— 空队列时也刷新 `seen_at`。`deepseek_health()` 的 `workers_alive` 数的是「30 秒内有心跳的通道」，不是「30 秒内领过活」，所以「空闲」和「没人服务」从此分得开；`workers` 数组（id / kind / turns / 距上次心跳秒数）只在隐藏后台展示。这张表 anon 读不到（revoke 掉了），浏览器只能通过 RPC 看。

### 队列（queue）

`deepseek_job.queue` 把「谁领这条任务」分开：线上转发只吃 `default`，测试套件（`test:db` / `test:worker` / `test:browser`）都往 `test` 排队并只领 `test`。没有这个隔离，线上转发会抢走测试排的任务，拿一次性令牌去打上游然后判失败；有了它，测试和线上转发可以同时跑在同一个 project 上。前端默认 `default`，`#queue=staging` 可以临时切到别的通道；`deepseek_health()` 只统计 `default`，测试队列的积压不会让线上状态条变红。

**落库顺序是硬约束**：`deepseek_chunk` 必须全部写完才能 `deepseek_complete()`。complete 一旦先落地，服务端就把后续 append 判成 `job_done` 丢掉，`done` 帧（会话 id、标题、计时）就永远进不了库 —— 只轮询的客户端于是无法继续同一会话。实测踩过：130 个 chunk 只落了 124 个。现在 `ChunkSink.flush()` 会等齐所有在途写入，单次 append 失败退避重试、只丢那一块（`metrics.chunks_written` / `chunk_stop_reason` 会把它暴露出来），`tests/relay.test.ts` 把这几种情形都钉住了。

### 一个字符串换到所有需要的数据

登录态会过期，所以刷新它不需要重新部署，也不需要再开浏览器：**粘贴一个字符串**，服务端解析出需要的数据、当场向上游验证、然后存库。支持的格式（`supabase/functions/_shared/credential.ts`，浏览器预览 / node 脚本 / Edge Function 用的是同一份代码）：

| 格式 | 例子 |
| --- | --- |
| 规范串 | `dscred1:<base64url(json)>` —— 由下面的命令生成，可复制保存、下次直接粘回来 |
| DevTools | 在 `chat.deepseek.com` 的请求上右键 **Copy as cURL** 整段粘贴（会顺带取出 authorization / x-device-id / cookie / UA，并忽略一次性的 `x-ds-pow-response`） |
| JSON | `{"userToken":"…","deviceId":"…"}`，或 localStorage 导出 |
| key: value | `token: …` / `authorization: Bearer …` / `x-device-id: …` 任意几行 |
| 裸 token | `localStorage.userToken` 的值 |
| 裸 Cookie | `smidV2=…; tfstk=…`（只有 Cookie 时会明确报错：登录态在 userToken 里） |

线上有两条写入路径，都不需要重新部署：

| 路径 | 前置 | 是否向上游校验 |
| --- | --- | --- |
| 隐藏后台页粘贴（Edge Function 已部署时） | `TOOLS_ADMIN_TOKEN` secret | ✓ 先打 `create_pow_challenge` 再存 |
| 隐藏后台页粘贴（Edge Function 未部署时） | `npm run admin:secret` 写入的令牌哈希 | 未校验，下一轮请求的结果会回到状态条 |
| `npm run deepseek:credential` | service role key | ✓ |

后台页存的就是 PostgREST 的 `deepseek_credential_set_admin()`：浏览器用同一份解析代码把字符串拆成 `{token, deviceId, cookie, userAgent}`，令牌只在 RPC 里和 sha256 摘要比对（库里不存明文令牌），猜错 20 次锁 5 分钟。

```bash
# 解析 → 向上游验证 → 写 .env.local → 存进数据库（下一次请求就生效，不用重新部署）
npm run deepseek:credential -- '<上面任意一种>'

# 只看当前可用的字符串 / 服务端状态
npm run deepseek:credential -- --show
npm run deepseek:credential -- --status
```

当前可用的字符串（`npm run deepseek:credential -- --show` 随时可再打印；它不含明文之外的信息，且已验证可用）：

```
dscred1:eyJ0IjoiMUpYQTU2MFFyT3NwdzU4UUdPZXJLYXIxc2txQUF5eW1iS1MyN2M5TThUTDVzYitEeEJPOUdCdWJaRFlVMXlCOSIsInUiOiJNb3ppbGxhLzUuMCAoWDExOyBMaW51eCB4ODZfNjQpIEFwcGxlV2ViS2l0LzUzNy4zNiAoS0hUTUwsIGxpa2UgR2Vja28pIENocm9tZS8xMjYuMC4wLjAgU2FmYXJpLzUzNy4zNiJ9
```

存进数据库后，token 只有 `service_role` 能读（`deepseek_credential_get`），anon 只能看到 `deepseek_credential_status()` 给的粗粒度状态（前 4 位 + 长度 + 更新时间 + 最近错误），前端状态条据此显示「DeepSeek 就绪 / 登录态异常」。

### 会话

DeepSeek 把上下文存在服务端，一个会话就是两个 id：`chat_session_id` + 上一轮的 `response_message_id`。

- **继续同一会话**：请求带上这两个 id（前端存在 `localStorage`，刷新页面也接得上）。
- **新开会话**：不带 id，Edge Function 先建 session 再发（`ready` 事件会回 `request_message_id` / `response_message_id`，`title` 事件会回会话标题）。
- 会话**管理**（多会话列表、改名、切换）暂时不做：界面上只有一个「新会话」按钮和一行「标题 · N 轮」。

`npm run test:function` 会验证这三件事：第二轮能记住第一轮的代号、第二轮携带第一轮产生的 session id 与 parent id、换新会话后不再记得。

## 本地开发

```bash
cp .env.example .env.local && chmod 600 .env.local   # 填 Supabase / 密码 / token
npm install
npm run db:push                                       # 应用 supabase/migrations/*.sql
npm run allowlist 'shared:你的密码'                    # 写入允许列表（bcrypt 在库内计算）
npm run admin:secret                                # 后台页粘贴字符串用的令牌哈希
npm run deepseek:credential -- '<登录字符串>'          # 配 DeepSeek 登录态
npm run dev                                           # http://127.0.0.1:5173
```

**直连 Postgres 只有 IPv6**（`db.<ref>.supabase.co` 公网只发 AAAA）。本机跑得通是因为 Tailscale MagicDNS 把它解析成了 198.18.0.x；GitHub runner 没 IPv6，会直接 `ENETUNREACH`。跳网机器（CI 等）用 session pooler（IPv4）：

```bash
export TOOLS_DB_URL='postgresql://postgres.<ref>:<密码>@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres'
```

CI 里这个值以 `TOOLS_DB_URL` secret 存在，所以 `db-push` / `db-test` 能在干净 runner 上跑真库。

## 测试

```bash
npm test              # 163 项单元测试（credential 解析 / 流回放 / PoW / 转发落库 / reducer / session / api / config / crypto / render）
npm run test:db       # 99 项线上后端端到端（PostgREST + Postgres，跑完会把登录态还原）
npm run test:worker   # 17 项：起一个真转发进程，走真实队列 + 真实上游，验证续聊 / 新会话 / 工具标记 / 心跳
npm run test:function # 23 项：本地用 Deno 跑 Edge Function，打真实 Supabase + 真实 DeepSeek
npm run test:browser  # 49 项浏览器冒烟：内置默认值、上传→加密→下载→解密、会话续聊、上游拒答后仍能续聊、工具标记（块故意后到）、后台隐藏、粘贴登录态
npm run test:live     # 39 项打线上站点：不塞任何桩。真转发 + 真 DeepSeek；五种登录态字符串格式（token / cURL / JSON / key-value / dscred1，以及只粘 Cookie 要被拒）、续聊 / 新会话 / 工具标记 / 跨设备共享剪贴板 / 5s 额外延迟预算 / 登录态失效演练（假 token → 报错 → 换回 → 恢复）/ 390×844 手机视口（无横向滚动、触控目标 ≥44px、输入框 16px 不触发 iOS 缩放）
npm run test:live:outage # 8 项：把转发服务真停掉 —— 健在心跳过期后状态条告知无人领取、排队消息不丢、重启后被补答
npm run test:all      # 全部跑一遍，含线上站点（test:live 与 test:live:outage；后者会把转发服务真停一分钟）
npm run check:generated   # 内置默认值与内联 wasm 是否和 .env.local / vendor 一致

# 冒烟测试也能直接打线上站点：
SMOKE_BASE_URL=https://irade-tqy.github.io/tools node scripts/browser-smoke.mjs
```

`test:db` / `test:browser` 会真的读写线上项目（结束前会清空剪贴板、排空对话队列）。`test:function` 需要本机有 deno（`DENO_BIN=/path/to/deno npm run test:function`）。

## 部署

**Pages**：push main → `Deploy Pages` 工作流跑 `npm run build` → `actions/deploy-pages` 发布 `dist/`。构建用相对路径，换仓库名或子目录都不用改配置。`CI` 工作流在干净 runner 上跑：生成物校验 + typecheck + 构建 + 单测，以及（`LIVE_TESTS` / `BROWSER_TESTS` 已开）对真项目的 `db-push` + `db-test`（**99/99**）和 Playwright 浏览器冒烟（**49/49**）—— 全部在 GitHub 的机器上跑通，不依赖这台开发机。

**转发通道**：`npm run relay:install`（systemd user + linger，重启后自动在；本机单元名 `tools-relay`，`npm run relay:status` / `relay:logs` 看状态）。停掉它前端不会崩，只会明说「没有通道在领取任务」。

**Edge Function**（第二通道，已部署在 `functions/v1/deepseek-chat`，`--no-verify-jwt`；需要 `SUPABASE_ACCESS_TOKEN=sbp_…`，Dashboard → Account → API Keys → Personal access token）：

```bash
npm run secrets:sync        # TOOLS_ADMIN_TOKEN / DEEPSEEK_CREDENTIAL → Supabase secrets
npm run functions:deploy    # 部署 supabase/functions/deepseek-chat；--dry-run = deno check + 体积报告（不需令牌）
```

两条通道跑的是同一套协议实现（`supabase/functions/_shared/`），谁在心跳 `deepseek_health` 就记谁。Edge 通道已验证能在 Deno 里加载 wasm、解 PoW、建会话并领取队列任务；本机转发是它的备份。

登录态本身存在数据库里，所以**轮换登录态不需要重新部署**；只有改函数代码时才要重新 deploy。

线上打开就能用，不需要填任何配置。自托管到别的 Supabase project 时，在后台页（`?admin=1`）填一次 URL + anon key（只存本机），或者把 `public/config.example.js` 复制成 `public/config.js`（被 git 忽略，构建时进 `dist/`），也可以用 `#supabase=…&anon=…` 临时覆盖。改了 `.env.local` 里的 project 后跑 `npm run defaults:sync` 同步内置默认值。

## 结构

```
supabase/migrations/     0001 剪贴板（允许列表 / 令牌 / RLS / 限流 / 7 天 TTL）
                         0002 DeepSeek 队列（job / chunk / Realtime / 指标）
                         0003 登录态入库 + 会话字段 + 会话化 RPC
                         0004 转发心跳（deepseek_worker / deepseek_heartbeat / workers_alive）
                         0005 后台粘贴登录字符串走 PostgREST（tools_secret 摘要 + 猜错限流）
                         0006 命名队列（default = 线上，test = 测试）
                         0007 一个 RPC 一个签名（删掉旧重载：PostgREST 无法重载解析）
supabase/functions/      deepseek-chat（Edge Function 入口：SSE + 凭据动作）
                         _shared/relay.ts         一轮转发的全部流程（Edge 与 node 共用）
                         _shared/credential.ts    一个字符串 → 需要的数据（浏览器/脚本/函数共用）
                         _shared/web-client.ts    官网协议：挑战 / 会话 / completion
                         _shared/web-stream.ts    流解码：fragment 分类 / 工具 / 引用 / 标题
                         _shared/pow.ts + pow-wasm.ts  内联 wasm 解 PoW
src/lib/                 config · api · crypto · sse · chat-reducer · session · render · editor · defaults
src/views/               clipboard · chat · admin（后台，?admin=1 才显示）
scripts/                 db-push · db-test · worker-test · allowlist · function-local · browser-smoke ·
                         browser-relay · relay-service（systemd 常驻转发）· deepseek-worker（常驻转发）·
                         admin-secret（管理令牌哈希）· live-smoke（打线上站点的端到端）·
                         deepseek-credential（登录字符串入口）· deepseek-pow-node（命令行跑上游）·
                         pow-vendor · defaults-sync · secrets-sync · functions-deploy · pages-*
tests/                   vitest 单元测试 + tests/fixtures/stream-*.txt（录制的真实上游流）
```

## 安全模型

- **公开值与密钥分界**：URL + anon key + 函数名内置在 `src/lib/defaults.ts`，`tests/defaults.test.ts` 解码 JWT 断言 `role === 'anon'`、ref 与 URL 一致，并拦住文件里出现任何非 anon 的 JWT 或密钥字样。
- **DeepSeek 登录态**：存在 `public.deepseek_credential`（单行，RLS 开启且无策略 → anon 一行都读不到），只有 `service_role` 能调 `deepseek_credential_get/set/report`（Supabase 的 schema 默认权限会把 EXECUTE 授给 anon/authenticated，所以迁移里显式 revoke）。前端只拿到 `token_hint`（前 4 位 + 长度）。
- **后台入口**：`?admin=1` 只是显示开关，真正的门是 `TOOLS_ADMIN_TOKEN`（常量时间比较）；没配这个 secret 时后台的写操作直接返回 501。
- **允许列表 / 令牌 / 限流**：`clipboard_secret` 存 bcrypt；`clipboard_verify` 发 256 位随机令牌，库里只存 sha256；同一密码 15 分钟最多 10 次失败，全局 5 分钟最多 120 次，失败记录只存 `sha256(密码|日期)`。
- **RLS**：剪贴板四张表全部开启 RLS 且没有策略，写操作只能走 `SECURITY DEFINER` 的 RPC；`deepseek_job` / `deepseek_chunk` 允许 anon 读（Realtime 的 RLS 授权需要），写仍只能走 RPC。
- **转发心跳**：`deepseek_worker` 只有 `service_role` 能 select，EXECUTE 只给 RPC，浏览器读不到表本身（`npm run test:db` 里断言 401/403）。
- **文件**：PBKDF2-SHA256/150000 派生 AES-256-GCM 密钥，IV 与 salt 每条随机；库里只有密文。换密码后旧文件解不开，这是设计而非 bug。
- **限流**：对话全局 1 分钟最多 20 条、同时在飞最多 10 条；worker 卡死 3 分钟自动回队。

## 延迟实测

约定是「相对官网额外耗时 ≤ 5s」，实现方式是把测量做进链路：Edge Function 上报 `upstream_ttft_ms` / `upstream_total_ms` / `pow_and_connect_ms`，服务端记 `claimed_at` / `first_chunk_at` / `finished_at`，前端 `latencyOf()` 算 `额外 = 本站首字 − 上游首字`，超 5s 在状态条标警告；`deepseek_health()` 还会给出近 1 小时的 `median_ttft_ms`。

实测（本机 → 上游，`npm run deepseek:upstream`）：

| 场景 | 建会话 | 上游首字 | 整轮 |
| --- | --- | --- | --- |
| 普通回答 | 195ms | 587ms | 1.16s |
| 联网搜索（6 个结果） | — | ~0.9s | 2.3s |
| 专家模式（多轮工具，61 个结果） | — | ~3.1s | 5.4s |

浏览器侧（含排队与 Realtime）在 `npm run test:browser` 里断言：状态行必须出现「首字 / 排队 / 额外」三段计时。
