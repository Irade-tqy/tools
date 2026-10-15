// Experiment: our own stop path, end to end against the live relay.
//
//   node scripts/stop-path-probe.mjs
//
// Asks a question, cancels while the answer is still streaming the way the Stop button does, then
// reads back what the job row and chunks look like and whether the next message still knows what
// was going on. Two things are checked, because both were broken:
//
//   1. the conversation ids must reach the client *before* the transport finishes (upstream names
//      the message in its `ready` frame; deepseek_complete only writes them at the end, by which
//      time a Stop has already marked the job cancelled and the client has committed);
//   2. the follow-up must be continued from the truncated answer, and must still have the stopped
//      turn's reasoning — upstream keeps neither the reasoning nor the truncation unless the
//      relay posts /api/v0/chat/stop_stream.
import { anonKey, rpc, serviceRoleKey, supabaseUrl } from './lib.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const anon = { key: anonKey() };
const svc = { key: serviceRoleKey() };

const jobRow = async (id) =>
  (
    await fetch(`${supabaseUrl}/rest/v1/deepseek_job?select=status,session_id,reply_message_id,metrics,error&id=eq.${id}`, {
      headers: { apikey: svc.key, Authorization: `Bearer ${svc.key}` },
    }).then((r) => r.json())
  )[0];

async function snapshot(id, since = -1) {
  const body = (await rpc('deepseek_status', { p_job_id: id, p_since_seq: since }, anon)).body ?? {};
  let text = '';
  let thinking = '';
  let announced = null;
  for (const c of body.chunks ?? []) {
    if (typeof c.payload.text === 'string') text += c.payload.text;
    if (typeof c.payload.thinking === 'string') thinking += c.payload.thinking;
    if (!c.payload.done && c.payload.reply_message_id != null) announced = c.payload.reply_message_id;
  }
  return { text, thinking, announced, status: body.status, chunks: (body.chunks ?? []).length, reply: body.reply_message_id };
}

console.log('1) ask');
const asked = await rpc(
  'deepseek_ask',
  { p_prompt: '从 1 数到 400，每个数字一行，不要解释，不要停顿。', p_queue: 'default', p_model_type: 'default', p_thinking: true },
  anon,
);
const jobId = asked.body?.job_id;
console.log('   job', jobId, '— upstream history afterwards: node scripts/deepseek-history.mjs <session_id from the job row>');

console.log('2) wait until it starts streaming, then cancel mid-answer');
let seen = { text: '', thinking: '', chunks: 0 };
for (let i = 0; i < 60; i += 1) {
  await sleep(500);
  seen = await snapshot(jobId);
  if (seen.text.length >= 10) break; // long answer: the cancel lands while it is still generating
}
console.log('   status', seen.status);
console.log('   answer so far :', JSON.stringify(seen.text));
console.log('   thinking so far:', seen.thinking.length, 'chars, head', JSON.stringify(seen.thinking.slice(0, 34)));
// The ids chunk: the client needs these to continue, and a Stop commits the moment the job looks
// finished.
console.log('   ids announced in the stream:', JSON.stringify(seen.announced), '(job row says', JSON.stringify(seen.reply) + ')');

await rpc('deepseek_cancel', { p_job_id: jobId }, anon);
await sleep(6000);
const after = await snapshot(jobId);
const row = await jobRow(jobId);
console.log('3) after cancel: job', JSON.stringify({ status: row.status, reply: row.reply_message_id, error: row.error, chunks: row.metrics?.chunks }));
console.log('   answer the client kept:', JSON.stringify(after.text));

console.log('4) follow-up, continuing from the stopped message and carrying its reasoning');
const carry = [
  '（说明：上一轮你的回答被用户手动打断了。你当时的思考过程如下，请把它当作你自己还没说完的思路接着进行，不要重复它。）',
  `<thinking>${seen.thinking.slice(0, 1200)}</thinking>`,
  '',
  '两件事：(a) 把你上一条消息的最后几个数字逐字复述一遍；(b) 你刚才的思考里提到要数到几？',
].join('\n');
const next = await rpc(
  'deepseek_ask',
  {
    p_prompt: carry,
    p_queue: 'default',
    p_model_type: 'default',
    p_session_id: row.session_id,
    p_parent_message_id: row.reply_message_id ? Number(row.reply_message_id) : null,
  },
  anon,
);
const nextId = next.body?.job_id;
let out = { text: '', status: 'queued' };
for (let i = 0; i < 90; i += 1) {
  await sleep(1000);
  out = await snapshot(nextId);
  if (['done', 'error', 'cancelled'].includes(out.status)) break;
}
console.log('   status', out.status, 'error', JSON.stringify((await jobRow(nextId))?.error));
console.log('   answer:', JSON.stringify(out.text.slice(0, 320)));
console.log('');
console.log('   expected: (a) recites the numbers it had actually reached, not 400;');
console.log('             (b) knows the format from the reasoning it was handed.');
