#!/usr/bin/env node
// Seed the admin-token hash the PostgREST credential path checks against.
//
//   node scripts/admin-secret.mjs           # write sha256(TOOLS_ADMIN_TOKEN)
//   node scripts/admin-secret.mjs --status  # is it there, and when was it set?
//   node scripts/admin-secret.mjs --check   # exit 1 if the DB hash does not match .env.local
//
// Only the digest is stored (tools_secret, service_role only) — the token itself stays out of
// the database. Without this row the hidden backend page cannot store a DeepSeek credential
// string while the Edge Function is undeployed; with it, pasting a string works over
// PostgREST alone.
import { connectDb, env, rpc, serviceRoleKey, supabaseUrl } from './lib.mjs';
import { createHash } from 'node:crypto';

const args = new Set(process.argv.slice(2));
const token = (env.TOOLS_ADMIN_TOKEN || '').trim();
const key = serviceRoleKey();

const digest = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const hint = (value) => `${value.slice(0, 2)}…${value.slice(-2)} (${value.length})`;

async function current() {
  // tools_secret is not selectable by anon, and the RPC only writes — read it back over SQL.
  const db = await connectDb();
  try {
    const row = await db.query("select name, algo, digest, hint, updated_at from public.tools_secret where name = 'admin_token'");
    return row.rows[0] ?? null;
  } finally {
    await db.end().catch(() => {});
  }
}

if (!supabaseUrl) {
  console.error('TOOLS_SUPABASE_URL is not set');
  process.exit(2);
}
if (!token) {
  console.error('TOOLS_ADMIN_TOKEN is not set in .env.local');
  process.exit(2);
}

const stored = await current();

if (args.has('--status')) {
  console.log(stored ? `admin_token: ${stored.algo}, hint ${stored.hint}, set ${stored.updated_at.toISOString()}` : 'admin_token: 未写入（跑 npm run admin:secret）');
  process.exit(0);
}

if (args.has('--check')) {
  const ok = stored && stored.digest === digest(token);
  console.log(ok ? 'admin secret matches .env.local' : `admin secret ${stored ? 'DIFFERS from' : 'missing —'} .env.local`);
  process.exit(ok ? 0 : 1);
}

const res = await rpc('tools_secret_set', {
  p_name: 'admin_token',
  p_digest: digest(token),
  p_hint: hint(token),
}, { key });

if (!res.body?.ok) {
  console.error(`failed: ${JSON.stringify(res.body).slice(0, 200)}`);
  process.exit(1);
}
console.log(`wrote sha256 of TOOLS_ADMIN_TOKEN (${hint(token)}) → tools_secret.admin_token`);
console.log('next: 在隐藏后台页（?admin=1）粘贴登录字符串，不需要 Edge Function');
