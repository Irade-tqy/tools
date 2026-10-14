#!/usr/bin/env node
// Prototype of the DeepSeek web upstream call, run outside the browser.
//
// The web app authenticates with `Authorization: Bearer <localStorage.userToken>` and gates
// /api/v0/chat/completion with a proof-of-work header (x-ds-pow-response). The PoW rule is
// SHA3-based and implemented in a 26 KB wasm (fe-static.deepseek.com/chat/static/sha3_wasm_bg.*.wasm,
// zero imports), so we vendor it and call it directly instead of reverse-engineering the rule.
//
//   node scripts/deepseek-pow-node.mjs [--prompt "..."] [--thinking] [--search] [--json]
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback = '') => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const value = args[i + 1];
  return value && !value.startsWith('--') ? value : fallback;
};

const TOKEN = (env.DEEPSEEK_WEB_TOKEN || '').trim();
if (!TOKEN) {
  console.error('DEEPSEEK_WEB_TOKEN missing — finish login in scripts/browser-relay.mjs and press 导出 Cookie');
  process.exit(2);
}
const DEVICE = (env.DEEPSEEK_DEVICE_ID || '28abc89b-c6db-4fed-be58-615e18be02f1').trim();
const PROMPT = flag('--prompt', 'reply with the single word OK');
const THINKING = args.includes('--thinking');
const SEARCH = args.includes('--search');
const BASE = 'https://chat.deepseek.com';

const HEADERS = {
  'content-type': 'application/json',
  accept: '*/*',
  authorization: `Bearer ${TOKEN}`,
  'x-client-version': '2.5.0',
  'x-client-platform': 'web',
  'x-client-bundle-id': 'com.deepseek.chat',
  'x-client-locale': 'zh_CN',
  'x-client-timezone-offset': '-14400',
  'x-device-id': DEVICE,
  'x-device-model': '',
  origin: 'https://chat.deepseek.com',
  referer: 'https://chat.deepseek.com/',
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
};

async function api(path, body, extra = {}) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { ...HEADERS, ...extra },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* html from the WAF */
  }
  if (!res.ok || (json && json.code !== 0)) {
    const biz = json?.data?.biz_code;
    throw new Error(`${path}: HTTP ${res.status} code=${json?.code} biz=${biz} msg=${json?.msg || json?.data?.biz_msg || text.slice(0, 160)}`);
  }
  return json.data?.biz_data ?? json.data ?? json;
}

// ---- wasm PoW ---------------------------------------------------------------
const wasmBytes = readFileSync(resolve(here, 'vendor/sha3_wasm_bg.wasm'));
const { instance } = await WebAssembly.instantiate(wasmBytes, {});
const ex = instance.exports;
const encoder = new TextEncoder();

function writeString(value) {
  const bytes = encoder.encode(value);
  const ptr = ex.__wbindgen_export_0(bytes.length, 1) >>> 0;
  new Uint8Array(ex.memory.buffer).subarray(ptr, ptr + bytes.length).set(bytes);
  return { ptr, len: bytes.length };
}

function solvePow(challenge) {
  const stack = ex.__wbindgen_add_to_stack_pointer(-16);
  const a = writeString(challenge.challenge);
  const b = writeString(`${challenge.salt}_${challenge.expire_at}_`);
  ex.wasm_solve(stack, a.ptr, a.len, b.ptr, b.len, challenge.difficulty);
  const view = new DataView(ex.memory.buffer);
  // The wasm's success flag is inverted: it stores `flag ^ 1`, so 1 means "solution found" and 0
  // means "no solution" (the JS glue does `return 0 === status ? undefined : answer`).
  const found = view.getInt32(stack, true) === 1;
  const answer = view.getFloat64(stack + 8, true);
  ex.__wbindgen_add_to_stack_pointer(16);
  if (!found || !Number.isFinite(answer)) throw new Error('wasm_solve found no solution');
  return Math.trunc(answer);
}

function powHeader(challenge, answer) {
  const payload = {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: '/api/v0/chat/completion',
  };
  return btoa(JSON.stringify(payload));
}

