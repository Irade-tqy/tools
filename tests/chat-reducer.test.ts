import { describe, expect, it } from 'vitest';
import {
  LATENCY_BUDGET_MS,
  applyChunk,
  applyStatus,
  chunkCursor,
  createChatState,
  describeLatency,
  flushPending,
  formatMs,
  latencyOf,
  sourcesOf,
  toolSummaryOf,
  type ChunkPayload,
  type ToolPayload,
} from '../src/lib/chat-reducer';

const iso = (ms: number) => new Date(ms).toISOString();

const tool = (overrides: Partial<ToolPayload> = {}): ToolPayload => ({
  id: 2,
  type: 'SEARCH',
  status: 'WIP',
  label: '搜索到 2 个网页',
  queries: ['上海天气'],
  results: [
    { cite_index: 1, title: 'A', url: 'https://a', site_name: 'a.com', snippet: 'x' },
    { cite_index: 2, title: 'B', url: 'https://b', site_name: 'b.com', snippet: 'y' },
  ],
  page: null,
  ...overrides,
});

describe('applyChunk', () => {
  it('concatenates answer deltas and stamps the first token', () => {
    const state = createChatState(1000);
    applyChunk(state, 0, { text: '你' }, 1100);
    applyChunk(state, 1, { text: '好' }, 1200);
    expect(state.text).toBe('你好');
    expect(state.firstTokenAt).toBe(1100);
    expect(state.done).toBe(false);
  });

  it('keeps reasoning separate from the answer', () => {
    const state = createChatState();
    applyChunk(state, 0, { thinking: '先算 9.11 …' }, 1);
    applyChunk(state, 1, { text: '9.11 更大' }, 2);
    expect(state.reasoning).toBe('先算 9.11 …');
    expect(state.text).toBe('9.11 更大');
  });

  it('holds an out-of-order chunk so the answer stays in seq order', () => {
    const state = createChatState();
    applyChunk(state, 1, { text: '好' }, 10);
    expect(state.text).toBe(''); // seq 0 is still missing — hold it, do not append early
    applyChunk(state, 0, { text: '你' }, 11);
    expect(state.text).toBe('你好');
    applyChunk(state, 1, { text: 'IGNORED' }, 12); // exact replay
    expect(state.text).toBe('你好');
    expect(state.lastSeq).toBe(1);
    expect(state.nextSeq).toBe(2);
  });

  it('keeps a tool payload that arrives after a later text chunk', () => {
    // The live failure this guards: the subscription started after the relay wrote seq 0 (the
    // SEARCH payload), so seq 1 landed first and the "已调用工具" chip never appeared.
    const state = createChatState();
    applyChunk(state, 1, { text: '今天晴' }, 10);
    applyChunk(state, 0, { tool: tool() }, 11);
    expect(toolSummaryOf(state).used).toBe(true);
    expect(toolSummaryOf(state).kinds).toEqual(['网页搜索 · 2 个结果']);
    expect(state.text).toBe('今天晴');
  });

  it('asks for the lowest missing seq so a gap refills', () => {
    const state = createChatState();
    expect(chunkCursor(state)).toBe(-1);
    applyChunk(state, 1, { text: 'b' }, 10);
    // seq 0 is still missing: the server only returns seq > since_seq, so the cursor has to
    // sit below the hole or the chunk is stranded forever.
    expect(chunkCursor(state)).toBe(-1);
    applyChunk(state, 0, { tool: tool() }, 11);
    expect(chunkCursor(state)).toBe(1);
    applyChunk(state, 2, { done: true }, 12);
    expect(chunkCursor(state)).toBe(2);
  });

  it('releases buffered chunks when a hole looks permanent, but keeps asking for it', () => {
    const state = createChatState();
    applyChunk(state, 2, { text: '尾' }, 10);
    expect(state.text).toBe('');
    flushPending(state, 20);
    expect(state.text).toBe('尾');
    // The cursor must not walk past the hole: on the deployed page the tool payload arrived
    // after this flush, and a cursor at lastSeq dropped it for good.
    expect(chunkCursor(state)).toBe(-1);
    applyChunk(state, 0, { tool: tool() }, 30);
    expect(toolSummaryOf(state).used).toBe(true);
    expect(state.text).toBe('尾'); // the flushed chunk is not appended twice
    applyChunk(state, 1, { text: '中' }, 31);
    expect(state.text).toBe('尾中'); // late content lands even though it can no longer be re-ordered
    expect(state.seen.size).toBe(3);
  });

  it('releases the tail as soon as the job reports finished', () => {
    const state = createChatState();
    applyChunk(state, 2, { text: '尾' }, 10);
    applyStatus(state, { status: 'done', finished: true }, 20);
    expect(state.text).toBe('尾');
    expect(state.done).toBe(true);
  });

  it('ends the turn on an error chunk', () => {
    const state = createChatState();
    applyChunk(state, 0, { error: 'upstream HTTP 401' }, 50);
    expect(state.done).toBe(true);
    expect(state.error).toContain('401');
    expect(state.finishedAt).toBe(50);
  });

  it('records the conversation ids that let the next turn continue', () => {
    const state = createChatState();
    applyChunk(state, 0, { text: 'hi' }, 1);
    applyChunk(
      state,
      1,
      {
        done: true,
        ok: true,
        session_id: 'sess-9',
        reply_message_id: 42,
        title: '天气问题',
        mode: 'DEEP_SEARCH',
        search_triggered: true,
        token_usage: 243,
        citations: [{ marker: 'citation:1', kind: 'citation', index: 1, resolved: true, title: 'A', url: 'https://a', site_name: 'a.com' }],
      },
      900,
    );
    expect(state.done).toBe(true);
    expect(state.sessionId).toBe('sess-9');
    expect(state.replyMessageId).toBe('42');
    expect(state.title).toBe('天气问题');
    expect(state.mode).toBe('DEEP_SEARCH');
    expect(state.searchTriggered).toBe(true);
    expect(state.tokenUsage).toBe(243);
    expect(state.citations).toHaveLength(1);
  });

  it('marks a failed done payload as an error turn', () => {
    const state = createChatState();
    applyChunk(state, 0, { done: true, ok: false, error: 'HTTP 401' }, 1);
    expect(state.status).toBe('error');
    expect(state.error).toBe('HTTP 401');
  });

  it('upserts tools without losing results a later frame omits', () => {
    const state = createChatState();
    applyChunk(state, 0, { tool: tool() });
    applyChunk(state, 1, { tool: tool({ status: 'FINISHED', results: [] }) });
    expect(state.tools).toHaveLength(1);
    expect(state.tools[0]?.status).toBe('FINISHED');
    expect(state.tools[0]?.results).toHaveLength(2);
  });
});

