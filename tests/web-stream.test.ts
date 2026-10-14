// Replay of recorded DeepSeek web streams (tests/fixtures/stream-*.txt, captured with
// `node scripts/deepseek-pow-node.mjs --dump`). These are the ground truth for the fragment
// protocol: the answer must come only from RESPONSE fragments, reasoning only from THINK, and
// tool payloads must never leak into the answer text.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applyWebFrame,
  createWebFrameParser,
  createWebStreamState,
  resolveCitations,
  toolSummary,
  type WebStreamState,
} from '../supabase/functions/_shared/web-stream';

function replay(fixture: string) {
  const raw = readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), 'utf8');
  const state: WebStreamState = createWebStreamState();
  const parse = createWebFrameParser();
  const deltas: { text: string; thinking: string; tools: number }[] = [];
  let text = '';
  let thinking = '';
  for (const frame of [...parse(raw), ...parse.flush()]) {
    applyWebFrame(state, frame, (delta) => {
      text += delta.text;
      thinking += delta.thinking;
      if (delta.tool) deltas.push({ text: delta.text, thinking: delta.thinking, tools: 1 });
    });
  }
  // trailing bytes without a closing blank line still parse
  return { state, text, thinking, toolFrames: deltas.length };
}

describe('recorded plain answer', () => {
  const { state, text, thinking } = replay('stream-plain.txt');

  it('reassembles the answer and marks the turn finished', () => {
    expect(text).toBe(state.text);
    expect(text.length).toBeGreaterThan(4);
    expect(state.finished).toBe(true);
    expect(state.failed).toBeNull();
  });

  it('captures the ids the next turn needs to continue the conversation', () => {
    expect(state.requestMessageId).toBe(1);
    expect(state.responseMessageId).toBe(2);
    expect(state.title).toBeTruthy();
    expect(state.tokenUsage).toBeGreaterThan(0);
  });

  it('sees no tools and no reasoning', () => {
    expect(state.tools).toEqual([]);
    expect(thinking).toBe('');
    expect(toolSummary(state).used).toBe(false);
  });

  it('streams deltas rather than only the final snapshot', () => {
    // The first frame is a snapshot with the whole fragment; the deltas after it must not
    // duplicate it.
    expect(state.text).not.toContain(state.text.slice(0, 6).repeat(2));
  });
});

describe('recorded reasoning answer', () => {
  const { state, text, thinking } = replay('stream-thinking.txt');

  it('keeps reasoning out of the answer', () => {
    expect(thinking.length).toBeGreaterThan(20);
    expect(state.thinking).toBe(thinking);
    expect(text.length).toBeGreaterThan(0);
    expect(state.thinking).not.toContain(text.slice(0, 12));
  });

  it('routes THINK fragments to reasoning and RESPONSE fragments to the answer', () => {
    const types = new Set(Array.from(state.fragments.values()).map((f) => f.type));
    expect(types.has('THINK')).toBe(true);
    expect(types.has('RESPONSE')).toBe(true);
  });

  it('still reports a clean finish', () => {
    expect(state.finished).toBe(true);
    expect(state.failed).toBeNull();
  });
});

describe('recorded web-search answer', () => {
  const { state, text, thinking } = replay('stream-search.txt');

  it('records the search tool with its queries and results', () => {
    const summary = toolSummary(state);
    expect(summary.used).toBe(true);
    expect(summary.queries.length).toBeGreaterThan(0);
    expect(summary.resultCount).toBeGreaterThan(2);
    expect(state.tools.some((t) => t.type === 'SEARCH')).toBe(true);
  });

  it('never lets tool text into the answer or the reasoning', () => {
    expect(thinking).toBe('');
    expect(text).not.toMatch(/搜索到\s*\d+\s*个网页/);
    for (const tool of state.tools) {
      if (tool.label) expect(text).not.toContain(tool.label);
    }
  });

  it('resolves [citation:N] by cite_index, the way the app does', () => {
    expect(text).toContain('[citation:');
    const citations = resolveCitations(state);
    expect(citations.length).toBeGreaterThan(0);
    const byIndex = new Map<number, string>();
    for (const tool of state.tools) {
      for (const r of tool.results) if (r.cite_index !== null) byIndex.set(r.cite_index, r.url);
    }
    for (const citation of citations) {
      if (citation.kind !== 'citation') continue;
      expect(citation.resolved, `citation ${citation.index} should resolve`).toBe(true);
      expect(citation.url).toBe(byIndex.get(citation.index));
    }
  });

  it('flags the turn as search-triggered', () => {
    expect(state.searchTriggered).toBe(true);
  });
});

