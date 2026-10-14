#!/usr/bin/env node
// Run the Edge Function locally under Deno and drive it over HTTP — the same code that runs
// on Supabase, the same Postgres, the same DeepSeek upstream.
//
//   node scripts/function-local.mjs [--port 8091] [--keep-open]
//
// Needs deno on PATH (or DENO_BIN=/path/to/deno). Requires the migrations applied and a
// DeepSeek credential in .env.local (scripts/deepseek-credential.mjs).
//
// This is the pre-deploy gate: if it passes here, the deployed function behaves the same,
// because nothing in supabase/functions/deepseek-chat reads Deno globals except env + serve.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { env, mask } from './lib.mjs';

const args = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const port = Number(flagValue('--port', '8091'));
const keepOpen = args.includes('--keep-open');

const DENO = process.env.DENO_BIN || 'deno';
const ADMIN_TOKEN = env.TOOLS_ADMIN_TOKEN || 'local-dev-admin-token';
const results = [];

function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : `\n        ${String(detail).slice(0, 300)}`}`);
}

// Supabase's runtime calls Deno.serve() itself, so run the module (not `deno serve`, which
// wants `export default { fetch }`) and pass the port the way Deno.serve reads it: PORT.
const child = spawn(DENO, ['run', '--allow-env', '--allow-net', 'supabase/functions/deepseek-chat/index.ts'], {
  env: {
    ...process.env,
    PORT: String(port),
    SUPABASE_URL: env.TOOLS_SUPABASE_URL,
    SUPABASE_ANON_KEY: env.TOOLS_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: env.TOOLS_SUPABASE_SERVICE_ROLE_KEY,
    TOOLS_ADMIN_TOKEN: ADMIN_TOKEN,
    DEEPSEEK_CREDENTIAL: env.DEEPSEEK_CREDENTIAL || '',
    DENO_NO_UPDATE_CHECK: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => process.stderr.write(`[deno] ${chunk}`));
child.stderr.on('data', (chunk) => process.stderr.write(`[deno] ${chunk}`));

const url = `http://127.0.0.1:${port}/`;

async function call(body, token = env.TOOLS_SUPABASE_ANON_KEY) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: token, authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, res };
}

async function callJson(body) {
  const { status, res } = await call(body);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* SSE or html */
  }
  return { status, json, text };
}

async function streamTurn(body) {
  const { status, res } = await call(body);
  if (status !== 200) return { status, text: await res.text(), events: [] };
  const text = await res.text();
  const events = text
    .split('\n\n')
    .filter((frame) => frame.startsWith('data:'))
    .map((frame) => frame.slice(5).trim())
    .filter((data) => data && data !== '[DONE]')
    .map((data) => {
      try {
        return JSON.parse(data);
      } catch {
        return { raw: data };
      }
    });
  return { status, text, events };
}

// wait for the listener
let up = false;
for (let attempt = 0; attempt < 40 && !up; attempt += 1) {
  try {
    await callJson({ action: 'health' });
    up = true;
  } catch {
    await sleep(250);
  }
}

if (!up) {
  console.error('deno serve never came up — is deno installed? (DENO_BIN=/path/to/deno)');
  child.kill('SIGTERM');
  process.exit(2);
}

