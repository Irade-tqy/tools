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

/**
 * An answer reconstructed straight from the fixture's JSON, without the decoder.
 *
 * The existing assertions compare the decoder's output against itself (`text === state.text`),
 * which passes even when a whole patch is dropped. This walks the frames independently — every
 * fragment registration, every `…/content` patch, every bare `{"v":"…"}` delta — and buckets the
 * text by fragment type, so a dropped character shows up as a mismatch.
 */
function oracleAnswer(fixture: string): string {
  const raw = readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), 'utf8');
  const parse = createWebFrameParser();
  const types = new Map<number, string>();
  const order: number[] = [];
  const buckets = new Map<number, string>();
  let current: number | null = null;

  const note = (id: number, text: string) => {
    buckets.set(id, (buckets.get(id) ?? '') + text);
  };
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    const obj = value as Record<string, unknown>;
    if (typeof obj.id === 'number' && typeof obj.type === 'string') {
      const id = obj.id;
      if (!types.has(id)) {
        types.set(id, obj.type);
        order.push(id);
      } else types.set(id, obj.type);
      current = id;
      if (typeof obj.content === 'string') note(id, obj.content);
    }
    for (const key of Object.keys(obj)) walk(obj[key]);
  };

  for (const frame of [...parse(raw), ...parse.flush()]) {
    let obj: unknown;
    try {
      obj = JSON.parse(frame.data);
    } catch {
      continue;
    }
    if (typeof obj === 'string') {
      if (current !== null) note(current, obj);
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    const record = obj as Record<string, unknown>;
    walk(record.v);
    if (typeof record.p === 'string' && /content$/.test(record.p) && typeof record.v === 'string') {
      const op = String(record.o ?? '').toUpperCase();
      if (current === null) continue;
      if (op === 'SET' || op === 'REPLACE') buckets.set(current, record.v);
      else note(current, record.v);
    } else if (record.p === undefined && typeof record.v === 'string' && current !== null) {
      note(current, record.v);
    }
  }

  return order
    .filter((id) => ['RESPONSE', 'TEMPLATE_RESPONSE'].includes(types.get(id) ?? ''))
    .map((id) => buckets.get(id) ?? '')
    .join('');
}

describe('every recorded stream is decoded without losing text', () => {
  for (const fixture of ['stream-plain.txt', 'stream-thinking.txt', 'stream-search.txt', 'stream-backend-err.txt']) {
    it(`${fixture} matches an independent reconstruction`, () => {
      const { state } = replay(fixture);
      const expected = oracleAnswer(fixture);
      // stream-backend-err never produced an answer, so only the fixtures that do get a
      // length floor; the equality is the point either way.
      if (!fixture.includes('backend-err')) expect(expected.length).toBeGreaterThan(4);
      // A missing `o` on a content patch means APPEND upstream. Reading it as SET made the
      // decoder drop the answer's first character — "黎曼猜想" came out as "黎猜想".
      expect(state.text).toBe(expected);
    });
  }
});

describe('content patches with no explicit op', () => {
  it('appends a delta patch that omits `o`', () => {
    const state = createWebStreamState();
    const parse = createWebFrameParser();
    const wire = [
      'data: {"v":{"response":{"message_id":2,"fragments":[{"id":3,"type":"RESPONSE","content":"黎"}]}}}',
      '',
      'data: {"p":"response/fragments/-1/content","v":"曼"}',
      '',
      'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"猜想"}',
      '',
      'data: {"v":"断言"}',
      '',
      'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
      '',
    ].join('\n');
    for (const frame of [...parse(wire), ...parse.flush()]) applyWebFrame(state, frame);
    expect(state.text).toBe('黎曼猜想断言');
  });

  it('still treats an explicit SET as the whole fragment', () => {
    const state = createWebStreamState();
    const parse = createWebFrameParser();
    const wire = [
      'data: {"v":{"response":{"fragments":[{"id":3,"type":"RESPONSE","content":"abc"}]}}}',
      '',
      'data: {"p":"response/fragments/-1/content","o":"SET","v":"abcdef"}',
      '',
    ].join('\n');
    for (const frame of [...parse(wire), ...parse.flush()]) applyWebFrame(state, frame);
    expect(state.text).toBe('abcdef');
  });
});

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

describe('recorded upstream degradation (captured live)', () => {
  // DeepSeek was briefly unavailable and answered with a hint frame instead of an error frame.
  // The relay must report what the upstream said, not "upstream closed without an answer".
  const { state, text } = replay('stream-backend-err.txt');

  it('keeps the upstream reason and its finish reason', () => {
    expect(state.failed).toContain('服务器暂时不可用');
    expect(state.failed).toContain('backend_err');
  });

  it('treats the turn as finished so no generic fallback fires', () => {
    expect(state.finished).toBe(true);
    expect(text).toBe('');
  });
});
