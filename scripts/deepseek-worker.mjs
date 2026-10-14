#!/usr/bin/env node
// Self-hosted DeepSeek relay — the Edge Function's job, run as a claim loop.
//
//   node scripts/deepseek-worker.mjs                 # serve the queue until Ctrl-C
//   node scripts/deepseek-worker.mjs --once          # take what is queued, then exit
//   node scripts/deepseek-worker.mjs --idle-exit 60s # exit after that much quiet
//   node scripts/deepseek-worker.mjs --worker-id tools-box
//
// Why this exists: the browser queues a turn with deepseek_ask() and reads the answer from
// deepseek_chunk (Realtime, with a polling fallback), so the relay does not have to be
// reachable — it only needs outbound HTTPS to Supabase and to DeepSeek. That makes the same
// protocol runnable on a box, in CI, or as a second relay next to the Edge Function.
//
// The protocol itself is supabase/functions/_shared/relay.ts — the same file the deployed
// Edge Function imports — so the two hosts cannot drift apart.
//
// Credentials: read per turn from the database (deepseek_credential_get, service role), so
// pasting a new DeepSeek string takes effect without restarting the worker. Falls back to
// DEEPSEEK_CREDENTIAL in .env.local when the row is empty.
import { setTimeout as sleep } from 'node:timers/promises';
import { env, mask, rpc, serviceRoleKey, supabaseUrl } from './lib.mjs';
import { parseCredential } from '../supabase/functions/_shared/credential.ts';
import { runRelayTurn, TRANSPORT_WORKER } from '../supabase/functions/_shared/relay.ts';

const args = process.argv.slice(2);
const flagValue = (name, fallback = '') => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);

const parseDuration = (raw, fallback) => {
  if (!raw) return fallback;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(String(raw).trim());
  if (!m) return fallback;
  const n = Number(m[1]);
  const unit = m[2] === 's' ? 1000 : m[2] === 'm' ? 60_000 : 1; // bare number = ms
  return Math.round(n * unit);
};

const IDLE_MS = parseDuration(flagValue('--idle-ms', ''), 1000);
const IDLE_EXIT_MS = parseDuration(flagValue('--idle-exit', ''), 0);
const ONCE = has('--once');
const QUEUE = flagValue('--queue', env.TOOLS_RELAY_QUEUE || 'default').slice(0, 32);
const QUIET = has('--quiet');
const WORKER_ID = (flagValue('--worker-id', '') || process.env.TOOLS_WORKER_ID || `node-${process.pid}-${Date.now().toString(36).slice(-4)}`)
  .slice(0, 64);

if (!supabaseUrl) {
  console.error('TOOLS_SUPABASE_URL is not set in .env.local');
  process.exit(2);
}
let key;
try {
  key = serviceRoleKey();
} catch {
  console.error('TOOLS_SUPABASE_SERVICE_ROLE_KEY is not set in .env.local');
  process.exit(2);
}

// relay.ts expects the RPC *body*, while lib.mjs returns the HTTP envelope — unwrap here so
// the shared protocol sees {ok, claimed, job_id, …} exactly as it does on Supabase.
// A stalled connection must not become a stalled relay: every call is bounded, and the
// watchdog below exits the process so the supervisor starts a clean one.
const RPC_TIMEOUT_MS = parseDuration(flagValue('--rpc-timeout', ''), 20_000);
const WATCHDOG_MS = parseDuration(flagValue('--watchdog', ''), 90_000);

const call = async (fn, payload = {}) => {
  let res;
  try {
    res = await rpc(fn, payload, { key, timeoutMs: RPC_TIMEOUT_MS });
  } catch (err) {
    return { ok: false, error: `transport_${fn}: ${(err && err.message) || 'request failed'}` };
  }
  return (res.body ?? { ok: false, error: `empty_response_${fn}`, http: res.status });
};

const startedAt = Date.now();
const log = (...parts) => {
  if (QUIET) return;
  const line = parts.filter((p) => p !== '' && p !== null && p !== undefined).join(' ');
  console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
};

let stopping = false;
let current = null;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    log(`worker ${WORKER_ID}: ${signal} — finishing the current turn, then stopping`);
    if (!current) process.exit(0);
  });
}

