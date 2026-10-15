// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import type { ToolsApi } from '../src/lib/api';
import { readSse } from '../src/lib/sse';
import { initChat } from '../src/views/chat';

vi.mock('../src/lib/sse', () => ({
  SSE_DONE: '[DONE]',
  readSse: vi.fn(async (_response: Response, options: { onEvent: (event: { data: string }) => void }) => {
    options.onEvent({ data: JSON.stringify({ v: 1, _transport: 'edge-web', error: 'not_claimed: not_available' }) });
    options.onEvent({ data: '[DONE]' });
  }),
}));

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('keeps the worker response running after the competing Edge stream closes', async () => {
  vi.useFakeTimers();
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  const html = new DOMParser().parseFromString(readFileSync('index.html', 'utf8'), 'text/html');
  document.body.replaceChildren(...Array.from(html.body.children));
  let handlers: Parameters<ToolsApi['subscribeJob']>[1] | undefined;
  const api = {
    token: 'test-token',
    config: { url: 'https://example.invalid', queue: 'test' },
    ask: vi.fn(async () => ({ ok: true, job_id: 'job' })),
    subscribeJob: vi.fn((_id, callbacks) => { handlers = callbacks; return vi.fn(); }),
    callEdgeFunction: vi.fn(async () => ({ ok: true })),
    jobStatus: vi.fn(async () => ({ ok: true, status: 'done', finished: true, chunks: [] })),
  } as unknown as ToolsApi;
  const chat = initChat(api);
  await chat.send('Hello');
  await vi.waitFor(() => expect(readSse).toHaveBeenCalledOnce());
  expect(api.jobStatus).not.toHaveBeenCalled();
  expect(document.getElementById('chat-stop')!.hidden).toBe(false);
  if (!handlers) throw new Error('Expected a worker subscription');
  handlers.onChunk({ seq: 0, payload: { text: 'Hello ' }, created_at: '' });
  handlers.onChunk({ seq: 1, payload: { text: 'world' }, created_at: '' });
  expect(document.querySelector('.msg__body')?.textContent).toBe('Hello world');
  expect(document.querySelector('.msg__error')).toBeNull();
  handlers.onChunk({ seq: 2, payload: { done: true, ok: true, session_id: 'session', reply_message_id: 42 }, created_at: '' });
  handlers.onJob?.({ status: 'done' });
  await vi.waitFor(() => expect(chat.currentSession().turns.at(-1)?.role).toBe('assistant'));
  expect(chat.currentSession().turns.at(-1)?.content).toBe('Hello world');
  expect(chat.currentSession().parentId).toBe('42');
  expect(document.getElementById('chat-stop')!.hidden).toBe(true);
});
