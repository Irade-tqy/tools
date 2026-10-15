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
  results.push({ name, pass: !!cond, detail: note });
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

/**
 * DeepSeek reports degradation out of band and it flaps on a seconds timescale: `服务器暂时不可用
 * （backend_err）`, a stream that dies before its `close` frame, and the occasional `invalid token`
 * from create_pow_challenge. None of those is this product's failure, and a suite that fails on
 * them cannot tell a real regression from an upstream mood swing — so retry a bounded number of
 * times and count it. A genuine regression (no relay, lost session, missing tool chip) does not
 * match these signatures and still fails immediately.
 */
const UPSTREAM_DEGRADED =
  /服务器暂时不可用|backend_err|upstream closed without an answer|invalid token|rate.?limit|too many|限流|繁忙|稍后再试/i;
let turnRetries = 0;

async function sendTurn(page, text, { attempts = 4, waitMs = 6000 } = {}) {
  let last = '';
  for (let i = 0; i < attempts; i++) {
    last = await send(page, text);
    if (!UPSTREAM_DEGRADED.test(last)) return last;
    turnRetries++;
    if (i < attempts - 1) await page.waitForTimeout(waitMs);
  }
  return last;
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
  const turnQueuedAt = new Date();
  const first = await sendTurn(page, `请记住这个代号：${marker}。只回复：好的`);
  check('a real answer renders on the live site', first.includes('好的'), first.slice(0, 160));
  const status1 = (await page.textContent('#chat-status')) || '';
  check('the live status strip reports the upstream first token', /首字/.test(status1), status1);

  // The job the page just ran: the newest turn this run queued in the production queue. Scoping
  // by queue and time matters — an unfiltered "newest done job" once read a synthetic row from
  // the test queue and reported the live turn as unserved.
  const { connectDb } = await import('./lib.mjs');
  const db = await connectDb();
  let newest;
  try {
    const row = await db.query(
      `select id, transport, status, session_id, reply_message_id, title, metrics, error
         from public.deepseek_job
        where queue = 'default' and created_at >= $1
        order by created_at desc limit 1`,
      [turnQueuedAt],
    );
    newest = row.rows[0];
  } finally {
    await db.end().catch(() => {});
  }
  check(
    'the live turn was served by a relay',
    newest?.status === 'done' && /web$/.test(String(newest?.transport || '')),
    newest,
  );
  check('the live turn recorded the conversation ids', Boolean(newest?.session_id) && Boolean(newest?.reply_message_id), newest);
  check('the live turn recorded upstream timings', Number(newest?.metrics?.upstream_ttft_ms) > 0, newest?.metrics);

  // The agreed budget: our end-to-end time-to-first-token may exceed upstream's by at most 5s.
  // The page prints the difference itself, so this asserts what a visitor is actually told.
  // last(), not first(): a retry appends another bubble, and the turn whose overhead matters is
  // the one that actually got an answer.
  const meta1 = (await page.locator('.msg__meta').last().textContent().catch(() => null)) || '';
  check('the live turn reports its overhead over upstream', /额外 \d/.test(meta1), meta1);
  check('the live turn stays inside the 5s overhead budget', meta1.includes('额外') && !/超 5s/.test(meta1), meta1);

  // 2. continue the same conversation
  const second = await sendTurn(page, '我刚才让你记住的代号是什么？只回复代号');
  check('the live site continues the same conversation', second.includes(marker), second.slice(0, 160));

  // 3. a new conversation forgets it
  await page.click('#chat-new-session');
  await page.waitForFunction(() => document.querySelectorAll('.msg').length === 0, null, { timeout: 10_000 });
  const third = await sendTurn(page, '我刚才让你记住的代号是什么？只回复代号');
  check('新会话 starts over and forgets the marker', !third.includes(marker), third.slice(0, 160));

  // 4. tools surface as a chip, not as answer text
  await page.setChecked('#chat-search', true);
  const fourth = await sendTurn(page, '今天上海天气怎么样？');
  const chip = await page.evaluate(() => document.querySelector('.msg--assistant:last-of-type .chip--tool')?.textContent || '');
  check('a tool-using turn shows the "已调用工具" marker', /已调用工具/.test(chip), chip.slice(0, 200));
  check('tool noise stays out of the answer text', !/搜索到\s*\d+\s*个网页/.test(fourth), fourth.slice(0, 200));

  // 5. the shared clipboard really is shared: a second, clean browser (no localStorage, no
  // remembered token) unlocks with the same password and reads what the first one saved —
  // decrypted. One browser can never prove this, which is why it lives here and not only in
  // scripts/browser-smoke.mjs.
  const password = (env.TOOLS_CLIPBOARD_PASSWORDS || '').split(':').pop().trim();
  const shared = `live-share-${Date.now().toString(36)}`;
  const writer = await (await browser.newContext()).newPage();
  await writer.goto(`${BASE}/`, { waitUntil: 'load' });
  await writer.fill('#password-input', password);
  await writer.click('#unlock-form button[type=submit]');
  await writer.waitForSelector('.cm-editor', { timeout: 30_000 });
  await writer.click('.cm-content');
  await writer.keyboard.type(shared);
  await writer.fill('#entry-title', 'live share');
  await writer.click('#save-text');
  await writer.waitForFunction((m) => Array.from(document.querySelectorAll('.entry__body')).some((n) => n.textContent.includes(m)), shared, {
    timeout: 25_000,
  });
  check('a browser saves a clipboard entry on the live site', true);

  const reader = await (await browser.newContext()).newPage();
  await reader.goto(`${BASE}/`, { waitUntil: 'load' });
  await reader.fill('#password-input', password);
  await reader.click('#unlock-form button[type=submit]');
  await reader.waitForSelector('.cm-editor', { timeout: 30_000 });
  const sharedSeen = await reader
    .waitForFunction((m) => Array.from(document.querySelectorAll('.entry__body')).some((n) => n.textContent.includes(m)), shared, {
      timeout: 25_000,
    })
    .then(() => true)
    .catch(() => false);
  check('a second device sees the entry the first one saved, decrypted', sharedSeen, shared);
  await writer.context().close();
  await reader.context().close();

  // 6. the public page never leaks the backend
  // The admin <section> exists in the DOM (hidden) and holds the credential box, so the
  // question is whether a visitor can see or reach it — not whether it is in the markup.
  const credVisible = await page.isVisible('#cred-input');
  check('the credential box is not reachable on the public page', !credVisible, { credVisible });

  // 7. the operator flow on the DEPLOYED page: paste one string → parsed → stored.
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

  // 8. the failure a live deployment actually hits: DeepSeek stops accepting the stored login
  // state. The bogus token pasted above is what the relay is holding right now, so this is the
  // real path — not a stubbed 401.
  await page.goto(`${BASE}/#view=chat`, { waitUntil: 'load' });
  await page.waitForSelector('#chat-input', { state: 'visible', timeout: 25_000 });
  const broken = await send(page, '登录态失效测试：只回复 OK');
  const brokenStatus = (await page.textContent('#chat-status')) || '';
  check(
    'an upstream rejection ends the turn with a visible error',
    /错误/.test(brokenStatus) || /错误/.test(broken),
    { brokenStatus, broken: broken.slice(0, 160) },
  );
  const healthBroken = await call('deepseek_health');
  check('the failed turn is reported against the credential', Boolean(healthBroken.body?.credential_error), healthBroken.body?.credential_error);
  // The strip refreshes on load and on an interval, so a reload is what a visitor would do.
  await page.reload({ waitUntil: 'load' });
  const strip = await page
    .waitForFunction(() => /登录态/.test(document.getElementById('status-text')?.textContent || ''), null, { timeout: 20_000 })
    .then(() => page.textContent('#status-text'))
    .catch(() => page.textContent('#status-text'));
  check('the status strip names the login state, not a raw error', /登录态/.test(strip || ''), strip);

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

    // Recovery: swapping the string back has to bring the service back on the very next turn.
    await page.goto(`${BASE}/#view=chat`, { waitUntil: 'load' });
    await page.waitForSelector('#chat-input', { state: 'visible', timeout: 25_000 });
    const recovered = await sendTurn(page, '恢复测试：只回复 OK');
    check('replacing the credential brings the service back', /OK/.test(recovered), recovered.slice(0, 160));
    const healthBack = await call('deepseek_health');
    check('the credential error clears once a turn succeeds', !healthBack.body?.credential_error, healthBack.body?.credential_error);
  }

  // 9. the phone path. The toolbox is opened over Tailscale from a phone, and the compact
  // desktop sizing shipped 39px and 30px touch targets plus a 15px input (iOS Safari zooms the
  // page on focus below 16px). Assert the numbers a thumb depends on.
  const mobile = await (await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  })).newPage();
  await mobile.goto(`${BASE}/#view=chat`, { waitUntil: 'load' });
  await mobile.waitForSelector('#chat-input', { state: 'visible', timeout: 25_000 });
  const m = await mobile.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().height) : 0;
    };
    const de = document.documentElement;
    return {
      overflowX: de.scrollWidth - de.clientWidth,
      send: box('#chat-send'),
      newSession: box('#chat-new-session'),
      tab: box('.tab[data-view="chat"]'),
      inputFont: parseInt(getComputedStyle(document.getElementById('chat-input')).fontSize, 10),
      adminTabVisible: Boolean(document.querySelector('.tab[data-view="admin"]')?.getBoundingClientRect().width),
    };
  });
  check('the phone layout has no horizontal scroll', m.overflowX <= 0, m);
  check('the phone touch targets are at least 44px', m.send >= 44 && m.newSession >= 44 && m.tab >= 44, m);
  check('the phone input is 16px so iOS does not zoom on focus', m.inputFont >= 16, m);
  check('the backend stays hidden on the phone too', m.adminTabVisible === false, m);
  await mobile.context().close();

  // 10. "the user pastes one string" — every format the parser claims to read, pasted into the
  // deployed backend page. Unit tests cover the parser; this proves the page in production takes
  // a bare token, a DevTools "Copy as cURL", a JSON dump, labelled key/value lines and the
  // reusable dscred1 string, and refuses a cookie-only paste instead of storing a tokenless row.
  const liveToken = snapshot.body?.token || '';
  const curl = `curl 'https://chat.deepseek.com/api/v0/chat/completion' \
  -H 'Authorization: Bearer ${liveToken}' \
  -H 'Content-Type: application/json' \
  --data-raw '{}'`;
  const formats = [
    { label: 'token', input: liveToken },
    { label: 'curl', input: curl },
    { label: 'json', input: JSON.stringify({ userToken: liveToken }) },
    { label: 'kv', input: `token: ${liveToken}` },
    {
      label: 'canonical',
      input: `dscred1:${Buffer.from(JSON.stringify({ t: liveToken })).toString('base64url')}`,
    },
  ];
  await page.goto(`${BASE}/?admin=1`, { waitUntil: 'load' });
  await page.waitForSelector('.tab[data-view="admin"]:not([hidden])', { timeout: 15_000 }).catch(() => {});
  await page.click('.tab[data-view="admin"]');
  await page.waitForSelector('#cred-input', { state: 'visible', timeout: 20_000 });
  await page.fill('#admin-token', env.TOOLS_ADMIN_TOKEN || '');
  for (const f of formats) {
    await page.fill('#cred-input', f.input);
    await page.click('#cred-save');
    const saved = await page
      .waitForFunction(() => /已保存/.test(document.getElementById('cred-preview')?.textContent || ''), null, { timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    const preview = (await page.textContent('#cred-preview')) || '';
    const canonical = await page.inputValue('#cred-canonical');
    const carried = canonical.startsWith('dscred1:') ? JSON.parse(Buffer.from(canonical.slice(8), 'base64url').toString('utf8')).t : null;
    check(`the deployed page stores a ${f.label} string and hands back the reusable one`, saved && preview.includes(f.label) && carried === liveToken, {
      preview,
      carried: String(carried).slice(0, 12),
    });
  }
  await page.fill('#cred-input', 'smidV2=abc123; other=1');
  await page.click('#cred-save');
  const refused = await page
    .waitForFunction(() => !document.getElementById('cred-error')?.hidden, null, { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  check('a cookie-only paste is refused with a message, not stored', refused, await page.textContent('#cred-error'));

  // The format loop stored whatever it parsed last; put the operator's credential back exactly.
  if (snapshot.body?.token) {
    await rpc(
      'deepseek_credential_set',
      {
        p_token: snapshot.body.token,
        p_device_id: snapshot.body.device_id,
        p_cookie: snapshot.body.cookie,
        p_user_agent: snapshot.body.user_agent,
        p_source: snapshot.body.source,
        p_note: 'restored by live-smoke (format loop)',
      },
      { key: serviceRoleKey() },
    );
    const back = await rpc('deepseek_credential_get', {}, { key: serviceRoleKey() });
    check('the credential is back exactly as found after the format loop', back.body?.token === snapshot.body.token && (back.body?.user_agent || '') === (snapshot.body.user_agent || ''), back.body?.token?.slice(0, 8));
  }
} finally {
  await browser.close();
}

check('no page errors and no failing requests', pageErrors.length === 0 && httpErrors.length === 0, { pageErrors, httpErrors });

const failed = results.filter((r) => !r.pass);
// DeepSeek has its own bad days: it answers with 服务器暂时不可用 / backend_err and the checks
// that need a real answer cannot pass. Say so, so a red run is never mistaken for a regression.
const degraded = failed.filter((r) => /服务器暂时不可用|backend_err|upstream closed/i.test(`${r.name} ${r.detail || ''}`));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (turnRetries) {
  console.log(`  absorbed ${turnRetries} upstream-degraded turn(s) with retries — DeepSeek reported it is temporarily unavailable`);
}
if (degraded.length) {
  console.log(`  ${degraded.length}/${failed.length} failures are turns that need a live DeepSeek answer, and the upstream reported it is temporarily unavailable`);
}
if (failed.length) process.exit(1);
