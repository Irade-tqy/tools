import { describe, expect, it } from 'vitest';
import {
  LATENCY_BUDGET_MS,
  applyChunk,
  applyStatus,
  createChatState,
  describeLatency,
  extractDelta,
  formatMs,
  latencyOf,
} from '../src/lib/chat-reducer';

const chunk = (content: string, finish: string | null = null) => ({
  choices: [{ delta: { content }, finish_reason: finish }],
});

describe('extractDelta', () => {
  it('concatenates content across choices', () => {
    const delta = extractDelta({
      choices: [
        { delta: { content: 'a' } },
        { delta: { content: 'b' } },
      ],
    });
    expect(delta.content).toBe('ab');
  });

  it('separates reasoning from the answer', () => {
    const delta = extractDelta({ choices: [{ delta: { content: 'hi', reasoning_content: 'thinking' } }] });
    expect(delta).toMatchObject({ content: 'hi', reasoning: 'thinking' });
  });

  it('reads non-stream message payloads too', () => {
    expect(extractDelta({ choices: [{ message: { content: 'whole' }, finish_reason: 'stop' }] })).toMatchObject({
      content: 'whole',
      finishReason: 'stop',
    });
  });

  it('surfaces upstream errors in both shapes', () => {
    expect(extractDelta({ error: 'boom' }).error).toBe('boom');
    expect(extractDelta({ error: { message: 'bad key' } }).error).toBe('bad key');
  });
});

describe('applyChunk', () => {
  it('assembles the answer and stamps time-to-first-token', () => {
    const state = createChatState(1000);
    applyChunk(state, 0, chunk('He'), 1200);
    applyChunk(state, 1, chunk('llo'), 1300);
    expect(state.text).toBe('Hello');
    expect(state.firstTokenAt).toBe(1200);
    expect(state.done).toBe(false);
  });

  it('drops duplicate and out-of-order seqs', () => {
    const state = createChatState(0);
    applyChunk(state, 0, chunk('once'), 1);
    applyChunk(state, 0, chunk('once'), 2);
    applyChunk(state, 1, chunk(' twice'), 3);
    applyChunk(state, 1, chunk(' twice'), 4);
    expect(state.text).toBe('once twice');
    expect(state.lastSeq).toBe(1);
  });

  it('finishes on finish_reason', () => {
    const state = createChatState(0);
    applyChunk(state, 0, chunk('done', 'stop'), 50);
    expect(state.done).toBe(true);
    expect(state.finishedAt).toBe(50);
    expect(state.status).toBe('done');
  });

  it('treats an upstream error as terminal', () => {
    const state = createChatState(0);
    applyChunk(state, 0, { error: { message: 'quota' } }, 10);
    expect(state.error).toBe('quota');
    expect(state.done).toBe(true);
  });

  it('records the transport tag', () => {
    const state = createChatState(0);
    applyChunk(state, 0, { ...chunk('x'), _transport: 'edge-api' }, 1);
    expect(state.transport).toBe('edge-api');
  });

  it('keeps usage when the upstream sends it', () => {
    const state = createChatState(0);
    applyChunk(state, 0, { choices: [], usage: { total_tokens: 42 } }, 1);
    expect(state.usage).toEqual({ total_tokens: 42 });
  });
});

describe('applyStatus', () => {
  it('merges metrics and chunks from a poll response', () => {
    const state = createChatState(0);
    applyStatus(state, {
      status: 'streaming',
      metrics: { upstream_ttft_ms: 900, claimed_at: new Date(100).toISOString() },
      chunks: [{ seq: 0, payload: chunk('po') }, { seq: 1, payload: chunk('ng', 'stop') }],
    }, 500);
    expect(state.text).toBe('pong');
    expect(state.done).toBe(true);
    expect(state.metrics.upstream_ttft_ms).toBe(900);
  });

  it('marks finished snapshots done even with no chunks', () => {
    const state = createChatState(0);
    applyStatus(state, { status: 'done', finished: true }, 77);
    expect(state.done).toBe(true);
    expect(state.finishedAt).toBe(77);
  });
});

describe('latency accounting', () => {
  it('computes ttft, queue and added latency against the 5s budget', () => {
    const state = createChatState(0);
    state.metrics = { upstream_ttft_ms: 1200, claimed_at: new Date(300).toISOString() };
    applyChunk(state, 0, chunk('hi'), 1800);
    const report = latencyOf(state, 5000);
    expect(report.ttftMs).toBe(1800);
    expect(report.queueMs).toBe(300);
    expect(report.upstreamTtftMs).toBe(1200);
    expect(report.addedMs).toBe(600);
    expect(report.withinBudget).toBe(true);
  });

  it('flags an over-budget stream', () => {
    const state = createChatState(0);
    state.metrics = { upstream_ttft_ms: 1000 };
    applyChunk(state, 0, chunk('hi'), LATENCY_BUDGET_MS + 1001);
    const report = latencyOf(state);
    expect(report.addedMs).toBe(5001);
    expect(report.withinBudget).toBe(false);
  });

  it('stays null until upstream timings exist', () => {
    const state = createChatState(0);
    applyChunk(state, 0, chunk('hi'), 100);
    const report = latencyOf(state);
    expect(report.upstreamTtftMs).toBeNull();
    expect(report.addedMs).toBeNull();
    expect(report.withinBudget).toBeNull();
  });

  it('parses numeric-string metrics', () => {
    const state = createChatState(0);
    state.metrics = { upstream_ttft_ms: '800' };
    applyChunk(state, 0, chunk('x'), 1300);
    expect(latencyOf(state).addedMs).toBe(500);
  });

  it('total keeps growing until the stream finishes', () => {
    const state = createChatState(0);
    expect(latencyOf(state, 250).totalMs).toBe(250);
    applyChunk(state, 0, chunk('x', 'stop'), 400);
    expect(latencyOf(state, 900).totalMs).toBe(400);
  });
});

describe('formatting', () => {
  it('formats milliseconds readably', () => {
    expect(formatMs(null)).toBe('—');
    expect(formatMs(812)).toBe('812ms');
    expect(formatMs(1812)).toBe('1.81s');
    expect(formatMs(42_000)).toBe('42.0s');
  });

  it('describes a finished answer for the status line', () => {
    const state = createChatState(0);
    state.transport = 'browser';
    state.metrics = { upstream_ttft_ms: 1000 };
    applyChunk(state, 0, chunk('hi', 'stop'), 1500);
    const text = describeLatency(state);
    expect(text).toContain('首字 1.50s');
    expect(text).toContain('额外 500ms');
    expect(text).toContain('通道 browser');
  });
});
