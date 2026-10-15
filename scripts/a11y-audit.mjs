#!/usr/bin/env node
// Accessibility audit of the deployed app, run with axe-core in a real browser.
//
//   node scripts/a11y-audit.mjs [--url https://…/tools/]
//
// Why this exists: axe found a serious color-contrast failure on the deployed 发送 button
// (white on #4c8dff measures 3.2:1, AA needs 4.5:1) and a landmark nesting problem — neither
// of which any functional test would notice. It loads axe from a CDN, so it needs network;
// the app itself ships no audit code.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import playwright from 'playwright';

const args = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const BASE = (flagValue('--url', process.env.LIVE_URL || 'https://irade-tqy.github.io/tools/'))
  .trim()
  .replace(/\/+$/, '');
const AXE_URL = 'https://cdn.jsdelivr.net/npm/axe-core@4.10.2/axe.min.js';
const results = [];

function check(name, cond, detail = '') {
  const note = typeof detail === 'string' ? detail : JSON.stringify(detail ?? null);
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : `\n        ${String(note).slice(0, 400)}`}`);
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

const browser = await launchChromium();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();

async function audit(label) {
  try {
    await page.addScriptTag({ url: AXE_URL });
  } catch (err) {
    check(`${label}: axe loaded`, false, `cannot fetch ${AXE_URL} — ${err.message}`);
    return;
  }
  const r = await page.evaluate(() => window.axe.run(document, { resultTypes: ['violations'] }));
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  check(
    `${label}: no serious or critical axe violations`,
    serious.length === 0,
    r.violations.map((v) => `[${v.impact}] ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  );
  for (const v of r.violations.filter((x) => x.impact === 'moderate' || x.impact === 'minor')) {
    console.log(`      note [${v.impact}] ${v.id} — ${v.nodes[0]?.target?.join(' ')}`);
  }
}

try {
  await page.goto(`${BASE}/#view=chat`, { waitUntil: 'load' });
  await page.waitForSelector('#chat-input', { state: 'visible', timeout: 25_000 });
  await audit('chat view');

  // a turn in flight and a finished turn render different nodes
  await page.fill('#chat-input', '可访问性检查用的占位消息');
  await page.click('#chat-send').catch(() => {});
  await page.waitForTimeout(2500);
  await audit('chat view with a turn');

  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.waitForSelector('#unlock-form', { state: 'visible', timeout: 25_000 });
  await audit('clipboard unlock gate');

  await page.goto(`${BASE}/?admin=1`, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  await audit('backend page');
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
