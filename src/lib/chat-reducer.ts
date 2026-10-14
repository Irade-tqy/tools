// Pure chat state: turns DeepSeek chunk payloads (from the edge function SSE or from the
// deepseek_chunk table) into rendered text, and does the latency accounting the
// "≤ 5s slower than the official site" target depends on. No DOM, no fetch — unit tested.

export type Metrics = Record<string, string | number>;

export interface ChatState {
  jobId: string | null;
  text: string;
  reasoning: string;
  status: string;
  transport: string | null;
  error: string | null;
  done: boolean;
  lastSeq: number;
  metrics: Metrics;
  usage: Record<string, number> | null;
  startedAt: number;
  firstTokenAt: number | null;
  finishedAt: number | null;
}

export interface ChunkPayload {
  error?: { message?: string; type?: string } | string;
  choices?: {
    delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null };
    message?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null };
    finish_reason?: string | null;
  }[];
  usage?: Record<string, number>;
  _transport?: string;
}

/** The agreed budget: our end-to-end time-to-first-token may exceed upstream's by 5s. */
export const LATENCY_BUDGET_MS = 5000;

export function createChatState(startedAt = Date.now()): ChatState {
  return {
    jobId: null,
    text: '',
    reasoning: '',
    status: 'idle',
    transport: null,
    error: null,
    done: false,
    lastSeq: -1,
    metrics: {},
    usage: null,
    startedAt,
    firstTokenAt: null,
    finishedAt: null,
  };
}

export function extractDelta(payload: ChunkPayload): {
  content: string;
  reasoning: string;
  finishReason: string | null;
  error: string | null;
} {
  let content = '';
  let reasoning = '';
  let finishReason: string | null = null;
  let error: string | null = null;

  if (typeof payload?.error === 'string') error = payload.error;
  else if (payload?.error?.message) error = payload.error.message;

  for (const choice of payload?.choices ?? []) {
    const delta = choice.delta ?? choice.message ?? {};
    content += delta.content ?? '';
    reasoning += delta.reasoning_content ?? delta.reasoning ?? '';
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  return { content, reasoning, finishReason, error };
}

export function applyChunk(
  state: ChatState,
  seq: number,
  payload: ChunkPayload,
  now = Date.now(),
): ChatState {
  // Chunks are appended with a monotonic seq by the transport; Realtime can redeliver,
  // and the SSE path may race the polling fallback, so drop anything already rendered.
  if (seq <= state.lastSeq) return state;
  state.lastSeq = seq;

  if (payload?._transport) state.transport = payload._transport;

  const delta = extractDelta(payload);
  if (delta.error) {
    state.error = delta.error;
    state.done = true;
    state.finishedAt = state.finishedAt ?? now;
    return state;
  }

  if (delta.content) {
    if (state.firstTokenAt === null) state.firstTokenAt = now;
    state.text += delta.content;
  }
  if (delta.reasoning) state.reasoning += delta.reasoning;
  if (payload?.usage) state.usage = payload.usage;

  if (delta.finishReason) {
    state.done = true;
    state.finishedAt = state.finishedAt ?? now;
    state.status = 'done';
  }
  return state;
}

export interface StatusSnapshot {
  status?: string;
  transport?: string | null;
  metrics?: Metrics | null;
  error?: string | null;
  finished?: boolean;
  chunks?: { seq: number; payload: ChunkPayload; created_at?: string }[];
}

export function applyStatus(state: ChatState, snapshot: StatusSnapshot, now = Date.now()): ChatState {
  if (snapshot.status) state.status = snapshot.status;
  if (snapshot.transport) state.transport = snapshot.transport;
  if (snapshot.metrics) state.metrics = { ...state.metrics, ...snapshot.metrics };
  if (snapshot.error) state.error = snapshot.error;

  for (const chunk of snapshot.chunks ?? []) {
    applyChunk(state, chunk.seq, chunk.payload, now);
  }

  if (snapshot.finished && !state.done) {
    state.done = true;
    state.finishedAt = state.finishedAt ?? now;
  }
  return state;
}

function metricNumber(metrics: Metrics, key: string): number | null {
  const value = metrics[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value);
  return null;
}

function metricTime(metrics: Metrics, key: string): number | null {
  const value = metrics[key];
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export interface LatencyReport {
  /** our send → first visible token */
  ttftMs: number | null;
  /** our send → stream finished */
  totalMs: number | null;
  /** time the job sat in the queue before a transport claimed it */
  queueMs: number | null;
  /** the transport's own time-to-first-token, measured against DeepSeek */
  upstreamTtftMs: number | null;
  /** ttftMs - upstreamTtftMs: the overhead this toolbox adds */
  addedMs: number | null;
  withinBudget: boolean | null;
}

export function latencyOf(state: ChatState, now = Date.now()): LatencyReport {
  const ttftMs = state.firstTokenAt === null ? null : state.firstTokenAt - state.startedAt;
  const totalMs = state.finishedAt === null ? now - state.startedAt : state.finishedAt - state.startedAt;
  const claimedAt = metricTime(state.metrics, 'claimed_at');
  const queueMs = claimedAt === null ? null : Math.max(0, claimedAt - state.startedAt);
  const upstreamTtftMs = metricNumber(state.metrics, 'upstream_ttft_ms');
  const addedMs = ttftMs !== null && upstreamTtftMs !== null ? ttftMs - upstreamTtftMs : null;
  return {
    ttftMs,
    totalMs,
    queueMs,
    upstreamTtftMs,
    addedMs,
    withinBudget: addedMs === null ? null : addedMs <= LATENCY_BUDGET_MS,
  };
}

export function formatMs(ms: number | null): string {
  if (ms === null) return '—';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

export function describeLatency(state: ChatState, now = Date.now()): string {
  const report = latencyOf(state, now);
  const parts = [`首字 ${formatMs(report.ttftMs)}`, `总 ${formatMs(report.totalMs)}`];
  if (report.queueMs !== null) parts.push(`排队 ${formatMs(report.queueMs)}`);
  if (report.addedMs !== null) {
    parts.push(`额外 ${formatMs(report.addedMs)}${report.withinBudget ? '' : '（超 5s）'}`);
  }
  if (state.transport) parts.push(`通道 ${state.transport}`);
  return parts.join(' · ');
}
