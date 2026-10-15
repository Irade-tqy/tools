#!/usr/bin/env node
// Browser smoke test: serves dist/ over http, drives the built app with Playwright, and
// plays the role of a DeepSeek transport (claim → stream chunks → complete) so the whole
// path — PostgREST, Realtime/polling, the chat reducer and the UI — is exercised.
//
//   npm run build && node scripts/browser-smoke.mjs
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { anonKey, clearDeepseekBacklog, env, rpc as rpcLib, serviceRoleKey, supabaseUrl } from './lib.mjs';

const DIST = resolve(process.cwd(), 'dist');
const PORT = Number(process.env.SMOKE_PORT || 4178);
// Point at a deployed site instead of serving dist/ locally:
//   SMOKE_BASE_URL=https://<user>.github.io/tools/ node scripts/browser-smoke.mjs
const BASE_URL = (process.env.SMOKE_BASE_URL || '').trim().replace(/\/+$/, '');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

function serveDist() {
  return new Promise((resolveServer) => {
    const server = createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
      let file = normalize(join(DIST, urlPath));
      if (file.endsWith('/')) file = join(file, 'index.html');
      if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) {
        // Only the app shell gets the SPA fallback; a missing asset must 404 so an optional
        // script (config.js) fails cleanly instead of being parsed as HTML.
        if (urlPath !== '/' && !urlPath.endsWith('.html')) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('not found');
          return;
        }
        file = join(DIST, 'index.html');
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      createReadStream(file).pipe(res);
    });
    server.listen(PORT, '127.0.0.1', () => resolveServer(server));
  });
}

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : `\n        ${String(detail).slice(0, 400)}`}`);
}

function password() {
  const first = (env.TOOLS_CLIPBOARD_PASSWORDS || '').split(',')[0]?.trim() || '';
  const at = first.indexOf(':');
  if (!first) throw new Error('TOOLS_CLIPBOARD_PASSWORDS is empty');
  return at > 0 ? first.slice(at + 1) : first;
}

// ---- fake DeepSeek transport (stands in for the edge function / logged-in tab) -------
const RPC = `${supabaseUrl}/rest/v1/rpc/`;
async function rpc(fn, args) {
  const res = await fetch(`${RPC}${fn}`, {
    method: 'POST',
    headers: { apikey: anonKey(), Authorization: `Bearer ${anonKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  return res.json();
}

/**
 * Stand in for the Edge Function: claim whatever the UI queued and append the same
 * normalized chunks the real relay sends (v1 text / tool / done frames), then complete the
 * job with the conversation ids so the UI can continue the session.
 */
