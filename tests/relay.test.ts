import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { ChunkSink, outboundTool, runRelayTurn, type RelayPayload } from '../supabase/functions/_shared/relay';

type Call = { fn: string; args: Record<string, unknown> };

const webTool = {
  id: 3,
  type: 'SEARCH',
  status: 'done',
  label: '搜索到 40 个网页',
  queries: ['今天上海天气'],
  results: Array.from({ length: 40 }, (_, i) => ({
    cite_index: i + 1,
    title: `结果 ${i}`,
    url: `https://example.com/${i}`,
    site_name: 'example',
    snippet: 'x'.repeat(400),
  })),
  page: null,
};

const credential = { token: 't', deviceId: '', cookie: '', userAgent: 'UA', source: 'test' } as never;

describe('outboundTool', () => {
  it('caps the result pool and the snippet so a deep search stays light', () => {
    const out = outboundTool(webTool as never);
    expect(out.results).toHaveLength(20);
    expect(out.results.at(-1)?.cite_index).toBe(40);
    expect(out.results[0]?.snippet.length).toBeLessThanOrEqual(160);
  });
});

describe('ChunkSink', () => {
  it('writes every chunk once, in seq order', async () => {
    const calls: Call[] = [];
    const sink = new ChunkSink('job-1', async (fn, args) => {
      calls.push({ fn, args: (args ?? {}) as Call['args'] });
      return { ok: true, seq: args?.p_seq };
    });
    sink.push({ v: 1, _transport: 'worker-web', text: 'a' });
    sink.push({ v: 1, _transport: 'worker-web', text: 'b' });
    sink.stopTimer();
    await sink.flush();

    expect(calls.map((c) => c.args.p_seq)).toEqual([0, 1]);
    expect(calls.every((c) => c.fn === 'deepseek_append')).toBe(true);
  });

  it('never strands the tail when a flush is already in flight', async () => {
    // The old implementation returned early while a flush was mid-flight, so the done frame
    // (session ids, title, timings) could stay in the queue while the job got completed —
    // a client that only polls the DB then never learned how to continue the conversation.
    let release: () => void = () => {};
    const written: number[] = [];
    const sink = new ChunkSink('job-2', async (_fn, args) => {
      written.push(args?.p_seq as number);
      if (written.length === 1) await new Promise<void>((resolve) => (release = resolve));
      return { ok: true };
    });

    sink.push({ v: 1, _transport: 'worker-web', text: 'first' });
    const first = sink.flush();
    sink.push({ v: 1, _transport: 'worker-web', done: true });
    const second = sink.flush();
    release();
    await Promise.all([first, second]);

    expect(written).toEqual([0, 1]);
  });

  it('stops writing once the server says the job is over', async () => {
    const written: number[] = [];
    const sink = new ChunkSink('job-3', async (_fn, args) => {
      written.push(args?.p_seq as number);
      return written.length === 1 ? { ok: false, error: 'job_cancelled' } : { ok: true };
    });
    sink.push({ v: 1, _transport: 'worker-web', text: 'a' });
    sink.push({ v: 1, _transport: 'worker-web', text: 'b' });
    sink.stopTimer();
    await sink.flush();

    expect(written).toEqual([0]);
    expect(sink.cancelled).toBe(true);
  });

  it('loses one chunk, not the batch, when an append throws', async () => {
    // PostgREST behind the local proxy blips; one blip used to discard every later chunk,
    // which is how a 130-chunk answer ended up with 124 rows and no done frame.
    const written: number[] = [];
    const sink = new ChunkSink('job-4', async (_fn, args) => {
      const seq = args?.p_seq as number;
      if (seq === 1) throw new Error('socket hang up');
      written.push(seq);
      return { ok: true };
    });
    for (let i = 0; i < 5; i += 1) sink.push({ v: 1, _transport: 'worker-web', text: `${i}` });
    sink.stopTimer();
    await sink.flush();

    expect(written).toEqual([0, 2, 3, 4]);
    expect(sink.stopReason).toContain('seq 1');
    expect(sink.cancelled).toBe(false);
  });

  it('retries a transient failure instead of dropping the chunk', async () => {
    const attempts: number[] = [];
    const written: number[] = [];
    const sink = new ChunkSink('job-5', async (_fn, args) => {
      const seq = args?.p_seq as number;
      attempts.push(seq);
      if (seq === 0 && attempts.filter((s) => s === 0).length < 3) return { ok: false, error: 'http_503' };
      written.push(seq);
      return { ok: true };
    });
    sink.push({ v: 1, _transport: 'worker-web', text: 'a' });
    sink.push({ v: 1, _transport: 'worker-web', done: true });
    sink.stopTimer();
    await sink.flush();

    expect(written).toEqual([0, 1]);
    expect(attempts.filter((s) => s === 0)).toHaveLength(3);
    expect(sink.stopReason).toBeNull();
  });

  it('does not return from flush while a push()-started write is still landing', async () => {
    // deepseek_complete runs the moment flush resolves. If flush returns early, the job is
    // already 'done' and the server rejects the late chunks with job_done — tail lost.
    const written: number[] = [];
    let release: () => void = () => {};
    const sink = new ChunkSink('job-6', async (_fn, args) => {
      const seq = args?.p_seq as number;
      if (seq === 0) await new Promise<void>((resolve) => (release = resolve));
      written.push(seq);
      return { ok: true };
    });
    for (let i = 0; i < 8; i += 1) sink.push({ v: 1, _transport: 'worker-web', text: `${i}` });
    // the 8th push started a write that is parked on seq 0; a second flush joins it
    const joined = sink.flush();
    release();
    await joined;
    sink.push({ v: 1, _transport: 'worker-web', done: true });
    sink.stopTimer();
    await sink.flush();

    expect(written.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(sink.inflightCount()).toBe(0);
  });
});

describe('runRelayTurn', () => {
  it('reports not_claimed without touching the upstream', async () => {
    const calls: Call[] = [];
    const result = await runRelayTurn(
      {
        rpc: async (fn, args) => {
          calls.push({ fn, args: (args ?? {}) as Call['args'] });
          return fn === 'deepseek_claim' ? { ok: true, claimed: false, reason: 'not_available' } : { ok: true };
        },
        credential,
        workerId: 'w',
        origin: 'test',
        transport: 'worker-web',
      },
      { jobId: 'job-9', prompt: 'hi' },
    );

    expect(result.status).toBe('not_claimed');
    expect(calls.map((c) => c.fn)).toEqual(['deepseek_claim']);
  });

  it('surfaces an enqueue failure instead of throwing', async () => {
    const result = await runRelayTurn(
      { rpc: async () => ({ ok: false, error: 'rate_limited', retry_after_seconds: 60 }), credential, workerId: 'w', origin: 'test' },
      { jobId: '', prompt: 'hi' },
    );
    expect(result.status).toBe('enqueue_failed');
    expect(result.error).toBe('rate_limited');
  });

  it('runs a recorded upstream stream end to end: chunks, done frame, job row', async () => {
    const raw = readFileSync(new URL('./fixtures/stream-plain.txt', import.meta.url), 'utf8');
    const calls: Call[] = [];
    const payloads: RelayPayload[] = [];

    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const json = (data: unknown) =>
        new Response(JSON.stringify({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: data } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (url.includes('create_pow_challenge')) {
        // A real recorded challenge (tests/pow.test.ts pins its answer) — the vendored wasm
        // solves it, so the relay exercises the same PoW path production uses.
        return json({
          algorithm: 'DeepSeekHashV1',
          challenge: 'bb3a237ae3a403cbf2a52b8cfeb77111a68748c910c74f2e3f8b878d4ee1af05',
          salt: '593dd6dda7708462ddd2',
          signature: '3583e8171942b021b690ecd81d0fc7212323c6e7a31f8a1cbb529ab08f5b9179',
          difficulty: 144000,
          expire_at: 1791975536431,
        });
      }
      if (url.includes('chat_session/create')) return json({ chat_session: { id: '11111111-2222-3333-4444-555555555555' } });
      if (url.includes('chat/completion')) {
        expect(String((init?.headers as Record<string, string>)?.['x-ds-pow-response'] || '')).not.toBe('');
        return new Response(raw, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      throw new Error(`unexpected upstream call ${url}`);
    }) as unknown as typeof fetch;

    const result = await runRelayTurn(
      {
        rpc: async (fn, args) => {
          calls.push({ fn, args: (args ?? {}) as Call['args'] });
          if (fn === 'deepseek_claim') {
            return {
              ok: true,
              claimed: true,
              job_id: 'job-1',
              prompt: '什么是幂等性？',
              session_id: '11111111-2222-3333-4444-555555555555',
              parent_message_id: null,
              model_type: 'default',
            };
          }
          return { ok: true };
        },
        credential,
        workerId: 'w',
        origin: 'test',
        transport: 'worker-web',
        fetchImpl,
        emit: (payload) => payloads.push(payload),
      },
      { jobId: 'job-1', prompt: '什么是幂等性？' },
    );

    const answer = payloads.filter((p) => p.text).map((p) => p.text).join('');
    const done = payloads.at(-1);
    const appends = calls.filter((c) => c.fn === 'deepseek_append');
    const complete = calls.find((c) => c.fn === 'deepseek_complete');

    if (!result.ok) throw new Error('relay error: ' + String(result.error));
    expect(result.ok).toBe(true);
    expect(answer.length).toBeGreaterThan(20);
    expect(payloads.every((p) => p._transport === 'worker-web')).toBe(true);
    // the DB copy is addressed by a monotonic seq, which is how the browser dedupes
    expect(appends.map((c) => c.args.p_seq)).toEqual(appends.map((_, i) => i));
    expect(done?.done).toBe(true);
    expect(done?.session_id).toBe('11111111-2222-3333-4444-555555555555');
    expect(done?.reply_message_id).toBe(2);
    expect(done?.title).toBe('幂等性定义');
    // the ids the next turn needs to continue this conversation land on the job row
    expect(complete?.args.p_session_id).toBe('11111111-2222-3333-4444-555555555555');
    expect(complete?.args.p_reply_message_id).toBe(2);
    expect(complete?.args.p_title).toBe('幂等性定义');
    expect(complete?.args.p_ok).toBe(true);
    expect((complete?.args.p_metrics as Record<string, number>).upstream_ttft_ms).toBeGreaterThan(0);
  });

  it('records no time-to-first-token when the upstream never answered', async () => {
    // Captured during DeepSeek's own outage: a hint frame says 服务器暂时不可用 and the stream
    // closes. The turn must report that reason, and must not write upstream_ttft_ms = 0 — that
    // zero is what made the public status strip read 「中位首字 0ms」 (migration 0008).
    const raw = readFileSync(new URL('./fixtures/stream-backend-err.txt', import.meta.url), 'utf8');
    const calls: Call[] = [];

    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      const json = (data: unknown) =>
        new Response(JSON.stringify({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: data } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (url.includes('create_pow_challenge')) {
        return json({
          algorithm: 'DeepSeekHashV1',
          challenge: 'bb3a237ae3a403cbf2a52b8cfeb77111a68748c910c74f2e3f8b878d4ee1af05',
          salt: '593dd6dda7708462ddd2',
          signature: '3583e8171942b021b690ecd81d0fc7212323c6e7a31f8a1cbb529ab08f5b9179',
          difficulty: 144000,
          expire_at: 1791975536431,
        });
      }
      if (url.includes('chat_session/create')) return json({ chat_session: { id: '11111111-2222-3333-4444-555555555555' } });
      if (url.includes('chat/completion')) return new Response(raw, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      throw new Error(`unexpected upstream call ${url}`);
    }) as unknown as typeof fetch;

    const result = await runRelayTurn(
      {
        rpc: async (fn, args) => {
          calls.push({ fn, args: (args ?? {}) as Call['args'] });
          if (fn === 'deepseek_claim') {
            return { ok: true, claimed: true, job_id: 'job-9', prompt: '天气', session_id: null, parent_message_id: null, model_type: 'default' };
          }
          return { ok: true };
        },
        credential,
        workerId: 'w',
        origin: 'test',
        transport: 'worker-web',
        fetchImpl,
      },
      { jobId: 'job-9', prompt: '天气' },
    );

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('服务器暂时不可用');
    const complete = calls.find((c) => c.fn === 'deepseek_complete');
    const metrics = (complete?.args.p_metrics ?? {}) as Record<string, unknown>;
    expect(metrics).not.toHaveProperty('upstream_ttft_ms');
    expect(metrics.upstream_total_ms).toBeGreaterThan(0);
  });
});
