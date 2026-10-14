#!/usr/bin/env node
// End-to-end test of the live Supabase backend, driven entirely through PostgREST the
// same way the browser does (anon key + x-clipboard-token header). Requires the
// migrations to be applied and at least one allowlist secret (scripts/allowlist.mjs).
//
//   node scripts/db-test.mjs
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { anonKey, clearDeepseekBacklog, connectDb, env, projectRef, rpc, serviceRoleKey, supabaseUrl } from './lib.mjs';

// Mirrors src/lib/crypto.ts (WebCrypto AES-GCM + PBKDF2-SHA256/150000). WebCrypto
// appends the 16-byte GCM tag to the ciphertext, so the tag is concatenated here too.
const PBKDF2_ITERATIONS = 150000;
function sealWith(password, plaintext) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    data: Buffer.concat([body, cipher.getAuthTag()]).toString('base64'),
    iv: iv.toString('base64'),
    salt: salt.toString('base64'),
  };
}
function openWith(password, sealed) {
  const key = pbkdf2Sync(password, Buffer.from(sealed.salt, 'base64'), PBKDF2_ITERATIONS, 32, 'sha256');
  const raw = Buffer.from(sealed.data, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString('utf8');
}

const TEST_QUEUE = 'test';
const results = [];
let token = '';
let token2 = '';
let db;

function detail(v) {
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function check(name, cond, detail_ = '') {
  const d = detail(detail_);
  results.push({ name, pass: !!cond, detail: cond ? '' : d.slice(0, 300) });
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : `\n        ${d.slice(0, 300)}`}`);
}

function firstPassword() {
  const raw = env.TOOLS_CLIPBOARD_PASSWORDS || '';
  const first = raw.split(',')[0]?.trim();
  if (!first) throw new Error('TOOLS_CLIPBOARD_PASSWORDS is empty — run scripts/allowlist.mjs first');
  const at = first.indexOf(':');
  return at > 0 ? first.slice(at + 1) : first;
}

async function rest(path, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method,
    headers: { apikey: anonKey(), Authorization: `Bearer ${anonKey()}`, ...headers },
    body,
  });
  return { status: res.status, text: await res.text() };
}

async function main() {
  if (!supabaseUrl) throw new Error('TOOLS_SUPABASE_URL missing');
  const password = firstPassword();
  const drained = await clearDeepseekBacklog({ workerId: 'db-test-setup' });
  console.log(`target: ${projectRef}  (anon key ${anonKey().slice(0, 8)}…, cleared ${drained.closed} stale + ${drained.drained} queued job(s))\n`);

  // ---- auth -----------------------------------------------------------------
  let r = await rpc('clipboard_list', {});
  check('list without a token is rejected', r.body?.ok === false && r.body?.error === 'unauthorized', r.body);

  r = await rpc('clipboard_verify', { p_password: 'definitely-not-the-password-xyz' });
  check('wrong password is refused', r.body?.ok === false && r.body?.error === 'invalid_password', r.body);

  r = await rpc('clipboard_verify', { p_password: '' });
  check('empty password is refused', r.body?.ok === false && r.body?.error === 'missing_password', r.body);

  r = await rpc('clipboard_verify', { p_password: password, p_ttl_seconds: 600 });
  token = r.body?.token || '';
  check('correct password mints a token', r.body?.ok === true && /^[0-9a-f]{64}$/.test(token), r.body);
  check(
    'token carries an expiry',
    typeof r.body?.expires_at === 'string' && new Date(r.body.expires_at).getTime() > Date.now(),
    r.body,
  );

  r = await rpc('clipboard_verify', { p_password: password });
  token2 = r.body?.token || '';
  check('a second password holder also gets a token', r.body?.ok === true && token2 && token2 !== token, r.body);

  // ---- lockdown -------------------------------------------------------------
  let direct = await rest('clipboard_entry?select=*');
  check('anon cannot select the table directly', direct.status === 401 || direct.status === 403, `${direct.status} ${direct.text.slice(0, 120)}`);

  direct = await rest('deepseek_chunk?select=*');
  check('anon can read deepseek_chunk (realtime/RLS read policy)', direct.status === 200, `${direct.status} ${direct.text.slice(0, 120)}`);

  direct = await rest('deepseek_chunk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ job_id: '00000000-0000-0000-0000-000000000000', seq: 0, payload: {} }),
  });
  check('anon cannot insert into deepseek_chunk', direct.status === 401 || direct.status === 403, `${direct.status} ${direct.text.slice(0, 120)}`);

  // ---- clipboard CRUD -------------------------------------------------------
  r = await rpc('clipboard_status', {}, { token });
  check('status works with a token', r.body?.ok === true && typeof r.body?.count === 'number', r.body);
  check('retention defaults to 7 days', r.body?.retention_days === 7, r.body);

  await rpc('clipboard_clear', {}, { token });

  r = await rpc(
    'clipboard_put',
    { p_kind: 'text', p_body: 'hello from db-test', p_title: 'greeting' },
    { token },
  );
  const textId = r.body?.entry?.id;
  check('put text succeeds', r.body?.ok === true && !!textId, r.body);

  r = await rpc('clipboard_put', { p_kind: 'text', p_body: '   ' }, { token });
  check('blank text is refused', r.body?.ok === false && r.body?.error === 'empty_text', r.body);

  r = await rpc('clipboard_put', { p_kind: 'image', p_body: 'x' }, { token });
  check('unknown kind is refused', r.body?.ok === false && r.body?.error === 'bad_kind', r.body);

  r = await rpc('clipboard_put', { p_kind: 'text', p_body: 'no token here' }, { token: 'bogus' });
  check('put with a bogus token is refused', r.body?.ok === false && r.body?.error === 'unauthorized', r.body);

  const plaintext = `secret file payload ${Date.now()}`;
  const sealed = sealWith(password, plaintext);
  r = await rpc(
    'clipboard_put',
    {
      p_kind: 'file',
      p_file_name: 'note.txt',
      p_file_type: 'text/plain',
      p_data: sealed.data,
      p_iv: sealed.iv,
      p_salt: sealed.salt,
      p_title: 'encrypted file',
    },
    { token },
  );
  const fileId = r.body?.entry?.id;
  check('put file (ciphertext) succeeds', r.body?.ok === true && !!fileId, r.body);
  check(
    'file size is the ciphertext length',
    r.body?.entry?.file_size === Buffer.from(sealed.data, 'base64').length,
    r.body?.entry,
  );

  r = await rpc('clipboard_put', { p_kind: 'file', p_file_name: 'x', p_data: '!!!not base64!!!', p_iv: 'aa==', p_salt: 'aa==' }, { token });
  check('non-base64 file data is refused', r.body?.ok === false && r.body?.error === 'bad_base64', r.body);

  r = await rpc('clipboard_put', { p_kind: 'file', p_file_name: 'x', p_data: sealed.data, p_iv: sealed.iv }, { token });
  check('file without a KDF salt is refused', r.body?.ok === false && r.body?.error === 'empty_file', r.body);

  r = await rpc('clipboard_list', { p_limit: 50 }, { token });
  const entries = r.body?.entries || [];
  check('list returns both entries', r.body?.ok === true && entries.length === 2, entries);
  check('list omits file bytes', entries.every((e) => e.data === undefined), entries[0]);
  check('list marks the file entry', entries.some((e) => e.kind === 'file' && e.has_data === true), entries);

  r = await rpc('clipboard_list', { p_limit: 50 }, { token: token2 });
  check(
    'shared mode: the second token sees the same entries',
    (r.body?.entries || []).length === 2,
    r.body,
  );

  r = await rpc('clipboard_get', { p_id: fileId }, { token });
  check(
    'get returns ciphertext, iv and salt verbatim',
    r.body?.entry?.data === sealed.data && r.body?.entry?.iv === sealed.iv && r.body?.entry?.kdf_salt === sealed.salt,
    r.body?.entry,
  );
  let decrypted = null;
  let decryptError = '';
  const sealedRow = {
    data: r.body?.entry?.data,
    iv: r.body?.entry?.iv,
    salt: r.body?.entry?.kdf_salt,
  };
  try {
    decrypted = openWith(password, sealedRow);
  } catch (err) {
    decryptError = err.message;
  }
  check('the ciphertext decrypts with the shared password', decrypted === plaintext, decryptError || decrypted);
  let wrongKey = false;
  try {
    openWith('some-other-password', sealedRow);
  } catch {
    wrongKey = true;
  }
  check('a different password cannot decrypt', wrongKey, 'decrypted with the wrong password');

  const stored = await db.query('select data, body from public.clipboard_entry where id = $1', [fileId]);
  check(
    'the database never sees plaintext file bytes',
    !stored.rows[0].data.includes(plaintext) && stored.rows[0].body === null,
    { hasPlaintext: stored.rows[0].data.includes(plaintext), body: stored.rows[0].body },
  );

  r = await rpc('clipboard_get', { p_id: '00000000-0000-0000-0000-000000000000' }, { token });
  check('get on a missing id reports not_found', r.body?.ok === false && r.body?.error === 'not_found', r.body);

  // ---- expiry / purge -------------------------------------------------------
  await db.query('update public.clipboard_entry set expires_at = now() - interval \'13 hours\' where id = $1', [textId]);
  r = await rpc('clipboard_list', { p_limit: 50 }, { token });
  const after = r.body?.entries || [];
  check(
    'expired entries are purged on access',
    after.length === 1 && after[0].id === fileId,
    after,
  );

  r = await rpc('clipboard_list', { p_limit: 50 }, { token: 'bogus' });
  check('a bogus token cannot list', r.body?.ok === false && r.body?.error === 'unauthorized', r.body);

  r = await rpc('clipboard_delete', { p_id: fileId }, { token: token2 });
  check('the other token can delete (shared mode)', r.body?.ok === true, r.body);

  r = await rpc('clipboard_delete', { p_id: fileId }, { token });
  check('deleting twice reports not_found', r.body?.ok === false && r.body?.error === 'not_found', r.body);

  r = await rpc('clipboard_clear', {}, { token });
  check('clear works', r.body?.ok === true, r.body);

  // ---- rate limiting --------------------------------------------------------
  const probe = `wrong-${Date.now()}`;
  let limited = null;
  for (let i = 0; i < 12; i += 1) {
    const rr = await rpc('clipboard_verify', { p_password: probe });
    if (rr.body?.error === 'rate_limited') {
      limited = { attempt: i + 1, body: rr.body };
      break;
    }
  }
  check('repeated wrong passwords hit the rate limit', limited && limited.attempt <= 12, limited || 'never rate limited');
  await db.query('delete from public.clipboard_attempt');

  // --- RPC shape: PostgREST cannot resolve an overloaded function (0007) ---
  const overloads = await db.query(
    `select n.nspname, p.proname, count(*) as candidates
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'app')
        and (p.proname like 'deepseek%' or p.proname like 'clipboard%' or p.proname like 'tools%')
      group by n.nspname, p.proname
     having count(*) > 1`,
  );
  check('no RPC is overloaded (PostgREST would fail with PGRST203)', overloads.rows.length === 0, overloads.rows);
  r = await rpc('deepseek_ask', { p_prompt: 'shape probe', p_queue: TEST_QUEUE });
  check('a call that omits every optional parameter still resolves', r.body?.ok === true && Boolean(r.body?.job_id), r.body);
  if (r.body?.job_id) await rpc('deepseek_cancel', { p_job_id: r.body.job_id });

  // ---- deepseek credential store -------------------------------------------
  // These checks overwrite the live credential, so snapshot it first and put it back in the
  // finally block — running the test suite must not log the relay out of DeepSeek.
  const snapshot = await rpc('deepseek_credential_get', {}, { key: serviceRoleKey() });
  const shortToken = 'x'.repeat(64);
  r = await rpc('deepseek_credential_set', { p_token: shortToken, p_device_id: 'dev-1', p_source: 'test' }, { key: serviceRoleKey() });
  check('service role can store a credential', r.body?.ok === true && !!r.body?.updated_at, r.body);

  r = await rpc('deepseek_credential_get', {}, { key: serviceRoleKey() });
  check('service role reads the token back', r.body?.ok === true && r.body?.token === shortToken && r.body?.device_id === 'dev-1', r.body?.token);

  r = await rpc('deepseek_credential_status', {});
  check('anon sees a status without the token', r.body?.ok === true && r.body?.configured === true && !JSON.stringify(r.body).includes(shortToken), r.body);
  check('the status reports age and source without leaking the secret', typeof r.body?.age_minutes === 'number' && r.body?.source === 'test', r.body);

  r = await rpc('deepseek_credential_get', {});
  check('anon cannot read the token', r.status === 401 || r.status === 403, `${r.status} ${r.body}`);
  r = await rpc('deepseek_credential_set', { p_token: shortToken });
  check('anon cannot store a credential', r.status === 401 || r.status === 403, `${r.status} ${r.body}`);
  r = await rpc('deepseek_credential_report', { p_ok: false, p_error: 'token rejected upstream' }, { key: serviceRoleKey() });
  check('the relay can report a credential failure', r.body?.ok === true, r.body);
  r = await rpc('deepseek_credential_status', {});
  check('a reported failure is visible to the UI', r.body?.last_error === 'token rejected upstream', r.body);
  r = await rpc('deepseek_credential_set', { p_token: 'short' }, { key: serviceRoleKey() });
  check('a too-short token is refused', r.body?.ok === false && r.body?.error === 'bad_token', r.body);
  r = await rpc('deepseek_credential_report', { p_ok: true }, { key: serviceRoleKey() });
  r = await rpc('deepseek_credential_status', {});
  check('a success clears the error and stamps last_ok_at', !r.body?.last_error && !!r.body?.last_ok_at, r.body);

  // --- pasting a credential string without the Edge Function (0005) ---
  const adminToken = (env.TOOLS_ADMIN_TOKEN || '').trim();
  const { createHash } = await import('node:crypto');
  await rpc(
    'tools_secret_set',
    { p_name: 'admin_token', p_digest: createHash('sha256').update(adminToken, 'utf8').digest('hex'), p_hint: 'db-test' },
    { key: serviceRoleKey() },
  );
  const pastedToken = 'p'.repeat(64);
  r = await rpc('deepseek_credential_set_admin', { p_token: pastedToken, p_admin_token: 'wrong-token' });
  check('a wrong admin token is refused over PostgREST', r.body?.ok === false && r.body?.error === 'bad_admin_token', r.body);
  const attempts = await db.query("select failed from public.tools_auth_attempt where bucket = app.tools_attempt_bucket(5)");
  check('a wrong token is counted against the guess-rate guard', Number(attempts.rows[0]?.failed) >= 1, attempts.rows[0]);

  r = await rpc('deepseek_credential_set_admin', {
    p_token: pastedToken,
    p_admin_token: adminToken,
    p_device_id: 'dev-rest',
    p_source: 'browser',
  });
  check('the right admin token stores the credential over PostgREST', r.body?.ok === true && r.body?.verified === false, r.body);
  check('the write is marked unverified', /not checked against the upstream/.test(String(r.body?.note ?? '')), r.body?.note);
  check('the response carries a hint, not the secret', r.body?.token_hint === `${pastedToken.slice(0, 4)}…${pastedToken.slice(-4)}` && !JSON.stringify(r.body).includes(pastedToken), r.body);

  r = await rpc('deepseek_credential_get', {}, { key: serviceRoleKey() });
  check('the relay will pick up the pasted credential', r.body?.token === pastedToken && r.body?.device_id === 'dev-rest', r.body?.token);
  r = await rpc('deepseek_credential_status', {});
  check('an unverified write does not look like a working login', r.body?.source === 'browser' && !r.body?.last_ok_at, r.body);

  r = await rpc('deepseek_credential_set_admin', { p_token: 'short', p_admin_token: adminToken });
  check('the PostgREST path validates the token shape', r.body?.ok === false && r.body?.error === 'bad_token', r.body);
  r = await rpc('deepseek_credential_set_admin', { p_token: pastedToken, p_admin_token: adminToken, p_source: 'everything' });
  check('the PostgREST path validates the source', r.body?.ok === false && r.body?.error === 'bad_source', r.body);

  const secretTable = await rest('tools_secret?select=*');
  check('the browser cannot read the secret table', secretTable.status === 401 || secretTable.status === 403 || secretTable.text.trim() === '[]', `HTTP ${secretTable.status}`);
  const secretRpc = await rpc('tools_secret_set', { p_name: 'admin_token', p_digest: '0'.repeat(64) });
  check('anon cannot write a secret', secretRpc.status === 401 || secretRpc.status === 403, `${secretRpc.status} ${secretRpc.body}`);

  if (snapshot.body?.ok && snapshot.body.token) {
    await rpc(
      'deepseek_credential_set',
      {
        p_token: snapshot.body.token,
        p_device_id: snapshot.body.device_id,
        p_cookie: snapshot.body.cookie,
        p_user_agent: snapshot.body.user_agent,
        p_source: snapshot.body.source,
        p_note: 'restored by db-test',
      },
      { key: serviceRoleKey() },
    );
    const restored = await rpc('deepseek_credential_get', {}, { key: serviceRoleKey() });
    check('the live credential is restored after the test', restored.body?.token === snapshot.body.token, restored.body?.token);
  } else {
    check('no credential was configured before the test (nothing to restore)', true, snapshot.body);
  }

  // ---- deepseek relay -------------------------------------------------------
  r = await rpc('deepseek_ask', { p_queue: TEST_QUEUE, p_prompt: 'ping' });
  const jobId = r.body?.job_id;
  check('ask queues a turn', r.body?.ok === true && !!jobId, r.body);

  r = await rpc('deepseek_ask', { p_queue: TEST_QUEUE, p_prompt: '   ' });
  check('an empty prompt is refused', r.body?.ok === false && r.body?.error === 'empty_prompt', r.body);

  r = await rpc('deepseek_ask', { p_queue: TEST_QUEUE, p_prompt: 'x', p_model_type: 'gpt-4' });
  check('an unknown model type is refused', r.body?.ok === false && r.body?.error === 'bad_model_type', r.body);

  r = await rpc('deepseek_ask', { p_queue: TEST_QUEUE, p_prompt: 'x'.repeat(40000) });
  check('an oversized prompt is refused', r.body?.ok === false && r.body?.error === 'prompt_too_long', r.body);

  r = await rpc('deepseek_claim', { p_queue: TEST_QUEUE, p_worker_id: 'test-worker' });
  check('worker claims the queued job', r.body?.ok === true && r.body?.claimed === true && r.body?.job_id === jobId, r.body);
  check('claim hands over the prompt', r.body?.prompt === 'ping', r.body?.prompt);

  r = await rpc('deepseek_claim', { p_queue: TEST_QUEUE, p_worker_id: 'test-worker-2' });
  check('an empty queue reports claimed=false', r.body?.ok === true && r.body?.claimed === false, r.body);

  r = await rpc('deepseek_claim', { p_queue: TEST_QUEUE, p_worker_id: '' });
  check('claim requires a worker id', r.body?.ok === false && r.body?.error === 'missing_worker_id', r.body);

  // targeted claims: the edge function processes the job the UI just enqueued
  const jobA = await rpc('deepseek_ask', { p_queue: TEST_QUEUE, p_prompt: 'A' });
  const jobB = await rpc('deepseek_ask', { p_queue: TEST_QUEUE, p_prompt: 'B' });
  r = await rpc('deepseek_claim', { p_queue: TEST_QUEUE, p_worker_id: 'targeted', p_job_id: jobB.body?.job_id });
  check('claim can target a specific job', r.body?.claimed === true && r.body?.job_id === jobB.body?.job_id, r.body);
  r = await rpc('deepseek_claim', { p_queue: TEST_QUEUE, p_worker_id: 'targeted', p_job_id: jobA.body?.job_id });
  check('a still-queued job can be claimed next', r.body?.claimed === true && r.body?.job_id === jobA.body?.job_id, r.body);
  r = await rpc('deepseek_claim', { p_queue: TEST_QUEUE, p_worker_id: 'targeted', p_job_id: jobB.body?.job_id });
  check('the holder can re-attach to its own job', r.body?.claimed === true && r.body?.job_id === jobB.body?.job_id, r.body);
  r = await rpc('deepseek_claim', { p_queue: TEST_QUEUE, p_worker_id: 'other-worker', p_job_id: jobB.body?.job_id });
  check('another worker cannot steal a claimed job', r.body?.claimed === false && r.body?.reason === 'not_available', r.body);
  await rpc('deepseek_cancel', { p_job_id: jobA.body?.job_id });
  await rpc('deepseek_complete', { p_job_id: jobB.body?.job_id, p_ok: true });

  r = await rpc('deepseek_append', { p_job_id: jobId, p_seq: 0, p_payload: { v: 1, text: 'po' } });
  check('append chunk 0', r.body?.ok === true, r.body);
  r = await rpc('deepseek_append', { p_job_id: jobId, p_seq: 1, p_payload: { v: 1, text: 'ng' } });
  check('append chunk 1', r.body?.ok === true, r.body);
  r = await rpc('deepseek_append', { p_job_id: jobId, p_seq: 1, p_payload: { v: 1, text: 'ng' } });
  check('duplicate seq is idempotent', r.body?.ok === true, r.body);
  r = await rpc('deepseek_append', { p_job_id: jobId, p_seq: 2, p_payload: 'not an object' });
  check('a non-object payload is refused', r.body?.ok === false && r.body?.error === 'bad_payload', r.body);

  r = await rpc('deepseek_status', { p_job_id: jobId, p_since_seq: -1 });
  check('status streams both chunks in order', r.body?.ok === true && r.body.chunks?.length === 2 && r.body.chunks[1].seq === 1, r.body);
  check('first chunk flips the job to streaming', r.body?.status === 'streaming', r.body?.status);
  check('time-to-first-chunk is recorded', !!r.body?.metrics?.first_chunk_at, r.body?.metrics);

  r = await rpc('deepseek_status', { p_job_id: jobId, p_since_seq: 0 });
  check('since_seq filters delivered chunks', r.body?.chunks?.length === 1 && r.body.chunks[0].seq === 1, r.body?.chunks);

  r = await rpc('deepseek_complete', {
    p_job_id: jobId,
    p_ok: true,
    p_metrics: { upstream_ms: 812, upstream_ttft_ms: 640 },
    p_session_id: 'sess-abc',
    p_reply_message_id: 42,
    p_title: '测试会话',
  });
  check('complete marks the job done', r.body?.ok === true && r.body?.status === 'done', r.body);
  check('complete returns the conversation ids', r.body?.session_id === 'sess-abc' && r.body?.reply_message_id === '42', r.body);

  r = await rpc('deepseek_status', { p_job_id: jobId, p_since_seq: -1 });
  check('finished jobs report finished', r.body?.finished === true && r.body?.status === 'done', r.body);
  check('custom metrics survive completion', r.body?.metrics?.upstream_ms === 812 && !!r.body?.metrics?.finished_at, r.body?.metrics);
  check('status exposes the ids a client needs to continue', r.body?.session_id === 'sess-abc' && r.body?.reply_message_id === '42' && r.body?.title === '测试会话', r.body);

  r = await rpc('deepseek_append', { p_job_id: jobId, p_seq: 9, p_payload: {} });
  check('appending to a done job is refused', r.body?.ok === false && r.body?.error === 'job_done', r.body);

  // a turn queued against an existing conversation keeps its ids
  r = await rpc('deepseek_ask', { p_queue: TEST_QUEUE, p_prompt: 'continue', p_session_id: 'sess-abc', p_parent_message_id: 42, p_thinking: true, p_search: true });
  const sessionJobId = r.body?.job_id;
  r = await rpc('deepseek_claim', { p_queue: TEST_QUEUE, p_worker_id: 'session-worker', p_job_id: sessionJobId });
  check('claim returns the session ids so the relay can continue', r.body?.session_id === 'sess-abc' && r.body?.parent_message_id === '42', r.body);
  check('claim returns the thinking/search flags', r.body?.thinking_enabled === true && r.body?.search_enabled === true, r.body);
  await rpc('deepseek_cancel', { p_job_id: sessionJobId });

  r = await rpc('deepseek_ask', { p_queue: TEST_QUEUE, p_prompt: 'cancel me' });
  const cancelId = r.body?.job_id;
  r = await rpc('deepseek_cancel', { p_job_id: cancelId });
  check('cancel stops a queued job', r.body?.ok === true && r.body?.status === 'cancelled', r.body);
  r = await rpc('deepseek_claim', { p_queue: TEST_QUEUE, p_worker_id: 'test-worker-3' });
  check('a cancelled job is never claimed', r.body?.ok === true && r.body?.claimed === false, r.body);

  r = await rpc('deepseek_health', {});
  check('health snapshot works', r.body?.ok === true && typeof r.body?.done_last_hour === 'number', r.body);
  check('health reports credential state for the status strip', r.body?.credential_configured === true && 'credential_age_minutes' in r.body, r.body);
  // median_ttft_ms counts only the 'default' queue (0006: the public site must not be told it is
  // ready because a test relay answered), so this assertion cannot depend on somebody having
  // used the site in the last hour — it failed at 03:00 when nobody had. Seed a finished turn
  // and take it back out.
  const seeded = await db.query(
    `insert into public.deepseek_job (status, metrics, finished_at)
     values ('done', jsonb_build_object('upstream_ttft_ms', 1234), now())
     returning id`,
  );
  const seedId = seeded.rows[0]?.id;
  r = await rpc('deepseek_health', {});
  check(
    'health reports the median upstream first-token time',
    typeof r.body?.median_ttft_ms === 'number' && r.body.median_ttft_ms > 0,
    r.body?.median_ttft_ms,
  );
  await db.query('delete from public.deepseek_job where id = $1', [seedId]);

  // --- relay liveness (0004): the status strip must tell "nobody is serving" from "idle" ---
  const relayId = `test-relay-${Date.now().toString(36)}`;
  r = await rpc('deepseek_heartbeat', { p_worker_id: relayId, p_kind: 'relay' });
  check('a relay can heartbeat by id', r.body?.ok === true && r.body?.worker_id === relayId, r.body);
  r = await rpc('deepseek_health', {});
  check('a heartbeating relay counts as alive', Number(r.body?.workers_alive) >= 1, r.body);
  check('health lists the live relays', Array.isArray(r.body?.workers) && r.body.workers.some((w) => w.worker_id === relayId), r.body);

  // An idle relay claims nothing, so the claim itself has to keep it counted.
  const idleId = `test-idle-${Date.now().toString(36)}`;
  await clearDeepseekBacklog({ workerId: 'db-test-idle' });
  r = await rpc('deepseek_claim', { p_queue: TEST_QUEUE, p_worker_id: idleId });
  check('an idle claim finds no work', r.body?.ok === true && r.body?.claimed === false, r.body);
  r = await rpc('deepseek_health', {});
  check('an idle relay still counts as alive', r.body?.workers?.some((w) => w.worker_id === idleId) === true && Number(r.body?.workers_alive) >= 1, r.body);

  await db.query("update public.deepseek_worker set seen_at = now() - interval '5 minutes' where worker_id = $1", [idleId]);
  r = await rpc('deepseek_health', {});
  check('a relay that stopped heartbeating stops counting', r.body?.workers?.some((w) => w.worker_id === idleId) !== true, r.body);

  // PostgREST answers 401/403 for a revoked table (and [] would be fine too) — the point is
  // that the browser learns relay liveness from deepseek_health(), not by reading the table.
  const workerTable = await rest('deepseek_worker?select=*');
  check(
    'the browser cannot read the worker table directly',
    workerTable.status === 401 || workerTable.status === 403 || workerTable.text.trim() === '[]',
    `HTTP ${workerTable.status} ${workerTable.text.slice(0, 120)}`,
  );
  await db.query('delete from public.deepseek_worker where worker_id in ($1, $2)', [relayId, idleId]);

  // worker timeout requeue
  await db.query('update public.deepseek_job set status=$1, claimed_at = now() - interval \'10 minutes\' where id = $2', ['claimed', cancelId]);
  r = await rpc('deepseek_claim', { p_queue: TEST_QUEUE, p_worker_id: 'test-worker-4' });
  check('a stuck job is requeued and reclaimed', r.body?.claimed === true && r.body?.job_id === cancelId, r.body);
  await rpc('deepseek_cancel', { p_job_id: cancelId });
}

try {
  db = await connectDb();
  await main();
} catch (err) {
  check(`unexpected error: ${err.message}`, false, err.stack || '');
} finally {
  await clearDeepseekBacklog({ workerId: 'db-test-cleanup' }).catch(() => {});
  if (db) await db.end().catch(() => {});
  const failed = results.filter((x) => !x.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('failed:');
    for (const f of failed) console.log(`  - ${f.name}`);
    process.exitCode = 1;
  }
}