describe('applyStatus', () => {
  it('merges metrics, chunks and the session ids stored server-side', () => {
    const state = createChatState();
    applyStatus(state, {
      status: 'done',
      finished: true,
      metrics: { upstream_ttft_ms: 600, claimed_at: new Date(1200).toISOString() },
      session_id: 'sess-1',
      reply_message_id: '7',
      chunks: [
        { seq: 0, payload: { text: 'partial' } as ChunkPayload },
        { seq: 1, payload: { done: true, ok: true } as ChunkPayload },
      ],
    });
    expect(state.text).toBe('partial');
    expect(state.done).toBe(true);
    expect(state.sessionId).toBe('sess-1');
    expect(state.replyMessageId).toBe('7');
    expect(latencyOf(state, 2000).upstreamTtftMs).toBe(600);
  });

  it('keeps an error message from the job row', () => {
    const state = createChatState();
    applyStatus(state, { status: 'error', error: 'credential expired', finished: true });
    expect(state.error).toContain('expired');
    expect(state.done).toBe(true);
  });
});

describe('tool summary', () => {
  it('labels tools and counts results for the "已调用工具" chip', () => {
    const state = createChatState();
    applyChunk(state, 0, { tool: tool() });
    applyChunk(state, 1, { tool: tool({ id: 3, type: 'TOOL_OPEN', results: [], label: '', queries: [], page: { url: 'https://a', title: 'A' } }) });
    const summary = toolSummaryOf(state);
    expect(summary.used).toBe(true);
    expect(summary.kinds).toEqual(['网页搜索 · 2 个结果', '打开页面']);
    expect(summary.queries).toEqual(['上海天气']);
    expect(summary.resultCount).toBe(2);
    expect(summary.pages).toEqual([{ url: 'https://a', title: 'A' }]);
  });

  it('reports no tools for a plain answer', () => {
    const state = createChatState();
    applyChunk(state, 0, { text: 'hi' });
    expect(toolSummaryOf(state).used).toBe(false);
  });

  it('dedupes sources across citations and tool results', () => {
    const state = createChatState();
    applyChunk(state, 0, { tool: tool() });
    applyChunk(state, 1, {
      citations: [
        { marker: 'citation:1', kind: 'citation', index: 1, resolved: true, title: 'A', url: 'https://a', site_name: 'a.com' },
        { marker: 'citation:9', kind: 'citation', index: 9, resolved: false, title: '', url: '', site_name: '' },
      ],
      done: true,
      ok: true,
    });
    const sources = sourcesOf(state);
    expect(sources.map((s) => s.url)).toEqual(['https://a', 'https://b']);
  });
});

