#!/usr/bin/env node
// Apply supabase/migrations/*.sql in filename order over a direct Postgres connection.
// Uses the same supabase_migrations.schema_migrations bookkeeping table the Supabase CLI
// expects, so `supabase db pull` / `supabase db lint` stay usable later.
//
//   node scripts/db-push.mjs                 apply pending migrations
//   node scripts/db-push.mjs --status        show applied / pending
//   node scripts/db-push.mjs --dry-run       report what would run, change nothing
//   node scripts/db-push.mjs --reapply 0001  re-run an already-applied migration
//                                            (all migrations are written idempotently)
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { connectDb, dbConfig, rootDir, mask } from './lib.mjs';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const reapplyIdx = args.indexOf('--reapply');
const reapply = reapplyIdx >= 0 ? String(args[reapplyIdx + 1] || '') : null;

const statusOnly = flags.has('--status');
const dryRun = flags.has('--dry-run');

const dir = resolve(rootDir, 'supabase/migrations');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const url = dbConfig().connectionString;
const client = await connectDb();

const versionOf = (f) => f.split('_')[0];

try {
  const row = await client.query('select current_user, version()');
  console.log(`db: ${row.rows[0].current_user} @ ${url.replace(/:[^:@/]*@/, ':***@')}`);

  await client.query('create schema if not exists supabase_migrations');
  await client.query(
    `create table if not exists supabase_migrations.schema_migrations (
       version text primary key,
       name text,
       statement text
     )`,
  );
  const applied = new Set(
    (await client.query('select version from supabase_migrations.schema_migrations')).rows.map(
      (r) => r.version,
    ),
  );

  if (statusOnly) {
    for (const f of files) {
      console.log(`${applied.has(versionOf(f)) ? 'applied' : 'pending'}  ${f}`);
    }
    process.exit(0);
  }

  let ran = 0;
  for (const file of files) {
    const version = versionOf(file);
    if (applied.has(version) && version !== reapply) {
      console.log(`skip      ${file}`);
      continue;
    }
    const sql = readFileSync(resolve(dir, file), 'utf8');
    if (dryRun) {
      console.log(`would run ${file} (${sql.length} bytes)`);
      ran += 1;
      continue;
    }
    const t0 = Date.now();
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query(
        `insert into supabase_migrations.schema_migrations (version, name) values ($1, $2)
         on conflict (version) do nothing`,
        [version, file],
      );
      await client.query('commit');
      console.log(`${applied.has(version) ? 'reapplied' : 'applied  '} ${file} (${Date.now() - t0}ms)`);
      ran += 1;
    } catch (err) {
      await client.query('rollback');
      console.error(`FAILED    ${file}: ${err.message}`);
      if (err.detail) console.error(`          ${err.detail}`);
      process.exitCode = 1;
      break;
    }
  }

  if (!dryRun && ran === 0) console.log('database already up to date');
  if (!dryRun && ran > 0) {
    // PostgREST caches function signatures; nudge it so new RPCs resolve immediately.
    await client.query("select pg_notify('pgrst', 'reload schema')").catch(() => {});
    console.log('asked PostgREST to reload its schema cache');
  }
} catch (err) {
  console.error(`db-push error: ${err.message}`);
  if (err.code) console.error(`code: ${err.code}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
