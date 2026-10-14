#!/usr/bin/env node
// Drive the DeepSeek web upstream from the command line — the reference implementation the
// Edge Function is built on, and the tool that proves session continuation works.
//
//   node scripts/deepseek-pow-node.mjs [--prompt "..."] [--thinking] [--search]
//                                      [--model default|expert|vision]
//                                      [--session-file .tmp/session.json] [--new-session]
//                                      [--dump] [--json out.json]
//
// --session-file persists {chat_session_id, parent_message_id} so a second run continues the
// same conversation instead of opening a new one. Credentials come from .env.local
// (DEEPSEEK_CREDENTIAL, or DEEPSEEK_WEB_TOKEN / DEEPSEEK_WEB_COOKIE — see scripts/deepseek-credential.mjs).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env, rootDir } from './lib.mjs';
import { parseCredential, serializeCredential } from '../supabase/functions/_shared/credential.ts';
import { DeepSeekWebClient } from '../supabase/functions/_shared/web-client.ts';
import { applyWebFrame, createWebFrameParser, createWebStreamState, resolveCitations, toolSummary } from '../supabase/functions/_shared/web-stream.ts';

const args = process.argv.slice(2);
const flag = (name, fallback = '') => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const value = args[i + 1];
  return value && !value.startsWith('--') ? value : fallback;
};

const rawCredential =
  env.DEEPSEEK_CREDENTIAL ||
  env.DEEPSEEK_WEB_TOKEN ||
  env.DEEPSEEK_WEB_COOKIE ||
  '';
if (!rawCredential.trim()) {
  console.error(
    'no credential — paste one with `npm run deepseek:credential "<userToken | Copy as cURL>"`\n' +
      '        (it writes DEEPSEEK_CREDENTIAL into .env.local and pushes it to Supabase)',
  );
  process.exit(2);
}
const parsed = parseCredential(rawCredential);
if (!parsed.ok) {
  console.error(`credential: ${parsed.error}`);
  process.exit(2);
}
const credential = parsed.credential;

const PROMPT = flag('--prompt', 'reply with the single word OK');
const MODEL = flag('--model', 'default');
const THINKING = args.includes('--thinking');
const SEARCH = args.includes('--search');
const DUMP = args.includes('--dump');
const sessionFile = flag('--session-file', '') ? resolve(rootDir, flag('--session-file')) : '';
const newSession = args.includes('--new-session');

const client = new DeepSeekWebClient(credential);

const prior = (() => {
  if (!sessionFile || newSession || !existsSync(sessionFile)) return {};
  try {
    return JSON.parse(readFileSync(sessionFile, 'utf8'));
  } catch {
    return {};
  }
})();

const state = createWebStreamState();
const timings = { start: Date.now() };

const t0 = Date.now();
let chatSessionId = prior.chat_session_id ?? null;
if (!chatSessionId) {
  const session = await client.createSession();
  chatSessionId = session.id;
}
timings.session = Date.now() - t0;

const t1 = Date.now();
const res = await client.completion({
  prompt: PROMPT,
  chatSessionId,
  parentMessageId: prior.parent_message_id ?? null,
  modelType: MODEL,
  thinking: THINKING,
  search: SEARCH,
});
timings.firstByte = Date.now() - t1;

const parse = createWebFrameParser();
const reader = res.body.getReader();
const decoder = new TextDecoder();
let rawHead = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  const text = decoder.decode(value, { stream: true });
  if (DUMP) process.stderr.write(text);
  if (rawHead.length < 800) rawHead += text.slice(0, 800 - rawHead.length);
  for (const frame of parse(text)) {
    applyWebFrame(state, frame, (delta) => {
      if (delta.text) process.stdout.write(delta.text);
    });
  }
}
for (const frame of parse.flush()) applyWebFrame(state, frame);
timings.firstDelta = state.firstDeltaAt ? state.firstDeltaAt - timings.start : null;
timings.total = Date.now() - timings.start;
process.stdout.write('\n');

if (sessionFile) {
  writeFileSync(
    sessionFile,
    JSON.stringify(
      {
        chat_session_id: chatSessionId,
        parent_message_id: state.responseMessageId ?? null,
        title: state.title,
        updated_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

const summary = toolSummary(state);
const citations = resolveCitations(state);
const report = {
  ok: !state.failed && state.finished && state.text.length > 0,
  continued: Boolean(prior.chat_session_id),
  chat_session_id: chatSessionId,
  request_message_id: state.requestMessageId,
  response_message_id: state.responseMessageId,
  title: state.title,
  finished: state.finished,
  failed: state.failed,
  conversationMode: state.mode,
  searchTriggered: state.searchTriggered,
  frames: state.frames,
  eventNames: state.eventNames,
  chars: state.text.length,
  thinkingChars: state.thinking.length,
  tokenUsage: state.tokenUsage,
  tools: state.tools.map((t) => ({
    id: t.id,
    type: t.type,
    status: t.status,
    queries: t.queries,
    results: t.results.length,
    page: t.page,
    label: t.label || null,
  })),
  toolSummary: summary,
  citations,
  unresolvedCitations: citations.filter((c) => !c.resolved).map((c) => `[${c.marker}]`),
  timingsMs: timings,
  credential: serializeCredential(credential).slice(0, 24) + '…',
};
if (!state.text) report.rawHead = rawHead.slice(0, 400);

const jsonPath = flag('--json', '');
const rendered = JSON.stringify(report, null, 2);
if (jsonPath) writeFileSync(resolve(rootDir, jsonPath), rendered);
console.error(jsonPath ? `wrote ${jsonPath}` : rendered);

process.exit(report.ok ? 0 : 1);
