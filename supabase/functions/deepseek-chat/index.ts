// deepseek-chat — Supabase Edge Function (Deno).
//
// The relay. It claims the turn the UI queued, calls DeepSeek's own web API with the stored
// credential, and streams the answer back twice: live as SSE to the caller, and into
// deepseek_chunk so the Realtime / polling path renders exactly the same thing.
//
// Everything DeepSeek-specific lives in ../_shared (web-client, web-stream, pow, credential)
// so this file is only plumbing: claim → call → fan out → record.
//
// Secrets (npm run secrets:sync):
//   TOOLS_ADMIN_TOKEN      gates the credential actions below (the hidden #admin page)
//   DEEPSEEK_CREDENTIAL    optional fallback, `dscred1:…`; the database row is preferred
//   DEEPSEEK_WEB_TOKEN     legacy fallback, bare userToken
//
// Body shapes:
//   {job_id}                                              stream an already-queued turn
//   {prompt, session_id?, parent_message_id?, model_type?, thinking?, search?}
//                                                         queue a turn and stream it
//   {action:"credential_set", credential, admin_token}    paste one string → live credential
//   {action:"credential_status", admin_token}             what the server holds (no token)
//   {action:"health"}                                     queue + credential freshness

import {
  CANONICAL_PREFIX,
  fingerprint,
  parseCredential,
  serializeCredential,
  type DeepSeekCredential,
} from '../_shared/credential.ts';
import { DeepSeekWebClient, type ModelType } from '../_shared/web-client.ts';
import { runRelayTurn, TRANSPORT_EDGE, type RelayPayload } from '../_shared/relay.ts';

const SUPABASE_URL = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '');
const SERVICE_KEY =
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const ADMIN_TOKEN = Deno.env.get('TOOLS_ADMIN_TOKEN') ?? '';
const WORKER_ID = `edge-${crypto.randomUUID().slice(0, 8)}`;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function rpc(fn: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const key = SERVICE_KEY || ANON_KEY;
  if (!key) return { ok: false, error: 'no_service_key' };
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });
  } catch (err) {
    return { ok: false, error: `rpc_network_${fn}: ${(err as Error).message}` };
  }
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, error: `rpc_${fn}_http_${res.status}`, raw: text.slice(0, 300) };
  }
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : { ok: false, error: `empty_${fn}` };
  } catch {
    return { ok: false, error: `bad_json_${fn}`, raw: text.slice(0, 200) };
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function adminOk(body: Record<string, unknown>): boolean {
  if (!ADMIN_TOKEN) return false;
  const given = typeof body.admin_token === 'string' ? body.admin_token : '';
  return constantTimeEqual(given, ADMIN_TOKEN);
}

// ---------------------------------------------------------------------------
// credential resolution
// ---------------------------------------------------------------------------

async function resolveCredential(): Promise<{ credential: DeepSeekCredential; origin: string; status: Record<string, unknown> } | { error: string }> {
  const status = await rpc('deepseek_credential_status');
  const row = await rpc('deepseek_credential_get');
  if (row.ok && typeof row.token === 'string' && row.token) {
    return {
      credential: {
        token: row.token,
        deviceId: typeof row.device_id === 'string' ? row.device_id : '',
        cookie: typeof row.cookie === 'string' ? row.cookie : '',
        userAgent: typeof row.user_agent === 'string' && row.user_agent ? row.user_agent : '',
        source: (typeof row.source === 'string' && row.source ? row.source : 'db') as DeepSeekCredential['source'],
      },
      origin: 'database',
      status,
    };
  }

  // Fallback: an env secret, so the relay still answers if the row is missing.
  const raw = Deno.env.get('DEEPSEEK_CREDENTIAL') ?? Deno.env.get('DEEPSEEK_WEB_TOKEN') ?? '';
  if (raw.trim()) {
    const parsed = parseCredential(raw);
    if (parsed.ok) return { credential: parsed.credential, origin: 'env', status };
    return { error: `env_credential_unparsable: ${parsed.error}` };
  }
  return { error: 'no_credentials: 在 #admin 页面粘贴 DeepSeek 登录字符串，或运行 npm run deepseek:credential' };
}

// ---------------------------------------------------------------------------
// the relay — the protocol lives in ../_shared/relay.ts, this file is plumbing only
// ---------------------------------------------------------------------------

interface TurnRequest {
  jobId: string;
  queue: string;
  prompt: string;
  sessionId: string | null;
  parentMessageId: string | null;
  modelType: ModelType;
  thinking: boolean;
  search: boolean;
}

async function runTurn(turn: TurnRequest): Promise<Response> {
  const resolved = await resolveCredential();
  if ('error' in resolved) {
    return json({ ok: false, error: resolved.error, transport: TRANSPORT_EDGE }, 503);
  }

  const encoder = new TextEncoder();

  // Enqueue straight through: a token must not wait for a DB round-trip, and holding frames
  // back would turn a streaming answer into one big blob at the end.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: RelayPayload | string) => {
        const frame = typeof payload === 'string' ? `data: ${payload}\n\n` : `data: ${JSON.stringify(payload)}\n\n`;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          /* the client hung up mid-stream; the DB copy still completes */
        }
      };
      try {
        const result = await runRelayTurn(
          {
            rpc,
            credential: resolved.credential,
            workerId: WORKER_ID,
            origin: resolved.origin,
            transport: TRANSPORT_EDGE,
            emit: send,
          },
          {
            jobId: turn.jobId,
            queue: turn.queue,
            prompt: turn.prompt,
            sessionId: turn.sessionId,
            parentMessageId: turn.parentMessageId,
            modelType: turn.modelType,
            thinking: turn.thinking,
            search: turn.search,
          },
        );
        if (result.status === 'not_claimed') {
          send({ v: 1, _transport: TRANSPORT_EDGE, error: `not_claimed: ${result.error}`, job_id: result.jobId });
        }
        if (result.status === 'enqueue_failed') {
          send({ v: 1, _transport: TRANSPORT_EDGE, error: result.error, done: true, ok: false });
        }
        send('[DONE]');
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      ...CORS_HEADERS,
    },
  });
}

