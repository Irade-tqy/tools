# Tools — 云剪贴板 + DeepSeek 对话

静态站点（GitHub Pages）+ Supabase 的工具箱：

- **云剪贴板**：共享模式。密码来自服务端允许列表，验证后拿到临时令牌；所有已验证用户看到同一份内容。文本明文存储，文件在浏览器内用 AES-GCM 加密后再上传。条目默认保留 7 天，访问时顺带清理过期项。
- **DeepSeek 对话**：消息进入队列，由两条通道之一领取并流式回传 —— Edge Function（凭据存在 Supabase secret 里），或一个**已登录 DeepSeek 的浏览器标签页**（跑 `deepseek-worker.js`）。界面实时显示首字延迟、排队时间与“相对官网额外耗时”。

代码是公开的，**仓库里没有任何密钥、Cookie 或凭据**：Supabase 地址与 anon key 存在本机浏览器（或自托管的 `config.js`），DeepSeek 凭据存在 Supabase secret / Vault。

## 当前状态

| 部分 | 状态 |
| --- | --- |
| 数据库结构 / RPC / RLS / 限流 | 已应用到线上项目，60 项端到端检查通过（`npm run test:db`） |
| 前端（剪贴板 / 对话 / 设置） | 已构建，真实浏览器 21 项检查通过（`npm run test:browser`） |
| 单元测试 | 101 项通过（`npm test`） |
| Pages 部署 | **已上线** https://irade-tqy.github.io/tools/ ，21 项浏览器检查直接跑在线上站点 |
| DeepSeek 通道 | 代码与回退路径已就绪；**等待登录态/密钥**，尚未跑通真实上游 |

线上当前状态：`/functions/v1/deepseek-chat` 返回 404（未部署，缺 Supabase access token），前端会自动退到队列 + 浏览器 worker 路线 —— 这条路线已被上面的浏览器检查覆盖（模拟通道领取任务并流式回传）。

DeepSeek 那一步之所以还没验证，是因为机器上没有可用的 DeepSeek 登录会话；一旦拿到 Cookie 或 API key：

```bash
# 方式 A：官方 API key（最稳）
echo 'DEEPSEEK_API_KEY=sk-...' >> .env.local
# 方式 B：网页登录态 Cookie
echo 'DEEPSEEK_WEB_COOKIE=<cookie 头>' >> .env.local

npm run secrets:sync        # 推到 Supabase secret
npm run functions:deploy    # 部署 Edge Function
```

没有服务端凭据时，在**已登录 chat.deepseek.com 的标签页**里粘贴设置页复制的 worker 代码即可（同源请求才能带上登录 Cookie）。

## 本地开发

```bash
cp .env.example .env.local && chmod 600 .env.local   # 填 Supabase / 密码 / token
npm install
npm run db:push                                       # 应用 supabase/migrations/*.sql
npm run allowlist 'shared:你的密码'                    # 写入允许列表（bcrypt 在库内计算）
npm run dev                                           # http://127.0.0.1:5173
```

## 测试

```bash
npm test              # 101 项单元测试（crypto / sse / reducer / api / config / render）
npm run test:db       # 60 项线上后端端到端（PostgREST + Postgres）
npm run test:browser  # 21 项浏览器冒烟：上传→加密→下载→解密、对话流式、令牌恢复
npm run test:all      # 三个跑一遍

# 冒烟测试也能直接打线上站点：
SMOKE_BASE_URL=https://irade-tqy.github.io/tools node scripts/browser-smoke.mjs
```

`test:db` / `test:browser` 会真的读写线上项目（结束前会清空剪贴板、排空对话队列）。

## 部署

当前站点用 `npm run pages:publish` 发布：本地 `npm run build` 后把 `dist/` 强推到 `gh-pages` 分支，Pages 以 classic 模式从该分支构建。之所以先走这条路，是因为仓库现在的 fine-grained PAT 没有 **Workflows** 权限，推 `.github/workflows/*` 会被拒（`refusing to allow a Personal Access Token to create or update workflow … without 'workflow' scope`）。

拿到带 Workflows 权限的 token 后：

```bash
git push origin main                 # 把最后那个 “Add CI and Pages workflows” 提交推上去
node scripts/pages-deploy.mjs        # 把 Pages 切成 workflow 构建模式
```

之后每次 push main 由 Actions 构建并发布；`dist/` 用相对路径构建，换仓库名或子目录都不用改配置。

线上首次打开时，设置页填一次 Supabase URL + anon key 即可（只存本机）。想省掉这步，就把 `public/config.example.js` 复制成 `public/config.js` 填好——它被 git 忽略，构建时会一起进 `dist/`。

## 结构

```
supabase/migrations/     0001 剪贴板（允许列表 / 令牌 / RLS / 限流 / 7 天 TTL）
                         0002 DeepSeek 队列（job / chunk / Realtime / 指标）
supabase/functions/      deepseek-chat（Edge Function）+ _shared 纯函数（可被 vitest 直接测）
src/lib/                 config · api · crypto · sse · chat-reducer · render · editor
src/views/               clipboard · chat · settings
public/deepseek-worker.js 零依赖浏览器 worker（登录态标签页里跑）
scripts/                 db-push · db-test · allowlist · browser-smoke · secrets-sync ·
                         functions-deploy · pages-publish · pages-deploy
tests/                   vitest 单元测试
```

## 安全模型

- **允许列表**：`clipboard_secret.pw_hash` 存 bcrypt（`crypt()` 在库内计算）。明文密码只在 `.env.local` 和浏览器内存里。
- **令牌**：`clipboard_verify` 发 256 位随机令牌，库里只存 sha256；后续请求带 `x-clipboard-token` 头。默认 12 小时过期。
- **限流**：同一密码 15 分钟内最多 10 次失败，全局 5 分钟最多 120 次失败；失败记录只存 `sha256(密码|日期)`，不存明文。
- **RLS**：四张剪贴板表全部开启 RLS 且**没有策略**，anon/authenticated 也没有表权限 —— 唯一入口是 `SECURITY DEFINER` 的 RPC。
- **文件**：PBKDF2-SHA256/150000 从密码派生 AES-256-GCM 密钥，IV 与 salt 每条随机；数据库里只有密文（`npm run test:db` 会断言明文不在字节流里）。换密码后旧文件解不开，这是设计而非 bug。
- **对话**：`deepseek_job` / `deepseek_chunk` 允许 anon 读（Realtime 的 RLS 授权需要），写仍然只能走 RPC。
- **Cookie**：只存在于 Supabase secret 或用户自己的浏览器里，不进仓库、不进前端代码、不进日志。

## 延迟目标

约定是“相对官网额外耗时 ≤ 5s”。实现方式是把测量做进链路：worker / Edge Function 上报 `upstream_ttfb_ms`、`upstream_ttft_ms`、`upstream_total_ms`，服务端记录 `claimed_at` / `first_chunk_at` / `finished_at`，前端 `latencyOf()` 计算 `额外 = 本站首字 − 上游首字`，超过 5s 会在状态条里标警告。真实数字要等 DeepSeek 通道跑通后看对话页的状态行。