// ---- run --------------------------------------------------------------------
const t0 = Date.now();
const rawChallenge = await api('/api/v0/chat/create_pow_challenge', { target_path: '/api/v0/chat/completion' });
const challenge = rawChallenge.challenge ?? rawChallenge;
const tChallenge = Date.now();
const answer = solvePow(challenge);
const tSolve = Date.now();
const session = await api('/api/v0/chat_session/create', {});
const sessionId = session.chat_session?.id ?? session.id;
const tSession = Date.now();
const res = await fetch(`${BASE}/api/v0/chat/completion`, {
  method: 'POST',
  headers: { ...HEADERS, 'x-ds-pow-response': powHeader(challenge, answer) },
  body: JSON.stringify({
    chat_session_id: sessionId,
    parent_message_id: null,
    model_type: 'default',
    prompt: PROMPT,
    ref_file_ids: [],
    thinking_enabled: THINKING,
    search_enabled: SEARCH,
    action: null,
    preempt: false,
  }),
});
const tFirstByte = Date.now();
const contentType = res.headers.get('content-type') || '';
if (!res.ok) {
  console.error(`completion HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}

let text = '';
let thinking = '';
let events = 0;
let firstDelta = 0;
let rawHead = '';
let finished = false;
let lastFragmentId = null;
const fragLengths = new Map();
const eventNames = new Set();
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  if (args.includes('--dump')) process.stderr.write(decoder.decode(value, { stream: true }));
  if (rawHead.length < 600) rawHead += buffer.slice(0, 600 - rawHead.length);
  const parts = buffer.split('\n\n');
  buffer = parts.pop() || '';
  for (const part of parts) {
    const lines = part.split('\n');
    let name = 'message';
    let payload = '';
    for (const l of lines) {
      if (l.startsWith('event:')) name = l.slice(6).trim();
      else if (l.startsWith('data:')) payload += l.slice(5).trim();
    }
    eventNames.add(name);
    if (!payload || payload === '[DONE]') continue;
    events += 1;
    try {
      const obj = JSON.parse(payload);
      const code = obj.code ?? 0;
      if (code !== 0) {
        console.error(`event ${name} code ${code}: ${obj.msg}`);
        process.exit(1);
      }
      // The web stream mixes full snapshots with JSON-patch deltas:
      //   {v:{response:{fragments:[{type,content,stage_id}]}}}   snapshot
      //   {p:"response/fragments/-1/content",o:"APPEND",v:"…"}    delta
      //   {p:"response/status",o:"SET",v:"FINISHED"}              done
      const emit = (kind, chunk) => {
        if (!chunk) return;
        if (!firstDelta) firstDelta = Date.now();
        if (kind === 'THINKING') thinking += chunk;
        else {
          text += chunk;
          process.stdout.write(chunk);
        }
      };
      // The web stream mixes three shapes:
      //   {v:"…"}                                            content delta
      //   {v:{response:{fragments:[{id,type,content}]}}}     snapshot (first fragment)
      //   {p:"response/fragments/-1/content",o:"APPEND",v:…} patch delta
      //   {p:"response/status",o:"SET",v:"FINISHED"}         end of turn
      if (obj.p === undefined && typeof obj.v === 'string') {
        const key = `frag:${lastFragmentId}`;
        fragLengths.set(key, (fragLengths.get(key) || 0) + obj.v.length);
        emit('RESPONSE', obj.v);
        continue;
      }
      if (obj.o === 'APPEND' && String(obj.p || '').endsWith('/content')) {
        const chunk = typeof obj.v === 'string' ? obj.v : '';
        if (chunk) {
          // APPEND targets the last fragment; keep its length so the next snapshot does not
          // replay the same text.
          const key = `frag:${lastFragmentId}`;
          fragLengths.set(key, (fragLengths.get(key) || 0) + chunk.length);
          emit('RESPONSE', chunk);
        }
        continue;
      }
      const response = obj.v?.response;
      if (response && Array.isArray(response.fragments)) {
        for (const f of response.fragments) {
          if (typeof f.content !== 'string') continue;
          const key = `frag:${f.id}`;
          lastFragmentId = f.id;
          const seen = fragLengths.get(key) || 0;
          if (f.content.length <= seen) continue;
          const chunk = f.content.slice(seen);
          fragLengths.set(key, f.content.length);
          emit(f.type, chunk);
        }
        continue;
      }
      if (obj.o === 'BATCH' && Array.isArray(obj.v)) {
        for (const op of obj.v) {
          if (op.p === 'error' && op.v) console.error('stream error:', JSON.stringify(op.v).slice(0, 300));
        }
        continue;
      }
      if (obj.p === 'response/status' && obj.v === 'FINISHED') finished = true;
    } catch {
      /* keep-alive or non-json frame */
    }
  }
}
const tEnd = Date.now();
process.stdout.write('\n');
if (!text) console.log(`no content deltas; raw head: ${rawHead.slice(0, 1200)}`);
console.log(
  JSON.stringify(
    {
      ok: true,
      finished,
      contentType,
      events,
      eventNames: [...eventNames],
      chars: text.length,
      thinkingChars: thinking.length,
      timingsMs: {
        challenge: tChallenge - t0,
        powSolve: tSolve - tChallenge,
        session: tSession - tSolve,
        firstByte: tFirstByte - tSession,
        firstDelta: firstDelta ? firstDelta - tFirstByte : null,
        total: tEnd - t0,
      },
      answer,
      difficulty: challenge.difficulty,
    },
    null,
    2,
  ),
);
