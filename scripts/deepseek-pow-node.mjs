#!/usr/bin/env node
// Reproduce the DeepSeek web upstream outside the browser, including tool calls.
//
// The web app authenticates with `Authorization: Bearer <localStorage.userToken>` and gates
// /api/v0/chat/completion with a proof-of-work header (x-ds-pow-response). The PoW is computed by
// a 26 KB wasm (fe-static.deepseek.com/chat/static/sha3_wasm_bg.*.wasm, zero imports) which is
// vendored under scripts/vendor, so we call it instead of reimplementing DeepSeekHashV1.
//
//   node scripts/deepseek-pow-node.mjs [--prompt "..."] [--thinking] [--search]
//                                      [--model default|expert|vision] [--dump]
//
// The stream carries one message as several fragment types (read out of the app's own constants):
//   RESPONSE / TEMPLATE_RESPONSE   the answer text
//   THINK                          reasoning
//   SEARCH                         web search: queries + results (each result has cite_index)
//   TOOL_SEARCH / TOOL_OPEN / TOOL_FIND   deep-search (expert mode) tool calls
//   TIP / FILE                     hints and attachments
// Only RESPONSE is the answer; everything else is metadata and must not be concatenated into it.
// `[citation:N]` in the answer resolves to the result whose cite_index === N (the app does the
// same via convertCiteIndexToListIndex), so results are keyed by cite_index, not by arrival order.
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
  console.error('DEEPSEEK_WEB_TOKEN missing — log in via `npm run deepseek:relay`, then press 导出 Cookie');
  process.exit(2);
}
const DEVICE = (env.DEEPSEEK_DEVICE_ID || '28abc89b-c6db-4fed-be58-615e18be02f1').trim();
const PROMPT = flag('--prompt', 'reply with the single word OK');
const MODEL = flag('--model', 'default');
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
    throw new Error(
      `${path}: HTTP ${res.status} code=${json?.code} biz=${json?.data?.biz_code} msg=${json?.msg || json?.data?.biz_msg || text.slice(0, 160)}`,
    );
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
  // The wasm stores `flag ^ 1`, so 1 means "solution found" (the JS glue reads
  // `0 === status ? undefined : answer`).
  const found = view.getInt32(stack, true) === 1;
  const answer = view.getFloat64(stack + 8, true);
  ex.__wbindgen_add_to_stack_pointer(16);
  if (!found || !Number.isFinite(answer)) throw new Error('wasm_solve found no solution');
  return Math.trunc(answer);
}

function powHeader(challenge, answer) {
  return btoa(JSON.stringify({
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: '/api/v0/chat/completion',
  }));
}

// ---- stream classification --------------------------------------------------
const ANSWER_TYPES = new Set(['RESPONSE', 'TEMPLATE_RESPONSE']);
const THINK_TYPES = new Set(['THINK']);
const TOOL_TYPES = new Set(['SEARCH', 'TOOL_SEARCH', 'TOOL_OPEN', 'TOOL_FIND', 'TIP', 'FILE']);

const state = {
  text: '',
  thinking: '',
  finished: false,
  failed: null,
  mode: 'DEFAULT',
  searchTriggered: false,
  tools: [],
  // [reference:N] resolves to the N-th TOOL_OPEN fragment in arrival order (0-based), which is
  // how the app's markdown plugin treats `\[reference:(\d+)\]`.
  opened: [],
  firstDelta: 0,
  currentId: null,
  fragments: new Map(), // id -> {type, len}
};

function toolFor(id, type) {
  let tool = state.tools.find((t) => t.id === id);
  if (!tool) {
    tool = { id, type, status: 'WIP', content: '', queries: [], results: [], result: null };
    state.tools.push(tool);
  }
  if (type) tool.type = type;
  return tool;
}

function appendContent(id, chunk) {
  if (!chunk) return;
  const frag = state.fragments.get(id) || { type: 'RESPONSE', len: 0 };
  frag.len += chunk.length;
  state.fragments.set(id, frag);
  if (TOOL_TYPES.has(frag.type)) {
    toolFor(id, frag.type).content += chunk;
    return;
  }
  if (THINK_TYPES.has(frag.type)) {
    state.thinking += chunk;
    return;
  }
  if (!state.firstDelta) state.firstDelta = Date.now();
  state.text += chunk;
  process.stdout.write(chunk);
}