async function fakeTransport({ respondWith, abortOnSeq, sessionId, replyMessageId, withTool, outOfOrderTool, failWith }) {
  const workerId = `smoke-${Math.random().toString(36).slice(2, 8)}`;
  const started = Date.now();
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const claim = await rpc('deepseek_claim', { p_worker_id: workerId, p_queue: 'test' });
    if (!claim.claimed) {
      await new Promise((r) => setTimeout(r, 150));
      continue;
    }
    const pieces = respondWith.match(/.{1,3}/gu) || [];
    const toolPayload = withTool
      ? {
          v: 1,
          _transport: 'smoke',
          tool: {
            id: 1,
            type: 'SEARCH',
            status: 'FINISHED',
            label: '搜索到 2 个网页',
            queries: ['上海天气'],
            results: [
              { cite_index: 1, title: '气象台', url: 'https://a.example', site_name: 'a.example', snippet: '晴' },
              { cite_index: 2, title: '天气网', url: 'https://b.example', site_name: 'b.example', snippet: '多云' },
            ],
            page: null,
          },
        }
      : null;
    // The live race, made deterministic: the browser subscribes after the relay writes the first
    // chunk, so the tool payload (seq 0) can reach it last. Writing seq 0 last reproduces that
    // ordering on every run instead of waiting for the race to happen by luck.
    let seq = toolPayload && outOfOrderTool ? 1 : 0;
    const append = async (payload, atSeq) => {
      const use = atSeq ?? seq;
      const out = await rpc('deepseek_append', { p_job_id: claim.job_id, p_seq: use, p_payload: payload });
      if (atSeq == null) seq += 1;
      return out;
    };
    if (toolPayload && !outOfOrderTool) await append(toolPayload);
    for (const piece of pieces) {
      await new Promise((r) => setTimeout(r, 40));
      const out = await append({ v: 1, _transport: 'smoke', text: piece });
      if (!out.ok && abortOnSeq != null && seq >= abortOnSeq) return { job_id: claim.job_id, cancelled: true, seq, claim };
    }
    if (toolPayload && outOfOrderTool) await append(toolPayload, 0);
    if (failWith) {
      // A turn the upstream refused: the relay still learns which DeepSeek conversation it
      // tried to join, and the next turn has to continue that same one.
      await append({
        v: 1,
        _transport: 'smoke',
        done: true,
        ok: false,
        error: failWith,
        job_id: claim.job_id,
        session_id: sessionId ?? `sess-${workerId}`,
      });
      await rpc('deepseek_complete', {
        p_job_id: claim.job_id,
        p_ok: false,
        p_error: failWith,
        p_metrics: { upstream_total_ms: Date.now() - started, transport: 'smoke' },
        p_session_id: sessionId ?? `sess-${workerId}`,
      });
      return { job_id: claim.job_id, seq, failed: true, claim };
    }
    await append({
      v: 1,
      _transport: 'smoke',
      done: true,
      ok: true,
      job_id: claim.job_id,
      session_id: sessionId ?? `sess-${workerId}`,
      reply_message_id: replyMessageId ?? 7,
      title: '冒烟测试会话',
      mode: withTool ? 'DEEP_SEARCH' : 'DEFAULT',
      search_triggered: Boolean(withTool),
      token_usage: 128,
      citations: [],
    });
    await rpc('deepseek_complete', {
      p_job_id: claim.job_id,
      p_ok: true,
      p_metrics: { upstream_ttft_ms: 700, upstream_total_ms: Date.now() - started, transport: 'smoke' },
      p_session_id: sessionId ?? `sess-${workerId}`,
      p_reply_message_id: replyMessageId ?? 7,
    });
    return { job_id: claim.job_id, seq, delivered: respondWith, claim };
  }
  return { error: 'never claimed' };
}

