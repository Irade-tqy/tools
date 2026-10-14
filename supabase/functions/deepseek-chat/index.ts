// deepseek-chat — Supabase Edge Function (Deno).
//
// Claims the job the UI just enqueued, calls DeepSeek with credentials kept in Supabase
// secrets (never in this repo), and streams the answer back twice: live as SSE to the
// caller, and into deepseek_chunk so the Realtime/polling path renders the same answer.
//
// Secrets (set with `npm run secrets:sync` or the dashboard):
//   DEEPSEEK_API_KEY      Bearer key  → official /v1/chat/completions route
//   DEEPSEEK_WEB_COOKIE   web session cookie → cookie route (needs DEEPSEEK_API_URL if the
//                         web endpoint differs; may still hit WAF/PoW)
//   DEEPSEEK_API_URL      override upstream URL
//   DEEPSEEK_EXTRA_HEADERS  JSON object of extra headers
//
// With neither credential set the function answers 501 and the toolbox falls back to a
// logged-in browser tab running public/deepseek-worker.js.

import {
  buildRequestBody,
  chunkEnvelope,
  createSseParser,
  extractDelta,
  markTtfb,
  markTtft,
  metricsOf,
  resolveUpstream,
  startTimings,
  type ChatMessage,
} from '../_shared/deepseek.ts';

const SUPABASE_URL = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '');
const SERVICE_KEY =
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const WORKER_ID = `edge-${crypto.randomUUID().slice(0, 8)}`;

const ENV_KEYS = [
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_WEB_COOKIE',
  'DEEPSEEK_API_URL',
  'DEEPSEEK_WEB_URL',
  'DEEPSEEK_EXTRA_HEADERS',
  'DEEPSEEK_USER_AGENT',
];

function envSnapshot(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    try {
      out[key] = Deno.env.get(key);
    } catch {
      out[key] = undefined;
    }
  }
  return out;
}

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

async function rpc(fn: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const key = SERVICE_KEY || ANON_KEY;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : { ok: false, error: `empty_${res.status}` };
  } catch {
    return { ok: false, error: `bad_json_${res.status}`, raw: text.slice(0, 200) };
  }
}

/** Buffered writer: DB round-trips must not serialise behind every token. */
class ChunkSink {
  private queue: { seq: number; payload: unknown }[] = [];
  private flushing = false;
  private timer: number | null = null;
  seq = 0;

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
      const out = await rpc('deepseek_append', {
        p_job_id: this.jobId,
        p_seq: item.seq,
        p_payload: item.payload,
      });
      if (!out.ok) break; // job cancelled or finished server-side
    }
    this.flushing = false;
  }

  get delivered(): number {
    return this.seq;
  }

  cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ ok: false, error: 'use POST' }, 405);
  if (!SUPABASE_URL) return json({ ok: false, error: 'SUPABASE_URL is not set' }, 500);

  let body: { job_id?: string; messages?: ChatMessage[]; model?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'expected a JSON body' }, 400);
  }

  const upstream = resolveUpstream(envSnapshot());
  if (upstream.mode === 'none') {
    return json({ ok: false, error: upstream.reason, transport: 'edge' }, 501);
  }

  let jobId = body.job_id ?? '';
  let messages = Array.isArray(body.messages) ? body.messages : [];

  if (!jobId) {
    if (!messages.length) return json({ ok: false, error: 'job_id or messages is required' }, 400);
    const enqueued = await rpc('deepseek_enqueue', { p_messages: messages, p_model: body.model ?? null });
    if (!enqueued.ok) return json(enqueued, 400);
    jobId = String(enqueued.job_id ?? '');
    const status = await rpc('deepseek_status', { p_job_id: jobId, p_since_seq: -1 });
    const job = status as { messages?: ChatMessage[] };
    if (Array.isArray(job.messages) && job.messages.length) messages = job.messages;
  }

  const claim = await rpc('deepseek_claim', { p_worker_id: WORKER_ID, p_job_id: jobId });
  if (!claim.claimed) {
    // Someone else (a browser worker) already owns it — the UI keeps rendering from the DB.
    return json({ ok: false, error: 'not_claimed', job_id: jobId, reason: claim.reason ?? 'busy' }, 409);
  }
  const claimed = claim as { messages?: ChatMessage[]; model?: string };
  if (Array.isArray(claimed.messages) && claimed.messages.length) messages = claimed.messages;
  const model = claimed.model ?? body.model ?? 'deepseek-chat';

  const sink = new ChunkSink(jobId);
  const timings = startTimings();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: string) => controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
      let errorText: string | null = null;

      try {
        const res = await fetch(upstream.url, {
          method: 'POST',
          headers: upstream.headers,
          body: buildRequestBody(messages, model, true),
        });
        markTtfb(timings);

        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => '');
          errorText = `upstream HTTP ${res.status} ${text.slice(0, 300)}`.trim();
        } else {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          const parse = createSseParser();
          let finishReason: string | null = null;

          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            for (const event of parse(decoder.decode(value, { stream: true }))) {
              if (event.data === '[DONE]') continue;
              let payload: unknown;
              try {
                payload = JSON.parse(event.data);
              } catch {
                continue;
              }
              const delta = extractDelta(payload);
              markTtft(timings, delta);
              if (delta.error) errorText = delta.error;
              if (delta.finishReason) finishReason = delta.finishReason;
              const envelope = chunkEnvelope(sink.delivered, payload, upstream.mode === 'api' ? 'edge-api' : 'edge-cookie');
              sink.push(envelope);
              send(JSON.stringify(envelope));
            }
          }
          if (!finishReason && !errorText) finishReason = 'stop';
        }
      } catch (err) {
        errorText = `upstream request failed: ${(err as Error).message}`;
      }

      sink.cancelTimer();
      await sink.flush();
      await rpc('deepseek_complete', {
        p_job_id: jobId,
        p_ok: !errorText,
        p_error: errorText,
        p_metrics: metricsOf(timings, upstream.mode === 'api' ? 'edge-api' : 'edge-cookie', Date.now(), {
          chunks: sink.delivered,
        }),
      });

      if (errorText) send(JSON.stringify({ error: { message: errorText } }));
      send('[DONE]');
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

Deno.serve(handle);
