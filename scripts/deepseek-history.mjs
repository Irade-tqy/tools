#!/usr/bin/env node
// What does DeepSeek itself remember about a conversation?
//
//   node scripts/deepseek-history.mjs <chat_session_id>
//
// The relay's chunks and the model's next-turn context are not the same thing: upstream stores
// its own copy of every message, and a stopped turn is stored truncated (status INCOMPLETE) only
// if the relay posted /api/v0/chat/stop_stream. This reads that copy back — the ground truth for
// "did the model actually see what the user saw?".
import { rpc } from './lib.mjs';
import { env } from './lib.mjs';
import { DeepSeekWebClient } from '../supabase/functions/_shared/web-client.ts';

const sessionId = process.argv[2];
if (!sessionId) {
  console.error('usage: node scripts/deepseek-history.mjs <chat_session_id>');
  process.exit(2);
}

const key = env.TOOLS_SUPABASE_SERVICE_ROLE_KEY;
const row = (await rpc('deepseek_credential_get', {}, { key })).body;
const credential = {
  token: row.token,
  deviceId: row.device_id || '',
  cookie: row.cookie || '',
  userAgent: row.user_agent || '',
  source: 'db',
};
const client = new DeepSeekWebClient(credential);

// GET, not POST: the endpoint answers 405 to a POST, and the ids/content keys are not the ones
// the SSE stream uses.
const headers = {
  accept: '*/*',
  authorization: `Bearer ${credential.token}`,
  'x-client-version': '2.0.1',
  'x-client-platform': 'web',
  'x-client-bundle-id': 'com.deepseek.chat',
  'x-client-locale': 'zh_CN',
  origin: 'https://chat.deepseek.com',
  referer: 'https://chat.deepseek.com/',
  'user-agent': credential.userAgent,
  ...(credential.deviceId ? { 'x-device-id': credential.deviceId } : {}),
  ...(credential.cookie ? { cookie: credential.cookie } : {}),
};
const res = await fetch(`https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=${sessionId}`, { headers });
const json = await res.json().catch(() => null);
if (!json) {
  console.error('HTTP', res.status, (await res.text()).slice(0, 200));
  process.exit(1);
}
const biz = (json?.data?.biz_data ?? json?.biz_data ?? {});
const messages = biz.chat_messages ?? biz.messages ?? [];
if (!messages.length) {
  console.error('no messages; shape:', JSON.stringify(Object.keys(biz)));
  process.exit(1);
}
for (const m of messages) {
  // The stored message is not the SSE shape: the ids are message_id, and the text lives in
  // fragments[] typed THINK / RESPONSE / SEARCH…
  const fragments = Array.isArray(m.fragments) ? m.fragments : [];
  const content = fragments.filter((f) => ['RESPONSE', 'TEMPLATE_RESPONSE'].includes(String(f.type))).map((f) => String(f.content ?? '')).join('');
  const reasoning = fragments.filter((f) => String(f.type) === 'THINK').map((f) => String(f.content ?? '')).join('');
  const others = fragments.map((f) => String(f.type)).filter((t) => !['RESPONSE', 'TEMPLATE_RESPONSE', 'THINK'].includes(t));
  console.log(
    `${String(m.message_id ?? '?').padEnd(4)} ${String(m.role).padEnd(9)} ${String(m.status).padEnd(11)}` +
      ` content=${content.length} reasoning=${reasoning.length}${others.length ? ` fragments=${others.join(',')}` : ''}`,
  );
  console.log('      head:', JSON.stringify(content.slice(0, 60)));
  console.log('      tail:', JSON.stringify(content.slice(-40)));
  if (reasoning) console.log('      think:', JSON.stringify(reasoning.slice(0, 60)));
}
