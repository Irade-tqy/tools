// Tests for the Edge Function's pure helpers. They run under vitest (no Deno needed)
// because supabase/functions/_shared/deepseek.ts deliberately avoids Deno globals.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_API_URL,
  buildRequestBody,
  chunkEnvelope,
  createSseParser,
  extractDelta,
  markTtfb,
  markTtft,
  metricsOf,
  resolveUpstream,
  startTimings,
} from '../supabase/functions/_shared/deepseek';

describe('resolveUpstream', () => {
  it('prefers the API key route', () => {
    const cfg = resolveUpstream({ DEEPSEEK_API_KEY: 'sk-test', DEEPSEEK_WEB_COOKIE: 'session=x' });
    expect(cfg.mode).toBe('api');
    expect(cfg.url).toBe(DEFAULT_API_URL);
    expect(cfg.headers.Authorization).toBe('Bearer sk-test');
    expect(cfg.headers.Cookie).toBeUndefined();
  });

  it('falls back to the cookie route', () => {
    const cfg = resolveUpstream({ DEEPSEEK_WEB_COOKIE: 'session=abc' });
    expect(cfg.mode).toBe('cookie');
    expect(cfg.headers.Cookie).toBe('session=abc');
    expect(cfg.headers.Origin).toBe('https://chat.deepseek.com');
    expect(cfg.headers['User-Agent']).toContain('Mozilla');
  });

  it('reports why nothing is configured', () => {
    const cfg = resolveUpstream({});
    expect(cfg.mode).toBe('none');
    expect(cfg.reason).toContain('no_credentials');
  });

  it('honours an explicit endpoint and extra headers', () => {
    const cfg = resolveUpstream({
      DEEPSEEK_API_KEY: 'k',
      DEEPSEEK_API_URL: 'https://api.deepseek.com/frontend/chat/completions',
      DEEPSEEK_EXTRA_HEADERS: '{"x-trace":"42"}',
    });
    expect(cfg.url).toBe('https://api.deepseek.com/frontend/chat/completions');
    expect(cfg.headers['x-trace']).toBe('42');
  });

  it('ignores malformed extra headers instead of crashing', () => {
    const cfg = resolveUpstream({ DEEPSEEK_API_KEY: 'k', DEEPSEEK_EXTRA_HEADERS: '{oops' });
    expect(cfg.mode).toBe('api');
  });

  it('treats blank env values as unset', () => {
    expect(resolveUpstream({ DEEPSEEK_API_KEY: '   ' }).mode).toBe('none');
  });
});

describe('buildRequestBody', () => {
  it('sends a streaming request with the model and messages', () => {
    const body = JSON.parse(buildRequestBody([{ role: 'user', content: 'hi' }], 'deepseek-chat'));
    expect(body).toEqual({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
  });

  it('defaults an empty model', () => {
    expect(JSON.parse(buildRequestBody([], '')).model).toBe('deepseek-chat');
  });
});

describe('createSseParser', () => {
  it('handles arbitrary split points', () => {
    const parse = createSseParser();
    const events = [
      ...parse('data: {"a"'),
      ...parse(':1}\n\ndata: [DO'),
      ...parse('NE]\n\n'),
    ];
    expect(events.map((e) => e.data)).toEqual(['{"a":1}', '[DONE]']);
  });

  it('skips non-data lines', () => {
    const parse = createSseParser();
    expect(parse(': hi\nevent: ping\n\ndata: ok\n\n').map((e) => e.data)).toEqual(['ok']);
  });
});

describe('extractDelta', () => {
  it('reads streaming deltas', () => {
    expect(extractDelta({ choices: [{ delta: { content: 'a' }, finish_reason: null }] })).toMatchObject({
      content: 'a',
      finishReason: null,
      error: null,
    });
  });

  it('reads reasoning deltas', () => {
    expect(extractDelta({ choices: [{ delta: { reasoning_content: 'hmm' } }] }).reasoning).toBe('hmm');
  });

  it('surfaces errors', () => {
    expect(extractDelta({ error: { message: 'rate limited' } }).error).toBe('rate limited');
  });

  it('tolerates junk payloads', () => {
    expect(extractDelta(null)).toEqual({ content: '', reasoning: '', finishReason: null, error: null });
    expect(extractDelta({ choices: 'not-an-array' }).content).toBe('');
  });
});

describe('chunk envelope and timings', () => {
  it('tags every chunk with seq and transport', () => {
    expect(chunkEnvelope(3, { choices: [] }, 'edge-api')).toEqual({ choices: [], seq: 3, _transport: 'edge-api' });
  });

  it('records ttfb and ttft exactly once', () => {
    const timings = startTimings(1000);
    markTtfb(timings, 1200);
    markTtfb(timings, 1400);
    markTtft(timings, { content: '', reasoning: '', finishReason: null, error: null }, 1300);
    markTtft(timings, { content: 'x', reasoning: '', finishReason: null, error: null }, 1500);
    expect(timings.ttfbMs).toBe(200);
    expect(timings.ttftMs).toBe(500); // stamped by the first non-empty delta, once
  });

  it('does not stamp ttft on empty deltas', () => {
    const timings = startTimings(0);
    markTtft(timings, { content: '', reasoning: '', finishReason: null, error: null }, 500);
    expect(timings.ttftMs).toBeNull();
  });

  it('emits the metrics the UI expects for latency accounting', () => {
    const timings = startTimings(0);
    markTtfb(timings, 100);
    markTtft(timings, { content: 'x', reasoning: '', finishReason: null, error: null }, 250);
    const metrics = metricsOf(timings, 'edge-cookie', 900, { chunks: 12 });
    expect(metrics).toMatchObject({
      transport: 'edge-cookie',
      upstream_ttfb_ms: 100,
      upstream_ttft_ms: 250,
      upstream_total_ms: 900,
      chunks: 12,
    });
  });
});
