import { describe, expect, it } from 'vitest';
import { SSE_DONE, createSseParser, readSse } from '../src/lib/sse';

function collect(...pieces: string[]) {
  const parse = createSseParser();
  const events = pieces.flatMap((piece) => parse(piece));
  return events;
}

describe('createSseParser', () => {
  it('parses a single complete event', () => {
    expect(collect('data: {"a":1}\n\n')).toEqual([{ data: '{"a":1}', event: undefined, id: undefined }]);
  });

  it('reassembles events split across chunk boundaries', () => {
    const events = collect('data: {"a"', ':1}\n', '\ndata: {"b"', ':2}\n\n');
    expect(events.map((e) => e.data)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('splits multiple events inside one chunk', () => {
    expect(collect('data: one\n\ndata: two\n\n').map((e) => e.data)).toEqual(['one', 'two']);
  });

  it('accepts CRLF and bare CR terminators', () => {
    expect(collect('data: crlf\r\n\r\ndata: cr\r\r').map((e) => e.data)).toEqual(['crlf', 'cr']);
  });

  it('ignores comments and keep-alives', () => {
    expect(collect(': keep-alive\n\n')).toEqual([]);
    expect(collect(': hi\ndata: ok\n\n').map((e) => e.data)).toEqual(['ok']);
  });

  it('joins multi-line data with newlines', () => {
    expect(collect('data: line1\ndata: line2\n\n')[0]?.data).toBe('line1\nline2');
  });

  it('keeps the event name and id', () => {
    const [event] = collect('event: message\nid: 7\ndata: hi\n\n');
    expect(event).toMatchObject({ data: 'hi', event: 'message', id: '7' });
  });

  it('tolerates a missing space after the colon', () => {
    expect(collect('data:{"tight":true}\n\n')[0]?.data).toBe('{"tight":true}');
  });

  it('does not emit an event until the line is complete', () => {
    expect(collect('data: partial')).toEqual([]);
  });

  it('recognises the DONE sentinel', () => {
    expect(collect('data: [DONE]\n\n')[0]?.data).toBe(SSE_DONE);
  });
});

describe('readSse', () => {
  function responseOf(chunks: string[]): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  }

  it('streams events in order', async () => {
    const seen: string[] = [];
    await readSse(responseOf(['data: {"n":1}\n\n', 'data: {"n":2}\n\ndata: [DONE]\n\n']), {
      onEvent: (event) => {
        seen.push(event.data);
      },
    });
    expect(seen).toEqual(['{"n":1}', '{"n":2}', '[DONE]']);
  });

  it('flushes a trailing event that lacks a blank line', async () => {
    const seen: string[] = [];
    await readSse(responseOf(['data: last']), {
      onEvent: (event) => {
        seen.push(event.data);
      },
    });
    expect(seen).toEqual(['last']);
  });

  it('stops early when the signal aborts', async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    await readSse(responseOf(['data: a\n\n', 'data: b\n\n']), {
      signal: controller.signal,
      onEvent: (event) => {
        seen.push(event.data);
        controller.abort();
      },
    });
    expect(seen).toEqual(['a']);
  });
});
