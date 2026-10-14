#!/usr/bin/env node
// Deploy supabase/functions/deepseek-chat with the Supabase CLI, wiring up the bits the CLI
// normally asks for interactively (project ref + access token).
//
//   node scripts/functions-deploy.mjs [--dry-run]
//
// Requires SUPABASE_ACCESS_TOKEN in .env.local (dashboard → Account → API Keys →
// Personal access token) and the secrets already pushed (npm run secrets:sync).
import { execFileSync } from 'node:child_process';
import { env, projectRef } from './lib.mjs';

const dryRun = process.argv.includes('--dry-run');

if (!projectRef) {
  console.error('TOOLS_SUPABASE_URL is not set — cannot derive the project ref');
  process.exit(1);
}
if (!env.SUPABASE_ACCESS_TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN is not set in .env.local — see npm run secrets:sync -- --list');
  process.exit(1);
}

const args = ['functions', 'deploy', 'deepseek-chat', '--no-verify-jwt', '--project-ref', projectRef];
if (dryRun) args.push('--dry-run');

console.log(`supabase ${args.join(' ')}`);
if (dryRun) process.exit(0);

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
