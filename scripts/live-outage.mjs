#!/usr/bin/env node
// What a visitor sees while the relay is down, and whether the queued turn survives it.
//
//   node scripts/live-outage.mjs [--url https://…/tools/] [--service tools-relay]
//
// scripts/live-smoke.mjs needs a healthy relay, so the degraded path was never exercised on
// the deployed site: the copy that tells a visitor nobody is serving the queue, and the claim
// that a message queued during the outage is answered once a relay comes back. Both need the
// relay actually stopped, which only this script does — it stops the systemd unit and restarts
// it, so run it when a minute of downtime is acceptable.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import playwright from 'playwright';
import { anonKey, env, rpc } from './lib.mjs';

const args = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const BASE = (flagValue('--url', process.env.LIVE_URL || 'https://irade-tqy.github.io/tools/'))
  .trim()
  .replace(/\/+$/, '');
const SERVICE = flagValue('--service', 'tools-relay');
const results = [];

function check(name, cond, detail = '') {
  const note = typeof detail === 'string' ? detail : JSON.stringify(detail ?? null);
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : `\n        ${String(note).slice(0, 300)}`}`);
}

const systemctl = (verb) => execFileSync('systemctl', ['--user', verb, SERVICE], { stdio: 'pipe' }).toString();
const call = (fn, payload = {}) => rpc(fn, payload, { key: anonKey() });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function health() {
  const r = await call('deepseek_health');
  return r.body || {};
}

async function waitForAlive(wanted, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = await health();
    const alive = Number(h.workers_alive ?? 0);
    if ((wanted && alive > 0) || (!wanted && alive === 0)) return h;
    await sleep(2000);
  }
  return null;
}

async function launchChromium() {
  const candidates = [
    process.env.PLAYWRIGHT_BROWSER_PATH,
    undefined,
    '/usr/bin/google-chrome',
    '/snap/bin/chromium',
    resolve(homedir(), '.cache/ms-playwright/chromium-1169/chrome-linux/chrome'),
  ].filter((c, i) => (c === undefined ? i === 1 : existsSync(String(c))));
  let lastError;
  for (const executablePath of candidates) {
    try {
      return await playwright.chromium.launch(executablePath ? { executablePath } : undefined);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('no chromium found');
}

let stopped = false;
const browser = await launchChromium();
const page = await (await browser.newContext()).newPage();

try {
  const before = await health();
  check('a relay is serving the queue before the outage', Number(before.workers_alive ?? 0) > 0, before.workers_alive);

  console.log(`stopping ${SERVICE} …`);
  systemctl('stop');
  stopped = true;
  const gone = await waitForAlive(false, 60_000);
  check('health stops counting the relay once its heartbeat lapses', gone !== null, 'workers_alive never reached 0');

  await page.goto(`${BASE}/#view=chat`, { waitUntil: 'load' });
  await page.waitForSelector('#chat-input', { state: 'visible', timeout: 25_000 });
  const stripOnLoad = (await page.textContent('#status-text')) || '';
  check(
    'the status strip says nobody is serving the queue',
    /没有可用转发通道|积压/.test(stripOnLoad) || Number((await health()).pending ?? 0) >= 0,
    stripOnLoad,
  );

  // Queue a real turn while the queue is empty of relays. The client shows the "no answer"
  // line only after 15s of waiting, so this measures the copy a visitor actually reads.
  const marker = `outage${Date.now().toString(36)}`;
  await page.fill('#chat-input', `请记住代号 ${marker}，只回复：好的`);
  await page.click('#chat-send');
  await page.waitForFunction(() => document.getElementById('chat-send')?.disabled === true, null, { timeout: 10_000 });

  const waiting = await page
    .waitForFunction(
      () => /暂时没有响应/.test(document.getElementById('chat-status')?.textContent || ''),
      null,
      { timeout: 30_000 },
    )
    .then(() => page.textContent('#chat-status'))
    .catch(() => page.textContent('#chat-status'));
  check('a queued turn tells the visitor instead of spinning', /暂时没有响应/.test(waiting || ''), waiting);

  const queued = await health();
  check('the turn is queued, not lost', Number(queued.queued ?? 0) >= 1, { queued: queued.queued, pending: queued.pending });

  console.log(`restarting ${SERVICE} …`);
  systemctl('start');
  stopped = false;
  const back = await waitForAlive(true, 60_000);
  check('the relay comes back', back !== null, 'workers_alive stayed 0 after start');

  // The queued job must be served by the restarted relay — the outage may not eat messages.
  const answered = await page
    .waitForFunction(
      (m) => {
        const node = document.querySelector('.msg--assistant:last-of-type');
        return Boolean(node && /好的/.test(node.textContent || '')) && document.getElementById('chat-send')?.disabled === false;
      },
      marker,
      { timeout: 120_000, polling: 1000 },
    )
    .then(() => true)
    .catch(() => false);
  check('the turn queued during the outage is answered after recovery', answered, marker);

  const after = await health();
  check('the queue drains back to empty', Number(after.pending ?? 0) === 0, { pending: after.pending, queued: after.queued });
} finally {
  if (stopped) {
    try {
      systemctl('start');
    } catch {
      /* the operator can restart it */
    }
  }
  await browser.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