function registerFragment(f) {
  if (!f || typeof f !== 'object' || f.id === undefined) return;
  state.currentId = f.id;
  const frag = state.fragments.get(f.id) || { type: f.type, len: 0 };
  frag.type = f.type || frag.type;
  state.fragments.set(f.id, frag);
  if (TOOL_TYPES.has(frag.type)) {
    const tool = toolFor(f.id, frag.type);
    if (f.status) tool.status = f.status;
    for (const q of f.queries || []) if (q?.query) tool.queries.push(q.query);
    for (const r of f.results || []) if (!tool.results.includes(r)) tool.results.push(r);
    if (f.result) tool.result = f.result;
    if (frag.type === 'TOOL_OPEN' && !state.opened.some((o) => o.id === f.id)) {
      state.opened.push({ id: f.id, url: f.result?.url ?? null });
    }
  }
  if (typeof f.content === 'string' && f.content.length > frag.len) {
    appendContent(f.id, f.content.slice(frag.len));
  }
}

function currentTool() {
  // Only SEARCH / TOOL_* fragments carry tool payloads; a `/status` patch on a RESPONSE fragment
  // must not create a phantom tool entry.
  const frag = state.fragments.get(state.currentId);
  if (!frag || !TOOL_TYPES.has(frag.type)) return null;
  return toolFor(state.currentId, frag.type);
}

function setContent(id, value) {
  // A BATCH sets a fragment's content outright (the SEARCH fragment gets its "搜索到 N 个网页"
  // label this way); emit only the part the stream has not already delivered.
  if (typeof value !== 'string') return;
  const frag = state.fragments.get(id) || { type: 'RESPONSE', len: 0 };
  if (value.length <= frag.len) return;
  appendContent(id, value.slice(frag.len));
}

// `base` says what a relative sub-path inside a BATCH refers to: the last fragment or the message.
function applyPatch(obj, base = 'fragment') {
  const path = String(obj.p || '');
  const onFragment = path.startsWith('response/fragments') || base === 'fragment';
  // Tool payloads arrive as patches on the last fragment: results (SEARCH / TOOL_SEARCH),
  // a single result (TOOL_OPEN), or a status flip.
  if (path === 'content' || path.endsWith('/content')) {
    if (obj.o === 'APPEND') appendContent(state.currentId, typeof obj.v === 'string' ? obj.v : '');
    else setContent(state.currentId, obj.v);
    return true;
  }
  if (path === 'results' || path.endsWith('/results')) {
    const tool = currentTool();
    if (tool && Array.isArray(obj.v)) for (const r of obj.v) if (!tool.results.includes(r)) tool.results.push(r);
    return true;
  }
  if (path === 'result' || path.endsWith('/result')) {
    const tool = currentTool();
    if (tool && obj.v && typeof obj.v === 'object') {
      tool.result = obj.v;
      const opened = state.opened.find((o) => o.id === tool.id);
      if (opened && obj.v.url) opened.url = obj.v.url;
    }
    return true;
  }
  if (path === 'status' || path.endsWith('/status')) {
    if (onFragment) {
      const tool = currentTool();
      if (tool) tool.status = obj.v;
      return true;
    }
    if (obj.v === 'FINISHED') state.finished = true;
    if (obj.v === 'FAILED') state.failed = 'FAILED';
    return true;
  }
  if (path === 'quasi_status') return true;
  if (path === 'conversation_mode' || path === 'response/conversation_mode') {
    state.mode = obj.v;
    return true;
  }
  if (path === 'search_triggered' || path === 'response/search_triggered') {
    state.searchTriggered = Boolean(obj.v);
    return true;
  }
  if (path === 'response/status') {
    if (obj.v === 'FINISHED') state.finished = true;
    if (obj.v === 'FAILED') state.failed = 'FAILED';
    return true;
  }
  if (path === 'error' || path === 'response/error' || path === 'incomplete_message') {
    if (obj.v) state.failed = JSON.stringify(obj.v).slice(0, 300);
    return true;
  }
  if (path === 'response/fragments' || path === 'fragments') {
    // New fragments arrive either bare ({p:"response/fragments",o:"APPEND",v:[…]}) or inside a
    // BATCH on `response`. Both must be registered, otherwise the following deltas are attributed
    // to the previous fragment and the answer text lands in the wrong bucket.
    if (Array.isArray(obj.v)) for (const f of obj.v) registerFragment(f);
    else if (obj.v && typeof obj.v === 'object') registerFragment(obj.v);
    return true;
  }
  if (obj.o === 'BATCH' && Array.isArray(obj.v)) {
    const nextBase = path === 'response' ? 'response' : 'fragment';
    for (const op of obj.v) {
      if (op.p === 'fragments' && op.o === 'APPEND' && Array.isArray(op.v)) {
        for (const f of op.v) registerFragment(f);
      } else {
        applyPatch(op, nextBase);
      }
    }
    return true;
  }
  return false;
}

