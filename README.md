# Tools — 云剪贴板 + DeepSeek 对话

静态站点（GitHub Pages）+ Supabase 的工具箱，线上地址 **https://irade-tqy.github.io/tools/** 。

- **云剪贴板**：共享模式。密码来自服务端允许列表，验证后拿到临时令牌；所有已验证用户看到同一份内容。文本明文存储，文件在浏览器内用 AES-GCM 加密后再上传。条目默认保留 7 天，访问时顺带清理过期项。
- **DeepSeek 对话**：Edge Function 用 DeepSeek 官网自己的会话协议转发，流式回传；**支持同一个会话继续追问，也可以一键新开会话**。界面显示首字延迟、排队时间、相对上游的额外耗时，以及「已调用工具」标记（官网调了搜索/打开页面时）。
- **后台**：线上默认不显示。只有 URL 带 `?admin=1` 才会出现「后台」标签页（DeepSeek 登录态输入框、队列计数、自托管覆盖项）。

代码是公开的，里面只有**公开值**：Supabase 地址、anon key、Edge Function 名已内置在 `src/lib/defaults.ts`（anon key 本来就是客户端公开凭据，数据边界是 RLS；`tests/defaults.test.ts` 会拦住误提交的非 anon key）。真正的密钥 —— service role key、数据库密码、剪贴板密码、管理令牌、DeepSeek 登录态 —— 不进仓库。

## 当前状态

| 部分 | 状态 |
| --- | --- |
| 数据库（迁移 / RPC / RLS / 限流 / TTL / 登录态存储） | 已应用到线上项目，**79 项**端到端检查通过（`npm run test:db`） |
| 单元测试 | **145 项**通过（`npm test`），含录制的 DeepSeek 真实流回放 |
| Edge Function（Deno） | 代码完成，本地用 Deno 跑通 **23 项**端到端检查（`npm run test:function`）；**线上未部署** —— 缺一个 Supabase access token |
| 前端（剪贴板 / 对话 / 隐藏后台） | 已上线，真实浏览器 **37 项**检查通过（`npm run test:browser`） |
| Pages | **已上线**，push main 即由 Actions 构建发布 |
| DeepSeek 上游 | **已跑通**：登录态已拿到并存进数据库；实测上游首字 ~0.6s、整轮 ~1.2s（见「延迟实测」） |

线上唯一没做的事：把 `supabase/functions/deepseek-chat` 推上去（`npm run functions:deploy` 需要一个 Supabase 个人访问令牌 `sbp_…`）。在它部署之前，线上打开站点仍然能用剪贴板；DeepSeek 对话会排队等待通道。

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
- **一条回复由多个 fragment 组成**，类型有 `RESPONSE / THINK / SEARCH / TOOL_SEARCH / TOOL_OPEN / TOOL_FIND / TIP / FILE`。只有 `RESPONSE` 是答案；把全部内容拼起来会把工具噪音混进正文，还会丢每个新 fragment 的首块。
- **`[citation:N]` 按 `cite_index` 查**，不是按数组顺序（官网的 `convertCiteIndexToListIndex` 同理）。前端不渲染引用，只在合适位置显示「已调用工具：网页搜索 · 6 个结果」。
- **`WIP` 是正常终态**（停止或纯工具回答），不能当失败。

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
npm run deepseek:credential -- '<登录字符串>'          # 配 DeepSeek 登录态
npm run dev                                           # http://127.0.0.1:5173
```

## 测试

```bash
npm test              # 145 项单元测试（credential 解析 / 流回放 / PoW / reducer / session / api / config / crypto / render）
npm run test:db       # 79 项线上后端端到端（PostgREST + Postgres，跑完会把登录态还原）
npm run test:function # 23 项：本地用 Deno 跑 Edge Function，打真实 Supabase + 真实 DeepSeek
npm run test:browser  # 37 项浏览器冒烟：内置默认值、上传→加密→下载→解密、会话续聊、工具标记、后台隐藏
npm run test:all      # 全部跑一遍
npm run check:generated   # 内置默认值与内联 wasm 是否和 .env.local / vendor 一致

# 冒烟测试也能直接打线上站点：
SMOKE_BASE_URL=https://irade-tqy.github.io/tools node scripts/browser-smoke.mjs
```

`test:db` / `test:browser` 会真的读写线上项目（结束前会清空剪贴板、排空对话队列）。`test:function` 需要本机有 deno（`DENO_BIN=/path/to/deno npm run test:function`）。

## 部署

**Pages**：push main → `Deploy Pages` 工作流跑 `npm run build` → `actions/deploy-pages` 发布 `dist/`。构建用相对路径，换仓库名或子目录都不用改配置。`CI` 工作流跑 typecheck + 构建 + 单测 + 生成物校验（线上测试用仓库变量 `LIVE_TESTS` / `BROWSER_TESTS` 开关）。

**Edge Function**（需要 `SUPABASE_ACCESS_TOKEN=sbp_…`，Dashboard → Account → API Keys → Personal access token）：

```bash
npm run secrets:sync        # TOOLS_ADMIN_TOKEN / DEEPSEEK_CREDENTIAL → Supabase secrets
npm run functions:deploy    # 部署 supabase/functions/deepseek-chat（--no-verify-jwt）
```

登录态本身存在数据库里，所以**轮换登录态不需要重新部署**；只有改函数代码时才要重新 deploy。

线上打开就能用，不需要填任何配置。自托管到别的 Supabase project 时，在后台页（`?admin=1`）填一次 URL + anon key（只存本机），或者把 `public/config.example.js` 复制成 `public/config.js`（被 git 忽略，构建时进 `dist/`），也可以用 `#supabase=…&anon=…` 临时覆盖。改了 `.env.local` 里的 project 后跑 `npm run defaults:sync` 同步内置默认值。

## 结构

```
supabase/migrations/     0001 剪贴板（允许列表 / 令牌 / RLS / 限流 / 7 天 TTL）
                         0002 DeepSeek 队列（job / chunk / Realtime / 指标）
                         0003 登录态入库 + 会话字段 + 会话化 RPC
supabase/functions/      deepseek-chat（Edge Function 入口）
                         _shared/credential.ts    一个字符串 → 需要的数据（浏览器/脚本/函数共用）
                         _shared/web-client.ts    官网协议：挑战 / 会话 / completion
                         _shared/web-stream.ts    流解码：fragment 分类 / 工具 / 引用 / 标题
                         _shared/pow.ts + pow-wasm.ts  内联 wasm 解 PoW
src/lib/                 config · api · crypto · sse · chat-reducer · session · render · editor · defaults
src/views/               clipboard · chat · admin（后台，?admin=1 才显示）
scripts/                 db-push · db-test · allowlist · function-local · browser-smoke · browser-relay ·
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
