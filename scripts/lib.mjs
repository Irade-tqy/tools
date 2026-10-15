// Shared loader for the local dev scripts. Reads ~/tools/.env.local (git-ignored) and
// derives the handful of values the scripts need. Nothing here is ever committed.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

export const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv(file = '.env.local') {
  const path = resolve(rootDir, file);
  const env = { ...process.env };
  if (!existsSync(path)) return env;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) env[key] = value;
  }
  return env;
}

export const env = loadEnv();

export function requireEnv(name) {
  const value = env[name];
  if (!value) {
    throw new Error(`missing ${name} — add it to .env.local (see .env.example)`);
  }
  return value;
}

export const supabaseUrl = (env.TOOLS_SUPABASE_URL || '').replace(/\/+$/, '');
export const projectRef = supabaseUrl
  ? new URL(supabaseUrl).hostname.split('.')[0]
  : env.TOOLS_SUPABASE_REF || '';

// Direct connections to db.<ref>.supabase.co are IPv6-only on newer projects; fall back
// to the session pooler (IPv4, port 5432) when the machine has no IPv6 route.
export function dbUrl() {
  if (env.TOOLS_DB_URL) return env.TOOLS_DB_URL;
  const password = requireEnv('TOOLS_SUPABASE_DB_PASSWORD');
  const host = env.TOOLS_DB_HOST || `db.${projectRef}.supabase.co`;
  const user = env.TOOLS_DB_USER || (host.includes('pooler') ? `postgres.${projectRef}` : 'postgres');
  return `postgresql://${user}:${encodeURIComponent(password)}@${host}:5432/postgres`;
}

// pg connection config. Local TLS-intercepting proxies mean the Supabase chain cannot be
// verified from this machine, so certificate checks are relaxed for dev scripts only.
export function dbConfig() {
  const insecure = env.TOOLS_DB_SSL === 'disable';
  return {
    connectionString: dbUrl().replace(/[?&]sslmode=[^&]*/, ''),
    ssl: insecure ? false : { rejectUnauthorized: false },
  };
}

export function anonKey() {
  return requireEnv('TOOLS_SUPABASE_ANON_KEY');
}

export function serviceRoleKey() {
  return requireEnv('TOOLS_SUPABASE_SERVICE_ROLE_KEY');
}

