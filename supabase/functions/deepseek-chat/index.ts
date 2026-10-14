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
import {
  applyWebFrame,
  createWebFrameParser,
  createWebStreamState,
  resolveCitations,
  toolSummary,
  type WebStreamState,
  type WebTool,
} from '../_shared/web-stream.ts';

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
// chunk fan-out (SSE + deepseek_chunk)
// ---------------------------------------------------------------------------

const MAX_RESULTS_PER_TOOL = 20;
const SNIPPET_CHARS = 160;

interface OutTool {
  id: number;
  type: string;
  status: string;
  label: string;
  queries: string[];
  results: { cite_index: number | null; title: string; url: string; site_name: string; snippet: string }[];
  page: { url: string; title: string } | null;
}

function outboundTool(tool: WebTool): OutTool {
  return {
    id: tool.id,
    type: tool.type,
    status: tool.status,
    label: tool.label.slice(0, 200),
    queries: tool.queries.slice(0, 10),
    results: tool.results.slice(-MAX_RESULTS_PER_TOOL).map((r) => ({
      cite_index: r.cite_index,
      title: r.title,
      url: r.url,
      site_name: r.site_name,
      snippet: r.snippet.slice(0, SNIPPET_CHARS),
    })),
    page: tool.page,
  };
}

/** Buffered writer: a DB round-trip must never serialise behind a token. */
class ChunkSink {
  private queue: { seq: number; payload: unknown }[] = [];
  private flushing = false;
  private timer: number | null = null;
  seq = 0;
  cancelled = false;

  constructor(private jobId: string) {}

  push(payload: unknown): void {
    this.queue.push({ seq: this.seq++, payload });
    if (this.queue.length >= 8) void this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, 250) as unknown as number;
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || !this.queue.length) return;
    this.flushing = true;
    const batch = this.queue.splice(0, this.queue.length);
    for (const item of batch) {
      const out = await rpc('deepseek_append', { p_job_id: this.jobId, p_seq: item.seq, p_payload: item.payload });
      if (!out.ok) {
        // job_cancelled / job_done server-side: stop writing, the caller stops streaming.
        if (typeof out.error === 'string' && out.error.startsWith('job_')) this.cancelled = true;
        break;
      }
    }
    this.flushing = false;
  }

  cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

// ---------------------------------------------------------------------------
// the relay
// ---------------------------------------------------------------------------

