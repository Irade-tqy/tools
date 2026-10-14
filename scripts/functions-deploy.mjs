#!/usr/bin/env node
// Deploy supabase/functions/deepseek-chat with the Supabase CLI, wiring up the bits the CLI
// normally asks for interactively (project ref + access token).
//
//   node scripts/functions-deploy.mjs [--dry-run]
//
// Requires SUPABASE_ACCESS_TOKEN in .env.local (dashboard → Account → API Keys →
// Personal access token) and the secrets already pushed (npm run secrets:sync).
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { env, projectRef } from './lib.mjs';

const dryRun = process.argv.includes('--dry-run');

if (!projectRef) {
  console.error('TOOLS_SUPABASE_URL is not set — cannot derive the project ref');
  process.exit(1);
}
const args = ['functions', 'deploy', 'deepseek-chat', '--no-verify-jwt', '--project-ref', projectRef];

if (dryRun) {
  // The installed CLI has no --dry-run for `functions deploy` — passing it exits with
  // "Unrecognized flag" — and the flag used to be swallowed before the CLI ever ran, so the
  // dry run proved nothing. Check what can be checked offline instead: the function type-checks
  // under Deno, and the payload (the wasm is inlined as base64) stays inside the deploy limit.
  console.log('deno check supabase/functions/deepseek-chat/index.ts');
  try {
    execFileSync('deno', ['check', 'supabase/functions/deepseek-chat/index.ts'], { stdio: 'inherit' });
  } catch (err) {
    console.error(`deno check failed: ${err.message}`);
    process.exit(1);
  }
  const dir = 'supabase/functions';
  const files = [...readdirSync(`${dir}/_shared`).map((f) => `${dir}/_shared/${f}`), `${dir}/deepseek-chat/index.ts`];
  const total = files.reduce((sum, f) => sum + statSync(f).size, 0);
  for (const f of files.sort()) console.log(`  ${(statSync(f).size / 1024).toFixed(1).padStart(7)} KB  ${f}`);
  console.log(`  ${(total / 1024).toFixed(1).padStart(7)} KB  total source (Supabase limit is 4 MB per function)`);
  if (total > 4 * 1024 * 1024) {
    console.error('over the deploy size limit');
    process.exit(1);
  }
  console.log('ready to deploy — rerun without --dry-run once SUPABASE_ACCESS_TOKEN is set');
  process.exit(0);
}

if (!env.SUPABASE_ACCESS_TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN is not set in .env.local — see npm run secrets:sync -- --list');
  console.error('run `npm run functions:deploy -- --dry-run` to check the function without a token');
  process.exit(1);
}

console.log(`supabase ${args.join(' ')}`);

try {
  execFileSync('npx', ['--no-install', 'supabase', ...args], {
    stdio: 'inherit',
    env: { ...process.env, SUPABASE_ACCESS_TOKEN: env.SUPABASE_ACCESS_TOKEN },
  });
} catch (err) {
  console.error(`deploy failed: ${err.message}`);
  process.exit(1);
}

const url = `${env.TOOLS_SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/deepseek-chat`;
console.log(`\nfunction url: ${url}`);
console.log('verify:  curl -X POST that URL -H "apikey: $ANON" -d \'{"messages":[{"role":"user","content":"hi"}]}\'');