async function launchChromium(chromium) {
  // Prefer a Playwright-managed build; fall back to a system Chrome/Chromium so the smoke
  // test still runs on machines that have not downloaded Playwright browsers.
  const candidates = [
    process.env.PLAYWRIGHT_BROWSER_PATH,
    undefined,
    '/usr/bin/google-chrome',
    '/snap/bin/chromium',
  ].filter((v, i) => (i === 1 ? true : v !== undefined));
  let lastError;
  for (const executablePath of candidates) {
    try {
      return await chromium.launch(executablePath ? { executablePath } : undefined);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

// ---- the test ------------------------------------------------------------------------
let server;
let browser;

try {
  if (!BASE_URL && !existsSync(join(DIST, 'index.html'))) {
    throw new Error('dist/index.html not found — run `npm run build` first (or set SMOKE_BASE_URL)');
  }
  const { chromium } = await import('playwright');
  server = BASE_URL ? null : await serveDist();
  const origin = BASE_URL ? `${BASE_URL}/` : `http://127.0.0.1:${PORT}/`;

  const marker = `smoke-${Date.now()}`;
  const fileMarker = `file-secret-${Date.now()}`;
  const answerText = '收到，这是模拟通道的流式回答。';
  const secondAnswer = '继续同一会话的回复';

  const drained = await clearDeepseekBacklog({ workerId: 'smoke-setup' });
  check(`the deepseek queue starts empty (cleared ${drained.closed} stale + ${drained.drained} queued job(s))`, true);

  // Start from an empty shared clipboard so list assertions are unambiguous.
  const boot = await rpc('clipboard_verify', { p_password: password(), p_ttl_seconds: 600 });
  if (boot.ok && boot.token) {
    const res = await fetch(`${RPC}clipboard_clear`, {
      method: 'POST',
      headers: {
        apikey: anonKey(),
        Authorization: `Bearer ${anonKey()}`,
        'Content-Type': 'application/json',
        'x-clipboard-token': boot.token,
      },
      body: '{}',
    });
    check('the shared clipboard starts empty', res.ok, `clear HTTP ${res.status}`);
  } else {
    check('the shared clipboard starts empty', false, JSON.stringify(boot));
  }

  const tmpFile = `/tmp/tools-smoke-${Date.now()}.txt`;
  const { writeFileSync, rmSync } = await import('node:fs');
  writeFileSync(tmpFile, fileMarker);

  browser = await launchChromium(chromium);
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  // Queue the smoke run's turns to 'test': the production relay serves 'default' and must
  // not claim them (its DeepSeek token would reject the stub prompt).
  await context.addInitScript(() => {
    window.TOOLS_CONFIG = { ...(window.TOOLS_CONFIG || {}), queue: 'test' };
  });
  const page = await context.newPage();
  const pageErrors = [];
  const httpErrors = [];
  const rpcCalls = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  if (process.env.SMOKE_CONSOLE) page.on('console', (m) => { if (/FINISH/.test(m.text())) console.log('[console]', m.text()); });
  page.on('response', (res) => {
    // config.js is optional by design; its 404 must not count as a failure.
    if (res.status() >= 400 && !res.url().endsWith('/config.js')) {
      httpErrors.push(`${res.status()} ${res.url().replace(supabaseUrl, '<supabase>')}`);
    }
  });
  page.on('request', (req) => {
    if (req.url().includes('/rpc/')) rpcCalls.push(req.url().split('/rpc/')[1]);
  });

  // Precedence check first: a hash override must beat the baked-in defaults.
  await page.goto(`${origin}index.html#supabase=https%3A%2F%2Fbogus.supabase.co&anon=short`, {
    waitUntil: 'load',
  });
  await page.waitForTimeout(600);
  const bogusStatus = (await page.textContent('#status-text')) || '';
  check('a URL-hash override replaces the baked-in defaults', /未配置/.test(bogusStatus), bogusStatus);
  check(
    'an unconfigured visitor is never sent to the backend page',
    !(await page.isVisible('#view-admin.is-active')) && !(await page.isVisible('.tab[data-view=admin]')),
    await page.textContent('#status-text'),
  );

  // The real run uses the defaults committed in src/lib/defaults.ts — no setup, no hash.
  await page.goto(`${origin}index.html`, { waitUntil: 'load' });

  check('the app loads without page errors or failing requests', pageErrors.length === 0 && httpErrors.length === 0, [...pageErrors, ...httpErrors].join('\n'));
  check('works with the baked-in defaults (no setup screen)', await page.isVisible('#clipboard-gate'));

  // --- clipboard: unlock, save text, list it
  await page.fill('#password-input', 'wrong-password-on-purpose');
  await page.click('#unlock-form button[type=submit]');
  await page.waitForSelector('#unlock-error:not([hidden])', { timeout: 10_000 });
  check('a wrong password shows an inline error', (await page.textContent('#unlock-error')).includes('允许列表'));

  await page.fill('#password-input', password());
  await page.click('#unlock-form button[type=submit]');
  await page.waitForSelector('#clipboard-work:not([hidden])', { timeout: 15_000 });
  await page.waitForSelector('.cm-editor', { timeout: 20_000 });
  check('the correct password unlocks the editor', true);

  await page.click('.cm-content');
  await page.keyboard.type(`第一行 ${marker}`);
  await page.fill('#entry-title', 'smoke title');
  const transport = fakeTransport({ respondWith: answerText, sessionId: 'sess-smoke-1', replyMessageId: 7 });
  await page.click('#save-text');
  await page.waitForSelector('.entry__body', { timeout: 15_000 });
  const listed = await page.textContent('#entry-list');
  check('the saved text appears in the shared list', listed.includes(marker), listed);
  check('the entry shows its expiry deadline', /天后到期/.test(listed), listed);

  // --- clipboard: encrypted upload + download/decrypt
  await page.setInputFiles('#file-input', tmpFile);
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('.entry')).some((e) => e.textContent.includes('tools-smoke')),
    { timeout: 25_000 },
  );
  const listAfterUpload = await page.textContent('#entry-list');
  check('the uploaded file is listed as a file entry', listAfterUpload.includes('文件') && listAfterUpload.includes('tools-smoke'), listAfterUpload);

  const downloadPromise = page.waitForEvent('download', { timeout: 25_000 });
  await page.click('.entry:has(.badge--file) [data-action=download]');
  const download = await downloadPromise;
  const suggested = download.suggestedFilename();
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const part of stream) chunks.push(part);
  const downloaded = Buffer.concat(chunks).toString('utf8');
  check('an uploaded file round-trips through AES-GCM', downloaded === fileMarker, `${suggested}: ${downloaded}`);

  // --- chat: queue, stream from a simulated transport, render latency
  await page.click('.tab[data-view=chat]');
  const sessionLabel = (await page.textContent('#chat-session')) || '';
  check('a fresh chat says it will open a new conversation', /新会话/.test(sessionLabel), sessionLabel);
  check('the new-session button starts disabled', await page.isDisabled('#chat-new-session'), sessionLabel);
  await page.fill('#chat-input', '你好，测试一下');
  await page.click('#chat-send');
  await page.waitForSelector('.msg--assistant', { timeout: 10_000 });
  const transportResult = await transport;
  check('the fake transport claimed and streamed the job', transportResult.seq > 0, transportResult);
  await page
    .waitForFunction(
      (expected) => {
        const node = document.querySelector('.msg--assistant');
        return Boolean(node && node.textContent.includes(expected));
      },
      answerText,
      { timeout: 25_000 }
    )
    .catch(async () => {
      const assistant = await page.locator('.msg--assistant').first().textContent().catch(() => null);
      const status = await page.textContent('#chat-status').catch(() => '');
      throw new Error(
        `the streamed answer never rendered\n  assistant: ${JSON.stringify(assistant)}\n  status: ${JSON.stringify(status)}\n  rpc calls: ${JSON.stringify(rpcCalls.slice(-14))}`,
      );
    });
  check('the streamed answer renders in the chat log', true);
  // The transport reports its own timings when it completes the job; wait for that.
  await page.waitForFunction(
    () => {
      const meta = document.querySelector('.msg--assistant .msg__meta');
      return Boolean(meta && meta.textContent.length > 0);
    },
    { timeout: 20_000 },
  );
  // the transport's own timings land with the job's metrics, which can trail the last chunk
  await page
    .waitForFunction(() => /额外/.test(document.getElementById('chat-status')?.textContent || ''), { timeout: 15_000 })
    .catch(() => {});
  const statusText = (await page.textContent('#chat-status')) || '';
  check('latency accounting is shown', /首字/.test(statusText) && /额外/.test(statusText), statusText);
  const metaText = (await page.textContent('.msg--assistant .msg__meta')) || '';
  check('the finished answer carries its metrics', /总/.test(metaText), metaText);

  // --- chat: the turn's conversation ids land in the session bar
  await page.waitForFunction(() => !/新会话/.test(document.getElementById('chat-session')?.textContent || ''), {
    timeout: 20_000,
  });
  const afterTurn = (await page.textContent('#chat-session')) || '';
  check('the session bar shows the live conversation', /1 轮/.test(afterTurn), afterTurn);
  check(
    'the answer is stored with the conversation for the next turn',
    await page.evaluate(() => {
      const raw = localStorage.getItem('tools.chat.session.v1');
      if (!raw) return false;
      const saved = JSON.parse(raw);
      return Boolean(saved.dsSessionId) && saved.parentId === '7' && saved.turns.length >= 2;
    }),
    afterTurn,
  );

  // --- chat: a second turn continues the same conversation (the transport sees its ids)
  // The tool payload is written with seq 0 but last, so the browser has to reorder the stream:
  // with a high-water-mark dedupe the chip below disappears (the bug that shipped).
  const transport2 = fakeTransport({
    respondWith: secondAnswer,
    sessionId: 'sess-continued',
    replyMessageId: 9,
    withTool: true,
    outOfOrderTool: true,
  });
  await page.fill('#chat-input', '第二句');
  await page.click('#chat-send');
  await page.waitForFunction(() => document.querySelectorAll('.msg--user').length >= 2, { timeout: 15_000 });
  const userCount = await page.locator('.msg--user').count();
  check('the conversation keeps earlier turns', userCount >= 2, `user messages: ${userCount}`);
  const first = await transport;
  const second = await transport2;
  // turn 1 had no session when it was queued (the relay creates it), so the proof of
  // continuation is turn 2 arriving with the id turn 1's answer produced.
  check('the first turn is queued with no session id', !first.claim?.session_id, first.claim?.session_id);
  check('the next turn is queued against the session the first turn created', second.claim?.session_id === 'sess-smoke-1', {
    first: first.claim?.session_id,
    second: second.claim?.session_id,
  });
  check('the queued turn carries the previous reply as its parent', second.claim?.parent_message_id === '7', second.claim);
  await page.waitForFunction(
    (expected) => Boolean(document.querySelector('.msg--assistant:last-of-type')?.textContent.includes(expected)),
    secondAnswer,
    { timeout: 25_000 },
  );
  check('the continued answer renders', true);
  const chip = (await page.textContent('.chip--tool')) || '';
  check('a tool-using turn shows a "已调用工具" chip even when its chunk arrives last', /已调用工具/.test(chip) && /网页搜索/.test(chip), chip);
  const continuedBody = (await page.textContent('.msg--assistant:last-of-type .msg__body')) || '';
  check('an out-of-order stream renders complete and in order', continuedBody === secondAnswer, continuedBody.slice(0, 160));

  // --- chat: 新会话 drops the conversation
  await page.evaluate(() => {
    window.confirm = () => true;
  });
  await page
    .waitForFunction(() => !document.getElementById('chat-new-session')?.disabled, { timeout: 15_000 })
    .catch(async () => {
      const detail = await page.evaluate(() => ({
        status: document.getElementById('chat-status')?.textContent,
        send: document.getElementById('chat-send')?.disabled,
        session: document.getElementById('chat-session')?.textContent,
      }));
      throw new Error(`the composer stayed busy: ${JSON.stringify(detail)}`);
    });
  await page.click('#chat-new-session');
  await page.waitForFunction(() => document.querySelectorAll('.msg').length === 0, { timeout: 10_000 });
  const clearedSession = (await page.textContent('#chat-session')) || '';
  check('新会话 clears the transcript', /新会话 · 0 轮/.test(clearedSession), clearedSession);
  check(
    '新会话 drops the DeepSeek ids so the next turn starts over',
    await page.evaluate(() => {
      const raw = localStorage.getItem('tools.chat.session.v1');
      if (!raw) return true;
      const saved = JSON.parse(raw);
      return !saved.dsSessionId && !saved.parentId && saved.turns.length === 0;
    }),
    clearedSession,
  );

  // --- a turn the upstream refuses must not cost the user the conversation
  // DeepSeek spends whole hours answering "服务器暂时不可用", so the failure path is the normal
  // path some days: the reason has to reach the user, the failed turn has to stay visible, and
  // the next turn has to continue the same DeepSeek conversation instead of starting a new one.
  const failTransport = fakeTransport({
    respondWith: '',
    sessionId: 'sess-after-fail',
    replyMessageId: 21,
    failWith: '服务器暂时不可用（backend_err）',
  });
  await page.fill('#chat-input', '这一轮会被上游拒绝');
  await page.click('#chat-send');
  await page
    .waitForFunction(() => /错误/.test(document.querySelector('.msg--assistant:last-of-type')?.textContent || ''), null, { timeout: 25_000 })
    .catch(() => {});
  const failedTurn = (await page.textContent('.msg--assistant:last-of-type')) || '';
  check('a refused turn shows the upstream reason', /服务器暂时不可用/.test(failedTurn), failedTurn.slice(0, 160));
  const failedResult = await failTransport;
  check('the refused turn starts a fresh conversation like any first turn', !failedResult.claim?.session_id, failedResult.claim?.session_id);

  const recoverTransport = fakeTransport({ respondWith: '这一轮恢复正常', sessionId: 'sess-after-fail', replyMessageId: 22 });
  await page.fill('#chat-input', '再来一轮');
  await page.click('#chat-send');
  await page
    .waitForFunction(() => /这一轮恢复正常/.test(document.querySelector('.msg--assistant:last-of-type')?.textContent || ''), null, { timeout: 25_000 })
    .catch(() => {});
  const recoverResult = await recoverTransport;
  check('the turn after a failure continues the same DeepSeek conversation', recoverResult.claim?.session_id === 'sess-after-fail', recoverResult.claim?.session_id);
  check('the failed turn stays in the transcript', (await page.locator('.msg--assistant').count()) === 2, await page.locator('.msg--assistant').count());
  const stillFailed = (await page.locator('.msg--assistant').first().textContent()) || '';
  check('the failed turn is not rewritten as a success', /错误/.test(stillFailed), stillFailed.slice(0, 160));

  // --- backend page stays hidden until ?admin=1
  check('the backend tab is hidden in the public site', !(await page.isVisible('.tab[data-view=admin]')), await page.textContent('.tabs'));
  await page.goto(`${origin}index.html?admin=1`, { waitUntil: 'load' });
  await page.waitForSelector('.tab[data-view=admin]:not([hidden])', { timeout: 10_000 });
  check('?admin=1 reveals the backend tab', true);
  await page.click('.tab[data-view=admin]');
  await page.waitForSelector('#health-kv dd', { timeout: 10_000 });
  const health = await page.textContent('#health-kv');
  check('the backend page reports health', /近 1 小时成功/.test(health), health);
  check('the credential box exists only there', await page.isVisible('#cred-input'), health);
  check(
    'the public chat page never shows the credential box',
    !(await page.evaluate(() => Boolean(document.querySelector('#view-chat #cred-input')))),
    health,
  );

  // --- pasting one credential string, with the Edge Function absent -------------------
  // The function is not deployed, so this exercises the PostgREST path: the page parses the
  // string with the shared parser and stores it through deepseek_credential_set_admin().
  const pasted = 'y'.repeat(64);
  const credSnapshot = await rpcLib('deepseek_credential_get', {}, { key: serviceRoleKey() });
  await page.fill('#admin-token', env.TOOLS_ADMIN_TOKEN || '');
  await page.fill('#cred-input', pasted);
  await page.click('#cred-save');
  await page
    .waitForFunction(() => /已保存/.test(document.getElementById('cred-preview')?.textContent || ''), null, { timeout: 20_000 })
    .catch(() => {});
  const preview = (await page.textContent('#cred-preview')) || '';
  const error = (await page.textContent('#cred-error')) || '';
  check('pasting a credential string stores it without the Edge Function', /已保存/.test(preview), { preview, error });
  check('the write is flagged as not checked upstream', /未经上游校验/.test(preview), preview);
  const canonical = await page.inputValue('#cred-canonical');
  check('the reusable string is handed back', canonical.startsWith('dscred1:'), canonical.slice(0, 40));
  const stored = await rpcLib('deepseek_credential_get', {}, { key: serviceRoleKey() });
  check('the relay will use the pasted token', stored.body?.token === pasted, stored.body?.token?.slice(0, 8));
  await page.click('#cred-status-refresh');
  await page.waitForFunction(() => /已配置/.test(document.getElementById('cred-status')?.textContent || ''), null, { timeout: 10_000 }).catch(() => {});
  check('the backend page reads credential status over PostgREST', /已配置/.test((await page.textContent('#cred-status')) || ''));

  if (credSnapshot.body?.token) {
    await rpcLib(
      'deepseek_credential_set',
      {
        p_token: credSnapshot.body.token,
        p_device_id: credSnapshot.body.device_id,
        p_cookie: credSnapshot.body.cookie,
        p_user_agent: credSnapshot.body.user_agent,
        p_source: credSnapshot.body.source,
        p_note: 'restored by browser-smoke',
      },
      { key: serviceRoleKey() },
    );
    const restored = await rpcLib('deepseek_credential_get', {}, { key: serviceRoleKey() });
    check('the live credential is restored after the run', restored.body?.token === credSnapshot.body.token, restored.body?.token?.slice(0, 8));
  }

  await page.goto(`${origin}index.html`, { waitUntil: 'load' });
  await page.waitForSelector('#clipboard-gate', { timeout: 10_000 });

  // --- reload: the remembered token restores the session
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(
    (expected) => {
      const list = document.getElementById('entry-list');
      return Boolean(list && list.textContent.includes(expected));
    },
    marker,
    { timeout: 20_000 },
  );
  const restored = await page.textContent('#entry-list');
  check('a reload restores the session from the remembered token', restored.includes(marker), restored);

  // --- cleanup
  await page.click('.tab[data-view=clipboard]');
  await page.waitForSelector('#clear-all', { timeout: 10_000 });
  // A native window.confirm blocks the click handler inside Playwright; stub it and assert
  // that the app asked before wiping the shared clipboard.
  await page.evaluate(() => {
    window.__confirms = [];
    window.confirm = (message) => {
      window.__confirms.push(message || '');
      return true;
    };
  });
  await page.click('#clear-all');
  const confirms = await page.evaluate(() => window.__confirms || []);
  check('clearing asks for confirmation first', /清空/.test(confirms.join('|')), confirms);
  await page.waitForFunction(
    (expected) => !(document.getElementById('entry-list')?.textContent || '').includes(expected),
    marker,
    { timeout: 15_000 },
  );
  const cleared = await page.textContent('#entry-list');
  check('clear empties the shared clipboard', !cleared.includes(marker), cleared);

  check(
    'no page errors or failing requests during the run',
    pageErrors.length === 0 && httpErrors.length === 0,
    [...pageErrors, ...httpErrors].join('\n'),
  );
  rmSync(tmpFile, { force: true });
} catch (err) {
  check(`smoke run crashed: ${err.message}`, false, err.stack || '');
} finally {
  await clearDeepseekBacklog({ workerId: 'smoke-cleanup' }).catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
  if (failed.length) {
    for (const f of failed) console.log(`  - ${f.name}`);
    process.exitCode = 1;
  }
}