try {
  // 1. health
  const health = await callJson({ action: 'health' });
  check('health answers with the transport and credential state', health.status === 200 && health.json?.ok === true, health.text);
  check('health reports the credential as configured', health.json?.credential_configured === true, health.text);
  check('health says the admin actions are enabled', health.json?.admin_enabled === true, health.text);

  // 2. admin gate
  const badAdmin = await callJson({ action: 'credential_status', admin_token: 'wrong-token' });
  check('a wrong admin token gets 401', badAdmin.status === 401, badAdmin.text);
  const goodAdmin = await callJson({ action: 'credential_status', admin_token: ADMIN_TOKEN });
  check('the right admin token returns status without the token', goodAdmin.status === 200 && goodAdmin.json?.configured === true, goodAdmin.text);
  check('the credential itself is never returned to the client', !('token' in (goodAdmin.json ?? {})), goodAdmin.text);

  // 3. credential parsing over HTTP
  const badCred = await callJson({ action: 'credential_set', credential: 'total garbage', admin_token: ADMIN_TOKEN });
  check('an unparsable credential is rejected with a helpful message', badCred.status === 400 && /解析|no_token|unrecognized|token/.test(badCred.text), badCred.text);

  // 4. a real turn, new conversation
  const marker = `fn${Date.now().toString(36)}`;
  const turn1 = await streamTurn({
    prompt: `请记住这个代号：${marker}。只回复：好的`,
    model_type: 'default',
  });
  const done1 = turn1.events.find((e) => e.done);
  const answer1 = turn1.events.filter((e) => e.text).map((e) => e.text).join('');
  check('a new conversation streams an answer', turn1.status === 200 && answer1.length > 0, turn1.text);
  check('the done frame carries a session id and a reply message id', Boolean(done1?.session_id) && done1?.reply_message_id !== undefined, JSON.stringify(done1));
  check('the transport tag is edge-web', turn1.events.every((e) => !e._transport || e._transport === 'edge-web'));

  // 5. continue the same conversation
  const turn2 = await streamTurn({
    prompt: '我刚才让你记住的代号是什么？只回复代号',
    session_id: done1?.session_id,
    parent_message_id: done1?.reply_message_id,
  });
  const answer2 = turn2.events.filter((e) => e.text).map((e) => e.text).join('');
  const done2 = turn2.events.find((e) => e.done);
  check('continuing the session recalls the marker', answer2.includes(marker), `answer="${answer2}"`);
  check('the session id is stable across turns', done2?.session_id === done1?.session_id, JSON.stringify(done2));
  check('the reply id advances so the next turn can chain', Number(done2?.reply_message_id) > Number(done1?.reply_message_id), JSON.stringify(done2));

  // 6. a new conversation must not know the marker
  const turn3 = await streamTurn({ prompt: '我刚才让你记住的代号是什么？只回复代号' });
  const answer3 = turn3.events.filter((e) => e.text).map((e) => e.text).join('');
  const done3 = turn3.events.find((e) => e.done);
  check('a fresh session gets a different conversation id', done3?.session_id && done3.session_id !== done1?.session_id, JSON.stringify(done3));
  check('a fresh session does not know the marker', !answer3.includes(marker), `answer="${answer3}"`);

  // 7. tools are surfaced as a chip payload, not as answer text
  const searched = await streamTurn({ prompt: '今天上海天气怎么样？', search: true });
  const toolEvents = searched.events.filter((e) => e.tool);
  const searchedText = searched.events.filter((e) => e.text).map((e) => e.text).join('');
  const searchedDone = searched.events.find((e) => e.done);
  check('a search turn emits tool events', toolEvents.length > 0, searched.text.slice(0, 200));
  check('tool labels stay out of the answer', !/搜索到\s*\d+\s*个网页/.test(searchedText), searchedText.slice(0, 200));
  check('the done frame reports the tool summary', (searchedDone?.tools?.length ?? 0) > 0, JSON.stringify(searchedDone));

  // 8. the job row carries the session ids, so a client that only polls can still continue
  const { rpc } = await import('./lib.mjs');
  const row = await rpc('deepseek_status', { p_job_id: done1?.job_id, p_since_seq: -1 });
  check('the done frame carries the job id', Boolean(done1?.job_id), JSON.stringify(done1));
  check('the job row stores the conversation ids', row.body?.session_id === done1?.session_id, JSON.stringify(row.body).slice(0, 300));
  check('the job row stores the reply id for the next turn', row.body?.reply_message_id === String(done1?.reply_message_id), JSON.stringify(row.body).slice(0, 300));
  check('the job row keeps the prompt and the auto-generated title', row.body?.prompt?.includes(marker) && Boolean(row.body?.title), JSON.stringify(row.body).slice(0, 300));
  check('the job records upstream timings for the latency budget', Number(row.body?.metrics?.upstream_ttft_ms) > 0, JSON.stringify(row.body?.metrics));
} finally {
  if (!keepOpen) child.kill('SIGTERM');
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
if (keepOpen) {
  console.log(`function still listening on ${url} (POST JSON to it)`);
  console.log(`admin token: ${mask(ADMIN_TOKEN)}`);
}