// ---------------------------------------------------------------------------
// credential actions
// ---------------------------------------------------------------------------

async function credentialSet(body: Record<string, unknown>): Promise<Response> {
  if (!ADMIN_TOKEN) return json({ ok: false, error: 'admin_disabled: TOOLS_ADMIN_TOKEN is not set on the server' }, 501);
  if (!adminOk(body)) return json({ ok: false, error: 'bad_admin_token' }, 401);

  const raw = typeof body.credential === 'string' ? body.credential : '';
  const parsed = parseCredential(raw);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);

  const credential = parsed.credential;

  if (body.verify !== false) {
    try {
      await new DeepSeekWebClient(credential).powChallenge();
    } catch (err) {
      return json({ ok: false, error: `verify_failed: ${(err as Error).message}`, fingerprint: fingerprint(credential) }, 400);
    }
  }

  const stored = await rpc('deepseek_credential_set', {
    p_token: credential.token,
    p_device_id: credential.deviceId || null,
    p_cookie: credential.cookie || null,
    p_user_agent: credential.userAgent || null,
    p_source: credential.source,
    p_note: body.verify === false ? 'stored without a live check' : 'verified against create_pow_challenge',
  });
  if (!stored.ok) return json({ ok: false, error: `store_failed: ${JSON.stringify(stored).slice(0, 200)}` }, 500);

  return json({
    ok: true,
    source: credential.source,
    fingerprint: fingerprint(credential),
    has_device_id: Boolean(credential.deviceId),
    has_cookie: Boolean(credential.cookie),
    warnings: parsed.warnings,
    // the reusable string: paste this back anywhere, or keep it as a backup
    canonical: serializeCredential(credential),
    canonical_prefix: CANONICAL_PREFIX,
    updated_at: stored.updated_at,
  });
}

async function credentialStatus(body: Record<string, unknown>): Promise<Response> {
  if (!adminOk(body)) return json({ ok: false, error: 'bad_admin_token' }, 401);
  const status = await rpc('deepseek_credential_status');
  return json(status, status.ok ? 200 : 500);
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ ok: false, error: 'use POST' }, 405);
  if (!SUPABASE_URL) return json({ ok: false, error: 'SUPABASE_URL is not set' }, 500);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'expected a JSON body' }, 400);
  }

  const action = typeof body.action === 'string' ? body.action : '';
  if (action === 'credential_set') return credentialSet(body);
  if (action === 'credential_status') return credentialStatus(body);
  if (action === 'health') {
    const health = await rpc('deepseek_health');
    return json({ ...health, transport: 'edge-web', admin_enabled: Boolean(ADMIN_TOKEN) });
  }

  const modelType = (typeof body.model_type === 'string' ? body.model_type : 'default') as ModelType;
  return runTurn({
    jobId: typeof body.job_id === 'string' ? body.job_id : '',
    queue: typeof body.queue === 'string' ? body.queue : 'default',
    prompt: typeof body.prompt === 'string' ? body.prompt : '',
    sessionId: typeof body.session_id === 'string' && body.session_id ? body.session_id : null,
    parentMessageId:
      typeof body.parent_message_id === 'string' || typeof body.parent_message_id === 'number'
        ? String(body.parent_message_id)
        : null,
    modelType: ['default', 'expert', 'vision'].includes(modelType) ? modelType : 'default',
    thinking: Boolean(body.thinking),
    search: Boolean(body.search),
  });
}

// Supabase's runtime hands the port over in PORT; Deno.serve() with no options would bind 8000
// regardless, which breaks local runs under `deno run`.
Deno.serve({ port: Number(Deno.env.get('PORT') || 8000) }, handle);