interface TurnRequest {
  jobId: string;
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
    return json({ ok: false, error: resolved.error, transport: 'edge-web' }, 503);
  }
  const { credential, origin } = resolved;
  const client = new DeepSeekWebClient(credential);

  let jobId = turn.jobId;
  if (!jobId) {
    const enqueued = await rpc('deepseek_ask', {
      p_prompt: turn.prompt,
      p_session_id: turn.sessionId,
      p_parent_message_id: turn.parentMessageId ? Number(turn.parentMessageId) : null,
      p_model_type: turn.modelType,
      p_thinking: turn.thinking,
      p_search: turn.search,
    });
    if (!enqueued.ok) return json(enqueued, 400);
    jobId = String(enqueued.job_id ?? '');
  }

  const claim = await rpc('deepseek_claim', { p_worker_id: WORKER_ID, p_job_id: jobId });
  if (!claim.claimed) {
    return json({ ok: false, error: 'not_claimed', job_id: jobId, reason: claim.reason ?? 'busy' }, 409);
  }
  const prompt = typeof claim.prompt === 'string' && claim.prompt ? claim.prompt : turn.prompt;
  let sessionId = typeof claim.session_id === 'string' && claim.session_id ? claim.session_id : turn.sessionId;
  const parentId = typeof claim.parent_message_id === 'string' ? claim.parent_message_id : turn.parentMessageId;
  const modelType = (typeof claim.model_type === 'string' ? claim.model_type : turn.modelType) as ModelType;
  const thinking = typeof claim.thinking_enabled === 'boolean' ? claim.thinking_enabled : turn.thinking;
  const search = typeof claim.search_enabled === 'boolean' ? claim.search_enabled : turn.search;

  const sink = new ChunkSink(jobId);
  const encoder = new TextEncoder();
  const state: WebStreamState = createWebStreamState();
  const startedAt = Date.now();
  let upstreamTtftMs: number | null = null;
  let powMs: number | null = null;

  const send = (controller: ReadableStreamDefaultController<Uint8Array>, payload: unknown) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let errorText: string | null = null;

      const emit = (delta: { text: string; thinking: string; tool: WebTool | null }) => {
        if (delta.text) {
          if (upstreamTtftMs === null) upstreamTtftMs = Date.now() - startedAt;
          const payload = { v: 1, _transport: 'edge-web', text: delta.text };
          sink.push(payload);
          send(controller, payload);
        }
        if (delta.thinking) {
          const payload = { v: 1, _transport: 'edge-web', thinking: delta.thinking };
          sink.push(payload);
          send(controller, payload);
        }
        if (delta.tool) {
          const payload = { v: 1, _transport: 'edge-web', tool: outboundTool(delta.tool) };
          sink.push(payload);
          send(controller, payload);
        }
      };

      try {
        // DeepSeek's completion endpoint refuses chat_session_id: null — a new conversation
        // has to create its session first, which is also what the web app does.
        const t0 = Date.now();
        if (!sessionId) {
          const created = await client.createSession();
          sessionId = created.id;
        }
        const response = await client.completion({
          prompt,
          chatSessionId: sessionId,
          parentMessageId: parentId,
          modelType,
          thinking,
          search,
        });
        powMs = Date.now() - t0;

        if (!response.body) throw new Error('upstream returned no body');
        const parse = createWebFrameParser();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const frame of parse(decoder.decode(value, { stream: true }))) {
            applyWebFrame(state, frame, emit);
            if (sink.cancelled) {
              await reader.cancel().catch(() => {});
              break;
            }
          }
        }
        for (const frame of parse.flush()) applyWebFrame(state, frame, emit);
        if (state.failed) errorText = state.failed;
        if (!state.finished && !errorText && !state.text) errorText = 'upstream closed without an answer';
      } catch (err) {
        errorText = (err as Error).message;
      }

      const finishedAt = Date.now();
      const summary = toolSummary(state);
      const citations = resolveCitations(state);

      const donePayload = {
        v: 1,
        _transport: 'edge-web',
        done: true,
        job_id: jobId,
        ok: !errorText,
        session_id: sessionId,
        reply_message_id: state.responseMessageId,
        title: state.title,
        mode: state.mode,
        search_triggered: state.searchTriggered,
        token_usage: state.tokenUsage,
        tools: state.tools.filter((t) => t.type !== 'UNKNOWN').map(outboundTool),
        citations: citations.slice(0, 30),
        error: errorText,
      };
      sink.push(donePayload);
      send(controller, donePayload);

      sink.cancelTimer();
      await sink.flush();

      const metrics = {
        upstream_ttft_ms: upstreamTtftMs ?? 0,
        upstream_total_ms: finishedAt - startedAt,
        pow_and_connect_ms: powMs ?? 0,
        chunks: sink.seq,
        frames: state.frames,
        credential_origin: origin,
        conversation_mode: state.mode,
        tool_kinds: summary.kinds.join(','),
        tool_results: summary.resultCount,
        token_usage: state.tokenUsage,
      };

      await rpc('deepseek_complete', {
        p_job_id: jobId,
        p_ok: !errorText,
        p_error: errorText,
        p_metrics: metrics,
        p_session_id: sessionId,
        p_reply_message_id: state.responseMessageId,
        p_title: state.title || null,
      });

      // Keep the credential's health visible: a 401-ish failure should show up in the
      // status strip as "登录过期" instead of a raw upstream error.
      await rpc('deepseek_credential_report', {
        p_ok: !errorText || !/HTTP 40[13]|unauthorized|invalid|expired/i.test(errorText ?? ''),
        p_error: errorText,
      });

      send(controller, '[DONE]');
      controller.close();
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
