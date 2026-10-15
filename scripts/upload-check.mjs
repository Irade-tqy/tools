// End-to-end attachment check against the deployed site: log in with a real code, upload a file
// through the "+" button, wait for upstream to finish parsing, send, and confirm the answer came
// from the file rather than the prompt.
import { writeFileSync, unlinkSync } from 'node:fs';
import playwright from 'playwright';

const BASE = process.env.LIVE_URL || 'https://irade-tqy.github.io/tools/';
const CODE = process.env.LOGIN_CODE || 'Tong';
const MARKER = `青柠-${Math.floor(Math.random() * 90 + 10)}`;
const results = [];

function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : `\n        ${String(detail).slice(0, 240)}`}`);
}

// Same fallback chain the other browser scripts use: prefer a Playwright-managed build, else a
// system Chrome, since this box is arm64 and Playwright's download may be missing.
let browser;
for (const executablePath of [process.env.PLAYWRIGHT_BROWSER_PATH, undefined, '/usr/bin/google-chrome', '/snap/bin/chromium']) {
  try {
    browser = await playwright.chromium.launch(executablePath ? { executablePath } : undefined);
    break;
  } catch (err) {
    if (executablePath === '/snap/bin/chromium') throw err;
  }
}
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('requestfailed', (r) => {
  // ./config.js is the optional self-hosting override (git-ignored, see src/lib/config.ts), so a
  // 404 for it is the normal case on this deployment, not a failure.
  if (/\/config\.js$/.test(r.url())) return;
  // Aborting the Edge Function's SSE stream is how the client tears the connection down; the
  // browser reports it as a failed request even though the turn completed.
  if (/\/functions\/v1\//.test(r.url()) && /ERR_ABORTED/i.test(r.failure()?.errorText || '')) return;
  errors.push(`${r.method()} ${r.url().slice(0, 90)} ${r.failure()?.errorText}`);
});

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForSelector('#chat-password', { timeout: 30_000 });
await page.fill('#chat-password', CODE);
await page.click('#chat-login button[type=submit]');
await page.waitForSelector('#chat-input', { state: 'visible', timeout: 30_000 });
check('a short login code unlocks the chat', await page.isVisible('#chat-input'));

check('the + button is the upload control', await page.isVisible('#chat-attach'));
check('the settings menu moved to a … button', await page.isVisible('.composer-menu summary'));
const menuIcon = await page.evaluate(() => document.querySelector('.composer-menu summary')?.textContent || '');
check('the … menu still holds model / thinking / search', await page.evaluate(() => {
  const d = document.querySelector('.composer-menu');
  return Boolean(d && d.querySelector('#chat-model') && d.querySelector('#chat-thinking') && d.querySelector('#chat-search'));
}), menuIcon);

const file = '/tmp/upload-note.txt';
writeFileSync(file, `内部代号：${MARKER}。\n这份文件只有两行，用来测试上传。\n`);
await page.setInputFiles('#chat-file', file);
await page.waitForFunction(
  () => {
    const chip = document.querySelector('#chat-files .file-chip');
    return chip && !chip.querySelector('.file-chip__state');
  },
  null,
  { timeout: 40_000 },
);
const chipText = await page.evaluate(() => document.querySelector('#chat-files .file-chip')?.textContent || '');
check('the uploaded file shows as a ready chip', /upload-note\.txt/.test(chipText), chipText);

await page.fill('#chat-input', '这份文件里的内部代号是什么？只回复代号。');
await page.click('#chat-send');
// The composer is the honest busy signal: setBusy() hides send and shows stop, and a visitor
// reads the same thing. Watching the bubble text alone raced the "…" placeholder.
const answer = await page
  .waitForFunction(
    () => {
      const stop = document.querySelector('#chat-stop');
      const send = document.querySelector('#chat-send');
      if (!stop || !send || !stop.hidden || send.hidden) return false;
      const node = document.querySelector('.msg--assistant:last-of-type');
      return (node?.textContent || '').trim().length > 1;
    },
    null,
    { timeout: 120_000 },
  )
  .then(() => page.evaluate(() => document.querySelector('.msg--assistant:last-of-type')?.textContent || ''));
check('DeepSeek answered from the uploaded file', answer.includes(MARKER), answer.slice(0, 200));

const bubbleFiles = await page.evaluate(() => document.querySelectorAll('.msg--user .file-chip').length);
check('the sent bubble keeps a record of the attachment', bubbleFiles === 1, `chips=${bubbleFiles}`);
const stripEmpty = await page.evaluate(() => document.querySelector('#chat-files')?.hidden !== false);
check('the staging strip clears after sending', stripEmpty);

check('no page errors and no failed requests', errors.length === 0, errors.slice(0, 3));
unlinkSync(file);
await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