function applySnapshot(obj) {
  const response = obj.v?.response;
  if (!response || typeof response !== 'object') return;
  if (response.conversation_mode) state.mode = response.conversation_mode;
  if (response.search_triggered !== undefined) state.searchTriggered = Boolean(response.search_triggered);
  if (response.status === 'FAILED') state.failed = 'FAILED';
  for (const f of response.fragments || []) registerFragment(f);
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
    model_type: MODEL,
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

let events = 0;
let rawHead = '';
const eventNames = new Set();
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  const chunk = decoder.decode(value, { stream: true });
  buffer += chunk;
  if (args.includes('--dump')) process.stderr.write(chunk);
  if (rawHead.length < 800) rawHead += chunk.slice(0, 800 - rawHead.length);
  const parts = buffer.split('\n\n');
  buffer = parts.pop() || '';
  for (const part of parts) {
    let name = 'message';
    let payload = '';
    for (const line of part.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) payload += line.slice(5).trim();
    }
    eventNames.add(name);
    if (!payload || payload === '[DONE]') continue;
    events += 1;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      continue; // keep-alive or non-json frame
    }
    if ((obj.code ?? 0) !== 0) {
      state.failed = `code ${obj.code}: ${obj.msg}`;
      continue;
    }
    if (name === 'close') state.finished = true;
    if (obj.p !== undefined) applyPatch(obj);
    else if (typeof obj.v === 'string') appendContent(state.currentId, obj.v);
    else if (obj.v && typeof obj.v === 'object') applySnapshot(obj);
  }
}
const tEnd = Date.now();
process.stdout.write('\n');

// Resolve [citation:N] / [reference:N] the way the app does (its markdown plugin matches
// /\[(citation|reference):(\d+)\]/ and looks the number up by cite_index, not by array position).
const cited = new Map();
for (const tool of state.tools) {
  if (tool.type !== 'SEARCH' && tool.type !== 'TOOL_SEARCH') continue;
  for (const r of tool.results) {
    if (r?.cite_index !== undefined && !cited.has(r.cite_index)) cited.set(r.cite_index, r);
  }
}
const markers = [
  ...new Set(
    (state.text.match(/\[(citation|reference):(\d+)\]/g) || []).map((m) => {
      const [, kind, n] = m.match(/\[(citation|reference):(\d+)\]/);
      return `${kind}:${n}`;
    }),
  ),
];
if (!state.text) console.log(`no answer text; raw head: ${rawHead.slice(0, 400)}`);
console.log(
  JSON.stringify(
    {
      ok: !state.failed && state.finished && state.text.length > 0,
      finished: state.finished,
      failed: state.failed,
      contentType,
      model: MODEL,
      conversationMode: state.mode,
      searchTriggered: state.searchTriggered,
      events,
      eventNames: [...eventNames],
      chars: state.text.length,
      thinkingChars: state.thinking.length,
      tools: state.tools.map((t) => ({
        id: t.id,
        type: t.type,
        status: t.status,
        queries: t.queries,
        results: t.results.length,
        resultUrl: t.result?.url ?? null,
        label: t.content || null,
      })),
      citations: markers.map((marker) => {
        const [kind, raw] = marker.split(':');
        const n = Number(raw);
        if (kind === 'reference') {
          return { marker: `[${marker}]`, resolved: n < state.opened.length, url: state.opened[n]?.url ?? null, site: null };
        }
        return {
          marker: `[${marker}]`,
          resolved: cited.has(n),
          url: cited.get(n)?.url ?? null,
          site: cited.get(n)?.site_name ?? null,
        };
      }),
      unresolvedCitations: markers.filter((marker) => {
        const [kind, raw] = marker.split(':');
        return kind === 'reference' ? Number(raw) >= state.opened.length : !cited.has(Number(raw));
      }),
      openedPages: state.opened.length,
      timingsMs: {
        challenge: tChallenge - t0,
        powSolve: tSolve - tChallenge,
        session: tSession - tSolve,
        firstByte: tFirstByte - tSession,
        firstDelta: state.firstDelta ? state.firstDelta - tFirstByte : null,
        total: tEnd - t0,
      },
      answer,
      difficulty: challenge.difficulty,
    },
    null,
    2,
  ),
);
