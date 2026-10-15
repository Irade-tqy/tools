// Pure chat state: turns the relay's normalized chunks (from the Edge Function's SSE or from
// the deepseek_chunk table) into rendered text, tool summaries and citations, and does the
// latency accounting the "≤ 5s slower than the official site" target depends on.
//
// No DOM, no fetch — unit tested against recorded DeepSeek streams.

export type Metrics = Record<string, string | number>;

/** A search result, as the relay trims it before storing. */
export interface ToolResult {
  cite_index: number | null;
  title: string;
  url: string;
  site_name: string;
  snippet: string;
}

export interface ToolPayload {
  id: number;
  type: string;
  status: string;
  label: string;
  queries: string[];
  results: ToolResult[];
  page: { url: string; title: string } | null;
}

export interface ChatCitation {
  marker: string;
  kind: 'citation' | 'reference';
  index: number;
  resolved: boolean;
  title: string;
  url: string;
  site_name: string;
}

/** The relay's normalized chunk. seq is assigned by the transport, never by DeepSeek. */
export interface ChunkPayload {
  v?: number;
  _transport?: string;
  text?: string;
  thinking?: string;
  tool?: ToolPayload;
  done?: boolean;
  ok?: boolean;
  /** the transport stopped this turn because the user pressed Stop */
  stopped?: boolean;
  session_id?: string | null;
  reply_message_id?: number | string | null;
  title?: string;
  mode?: string;
  search_triggered?: boolean;
  token_usage?: number;
  tools?: ToolPayload[];
  citations?: ChatCitation[];
  error?: string | null;
}

export interface ChatState {
  jobId: string | null;
  text: string;
  reasoning: string;
  status: string;
  transport: string | null;
  error: string | null;
  done: boolean;
  lastSeq: number;
  /** The lowest seq not yet applied. It sits on the hole even after a flush, so the cursor keeps
   * asking the server for it — a chunk that arrives after the flush still has to land. */
  nextSeq: number;
  /** Every seq already applied, contiguous or flushed. This is the dedupe key; re-fetching from
   * the hole is expected and must not append the same text twice. */
  seen: Set<number>;
  /** Chunks that arrived ahead of `nextSeq`; held until the gap in front of them fills. */
  pending: Map<number, ChunkPayload>;
  /** When the oldest held chunk arrived, so a permanently missing seq cannot stall the answer. */
  pendingSince: number | null;
  metrics: Metrics;
  tools: ToolPayload[];
  citations: ChatCitation[];
  sessionId: string | null;
  replyMessageId: string | null;
  /** true when the user stopped this turn — the next one has to carry the reasoning forward */
  stopped: boolean;
  title: string;
  mode: string;
  searchTriggered: boolean;
  tokenUsage: number;
  startedAt: number;
  firstTokenAt: number | null;
  finishedAt: number | null;
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
    nextSeq: 0,
    seen: new Set<number>(),
    pending: new Map<number, ChunkPayload>(),
    pendingSince: null,
    metrics: {},
    tools: [],
    citations: [],
    sessionId: null,
    replyMessageId: null,
    stopped: false,
    title: '',
    mode: '',
    searchTriggered: false,
    tokenUsage: 0,
    startedAt,
    firstTokenAt: null,
    finishedAt: null,
  };
}

function upsertTool(state: ChatState, tool: ToolPayload): void {
  const existing = state.tools.find((t) => t.id === tool.id);
  if (!existing) {
    state.tools.push(tool);
    return;
  }
  // Later frames carry more results; never let a shorter frame undo an earlier one.
  existing.type = tool.type || existing.type;
  existing.status = tool.status || existing.status;
  existing.label = tool.label || existing.label;
  if (tool.queries?.length) existing.queries = tool.queries;
  if (tool.results && tool.results.length >= (existing.results?.length ?? 0)) existing.results = tool.results;
  if (tool.page) existing.page = tool.page;
}

/**
 * Three transports feed this client at once — Realtime, the polling fallback and the Edge SSE
 * — so chunks arrive out of order and sometimes twice. Applying them in arrival order would
 * scramble the answer; dropping anything below a high-water mark loses the chunk that arrived
 * late, which is how the "已调用工具" chip disappeared on the deployed site: the subscription
 * started after the relay wrote seq 0 (the tool payload), so seq 1 landed first and seq 0 was
 * never offered again. Hold anything that is early, apply the contiguous prefix, and let the
 * cursor ask the server for the hole.
 */
