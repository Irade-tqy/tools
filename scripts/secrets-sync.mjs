#!/usr/bin/env node
// Push DeepSeek transport credentials into Supabase's Edge Function secret store so they
// never touch the repo. Reads .env.local (or the shell environment) and calls the
// Management API with SUPABASE_ACCESS_TOKEN.
//
//   node scripts/secrets-sync.mjs [--dry-run] [--list]
import { env, projectRef, requireEnv } from './lib.mjs';

const KEYS = [
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_WEB_COOKIE',
  'DEEPSEEK_API_URL',
  'DEEPSEEK_EXTRA_HEADERS',
  'DEEPSEEK_USER_AGENT',
];

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const listOnly = args.has('--list');

const present = KEYS.filter((key) => (env[key] || '').trim());
const missing = KEYS.filter((key) => !(env[key] || '').trim());

console.log(`project: ${projectRef}`);
for (const key of present) {
  const value = env[key].trim();
  const shown = key === 'DEEPSEEK_API_URL' || key === 'DEEPSEEK_EXTRA_HEADERS' || key === 'DEEPSEEK_USER_AGENT'
    ? value
    : `${value.slice(0, 6)}…${value.slice(-4)} (${value.length} chars)`;
  console.log(`  set   ${key} = ${shown}`);
}
for (const key of missing) console.log(`  unset ${key}`);

if (listOnly) process.exit(0);

if (!present.length) {
  console.error('\nnothing to push — add DEEPSEEK_API_KEY or DEEPSEEK_WEB_COOKIE to .env.local');
  process.exit(1);
}

if (dryRun) {
  console.log('\n(dry run) nothing sent');
  process.exit(0);
}

const token = (() => {
  try {
    return requireEnv('SUPABASE_ACCESS_TOKEN');
  } catch {
    return '';
  }
})();

if (!token) {
  console.error(
    '\nSUPABASE_ACCESS_TOKEN is not set. Get one from the Supabase dashboard ' +
      '(Account → API Keys → Personal access token), add it to .env.local, then re-run.\n' +
      'Alternative: paste the values in Dashboard → Project Settings → Edge Functions → Secrets.',
  );
  process.exit(1);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/secrets`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(present.map((key) => ({ name: key, value: env[key].trim() }))),
});

const text = await res.text();
if (!res.ok) {
  console.error(`failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  process.exit(1);
}
console.log(`\npushed ${present.length} secret(s) to ${projectRef}`);
console.log('next: npm run functions:deploy');
