#!/usr/bin/env node
// Drive the DeepSeek web login and export the resulting cookie for the Edge Function.
//
// The toolbox cannot use a DeepSeek login from an arbitrary origin (the session cookie is
// SameSite-restricted), but the *cookie itself* is what the deepseek-chat Edge Function
// needs. This script logs in through a real browser, then writes the cookie header into
// .env.local as DEEPSEEK_WEB_COOKIE.
//
//   node scripts/deepseek-login.mjs --phone 13800000000 [--code-file /tmp/ds-code.txt]
//                                   [--headed] [--timeout 300] [--keep-open]
//
// Headed (default when DISPLAY is set) so a WAF/CAPTCHA can be solved by hand in the
// window. The SMS code arrives out of band: write it into --code-file (or pass
// --code 123456) and the script continues.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env, rootDir } from './lib.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback = '') => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const value = args[i + 1];
  return value && !value.startsWith('--') ? value : fallback;
};

const phone = (flag('--phone') || env.TOOLS_DEEPSEEK_PHONE || '').replace(/\D/g, '');
const codeFile = flag('--code-file', '/tmp/deepseek-code.txt');
const inlineCode = flag('--code');
const timeoutMs = Number(flag('--timeout', '300')) * 1000;
const headed = args.includes('--headed') || (!args.includes('--headless') && Boolean(process.env.DISPLAY));
const keepOpen = args.includes('--keep-open');
const profileDir = resolve(rootDir, '.tmp/deepseek-profile');
const logPath = resolve(rootDir, '.tmp/deepseek-login.log');

function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(' ')}`;
  console.log(line);
  appendFileSync(logPath, `${line}\n`);
}

if (!phone) {
  console.error('usage: node scripts/deepseek-login.mjs --phone 13800000000');
  process.exit(1);
}

mkdirSync(profileDir, { recursive: true, mode: 0o700 });
writeFileSync(logPath, `--- login run ${new Date().toISOString()} ---\n`);

const { chromium } = await import('playwright');
const executablePath = process.env.PLAYWRIGHT_BROWSER_PATH || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);

const context = await chromium.launchPersistentContext(profileDir, {
  headless: !headed,
  executablePath,
  viewport: { width: 1280, height: 900 },
  locale: 'zh-CN',
  userAgent:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  args: ['--no-first-run', '--no-default-browser-check'],
});
const page = context.pages()[0] || (await context.newPage());

function cookieHeader(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

function upsertEnv(name, value) {
  const path = resolve(rootDir, '.env.local');
  const line = `${name}=${value}`;
  if (!existsSync(path)) {
    writeFileSync(path, `${line}\n`, { mode: 0o600 });
    return;
  }
  const text = readFileSync(path, 'utf8');
  const next = new RegExp(`^${name}=.*$`, 'm').test(text)
    ? text.replace(new RegExp(`^${name}=.*$`, 'm'), line)
    : `${text.replace(/\n*$/, '')}\n${line}\n`;
  writeFileSync(path, next, { mode: 0o600 });
}

async function signedIn() {
  const cookies = await context.cookies('https://chat.deepseek.com');
  const auth = cookies.find((c) => /session|auth|token/i.test(c.name) && c.name !== 'ds_session_id' && c.value.length > 20);
  const onChat = !/sign_in/.test(page.url());
  return { auth, onChat, cookies };
}

try {
  log(`mode: ${headed ? 'headed' : 'headless'}  phone: ${phone.slice(0, 3)}****${phone.slice(-4)}`);
  await page.goto('https://chat.deepseek.com/sign_in', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(3000);

  const existing = await signedIn();
  if (existing.onChat && existing.auth) {
    log('already signed in from this profile');
  } else {
    const phoneInput = page.locator('input[placeholder="请输入手机号"]').first();
    await phoneInput.waitFor({ state: 'visible', timeout: 20_000 });
    await phoneInput.fill(phone);
    log('phone filled');

    const send = page.getByText(/发送验证码|获取验证码/).first();
    await send.click({ timeout: 10_000 });
    log('clicked 发送验证码 — check the phone for the SMS');

    let code = inlineCode.trim();
    const deadline = Date.now() + timeoutMs;
    while (!code && Date.now() < deadline) {
      if (existsSync(codeFile)) {
        const value = readFileSync(codeFile, 'utf8').trim();
        if (value) {
          code = value.replace(/\D/g, '');
          rmSync(codeFile, { force: true });
        }
      }
      if (!code) await new Promise((r) => setTimeout(r, 500));
    }
    if (!code) throw new Error(`no verification code arrived in ${timeoutMs / 1000}s (write it to ${codeFile})`);
    log(`code received (${code.length} digits)`);

    const codeInput = page.locator('input[placeholder="请输入验证码"]').first();
    await codeInput.waitFor({ state: 'visible', timeout: 10_000 });
    await codeInput.fill(code);

    const submit = page.getByRole('button', { name: /登录|登 录/ }).first();
    if (await submit.isVisible().catch(() => false)) {
      await submit.click();
      log('clicked the login button');
    } else {
      await codeInput.press('Enter');
      log('pressed Enter in the code field');
    }
  }

  // Wait for the app to leave the sign-in page (login success) or for the timeout.
  let state = await signedIn();
  const deadline = Date.now() + 120_000;
  while ((!state.onChat || !state.auth) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    state = await signedIn();
    if (Date.now() % 15_000 < 1600) log('still waiting for login to complete…', page.url());
  }

  if (!state.auth) {
    await page.screenshot({ path: resolve(rootDir, '.tmp/deepseek-login.png'), fullPage: true });
    throw new Error(`login did not produce an auth cookie; screenshot at .tmp/deepseek-login.png (url ${page.url()})`);
  }

  const all = await context.cookies(['https://chat.deepseek.com', 'https://api.deepseek.com', 'https://www.deepseek.com']);
  const header = cookieHeader(all.filter((c) => /deepseek\.com$/.test(c.domain.replace(/^\./, '')) || c.domain.includes('deepseek.com')));
  upsertEnv('DEEPSEEK_WEB_COOKIE', header);
  log(`exported DEEPSEEK_WEB_COOKIE (${header.length} chars, ${all.length} cookies) to .env.local`);
  log(`cookie names: ${all.map((c) => c.name).join(', ')}`);
  log('next: npm run secrets:sync && npm run functions:deploy');
} catch (err) {
  log(`FAILED: ${err.message}`);
  try {
    await page.screenshot({ path: resolve(rootDir, '.tmp/deepseek-login.png'), fullPage: true });
  } catch {
    /* ignore */
  }
  process.exitCode = 1;
} finally {
  if (!keepOpen) await context.close().catch(() => {});
}
