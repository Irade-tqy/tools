// The relay turn, transport-free.
//
// One DeepSeek turn, end to end: claim the queued job → call the web upstream → fan the
// answer out to whoever is watching → record chunks, metrics and the conversation ids.
//
// Two hosts use this file:
//   supabase/functions/deepseek-chat/index.ts  (Deno, SSE to the waiting browser)
//   scripts/deepseek-worker.mjs                (node, a claim loop with no live caller)
//
// Nothing here touches Deno or node globals: the host injects `rpc` (PostgREST) and an
// optional `emit` (its own live stream), so the protocol cannot drift between hosts.

import type { DeepSeekCredential } from './credential.ts';
import { DeepSeekWebClient, type ModelType } from './web-client.ts';
import {
  applyWebFrame,
  createWebFrameParser,
  createWebStreamState,
  resolveCitations,
  type WebStreamState,
  type WebTool,
} from './web-stream.ts';

export type RelayRpc = (fn: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface RelayDeps {
  rpc: RelayRpc;
  credential: DeepSeekCredential;
  /** doubles as the heartbeat key deepseek_health() counts as workers_alive */
  workerId: string;
  /** where the credential came from — lands in metrics for the status strip */
  origin: string;
  /** the host's live transport; chunks are written to the DB regardless */
  emit?: (payload: RelayPayload) => void;
  /** stamped on every chunk so the job row says which host served it */
  transport?: string;
  /** injectable fetch — tests replay recorded upstream streams through the whole turn */
  fetchImpl?: typeof fetch;
  /** host wants to stop (SIGTERM / client disconnect) */
  shouldAbort?: () => boolean;
}

export interface RelayTurn {
  /** '' → enqueue the turn first (the browser path queues before it calls us) */
  jobId: string;
  /** which relay serves an enqueued turn; null/'' → the server's 'default' queue */
  queue?: string | null;
  prompt: string;
  sessionId?: string | null;
  parentMessageId?: string | null;
  modelType?: ModelType;
  thinking?: boolean;
  search?: boolean;
}

export interface RelayPayload {
  v: number;
  _transport: string;
  text?: string;
  thinking?: string;
  tool?: OutboundTool;
  done?: boolean;
  [key: string]: unknown;
}

export interface OutboundTool {
  id: number;
  type: string;
  status: string;
  label: string;
  queries: string[];
  results: { cite_index: number | null; title: string; url: string; site_name: string; snippet: string }[];
  page: { url: string; title: string } | null;
}

export interface RelayResult {
  jobId: string;
  ok: boolean;
  status: 'done' | 'not_claimed' | 'enqueue_failed' | 'cancelled';
  error: string | null;
  sessionId: string | null;
  replyMessageId: string | number | null;
  title: string;
  mode: string;
  chunks: number;
  metrics: Record<string, unknown>;
}

// The DB and the browser both cap this: 20 results and a short snippet per tool is plenty
// for a "已调用工具" chip, and a full deep-search pool can run to hundreds of rows.
const MAX_RESULTS_PER_TOOL = 20;
const SNIPPET_CHARS = 160;
const MAX_CITATIONS = 30;
const FLUSH_BATCH = 8;
const FLUSH_INTERVAL_MS = 250;
// PostgREST behind a TLS-intercepting proxy blips now and then. One blip used to discard the
// rest of the batch, which is how a long answer ended up with a handful of chunks in the DB.
const APPEND_RETRIES = 3;
const APPEND_BACKOFF_MS = 120;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const RELAY_TRANSPORT = 'relay-web';

/** What each host stamps on its chunks (the status strip and the job row report this). */
export const TRANSPORT_EDGE = 'edge-web';
export const TRANSPORT_WORKER = 'worker-web';

export function outboundTool(tool: WebTool): OutboundTool {
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
export class ChunkSink {
  // Plain field assignments, not constructor parameter properties: node's type stripping
  // (which scripts/deepseek-worker.mjs uses to import this file) rejects parameter properties.
  jobId: string;
  rpc: RelayRpc;
  private queue: { seq: number; payload: RelayPayload }[] = [];
  /** every write started so far — flush() must wait for all of them, not just its own */
  private inflight = new Set<Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  seq = 0;
  cancelled = false;
  /** why writing stopped — surfaced in metrics, because a lost tail loses the session ids */
  stopReason: string | null = null;

  constructor(jobId: string, rpc: RelayRpc) {
    this.jobId = jobId;
    this.rpc = rpc;
  }

  push(payload: RelayPayload): void {
    this.queue.push({ seq: this.seq++, payload });
    if (this.queue.length >= FLUSH_BATCH) void this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, FLUSH_INTERVAL_MS);
    }
  }

  /**
   * Drain the stream. Two races used to lose the tail here:
   *  - a second flush returned while a write started elsewhere was still running, so
   *    deepseek_complete landed first and the server answered the late appends with
   *    job_done — the done frame (session ids, title, timings) never reached the DB;
   *  - one failed append discarded the rest of its batch.
   * So: keep writing until the queue is empty, then wait for every in-flight write.
   */
  async flush(): Promise<void> {
    while (this.queue.length || this.inflight.size) {
      if (this.cancelled) {
        this.queue.length = 0;
        break;
      }
      if (!this.inflight.size && this.queue.length) {
        const batch = this.queue.splice(0, this.queue.length);
        const writing = this.write(batch).finally(() => this.inflight.delete(writing));
        this.inflight.add(writing);
      }
      if (this.inflight.size) await Promise.race(this.inflight);
    }
  }

  private async write(batch: { seq: number; payload: RelayPayload }[]): Promise<void> {
    for (const item of batch) {
      const res = await this.append(item);
      if (res.ok) continue;
      this.stopReason = `seq ${item.seq}: ${res.reason}`;
      // job_cancelled / job_done server-side: the caller has moved on, stop writing.
      if (res.terminal) {
        this.cancelled = true;
        return;
      }
      // A transient failure costs this one chunk, not the rest of the batch. Dropping the
      // whole batch is what used to strand the done frame (and with it the session ids).
    }
  }

  /** deepseek_append with a little backoff; never throws, whatever the transport does. */
  private async append(item: { seq: number; payload: RelayPayload }): Promise<{ ok: boolean; reason: string; terminal: boolean }> {
    let reason = 'unknown';
    for (let attempt = 0; attempt <= APPEND_RETRIES; attempt += 1) {
      try {
        const out = await this.rpc('deepseek_append', { p_job_id: this.jobId, p_seq: item.seq, p_payload: item.payload });
        if (out.ok) return { ok: true, reason: '', terminal: false };
        reason = typeof out.error === 'string' ? out.error : JSON.stringify(out).slice(0, 160);
        // The server says the job is over: retrying cannot help.
        if (reason.startsWith('job_')) return { ok: false, reason, terminal: true };
      } catch (err) {
        reason = `transport: ${((err as Error) && (err as Error).message) || 'append failed'}`;
      }
      if (attempt < APPEND_RETRIES) await delay(APPEND_BACKOFF_MS * (attempt + 1));
    }
    return { ok: false, reason: `${reason} (after ${APPEND_RETRIES + 1} attempts)`, terminal: false };
  }

  /** how many payloads are still buffered (a non-zero tail means the stream was cut short) */
  queueLength(): number {
    return this.queue.length;
  }

  /** writes that have not landed yet — must be zero before the job is completed */
  inflightCount(): number {
    return this.inflight.size;
  }

  stopTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

/**
 * Run one turn. Never throws: an upstream failure becomes ok=false + error, is streamed to
 * the caller, written to deepseek_chunk, recorded on the job row and reported against the
 * credential so a 401 shows up as "登录过期" in the status strip instead of a raw error.
 */
export async function runRelayTurn(deps: RelayDeps, turn: RelayTurn): Promise<RelayResult> {
  const { rpc, workerId, origin } = deps;
  const transport = deps.transport || RELAY_TRANSPORT;
  const client = new DeepSeekWebClient(deps.credential, deps.fetchImpl);

  let jobId = turn.jobId;
  if (!jobId) {
    const enqueued = await rpc('deepseek_ask', {
      p_prompt: turn.prompt,
      p_session_id: turn.sessionId ?? null,
      p_parent_message_id: turn.parentMessageId ? Number(turn.parentMessageId) : null,
      p_model_type: turn.modelType ?? 'default',
      p_thinking: Boolean(turn.thinking),
      p_search: Boolean(turn.search),
      p_queue: turn.queue ?? null,
    });
    if (!enqueued.ok) {
      return {
        jobId: '',
        ok: false,
        status: 'enqueue_failed',
        error: typeof enqueued.error === 'string' ? enqueued.error : JSON.stringify(enqueued).slice(0, 200),
        sessionId: null,
        replyMessageId: null,
        title: '',
        mode: '',
        chunks: 0,
        metrics: {},
      };
    }
    jobId = String(enqueued.job_id ?? '');
  }

  const claim = await rpc('deepseek_claim', { p_worker_id: workerId, p_job_id: jobId, p_queue: turn.queue ?? null });
  if (!claim.claimed) {
    return {
      jobId,
      ok: false,
      status: 'not_claimed',
      error: typeof claim.reason === 'string' ? claim.reason : 'busy',
      sessionId: null,
      replyMessageId: null,
      title: '',
      mode: '',
      chunks: 0,
      metrics: {},
    };
  }
  // A job the caller cancelled mid-flight surfaces as `job_cancelled` from deepseek_append
  // (see ChunkSink), which stops the read loop — there is nothing to pre-check here.
  const prompt = typeof claim.prompt === 'string' && claim.prompt ? claim.prompt : turn.prompt;
  let sessionId = typeof claim.session_id === 'string' && claim.session_id ? claim.session_id : (turn.sessionId ?? null);
  const parentId = typeof claim.parent_message_id === 'string' ? claim.parent_message_id : (turn.parentMessageId ?? null);
  const modelType = (typeof claim.model_type === 'string' ? claim.model_type : (turn.modelType ?? 'default')) as ModelType;
  const thinking = typeof claim.thinking_enabled === 'boolean' ? claim.thinking_enabled : Boolean(turn.thinking);
  const search = typeof claim.search_enabled === 'boolean' ? claim.search_enabled : Boolean(turn.search);

  const sink = new ChunkSink(jobId, rpc);
  const state: WebStreamState = createWebStreamState();
  const startedAt = Date.now();
  let upstreamTtftMs: number | null = null;
  let powMs: number | null = null;

  const emit = (payload: RelayPayload) => {
    sink.push(payload);
    deps.emit?.(payload);
  };

  // One place to turn a stream delta into the chunk shape the reducer dedupes on.
  const emitDelta = (delta: { text: string; thinking: string; tool: WebTool | null }) => {
    if (delta.text) {
      if (upstreamTtftMs === null) upstreamTtftMs = Date.now() - startedAt;
      emit({ v: 1, _transport: transport, text: delta.text });
    }
    if (delta.thinking) emit({ v: 1, _transport: transport, thinking: delta.thinking });
    if (delta.tool) emit({ v: 1, _transport: transport, tool: outboundTool(delta.tool) });
  };

  let errorText: string | null = null;

  try {
    // DeepSeek's completion endpoint refuses chat_session_id: null — a new conversation has
    // to create its session first, which is also what the web app does.
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
        applyWebFrame(state, frame, emitDelta);
        if (sink.cancelled || deps.shouldAbort?.()) {
          await reader.cancel().catch(() => {});
          break;
        }
      }
      if (sink.cancelled || deps.shouldAbort?.()) break;
    }
    for (const frame of parse.flush()) applyWebFrame(state, frame, emitDelta);
    if (state.failed) errorText = state.failed;
    if (!state.finished && !errorText && !state.text) errorText = 'upstream closed without an answer';
  } catch (err) {
    errorText = (err as Error).message;
  }

  const finishedAt = Date.now();
  const citations = resolveCitations(state);

  const donePayload: RelayPayload = {
    v: 1,
    _transport: transport,
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
    citations: citations.slice(0, MAX_CITATIONS),
    error: errorText,
  };
  emit(donePayload);

  sink.stopTimer();
  await sink.flush();
  const written = sink.seq - sink.queueLength() - sink.inflightCount();

  const metrics = {
    upstream_ttft_ms: upstreamTtftMs ?? 0,
    upstream_total_ms: finishedAt - startedAt,
    pow_and_connect_ms: powMs ?? 0,
    chunks: sink.seq,
    chunks_written: written,
    chunks_pending: sink.queueLength() + sink.inflightCount(),
    chunk_stop_reason: sink.stopReason,
    frames: state.frames,
    credential_origin: origin,
    conversation_mode: state.mode,
    tool_kinds: state.tools.map((t) => t.type).filter((t) => t !== 'UNKNOWN').join(','),
    tool_results: state.tools.reduce((n, t) => n + t.results.length, 0),
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

  await rpc('deepseek_credential_report', {
    p_ok: !errorText || !/HTTP 40[13]|unauthorized|invalid|expired/i.test(errorText),
    p_error: errorText,
  });

  return {
    jobId,
    ok: !errorText,
    status: 'done',
    error: errorText,
    sessionId,
    replyMessageId: state.responseMessageId,
    title: state.title,
    mode: state.mode,
    chunks: sink.seq,
    metrics,
  };
}