// Minimal PostgREST RPC client: no SDK, no build step, works from plain node.
// timeoutMs matters for the long-running relay: a stalled connection would otherwise sit in
// await forever, and a relay that stops claiming also stops heartbeating.
export async function rpc(fn, args, { key, token, method = 'POST', timeoutMs = 0 } = {}) {
  const apiKey = key ?? anonKey();
  const url = `${supabaseUrl}/rest/v1/rpc/${fn}`;
  const headers = {
    apikey: apiKey,
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
  if (token) headers['x-clipboard-token'] = token;
  // This box reaches Supabase over Tailscale's MagicDNS and the link intermittently resets the
  // TLS handshake. A reset before the handshake completes means the request never reached
  // PostgREST, so replaying it is safe even for a mutating RPC; without this a single blip
  // aborts a whole live run before its first check.
  const TRANSIENT = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|socket hang up|fetch failed|network socket disconnected|TLS connection/i;
  let res;
  for (let attempt = 0; ; attempt += 1) {
    try {
      res = await fetch(url, {
        method,
        headers,
        body: method === 'GET' ? undefined : JSON.stringify(args ?? {}),
        signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
      });
      break;
    } catch (err) {
      const why = `${err?.message || err} ${err?.cause?.code || err?.cause?.message || ''}`;
      if (attempt >= 3 || !TRANSIENT.test(why)) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, ok: res.ok, body: json };
}

// Claim and close everything sitting in the deepseek queue. Tests use this to start from a
// known state (jobs otherwise linger for up to an hour) and to clean up afterwards.
export async function drainDeepseekQueue(workerId = 'drain') {
  let drained = 0;
  for (let i = 0; i < 100; i += 1) {
    const claim = await rpc('deepseek_claim', { p_worker_id: workerId });
    if (!claim.body?.claimed) break;
    await rpc('deepseek_complete', {
      p_job_id: claim.body.job_id,
      p_ok: false,
      p_error: 'drained by tests',
    });
    drained += 1;
  }
  return drained;
}

/**
 * Close jobs a dead relay left behind. A row stuck in claimed/streaming keeps counting
 * against deepseek_ask's backlog limit (>=10 pending → rate_limited), which is how a killed
 * test worker can make every later enqueue fail. Closes them over SQL (dev scripts only) and
 * then drains whatever is still queued.
 */
export async function clearDeepseekBacklog({ olderThanSeconds = 20, workerId = 'drain' } = {}) {
  const client = await connectDb();
  let closed = 0;
  try {
    const res = await client.query(
      `update public.deepseek_job
          set status = 'error',
              error = 'closed: relay went away mid-turn',
              finished_at = now(),
              metrics = metrics || jsonb_build_object('closed_at', now(), 'closed_by', $2::text)
        where status in ('claimed', 'streaming')
          and coalesce(claimed_at, created_at) < now() - ($1::int * interval '1 second')
        returning id`,
      [olderThanSeconds, workerId],
    );
    closed = res.rowCount ?? res.rows.length;
  } finally {
    await client.end().catch(() => {});
  }
  const drained = await drainDeepseekQueue(workerId);
  return { closed, drained };
}

// Resolve "owner/repo" from TOOLS_GH_REPO or the origin remote.
export function ghRepo() {
  const explicit = (env.TOOLS_GH_REPO || '').trim();
  if (explicit) return explicit;
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    const match = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
    if (match) return match[1];
  } catch {
    /* not a git checkout */
  }
  return '';
}

/** Replace (or append) one KEY=value line in .env.local without exposing the value. */
export function upsertEnvLocal(name, value, file = '.env.local') {
  const path = resolve(rootDir, file);
  const line = `${name}=${value}`;
  if (!existsSync(path)) {
    writeFileSync(path, `${line}\n`, { mode: 0o600 });
    return path;
  }
  const text = readFileSync(path, 'utf8');
  const next = new RegExp(`^${name}=.*$`, 'm').test(text)
    ? text.replace(new RegExp(`^${name}=.*$`, 'm'), line)
    : `${text.replace(/\n*$/, '')}\n${line}\n`;
  writeFileSync(path, next, { mode: 0o600 });
  return path;
}

/**
 * Turn Playwright's cookie list into the Cookie header the DeepSeek upstream expects, and
 * store it as DEEPSEEK_WEB_COOKIE. Returns a summary safe to print (names + length only).
 */
export function exportDeepseekCookie(cookies) {
  const relevant = cookies.filter((c) => String(c.domain).includes('deepseek.com'));
  const header = relevant.map((c) => `${c.name}=${c.value}`).join('; ');
  if (!header) return { written: false, names: [], length: 0 };
  upsertEnvLocal('DEEPSEEK_WEB_COOKIE', header);
  return { written: true, names: relevant.map((c) => c.name), length: header.length };
}

/**
 * The DeepSeek web app keeps its session in localStorage.userToken, not in a cookie, so the
 * upstream needs `Authorization: Bearer <userToken>`. Store it as DEEPSEEK_WEB_TOKEN.
 */
export function exportDeepseekToken(token) {
  const value = String(token || '').trim();
  if (!value) return { written: false, length: 0 };
  upsertEnvLocal('DEEPSEEK_WEB_TOKEN', value);
  return { written: true, length: value.length };
}

export function mask(value, keep = 6) {
  if (!value) return '(unset)';
  return value.length <= keep * 2 ? `${value.slice(0, 2)}…` : `${value.slice(0, keep)}…${value.slice(-4)}`;
}

// Supabase direct connections behind a local proxy drop occasionally; retry a few times
// before giving up so one blip does not fail a whole migration or test run.
export async function connectDb({ retries = 3, delayMs = 1200 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const client = new pg.Client(dbConfig());
    try {
      await client.connect();
      // A connection that dies between queries (this box reaches Postgres over Tailscale's
      // MagicDNS, and the link blips) emits 'error' on the client with no listener, which
      // becomes an uncaught exception and kills a whole test run after its queries already
      // succeeded. query() still rejects for the caller that is actually waiting on it.
      client.on('error', () => {});
      return client;
    } catch (err) {
      lastError = err;
      await client.end().catch(() => {});
      if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
  throw lastError;
}