describe('frame parser', () => {
  it('splits frames that arrive split across chunk boundaries', () => {
    const parse = createWebFrameParser();
    const a = parse('event: ready\ndata: {"request_mess');
    const b = parse('age_id":7}\n\ndata: {"v":"hi"}\n\n');
    expect(a).toEqual([]);
    expect(b[0]).toEqual({ event: 'ready', data: '{"request_message_id":7}' });
    expect(b[1]).toEqual({ event: 'message', data: '{"v":"hi"}' });
  });

  it('ignores keep-alive and non-JSON frames without failing the turn', () => {
    const state = createWebStreamState();
    const parse = createWebFrameParser();
    for (const frame of parse('data: \ndata: not json\n\nevent: close\ndata: {}\n\n')) {
      applyWebFrame(state, frame);
    }
    expect(state.finished).toBe(true);
    expect(state.failed).toBeNull();
  });

  it('flushes a final frame that arrives without a trailing blank line', () => {
    const parse = createWebFrameParser();
    expect(parse('event: close\ndata: {"auto_resume":false}')).toEqual([]);
    expect(parse.flush()).toEqual([{ event: 'close', data: '{"auto_resume":false}' }]);
    expect(parse.flush()).toEqual([]);
  });

  it('turns an upstream error code into a failure', () => {
    const state = createWebStreamState();
    applyWebFrame(state, { event: 'message', data: JSON.stringify({ code: 402, msg: 'quota exceeded' }) });
    expect(state.failed).toContain('quota exceeded');
  });
});

describe('fragment routing', () => {
  it('appends only the part of a snapshot the stream has not already delivered', () => {
    const state = createWebStreamState();
    const parse = createWebFrameParser();
    const raw =
      'data: {"p":"response/fragments","o":"APPEND","v":[{"id":1,"type":"RESPONSE","content":"ab"}]}\n\n' +
      'data: {"v":"c"}\n\n' +
      'data: {"v":{"response":{"fragments":[{"id":1,"type":"RESPONSE","content":"abc"}]}}}\n\n';
    for (const frame of parse(raw)) applyWebFrame(state, frame);
    expect(state.text).toBe('abc');
  });

  it('keeps a tool fragment out of the answer even when it arrives mid-stream', () => {
    const state = createWebStreamState();
    const parse = createWebFrameParser();
    const raw =
      'data: {"p":"response/fragments","o":"APPEND","v":[{"id":1,"type":"SEARCH","queries":[{"query":"q"}]}]}\n\n' +
      'data: {"p":"content","o":"APPEND","v":"搜索到 1 个网页"}\n\n' +
      'data: {"p":"results","o":"SET","v":[{"url":"https://a","title":"A","cite_index":1,"site_name":"a"}]}\n\n' +
      'data: {"p":"response/fragments","o":"APPEND","v":[{"id":2,"type":"RESPONSE","content":"答案"}]}\n\n' +
      'data: {"v":"[citation:1]"}\n\n';
    for (const frame of parse(raw)) applyWebFrame(state, frame);
    expect(state.text).toBe('答案[citation:1]');
    expect(state.tools).toHaveLength(1);
    expect(state.tools[0]?.queries).toEqual(['q']);
    expect(state.tools[0]?.label).toBe('搜索到 1 个网页');
    expect(resolveCitations(state)[0]).toMatchObject({ index: 1, resolved: true, url: 'https://a' });
  });

  it('maps [reference:N] to the N-th opened page', () => {
    const state = createWebStreamState();
    const parse = createWebFrameParser();
    const raw =
      'data: {"p":"response/fragments","o":"APPEND","v":[{"id":5,"type":"TOOL_OPEN","result":{"url":"https://x/1","title":"one"}}]}\n\n' +
      'data: {"p":"response/fragments","o":"APPEND","v":[{"id":6,"type":"TOOL_OPEN","result":{"url":"https://x/2","title":"two"}}]}\n\n' +
      'data: {"p":"response/fragments","o":"APPEND","v":[{"id":7,"type":"RESPONSE","content":"[reference:1]"}]}\n\n';
    for (const frame of parse(raw)) applyWebFrame(state, frame);
    expect(state.opened.map((o) => o.url)).toEqual(['https://x/1', 'https://x/2']);
    expect(resolveCitations(state)[0]).toMatchObject({ kind: 'reference', index: 1, url: 'https://x/2' });
  });

  it('treats WIP as a normal state, not an error', () => {
    const state = createWebStreamState();
    const parse = createWebFrameParser();
    for (const frame of parse('data: {"p":"response/status","o":"SET","v":"WIP"}\n\nevent: close\ndata: {}\n\n')) {
      applyWebFrame(state, frame);
    }
    expect(state.failed).toBeNull();
    expect(state.finished).toBe(true);
  });
});
