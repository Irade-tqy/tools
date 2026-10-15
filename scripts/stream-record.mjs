#!/usr/bin/env node
// Record one live DeepSeek turn and diff the decoder against the raw frames.
//
//   node scripts/stream-record.mjs                      # thinking on, default model
//   node scripts/stream-record.mjs --prompt "…" --thinking off --model expert
//   node scripts/stream-record.mjs --out tests/fixtures/stream-live.txt
//
// Why: unit tests replay recorded streams, so a bug that only shows up on a *fresh* upstream
// stream (a frame shape we have never seen) is invisible to them. This writes the raw SSE to a
// fixture and then reports, side by side, what the decoder produced and what the frames
// actually contained — which is how "the answer is missing its first character" gets pinned to
// a specific frame instead of argued about.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env, rpc } from './lib.mjs';
import { parseCredential } from '../supabase/functions/_shared/credential.ts';
import { DeepSeekWebClient } from '../supabase/functions/_shared/web-client.ts';
import {
  ANSWER_TYPES,
  applyWebFrame,
  createWebFrameParser,
  createWebStreamState,
} from '../supabase/functions/_shared/web-stream.ts';

const args = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const prompt = flagValue('--prompt', '用一句话解释黎曼猜想');
const modelType = flagValue('--model', 'default');
const thinking = flagValue('--thinking', 'on') !== 'off';
const out = resolve(flagValue('--out', '.tmp/stream-live.txt'));

const key = env.TOOLS_SUPABASE_SERVICE_ROLE_KEY;
const row = key ? (await rpc('deepseek_credential_get', {}, { key })).body : null;
let credential = null;
if (row && typeof row.token === 'string' && row.token) {
  credential = {
    token: row.token,
    deviceId: typeof row.device_id === 'string' ? row.device_id : '',
    cookie: typeof row.cookie === 'string' ? row.cookie : '',
    userAgent: typeof row.user_agent === 'string' ? row.user_agent : '',
    source: 'db',
  };
} else {
  const parsed = parseCredential((env.DEEPSEEK_CREDENTIAL || env.DEEPSEEK_WEB_TOKEN || '').trim());
  if (!parsed.ok) {
    console.error(`no credential: ${parsed.error}`);
    process.exit(2);
  }
  credential = parsed.credential;
}

const client = new DeepSeekWebClient(credential);
const session = await client.createSession();
const res = await client.completion({
  prompt,
  chatSessionId: session.id,
  parentMessageId: null,
  modelType,
  thinking,
});

// Tee: the same bytes go to the fixture and to the decoder, so the fixture is exactly what the
// decoder saw.
const parse = createWebFrameParser();
const state = createWebStreamState();
const rawFrames = [];
const decoderFrames = [];
const feed = (frames) => {
  rawFrames.push(...frames);
  for (const f of frames) applyWebFrame(state, f, (d) => decoderFrames.push(d));
};

const reader = res.body.getReader();
const decoder = new TextDecoder();
let raw = '';
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  const text = decoder.decode(value, { stream: true });
  raw += text;
  feed(parse(text));
}
raw += decoder.decode();
feed(parse.flush());

writeFileSync(out, raw);

// --- what the frames say, independent of the decoder ------------------------------------
// Every frame that carries text, in arrival order, with the fragment it belongs to.
const fragType = new Map();
let currentId = null;
const rows = [];
for (const f of rawFrames) {
  let obj;
  try {
    obj = JSON.parse(f.data);
  } catch {
    continue;
  }
  if (typeof obj === 'string') {
    rows.push({ id: currentId, type: fragType.get(currentId) ?? '?', op: 'bare', text: obj });
    continue;
  }
  if (!obj || typeof obj !== 'object') continue;
  // {"v":"性"} is a whole-delta for the current fragment — the most common frame on the wire, so
  // an oracle that ignores it looks lossless while dropping most of the answer.
  if (typeof obj.v === 'string' && obj.p === undefined) {
    rows.push({ id: currentId, type: fragType.get(currentId) ?? '?', op: 'bare', text: obj.v });
    continue;
  }
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    if (typeof v.id === 'number' && typeof v.type === 'string') {
      fragType.set(v.id, v.type);
      currentId = v.id;
      if (typeof v.content === 'string') rows.push({ id: v.id, type: v.type, op: 'fragment', text: v.content });
    }
    for (const k of Object.keys(v)) walk(v[k]);
  };
  walk(obj.v);
  const path = typeof obj.p === 'string' ? obj.p : '';
  if (/content$/.test(path) && typeof obj.v === 'string') {
    rows.push({
      id: currentId,
      type: fragType.get(currentId) ?? '?',
      op: String(obj.o || '').toUpperCase(),
      text: obj.v,
    });
  }
}

const rawAnswer = rows
  .filter((r) => ANSWER_TYPES.has(r.type) || (r.type === '?' && r.op === 'bare'))
  .map((r) => r.text)
  .join('');

console.log(`recorded ${rawFrames.length} frames, ${raw.length} bytes -> ${out}`);
console.log(`upstream: finished=${state.finished} failed=${state.failed} mode=${state.mode}`);
console.log('');
console.log('decoder answer head :', JSON.stringify(state.text.slice(0, 40)));
console.log('raw frames answer   :', JSON.stringify(rawAnswer.slice(0, 40)));
console.log('identical           :', state.text === rawAnswer);
if (state.text !== rawAnswer) {
  // Show the first divergence — that is the frame the decoder mishandled.
  let i = 0;
  while (i < Math.min(state.text.length, rawAnswer.length) && state.text[i] === rawAnswer[i]) i += 1;
  console.log(`first divergence at ${i}:`);
  console.log('  decoder:', JSON.stringify(state.text.slice(i, i + 24)));
  console.log('  raw    :', JSON.stringify(rawAnswer.slice(i, i + 24)));
}
console.log('');
console.log('first 12 text-bearing frames:');
for (const r of rows.filter((x) => x.text).slice(0, 12)) {
  console.log(`  #${r.id} ${r.type.padEnd(9)} ${r.op.padEnd(8)} ${JSON.stringify(r.text.slice(0, 30))}`);
}
console.log('');
console.log('decoder thinking head :', JSON.stringify(state.thinking.slice(0, 40)));