/** The credential is re-read every turn so `npm run deepseek:credential` needs no restart. */
async function resolveCredential() {
  const row = await call('deepseek_credential_get');
  if (row.ok && typeof row.token === 'string' && row.token) {
    return {
      credential: {
        token: row.token,
        deviceId: typeof row.device_id === 'string' ? row.device_id : '',
        cookie: typeof row.cookie === 'string' ? row.cookie : '',
        userAgent: typeof row.user_agent === 'string' && row.user_agent ? row.user_agent : '',
        source: (typeof row.source === 'string' && row.source ? row.source : 'db'),
      },
      origin: 'database',
    };
  }
  const raw = (env.DEEPSEEK_CREDENTIAL || env.DEEPSEEK_WEB_TOKEN || '').trim();
  if (raw) {
    const parsed = parseCredential(raw);
    if (parsed.ok) return { credential: parsed.credential, origin: 'env' };
    return { error: `env credential unparsable: ${parsed.error}` };
  }
  return { error: 'no credential (paste one with npm run deepseek:credential -- "<string>")' };
}

let turns = 0;
let failures = 0;
let lastBeatAt = Date.now();
let lastWorkAt = Date.now();
let lastCredentialError = '';

async function serveOneTurn() {
  const claim = await call('deepseek_claim', { p_worker_id: WORKER_ID, p_queue: QUEUE });
  lastBeatAt = Date.now();
  if (!claim.claimed) return { worked: false, reason: claim.reason || claim.error || 'empty' };

  const resolved = await resolveCredential();
  if (resolved.error) {
    await call('deepseek_complete', { p_job_id: claim.job_id, p_ok: false, p_error: `relay: ${resolved.error}` });
    return { worked: true, jobId: claim.job_id, ok: false, error: resolved.error };
  }

  const result = await runRelayTurn(
    {
      rpc: call,
      credential: resolved.credential,
      workerId: WORKER_ID,
      origin: resolved.origin,
      transport: TRANSPORT_WORKER,
      shouldAbort: () => stopping,
    },
    { jobId: String(claim.job_id), queue: QUEUE, prompt: String(claim.prompt || '') },
  );

  const ms = result.metrics?.upstream_total_ms ?? 0;
  const ttft = result.metrics?.upstream_ttft_ms ?? 0;
  if (result.status === 'not_claimed') {
    // Another relay got there first (a second worker, or the Edge Function once deployed).
    return { worked: false, reason: `not_claimed:${result.error}` };
  }
  log(
    `turn ${result.jobId.slice(0, 8)} ${result.ok ? 'ok' : 'FAILED'} ${ms}ms (first token ${ttft}ms, ${result.chunks} chunks)` +
      `${result.error ? ` — ${String(result.error).slice(0, 160)}` : ''}` +
      `${result.title ? ` — “${String(result.title).slice(0, 40)}”` : ''}`,
  );
  return { worked: true, jobId: result.jobId, ok: result.ok, error: result.error };
}

// A relay that cannot reach the database is useless but still "running", so make the stall
// fatal and let the supervisor restart it.
const watchdog = setInterval(() => {
  const silent = Date.now() - lastBeatAt;
  if (silent > WATCHDOG_MS) {
    log(`no successful call for ${Math.round(silent / 1000)}s — exiting so the supervisor restarts`);
    process.exit(1);
  }
}, Math.max(5_000, Math.floor(WATCHDOG_MS / 3)));
watchdog.unref?.();

log(`worker ${WORKER_ID} → ${supabaseUrl} (queue ${QUEUE}, idle ${IDLE_MS}ms${ONCE ? ', once' : ''}${IDLE_EXIT_MS ? `, idle-exit ${IDLE_EXIT_MS}ms` : ''})`);

let credentialWarned = false;
while (!stopping) {
  let outcome;
  try {
    outcome = await serveOneTurn();
  } catch (err) {
    // A crash inside one turn must not take the relay down: log, back off, keep serving.
    failures += 1;
    log(`turn crashed (${failures}): ${(err && err.message) || err}`);
    await sleep(Math.min(30_000, IDLE_MS * 2 ** Math.min(failures, 5)));
    continue;
  }

  if (outcome.worked) {
    turns += 1;
    lastBeatAt = Date.now();
    lastWorkAt = Date.now();
    failures = 0;
    credentialWarned = false;
    if (!outcome.ok && outcome.error) log(`  ↳ ${outcome.error}`);
    if (ONCE) break;
    continue; // drain the queue back-to-back before idling
  }

  if (ONCE) break;

  const quiet = Date.now() - lastWorkAt;
  if (IDLE_EXIT_MS && quiet >= IDLE_EXIT_MS) {
    log(`quiet for ${Math.round(quiet / 1000)}s — exiting`);
    break;
  }
  if (outcome.reason === 'no_credential' && !credentialWarned) {
    credentialWarned = true;
  }
  await sleep(IDLE_MS + Math.floor(Math.random() * Math.max(1, IDLE_MS / 2)));
}

log(`served ${turns} turn(s) in ${Math.round((Date.now() - startedAt) / 1000)}s; credential ${mask((await resolveCredential().catch(() => ({}))).credential?.token || '', 4)}`);
if (stopping) process.exit(0);