export function applyChunk(state: ChatState, seq: number, payload: ChunkPayload, now = Date.now()): ChatState {
  // Another relay may own the job; its DB stream supplies the answer and sequence.
  if (payload.error?.startsWith('not_claimed:')) return state;
  if (state.seen.has(seq)) return state; // already in the answer (redelivery from another transport)
  if (seq !== state.nextSeq) {
    if (!state.pending.has(seq)) {
      state.pending.set(seq, payload);
      if (state.pendingSince === null) state.pendingSince = now;
    }
    return state;
  }
  applyPayload(state, seq, payload, now);
  drainPending(state, now);
  return state;
}

/**
 * Apply whatever is buffered, in seq order, without waiting for the gap in front of it. Used
 * when the turn finishes (the tail must not be held hostage) and when a hole stops refilling
 * (a chunk the relay could not write is gone for good). `nextSeq` deliberately stays on the
 * hole: the cursor keeps asking for it, and if the chunk turns up after all, it still lands —
 * abandoning the hole is what lost the tool payload the first time.
 */
export function flushPending(state: ChatState, now = Date.now()): ChatState {
  if (!state.pending.size) return state;
  for (const seq of [...state.pending.keys()].sort((a, b) => a - b)) {
    const payload = state.pending.get(seq)!;
    state.pending.delete(seq);
    applyPayload(state, seq, payload, now);
  }
  state.pendingSince = null;
  return state;
}

function drainPending(state: ChatState, now: number): void {
  for (;;) {
    if (state.seen.has(state.nextSeq)) {
      state.nextSeq += 1; // applied by an earlier flush, so the prefix is contiguous again
      continue;
    }
    if (!state.pending.has(state.nextSeq)) break;
    const payload = state.pending.get(state.nextSeq)!;
    state.pending.delete(state.nextSeq);
    applyPayload(state, state.nextSeq, payload, now);
    state.nextSeq += 1;
  }
  state.pendingSince = state.pending.size ? (state.pendingSince ?? now) : null;
}

function applyPayload(state: ChatState, seq: number, payload: ChunkPayload, now: number): ChatState {
  state.seen.add(seq);
  if (seq > state.lastSeq) state.lastSeq = seq;

  if (payload?._transport) state.transport = payload._transport;

  // The relay announces the upstream ids as soon as its `ready` frame arrives, not only in the
  // done chunk. A turn the user stops, or a page that reloads mid-answer, still needs them: the
  // next message continues from the stopped message, and without them it silently continues
  // from the one before it — which is how a Stop used to drop the context.
  if (payload?.session_id) state.sessionId = String(payload.session_id);
  if (payload?.reply_message_id !== undefined && payload?.reply_message_id !== null) {
    state.replyMessageId = String(payload.reply_message_id);
  }
  if (payload?.stopped) state.stopped = true;

  if (payload?.thinking) state.reasoning += payload.thinking;

  if (payload?.tool) upsertTool(state, payload.tool);

  if (payload?.text) {
    if (state.firstTokenAt === null) state.firstTokenAt = now;
    state.text += payload.text;
  }

  if (payload?.error && !payload.done) {
    state.error = String(payload.error);
    state.done = true;
    state.finishedAt = state.finishedAt ?? now;
    return state;
  }

  if (payload?.done) {
    state.done = true;
    state.finishedAt = state.finishedAt ?? now;
    state.status = payload.ok === false ? 'error' : 'done';
    if (payload.session_id) state.sessionId = String(payload.session_id);
    if (payload.reply_message_id !== undefined && payload.reply_message_id !== null) {
      state.replyMessageId = String(payload.reply_message_id);
    }
    if (payload.title) state.title = payload.title;
    if (payload.mode) state.mode = payload.mode;
    if (typeof payload.search_triggered === 'boolean') state.searchTriggered = payload.search_triggered;
    if (typeof payload.token_usage === 'number') state.tokenUsage = payload.token_usage;
    if (Array.isArray(payload.citations)) state.citations = payload.citations;
    if (Array.isArray(payload.tools)) for (const tool of payload.tools) upsertTool(state, tool);
    if (payload.ok === false && payload.error) state.error = String(payload.error);
  }
  return state;
}

/**
 * The `since_seq` value to ask the server for: one below `nextSeq`, i.e. from the first seq we
 * are still missing. Using `lastSeq` strands a hole — the server only returns `seq > since_seq`,
 * so a chunk that arrived too early to apply would never be offered again. Polls re-send what
 * is already applied; `seen` drops them.
 */
