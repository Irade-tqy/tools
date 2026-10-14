#!/usr/bin/env node
// Browser smoke test: serves dist/ over http, drives the built app with Playwright, and
// plays the role of a DeepSeek transport (claim → stream chunks → complete) so the whole
// path — PostgREST, Realtime/polling, the chat reducer and the UI — is exercised.
//
//   npm run build && node scripts/browser-smoke.mjs
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { anonKey, drainDeepseekQueue, env, supabaseUrl } from './lib.mjs';

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

async function fakeTransport({ respondWith, abortOnSeq }) {
  const workerId = `smoke-${Math.random().toString(36).slice(2, 8)}`;
  const started = Date.now();
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const claim = await rpc('deepseek_claim', { p_worker_id: workerId });
    if (!claim.claimed) {
      await new Promise((r) => setTimeout(r, 150));
      continue;
    }
    const pieces = respondWith.match(/.{1,3}/gu) || [];
    let seq = 0;
    for (const [i, piece] of pieces.entries()) {
      await new Promise((r) => setTimeout(r, 40));
      const out = await rpc('deepseek_append', {
        p_job_id: claim.job_id,
        p_seq: seq,
        p_payload: { choices: [{ delta: { content: piece }, index: 0 }], _transport: 'smoke' },
      });
      if (!out.ok && abortOnSeq != null && seq >= abortOnSeq) return { job_id: claim.job_id, cancelled: true, seq };
      seq += 1;
    }
    await rpc('deepseek_complete', {
      p_job_id: claim.job_id,
      p_ok: true,
      p_metrics: { upstream_ttft_ms: 700, upstream_total_ms: Date.now() - started, transport: 'smoke' },
    });
    return { job_id: claim.job_id, seq, delivered: respondWith };
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

  const drained = await drainDeepseekQueue('smoke-setup');
  check(`the deepseek queue starts empty (drained ${drained} stale job(s))`, true);

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
  const page = await context.newPage();
  const pageErrors = [];
  const httpErrors = [];
  const rpcCalls = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('response', (res) => {
    // config.js is optional by design; its 404 must not count as a failure.
    if (res.status() >= 400 && !res.url().endsWith('/config.js')) {
      httpErrors.push(`${res.status()} ${res.url().replace(supabaseUrl, '<supabase>')}`);
    }
  });
  page.on('request', (req) => {
    if (req.url().includes('/rpc/')) rpcCalls.push(req.url().split('/rpc/')[1]);
  });

  const hash = `#supabase=${encodeURIComponent(supabaseUrl)}&anon=${encodeURIComponent(anonKey())}`;
  await page.goto(`${origin}index.html${hash}`, { waitUntil: 'load' });

  check('the app loads without page errors or failing requests', pageErrors.length === 0 && httpErrors.length === 0, [...pageErrors, ...httpErrors].join('\n'));
  check('config came from the URL hash (no setup screen)', await page.isVisible('#clipboard-gate'));

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
  const transport = fakeTransport({ respondWith: answerText });
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
  const statusText = (await page.textContent('#chat-status')) || '';
  check('latency accounting is shown', /首字/.test(statusText) && /额外/.test(statusText), statusText);
  const metaText = (await page.textContent('.msg--assistant .msg__meta')) || '';
  check('the finished answer carries its metrics', /总/.test(metaText), metaText);

  // --- chat: a second turn keeps the conversation
  await page.fill('#chat-input', '第二句');
  await page.click('#chat-send');
  await page.waitForFunction(() => document.querySelectorAll('.msg--user').length >= 2, { timeout: 15_000 });
  const userCount = await page.locator('.msg--user').count();
  check('the conversation keeps earlier turns', userCount >= 2, `user messages: ${userCount}`);

  // --- settings: health panel + worker snippet
  await page.click('.tab[data-view=settings]');
  await page.waitForSelector('#health-kv dd', { timeout: 10_000 });
  const health = await page.textContent('#health-kv');
  check('the settings panel reports backend health', /近 1 小时成功/.test(health), health);
  await page.evaluate(() => navigator.clipboard.writeText('').catch(() => {}));
  await page.click('#copy-worker');
  await page.waitForFunction(() => /已复制/.test(document.getElementById('toast')?.textContent || ''), { timeout: 8_000 });
  const toastText = (await page.textContent('#toast')) || '';
  check('the worker snippet copies with a toast confirmation', /已复制/.test(toastText), toastText);

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
  await drainDeepseekQueue('smoke-cleanup').catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
  if (failed.length) {
    for (const f of failed) console.log(`  - ${f.name}`);
    process.exitCode = 1;
  }
}
