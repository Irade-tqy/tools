// Small access-control check. All documents, tokens and staged DDL roll back.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { connectDb } from './lib.mjs';

const db = await connectDb();
let checks = 0;
const check = (condition) => { assert.ok(condition); checks++; };
try {
  await db.query('begin');
  const existing = await db.query("select to_regprocedure('public.paste_document(text,uuid,text,text,text,text,text,bigint)') as fn");
  if (!existing.rows[0].fn) {
    await db.query(readFileSync(new URL('../supabase/migrations/20261015052449_named_pastes.sql', import.meta.url), 'utf8'));
  }
  await db.query('set local role anon');
  await db.query("select set_config('request.headers', $1, true)", [JSON.stringify({ 'x-real-ip': crypto.randomUUID() })]);
  async function rpc(action, args = {}) {
    const values = [action, args.id ?? null, args.name ?? null, args.body ?? null, args.mode ?? null, args.password ?? null, args.token ?? null, args.revision ?? null];
    return (await db.query('select public.paste_document($1,$2,$3,$4,$5,$6,$7,$8) as data', values)).rows[0].data;
  }
  let d = await rpc('create');
  check(d.ok && d.can_read && d.can_write && d.mode === 'public');
  const id = d.id;
  d = await rpc('save', { id, body: '# Shared', revision: d.revision });
  check(d.ok && d.body === '# Shared');
  check((await rpc('save', { id, body: 'stale', revision: 0 })).error === 'conflict');
  check((await rpc('rename', { id, name: '😀'.repeat(16), revision: d.revision })).error === 'invalid_name');
  d = await rpc('rename', { id, name: '😀'.repeat(15), revision: d.revision });
  check(d.ok && [...d.name].length === 15);
  check((await rpc('exists', { name: d.name })).exists);
  check(!(await rpc('exists', { id, name: d.name })).exists);
  const other = await rpc('create');
  check((await rpc('rename', { id, name: other.name, revision: d.revision })).error === 'name_exists');
  check((await rpc('mode', { id, mode: 'private', revision: d.revision })).error === 'password_required');
  const password = '任意字符😀'.repeat(30);
  d = await rpc('set_password', { id, mode: 'write_password', password, revision: d.revision });
  check(d.ok && d.token && d.can_write);
  const token = d.token;
  const readOnly = await rpc('read', { id });
  check(readOnly.can_read && !readOnly.can_write && readOnly.body === '# Shared');
  check((await rpc('save', { id, body: 'unauthorized', revision: d.revision })).error === 'unauthorized');
  d = await rpc('mode', { id, mode: 'private', token, revision: d.revision });
  const blocked = await rpc('read', { id });
  check(blocked.ok && !blocked.can_read && !blocked.can_write && blocked.body === null);
  check((await rpc('unlock', { id, password: password + 'different' })).error === 'invalid_password');
  check((await rpc('unlock', { id, password })).can_write);
  check((await rpc('set_password', { id, password: 'replacement', mode: 'private', token, revision: d.revision })).error === 'password_already_set');
  d = await rpc('mode', { id, mode: 'public', token, revision: d.revision });
  check(d.has_password && d.can_write);
  d = await rpc('mode', { id, mode: 'private', revision: d.revision });
  check(d.ok && !d.can_read && (await rpc('unlock', { id, password })).can_write);
  await db.query('savepoint forbidden_table');
  let denied = false;
  try { await db.query('select body from app.paste_document'); }
  catch (err) { denied = err.code === '42501'; await db.query('rollback to savepoint forbidden_table'); }
  check(denied);
  check(!(await db.query('select app.paste_image_write($1) as allowed', [`${id}/image.webp`])).rows[0].allowed);
  await db.query("select set_config('request.headers', $1, true)", [JSON.stringify({ 'x-clipboard-token': token })]);
  check((await db.query('select app.paste_image_write($1) as allowed', [`${id}/image.webp`])).rows[0].allowed);
  console.log(`${checks} named document access checks passed; all changes rolled back.`);
} finally {
  await db.query('rollback');
  await db.end();
}
