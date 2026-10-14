// Pure helpers for the deepseek-chat Edge Function. No Deno globals in here on purpose:
// vitest imports and tests this file directly (tests/functions-shared.test.ts), and the
// function entry point stays a thin wrapper.

export type UpstreamMode = 'api' | 'cookie' | 'none';

export interface UpstreamConfig {
  mode: UpstreamMode;
  url: string;
  headers: Record<string, string>;
  /** why mode === 'none' — surfaced to the UI so the fallback is obvious */
  reason?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export const DEFAULT_API_URL = 'https://api.deepseek.com/v1/chat/completions';
export const DEFAULT_MODEL = 'deepseek-chat';

type Env = Record<string, string | undefined>;

function firstEnv(env: Env, ...keys: string[]): string {
  for (const key of keys) {
    const value = env[key];
    if (value && value.trim()) return value.trim();
  }
  return '';
}

/**
 * Two upstream routes:
 *   api    — DEEPSEEK_API_KEY (Bearer). Stable, official, the route to prefer once available.
 *   cookie — DEEPSEEK_WEB_COOKIE from a logged-in web session. Needs DEEPSEEK_API_URL when
 *            DeepSeek's web endpoint differs from the public one, and may hit WAF/PoW.
 * Neither set → mode 'none', and the caller falls back to a logged-in browser tab.
 */
export function resolveUpstream(env: Env): UpstreamConfig {
  const key = firstEnv(env, 'DEEPSEEK_API_KEY');
  const cookie = firstEnv(env, 'DEEPSEEK_WEB_COOKIE');
  const url = firstEnv(env, 'DEEPSEEK_API_URL', 'DEEPSEEK_WEB_URL') || DEFAULT_API_URL;

  let extra: Record<string, string> = {};
  const rawExtra = firstEnv(env, 'DEEPSEEK_EXTRA_HEADERS');
  if (rawExtra) {
    try {
      extra = JSON.parse(rawExtra) as Record<string, string>;
    } catch {
      extra = {};
    }
  }

  const base: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    ...extra,
  };

  if (key) {
    return { mode: 'api', url, headers: { ...base, Authorization: `Bearer ${key}` } };
  }
  if (cookie) {
    return {
      mode: 'cookie',
      url,
      headers: {
        ...base,
        Cookie: cookie,
        Origin: 'https://chat.deepseek.com',
        Referer: 'https://chat.deepseek.com/',
        'User-Agent':
          firstEnv(env, 'DEEPSEEK_USER_AGENT') ||
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      },
    };
  }
  return {
    mode: 'none',
    url,
    headers: base,
    reason: 'no_credentials: set DEEPSEEK_API_KEY or DEEPSEEK_WEB_COOKIE as a Supabase secret',
  };
}

export function buildRequestBody(messages: ChatMessage[], model: string, stream = true): string {
  return JSON.stringify({
    model: model || DEFAULT_MODEL,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream,
  });
}

export interface SseEvent {
  data: string;
}

/** Incremental SSE line splitter (chunk boundaries land anywhere). */
export function createSseParser(): (text: string) => SseEvent[] {
  let buffer = '';
  return (text: string) => {
    buffer += text;
    const events: SseEvent[] = [];
    let match: RegExpExecArray | null;
    const newline = /\r\n|\r|\n/g;
    let searchFrom = 0;
    while (true) {
      newline.lastIndex = searchFrom;
      match = newline.exec(buffer);
      if (!match) break;
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      searchFrom = 0;
      if (line.startsWith('data:')) {
        const payload = line.slice(5).replace(/^ /, '');
        if (payload) events.push({ data: payload });
      }
    }
    return events;
  };
}

export interface Delta {
  content: string;
  reasoning: string;
  finishReason: string | null;
  error: string | null;
}

export function extractDelta(payload: unknown): Delta {
  const obj = (payload ?? {}) as Record<string, unknown>;
  let content = '';
  let reasoning = '';
  let finishReason: string | null = null;
  let error: string | null = null;

  if (typeof obj.error === 'string') error = obj.error;
  else if (obj.error && typeof obj.error === 'object') {
    const e = obj.error as { message?: string };
    error = e.message ?? 'upstream error';
  }

  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  for (const raw of choices) {
    const choice = (raw ?? {}) as Record<string, unknown>;
    const delta = (choice.delta ?? choice.message ?? {}) as Record<string, unknown>;
    if (typeof delta.content === 'string') content += delta.content;
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
    else if (typeof delta.reasoning === 'string') reasoning += delta.reasoning;
    if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
  }
  return { content, reasoning, finishReason, error };
}

/** Payload shape stored in deepseek_chunk and echoed over the function's own SSE stream. */
export function chunkEnvelope(seq: number, payload: unknown, transport: string): Record<string, unknown> {
  return { ...(payload as object), seq, _transport: transport };
}

export interface Timings {
  startedAt: number;
  ttfbMs: number | null;
  ttftMs: number | null;
}

export function startTimings(now = Date.now()): Timings {
  return { startedAt: now, ttfbMs: null, ttftMs: null };
}

export function markTtfb(timings: Timings, now = Date.now()): void {
  if (timings.ttfbMs === null) timings.ttfbMs = now - timings.startedAt;
}

export function markTtft(timings: Timings, delta: Delta, now = Date.now()): void {
  if (timings.ttftMs === null && (delta.content || delta.reasoning)) {
    timings.ttftMs = now - timings.startedAt;
  }
}

export function metricsOf(timings: Timings, transport: string, now = Date.now(), extra: Record<string, unknown> = {}) {
  return {
    transport,
    upstream_ttfb_ms: timings.ttfbMs,
    upstream_ttft_ms: timings.ttftMs,
    upstream_total_ms: now - timings.startedAt,
    ...extra,
  };
}
