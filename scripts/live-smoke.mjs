#!/usr/bin/env node
// End-to-end check of the DEPLOYED site, with the real relay serving the queue.
//
//   node scripts/live-smoke.mjs [--url https://irade-tqy.github.io/tools/]
//
// scripts/browser-smoke.mjs stubs the transport so its assertions are deterministic. This one
// stubs nothing: it drives the production URL in a real browser, the resident relay (or the
// Edge Function once deployed) claims the turn, DeepSeek answers for real, and the page has to
// render what arrives — including continuing the same conversation and starting a new one.
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import playwright from 'playwright';
import { anonKey, clearDeepseekBacklog, env, rpc, serviceRoleKey } from './lib.mjs';

const args = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const BASE = (flagValue('--url', process.env.LIVE_URL || 'https://irade-tqy.github.io/tools/'))
  .trim()
  .replace(/\/+$/, '');
const results = [];

function check(name, cond, detail = '') {
  const note = typeof detail === 'string' ? detail : JSON.stringify(detail ?? null);
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : `\n        ${String(note).slice(0, 300)}`}`);
}

const key = anonKey();
const call = (fn, payload = {}) => rpc(fn, payload, { key });

async function launchChromium() {
  const candidates = [process.env.PLAYWRIGHT_BROWSER_PATH, undefined, '/usr/bin/google-chrome', '/snap/bin/chromium'];
  let lastError;
  for (const executablePath of candidates) {
    try {
      return await playwright.chromium.launch(executablePath ? { executablePath } : undefined);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/** Wait for the assistant bubble to stop growing, then return its text. */
async function lastAnswer(page) {
  await page.waitForFunction(
    () => {
      const node = document.querySelector('.msg--assistant:last-of-type');
      if (!node) return false;
      const busy = document.getElementById('chat-send')?.disabled === true;
      return !busy && (node.textContent || '').trim().length > 0;
    },
    null,
    { timeout: 180_000, polling: 500 },
  );
  return page.evaluate(() => document.querySelector('.msg--assistant:last-of-type')?.textContent || '');
}

async function send(page, text) {
  await page.waitForFunction(() => document.getElementById('chat-send')?.disabled === false, null, { timeout: 120_000 });
  await page.fill('#chat-input', text);
  await page.click('#chat-send');
  return lastAnswer(page);
}

const health = await call('deepseek_health');
if (!(Number(health.body?.workers_alive) >= 1)) {
  console.error(`no relay is serving the queue (workers_alive=${health.body?.workers_alive}) — start one with npm run relay:start`);
  process.exit(2);
}

const marker = `live${Date.now().toString(36)}`;
const pageErrors = [];
const httpErrors = [];

const backlog = await clearDeepseekBacklog({ workerId: 'live-smoke' });
console.log(`target: ${BASE}  relay: ${(health.body?.workers ?? []).map((w) => `${w.worker_id}(${w.turns})`).join(', ')}  backlog: ${backlog.closed} stale / ${backlog.drained} queued\n`);

const browser = await launchChromium();
const context = await browser.newContext();
const page = await context.newPage();
page.on('pageerror', (err) => pageErrors.push(err.message));
page.on('response', (res) => {
  if (res.status() >= 400 && !res.url().endsWith('/config.js')) httpErrors.push(`${res.status()} ${res.url()}`);
});

try {
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => !/未配置/.test(document.getElementById('status-text')?.textContent || ''), null, { timeout: 15_000 });
  check('the deployed site needs no configuration', true);

  check('the backend tab is not offered to visitors', !(await page.isVisible('.tab[data-view="admin"]')), await page.evaluate(() => document.querySelector('.tab[data-view="admin"]')?.hidden));
  await page.click('.tab[data-view="chat"]');
  await page.waitForSelector('#chat-input', { state: 'visible', timeout: 10_000 });
  check('the DeepSeek tab opens', await page.isVisible('#chat-input'));

  // 1. a real turn, served by the resident relay
  const first = await send(page, `请记住这个代号：${marker}。只回复：好的`);
  check('a real answer renders on the live site', first.includes('好的'), first.slice(0, 160));
  const status1 = (await page.textContent('#chat-status')) || '';
  check('the live status strip reports the upstream first token', /首字/.test(status1), status1);

  // The job the page just ran is the newest finished one; read its row so the claim
  // "a relay served it" is evidence rather than a rendered string we trust.
  const { connectDb } = await import('./lib.mjs');
  const db = await connectDb();
  let newest;
  try {
    const row = await db.query(
      `select id, transport, status, session_id, reply_message_id, title, metrics
         from public.deepseek_job where status = 'done' order by finished_at desc nulls last limit 1`,
    );
    newest = row.rows[0];
  } finally {
    await db.end().catch(() => {});
  }
  check('the live turn was served by a relay', newest?.status === 'done' && /web$/.test(String(newest?.transport || '')), newest);
  check('the live turn recorded the conversation ids', Boolean(newest?.session_id) && Boolean(newest?.reply_message_id), newest);
  check('the live turn recorded upstream timings', Number(newest?.metrics?.upstream_ttft_ms) > 0, newest?.metrics);

  // 2. continue the same conversation
  const second = await send(page, '我刚才让你记住的代号是什么？只回复代号');
  check('the live site continues the same conversation', second.includes(marker), second.slice(0, 160));

  // 3. a new conversation forgets it
  await page.click('#chat-new-session');
  await page.waitForFunction(() => document.querySelectorAll('.msg').length === 0, null, { timeout: 10_000 });
  const third = await send(page, '我刚才让你记住的代号是什么？只回复代号');
  check('新会话 starts over and forgets the marker', !third.includes(marker), third.slice(0, 160));

  // 4. tools surface as a chip, not as answer text
  await page.setChecked('#chat-search', true);
  const fourth = await send(page, '今天上海天气怎么样？');
  const chip = await page.evaluate(() => document.querySelector('.msg--assistant:last-of-type .chip--tool')?.textContent || '');
  check('a tool-using turn shows the "已调用工具" marker', /已调用工具/.test(chip), chip.slice(0, 200));
  check('tool noise stays out of the answer text', !/搜索到\s*\d+\s*个网页/.test(fourth), fourth.slice(0, 200));

  // 5. the public page never leaks the backend
  // The admin <section> exists in the DOM (hidden) and holds the credential box, so the
  // question is whether a visitor can see or reach it — not whether it is in the markup.
  const credVisible = await page.isVisible('#cred-input');
  check('the credential box is not reachable on the public page', !credVisible, { credVisible });

  // 6. the operator flow on the DEPLOYED page: paste one string → parsed → stored.
  // Runs last, and restores the live credential straight afterwards.
  await page.goto(`${BASE}/?admin=1`, { waitUntil: 'load' });
  await page.waitForSelector('.tab[data-view="admin"]:not([hidden])', { timeout: 15_000 }).catch(() => {});
  await page.click('.tab[data-view="admin"]');
  await page.waitForSelector('#cred-input', { state: 'visible', timeout: 15_000 });
  check('?admin=1 reveals the backend on the deployed site', await page.isVisible('#cred-input'));

  const pasted = 'z'.repeat(64);
  const snapshot = await rpc('deepseek_credential_get', {}, { key: serviceRoleKey() });
  await page.fill('#admin-token', env.TOOLS_ADMIN_TOKEN || '');
  await page.fill('#cred-input', pasted);
  await page.click('#cred-save');
  await page
    .waitForFunction(() => /已保存/.test(document.getElementById('cred-preview')?.textContent || ''), null, { timeout: 25_000 })
    .catch(() => {});
  const preview = (await page.textContent('#cred-preview')) || '';
  const credError = (await page.textContent('#cred-error')) || '';
  check('pasting one string on the deployed backend page stores it', /已保存/.test(preview), { preview, credError });
  const canonical = await page.inputValue('#cred-canonical');
  check('the reusable string is handed back by the deployed page', canonical.startsWith('dscred1:'), canonical.slice(0, 32));
  const stored = await rpc('deepseek_credential_get', {}, { key: serviceRoleKey() });
  check('the deployed relay will use the pasted token', stored.body?.token === pasted, stored.body?.token?.slice(0, 8));

  if (snapshot.body?.token) {
    await rpc(
      'deepseek_credential_set',
      {
        p_token: snapshot.body.token,
        p_device_id: snapshot.body.device_id,
        p_cookie: snapshot.body.cookie,
        p_user_agent: snapshot.body.user_agent,
        p_source: snapshot.body.source,
        p_note: 'restored by live-smoke',
      },
      { key: serviceRoleKey() },
    );
    const restored = await rpc('deepseek_credential_get', {}, { key: serviceRoleKey() });
    check('the live credential is restored after the run', restored.body?.token === snapshot.body.token, restored.body?.token?.slice(0, 8));
  }
} finally {
  await browser.close();
}

check('no page errors and no failing requests', pageErrors.length === 0 && httpErrors.length === 0, { pageErrors, httpErrors });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
