#!/usr/bin/env node
// End-to-end test for the self-hosted relay (scripts/deepseek-worker.mjs).
//
//   node scripts/worker-test.mjs [--keep-open]
//
// Starts a real worker against the live Supabase project, then drives it exactly like the
// deployed site does: queue a turn with deepseek_ask(), read the answer back out of
// deepseek_chunk (the Realtime/polling path — no SSE here), and check the conversation ids
// that let the next turn continue. Real DeepSeek upstream, no mocks.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { anonKey, clearDeepseekBacklog, rpc } from './lib.mjs';

const args = process.argv.slice(2);
const keepOpen = args.includes('--keep-open');
const results = [];

function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond });
  const note = typeof detail === 'string' ? detail : JSON.stringify(detail ?? null);
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : `\n        ${String(note).slice(0, 300)}`}`);
}

const key = anonKey();
const call = (fn, payload = {}) => rpc(fn, payload, { key });

// A dead relay's leftover rows count against deepseek_ask's backlog limit, so start clean.
const backlog = await clearDeepseekBacklog({ workerId: 'worker-test' });
if (backlog.closed || backlog.drained) console.log(`cleared backlog: ${backlog.closed} stale, ${backlog.drained} queued`);

const worker = spawn(process.execPath, ['scripts/deepseek-worker.mjs', '--worker-id', `test-${Date.now().toString(36)}`, '--idle-ms', '300'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
const workerLog = [];
const capture = (chunk) => {
  const text = String(chunk);
  workerLog.push(...text.split('\n').filter(Boolean));
  if (process.env.WORKER_TEST_VERBOSE) process.stderr.write(`[worker] ${text}`);
};
worker.stdout.on('data', capture);
worker.stderr.on('data', capture);

/** Queue one turn and wait for the worker to finish it, collecting the streamed chunks. */
async function turn(input) {
  const enqueued = await call('deepseek_ask', {
    p_prompt: input.prompt,
    p_session_id: input.sessionId ?? null,
    p_parent_message_id: input.parentId ? Number(input.parentId) : null,
    p_model_type: input.modelType ?? 'default',
    p_thinking: Boolean(input.thinking),
    p_search: Boolean(input.search),
  });
  if (!enqueued.body?.ok) return { ok: false, error: enqueued.body?.error, jobId: null, text: '', tools: [], status: {} };

  const jobId = enqueued.body.job_id;
  let sinceSeq = -1;
  let status = {};
  const text = [];
  const tools = [];
  const payloads = [];

  for (let attempt = 0; attempt < 160; attempt += 1) {
    const res = await call('deepseek_status', { p_job_id: jobId, p_since_seq: sinceSeq });
    status = res.body ?? {};
    for (const chunk of status.chunks ?? []) {
      if (chunk.seq > sinceSeq) sinceSeq = chunk.seq;
      payloads.push(chunk.payload);
      if (chunk.payload?.text) text.push(chunk.payload.text);
      if (chunk.payload?.tool) tools.push(chunk.payload.tool);
    }
    if (status.finished) break;
    await sleep(500);
  }

  // deepseek_status only returns chunks newer than p_since_seq, so the done frame has to be
  // picked out of everything collected along the way, not just the last response.
  const done = payloads.filter((p) => p?.done).pop();
  return {
    ok: status.status === 'done',
    jobId,
    text: text.join(''),
    tools,
    status,
    done,
    transport: status.transport ?? done?._transport,
  };
}

try {
  // 1. the worker is alive before any turn runs (deepseek_claim doubles as the heartbeat)
  let health = await call('deepseek_health');
  for (let attempt = 0; attempt < 30 && !(Number(health.body?.workers_alive) >= 1); attempt += 1) {
    await sleep(500);
    health = await call('deepseek_health');
  }
  check('a live worker shows up in deepseek_health.workers_alive', Number(health.body?.workers_alive) >= 1, JSON.stringify(health.body));

  // 2. a brand-new conversation
  const marker = `box${Date.now().toString(36)}`;
  const first = await turn({ prompt: `请记住这个代号：${marker}。只回复：好的` });
  check('a queued turn is served and streams an answer', first.ok && first.text.length > 0, first.status);
  check('the answer arrives through deepseek_chunk (no SSE needed)', first.text.length > 0, first.text);
  check('the done frame carries a session id and a reply message id', Boolean(first.done?.session_id) && first.done?.reply_message_id !== undefined, JSON.stringify(first.done));
  check('the chunk transport is tagged worker-web', first.transport === 'worker-web' || first.done?._transport === 'worker-web', String(first.transport));

  // 3. continue the same conversation
  const second = await turn({
    prompt: '我刚才让你记住的代号是什么？只回复代号',
    sessionId: first.done?.session_id,
    parentId: first.done?.reply_message_id,
  });
  check('continuing the session recalls the marker', second.text.includes(marker), `answer="${second.text}"`);
  check('the session id is stable across turns', second.done?.session_id === first.done?.session_id, JSON.stringify(second.done));
  check('the reply id advances so the next turn can chain', Number(second.done?.reply_message_id) > Number(first.done?.reply_message_id), JSON.stringify(second.done));

  // 4. a new conversation must not know the marker
  const third = await turn({ prompt: '我刚才让你记住的代号是什么？只回复代号' });
  check('a fresh session gets a different conversation id', Boolean(third.done?.session_id) && third.done.session_id !== first.done?.session_id, JSON.stringify(third.done));
  check('a fresh session does not know the marker', !third.text.includes(marker), `answer="${third.text}"`);

  // 5. tools are reported as a chip payload, never as answer text
  const searched = await turn({ prompt: '今天上海天气怎么样？', search: true });
  check('a search turn emits tool chunks', searched.tools.length > 0, searched.status);
  check('tool labels stay out of the answer', !/搜索到\s*\d+\s*个网页/.test(searched.text), searched.text.slice(0, 200));
  check('the done frame reports the tool summary', (searched.done?.tools?.length ?? 0) > 0, searched.done);

  // 6. the job row keeps what the UI needs to keep talking
  check('the job row stores the conversation ids', searched.status.session_id === searched.done?.session_id, searched.status);
  check('the job row keeps the prompt and the auto-generated title', String(searched.status.prompt || '').includes('上海') && Boolean(searched.status.title), searched.status);
  check('the job records upstream timings for the latency budget', Number(searched.status.metrics?.upstream_ttft_ms) > 0, JSON.stringify(searched.status.metrics));
  check('the worker reports the credential origin', searched.status.metrics?.credential_origin === 'database', JSON.stringify(searched.status.metrics));
} finally {
  if (keepOpen) {
    console.log('worker still running (Ctrl-C to stop)');
  } else {
    worker.kill('SIGTERM');
    await sleep(200);
    if (!worker.killed) worker.kill('SIGKILL');
  }
}

const failed = results.filter((r) => !r.pass);
if (failed.length) {
  console.log('\nworker output:');
  for (const line of workerLog.slice(-25)) console.log(`  ${line}`);
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
