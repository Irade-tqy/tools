#!/usr/bin/env node
// Turn one pasted string into a working DeepSeek credential.
//
//   npm run deepseek:credential -- '<userToken | Copy as cURL | cookie | JSON>'
//   npm run deepseek:credential -- --show          # print the canonical string in use
//   npm run deepseek:credential -- --status        # what the server currently holds
//   npm run deepseek:credential -- --from-file f   # read the string from a file
//   npm run deepseek:credential -- --local         # only write .env.local
//   npm run deepseek:credential -- --no-verify     # skip the live upstream check
//   npm run deepseek:credential -- --quiet         # print nothing but the canonical string
//
// The string is parsed by supabase/functions/_shared/credential.ts (same code the Edge
// Function and the web admin use), checked against the live API, stored in .env.local as
// DEEPSEEK_CREDENTIAL, and pushed to the database so the Edge Function picks it up without
// a redeploy. The canonical `dscred1:…` string is printed at the end: that is the reusable
// string to keep, paste elsewhere, or hand to someone else.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env, mask, rootDir, rpc, serviceRoleKey, upsertEnvLocal } from './lib.mjs';
import { fingerprint, parseCredential, serializeCredential } from '../supabase/functions/_shared/credential.ts';
import { DeepSeekWebClient } from '../supabase/functions/_shared/web-client.ts';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--from-file');
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : '';
};

const quiet = flags.has('--quiet');
const say = (...parts) => {
  if (!quiet) console.log(...parts);
};

if (flags.has('--show')) {
  const raw = env.DEEPSEEK_CREDENTIAL || env.DEEPSEEK_WEB_TOKEN || env.DEEPSEEK_WEB_COOKIE || '';
  if (!raw) {
    console.error('no credential in .env.local');
    process.exit(1);
  }
  const parsed = parseCredential(raw);
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exit(1);
  }
  const canonical = serializeCredential(parsed.credential);
  if (quiet) console.log(canonical);
  else {
    console.log(`parsed from: ${parsed.credential.source}`);
    console.log(`token:       ${fingerprint(parsed.credential)}`);
    console.log(`device id:   ${parsed.credential.deviceId || '(none)'}`);
    console.log(`cookie:      ${parsed.credential.cookie ? `${parsed.credential.cookie.length} chars` : '(none)'}`);
    console.log(`\nusable string:\n${canonical}`);
  }
  process.exit(0);
}

if (flags.has('--status')) {
  const out = await rpc('deepseek_credential_status', {}, { key: serviceRoleKey() });
  console.log(JSON.stringify(out.body, null, 2));
  process.exit(out.ok ? 0 : 1);
}

const fromFile = flagValue('--from-file');
const raw = fromFile
  ? readFileSync(resolve(rootDir, fromFile), 'utf8')
  : positional.join(' ') || (!process.stdin.isTTY ? readFileSync(0, 'utf8') : '');

if (!raw || !raw.trim()) {
  console.error(
    'usage: npm run deepseek:credential -- "<string>"\n' +
      '       accepts localStorage.userToken, DevTools “Copy as cURL”, a Cookie header, JSON, or a dscred1: string',
  );
  process.exit(2);
}

const parsed = parseCredential(raw);
if (!parsed.ok) {
  console.error(`cannot parse: ${parsed.error}`);
  process.exit(2);
}

const credential = parsed.credential;
const canonical = serializeCredential(credential);

say(`format:      ${credential.source}`);
say(`token:       ${fingerprint(credential)}`);
say(`device id:   ${credential.deviceId || '(none)'}`);
say(`cookie:      ${credential.cookie ? `${credential.cookie.length} chars` : '(none)'}`);
for (const warning of parsed.warnings) say(`note:        ${warning}`);

if (!flags.has('--no-verify')) {
  const client = new DeepSeekWebClient(credential);
  try {
    const t0 = Date.now();
    const challenge = await client.powChallenge();
    say(`verify:      ok — challenge accepted in ${Date.now() - t0}ms (difficulty ${challenge.difficulty})`);
  } catch (err) {
    console.error(`verify failed: ${err.message}`);
    console.error('             the credential was NOT stored');
    process.exit(3);
  }
}

upsertEnvLocal('DEEPSEEK_CREDENTIAL', canonical);
say(`written:     .env.local → DEEPSEEK_CREDENTIAL`);

if (!flags.has('--local')) {
  const out = await rpc(
    'deepseek_credential_set',
    {
      p_token: credential.token,
      p_device_id: credential.deviceId || null,
      p_cookie: credential.cookie || null,
      p_user_agent: credential.userAgent || null,
      p_source: credential.source,
      p_note: flags.has('--no-verify') ? 'stored without a live check' : 'verified against create_pow_challenge',
    },
    { key: serviceRoleKey() },
  );
  if (!out.body?.ok) {
    console.error(`database: ${JSON.stringify(out.body).slice(0, 300)}`);
    console.error('          stored locally only — is the migration applied and TOOLS_SUPABASE_SERVICE_ROLE_KEY set?');
    process.exit(4);
  }
  say('database:    updated (the Edge Function reads it on the next request)');
}

say('\nusable string:');
if (quiet) process.stdout.write(`${canonical}\n`);
else process.stdout.write(`${canonical}\n`);