describe('latency accounting', () => {
  it('measures our ttft, the queue wait and the overhead over upstream', () => {
    const state = createChatState(1000);
    applyStatus(state, { status: 'streaming', metrics: { claimed_at: iso(1300), upstream_ttft_ms: 500 } });
    applyChunk(state, 0, { text: 'a' }, 1600);
    applyChunk(state, 1, { done: true, ok: true }, 2600);

    const report = latencyOf(state, 3000);
    expect(report.ttftMs).toBe(600);
    expect(report.queueMs).toBe(300);
    expect(report.upstreamTtftMs).toBe(500);
    expect(report.addedMs).toBe(100);
    expect(report.withinBudget).toBe(true);
    expect(report.totalMs).toBe(1600);
  });

  it('flags a turn that exceeds the 5s budget', () => {
    const state = createChatState(0);
    applyStatus(state, { metrics: { upstream_ttft_ms: 500 } });
    applyChunk(state, 0, { text: 'a' }, LATENCY_BUDGET_MS + 5000 + 1);
    expect(latencyOf(state).withinBudget).toBe(false);
  });

  it('reports no budget verdict before upstream timings exist', () => {
    const state = createChatState(0);
    applyChunk(state, 0, { text: 'a' }, 100);
    const report = latencyOf(state);
    expect(report.upstreamTtftMs).toBeNull();
    expect(report.withinBudget).toBeNull();
  });
});

describe('formatting', () => {
  it('formats durations', () => {
    expect(formatMs(null)).toBe('—');
    expect(formatMs(940)).toBe('940ms');
    expect(formatMs(2500)).toBe('2.50s');
    expect(formatMs(65_000)).toBe('65.0s');
  });

  it('describes a finished turn including token usage', () => {
    const state = createChatState(0);
    applyStatus(state, { metrics: { claimed_at: iso(100), upstream_ttft_ms: 400 } });
    applyChunk(state, 0, { text: 'a' }, 700);
    applyChunk(state, 1, { done: true, ok: true, token_usage: 120 }, 1500);
    const text = describeLatency(state);
    expect(text).toContain('首字 700ms');
    expect(text).toContain('排队 100ms');
    expect(text).toContain('额外 300ms');
    expect(text).toContain('120 tokens');
  });
});