export function chunkCursor(state: ChatState): number {
  return state.nextSeq - 1;
}

export interface StatusSnapshot {
  status?: string;
  transport?: string | null;
  metrics?: Metrics | null;
  error?: string | null;
  finished?: boolean;
  session_id?: string | null;
  reply_message_id?: string | null;
  parent_message_id?: string | null;
  title?: string | null;
  model_type?: string | null;
  chunks?: { seq: number; payload: ChunkPayload; created_at?: string }[];
}

export function applyStatus(state: ChatState, snapshot: StatusSnapshot, now = Date.now()): ChatState {
  if (snapshot.status) state.status = snapshot.status;
  if (snapshot.transport) state.transport = snapshot.transport;
  if (snapshot.metrics) state.metrics = { ...state.metrics, ...snapshot.metrics };
  if (snapshot.error) state.error = snapshot.error;
  if (snapshot.session_id) state.sessionId = snapshot.session_id;
  if (snapshot.reply_message_id) state.replyMessageId = snapshot.reply_message_id;
  if (snapshot.title) state.title = snapshot.title;

  for (const chunk of snapshot.chunks ?? []) {
    applyChunk(state, chunk.seq, chunk.payload, now);
  }

  // The tail must never be held in the buffer: once the job is finished, whatever arrived is
  // all there will ever be, so a hole in front of it is permanent.
  if (snapshot.finished) flushPending(state, now);

  // WIP is a normal terminal state for DeepSeek (a stopped or tool-only answer), so only a
  // job the backend actually finished counts as done.
  if (snapshot.finished && !state.done) {
    state.done = true;
    state.finishedAt = state.finishedAt ?? now;
  }
  return state;
}

// ---------------------------------------------------------------------------
// tool / citation presentation helpers
// ---------------------------------------------------------------------------

export interface ToolSummary {
  used: boolean;
  /** human labels, e.g. ["网页搜索 · 6 个结果", "打开页面"] */
  kinds: string[];
  queries: string[];
  resultCount: number;
  pages: { url: string; title: string }[];
  mode: string;
}

const TOOL_LABELS: Record<string, string> = {
  SEARCH: '网页搜索',
  TOOL_SEARCH: '深度搜索',
  TOOL_OPEN: '打开页面',
  TOOL_FIND: '页内查找',
  TIP: '提示',
  FILE: '文件',
};

export function toolSummaryOf(state: ChatState): ToolSummary {
  const kinds: string[] = [];
  const pages: { url: string; title: string }[] = [];
  const queries: string[] = [];
  let resultCount = 0;
  for (const tool of state.tools) {
    const label = TOOL_LABELS[tool.type] ?? tool.type;
    const withCount = tool.results?.length ? `${label} · ${tool.results.length} 个结果` : label;
    if (!kinds.includes(withCount)) kinds.push(withCount);
    for (const q of tool.queries ?? []) if (!queries.includes(q)) queries.push(q);
    resultCount += tool.results?.length ?? 0;
    if (tool.page?.url && !pages.some((p) => p.url === tool.page?.url)) pages.push(tool.page);
  }
  return {
    used: state.tools.length > 0 || state.searchTriggered,
    kinds,
    queries,
    resultCount,
    pages,
    mode: state.mode,
  };
}

/** Sources worth linking, deduped by url, search results first then opened pages. */
export function sourcesOf(state: ChatState): { url: string; title: string; site: string }[] {
  const out: { url: string; title: string; site: string }[] = [];
  const seen = new Set<string>();
  const add = (url: string, title: string, site: string) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ url, title: title || site || url, site });
  };
  for (const citation of state.citations) if (citation.resolved) add(citation.url, citation.title, citation.site_name);
  for (const tool of state.tools) {
    for (const r of tool.results ?? []) add(r.url, r.title, r.site_name);
    if (tool.page?.url) add(tool.page.url, tool.page.title, '');
  }
  return out;
}

// ---------------------------------------------------------------------------
// latency accounting
// ---------------------------------------------------------------------------

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
  /** time the job sat in the queue before the relay claimed it */
  queueMs: number | null;
  /** the relay's own time-to-first-token, measured against DeepSeek */
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
  if (state.tokenUsage) parts.push(`${state.tokenUsage} tokens`);
  return parts.join(' · ');
}
