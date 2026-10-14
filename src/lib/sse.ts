// Minimal Server-Sent-Events reader. DeepSeek's web/API endpoints stream `data: {json}`
// lines; chunk boundaries land anywhere, so buffering and partial-line handling matter.

export interface SseEvent {
  data: string;
  event?: string;
  id?: string;
}

export const SSE_DONE = '[DONE]';

export function createSseParser(): (text: string) => SseEvent[] {
  let buffer = '';
  let dataLines: string[] = [];
  let eventName: string | undefined;
  let lastId: string | undefined;

  const dispatch = (out: SseEvent[]) => {
    if (!dataLines.length) {
      eventName = undefined;
      return;
    }
    out.push({ data: dataLines.join('\n'), event: eventName, id: lastId });
    dataLines = [];
    eventName = undefined;
  };

  return (text: string) => {
    const out: SseEvent[] = [];
    buffer += text;
    let idx: number;
    // Normalise CRLF/CR to LF, then consume complete lines only.
    while (true) {
      const match = /\r\n|\r|\n/.exec(buffer);
      if (!match) break;
      idx = match.index;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + match[0].length);

      if (line === '') {
        dispatch(out);
        continue;
      }
      if (line.startsWith(':')) continue; // comment / keep-alive

      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);

      if (field === 'data') dataLines.push(value);
      else if (field === 'event') eventName = value;
      else if (field === 'id') lastId = value;
      // `retry:` and unknown fields are ignored on purpose.
    }
    return out;
  };
}

export interface SseStreamOptions {
  signal?: AbortSignal;
  onEvent: (event: SseEvent) => void | Promise<void>;
}

/** Read an SSE response body, invoking onEvent for every complete event. */
export async function readSse(response: Response, { signal, onEvent }: SseStreamOptions): Promise<void> {
  if (!response.body) throw new Error('响应没有可读的流');
  const parse = createSseParser();
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const event of parse(value)) {
        if (signal?.aborted) return;
        await onEvent(event);
      }
    }
    // Flush a trailing event that was not terminated by a blank line.
    for (const event of parse('\n\n')) await onEvent(event);
  } finally {
    reader.releaseLock();
  }
}
