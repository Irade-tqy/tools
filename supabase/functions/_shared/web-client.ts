// DeepSeek web API client (the protocol chat.deepseek.com itself speaks).
//
// Reverse-engineered from the deployed bundle (see README → DeepSeek 上游协议):
//   POST /api/v0/chat/create_pow_challenge   {target_path}            → PoW challenge
//   POST /api/v0/chat_session/create         {}                       → chat_session.id
//   POST /api/v0/chat/completion             {chat_session_id, parent_message_id, …}
//        header x-ds-pow-response: base64({algorithm,challenge,salt,answer,signature,target_path})
//        SSE: event: ready|update_session|title|close + JSON patches
//
// Auth is `Authorization: Bearer <localStorage.userToken>` — the login is NOT in the cookie.
// x-device-id is optional but reusing the browser's value keeps the WAF from flagging us.
//
// Shared by the Edge Function (Deno) and scripts/deepseek-pow-node.mjs (node).

import type { DeepSeekCredential } from './credential.ts';
import { createPowSolver, type PowChallenge, type PowSolver } from './pow.ts';

export const WEB_BASE = 'https://chat.deepseek.com';
export const COMPLETION_PATH = '/api/v0/chat/completion';
export const CLIENT_VERSION = '2.5.0';

export type ModelType = 'default' | 'expert' | 'vision';

export interface WebAskRequest {
  prompt: string;
  /**
   * The conversation to append to. DeepSeek rejects `null` here ("expected a UUID string"),
   * so a new conversation must call createSession() first and pass the id it got back.
   */
  chatSessionId: string;
  /** the previous turn's response_message_id; null on the first turn of a session */
  parentMessageId?: number | string | null;
  modelType?: ModelType;
  thinking?: boolean;
  search?: boolean;
}

export interface WebSession {
  id: string;
  title?: string;
}

export class DeepSeekWebError extends Error {
  // Plain field assignments, not constructor parameter properties: node's type stripping
  // (which the dev scripts use to import this file) rejects parameter properties.
  status: number;
  code?: unknown;
  body?: string;

  constructor(message: string, status: number, code?: unknown, body?: string) {
    super(message);
    this.name = 'DeepSeekWebError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

interface ApiEnvelope {
  code?: number | string;
  msg?: string;
  data?: { biz_code?: number | string; biz_msg?: string; biz_data?: unknown } & Record<string, unknown>;
}

function unwrap(path: string, status: number, json: ApiEnvelope | null, raw: string): unknown {
  const data = json?.data;
  const ok = status >= 200 && status < 300 && (json?.code === undefined || json.code === 0 || json.code === '0');
  const bizOk = !data || data.biz_code === undefined || data.biz_code === 0 || data.biz_code === '0';
  if (!ok || !bizOk) {
    const detail = data?.biz_msg || json?.msg || raw.slice(0, 200);
    throw new DeepSeekWebError(
      `${path}: HTTP ${status} code=${String(json?.code)} biz=${String(data?.biz_code)} msg=${detail}`.trim(),
      status,
      json?.code ?? data?.biz_code,
      raw.slice(0, 400),
    );
  }
  return (data?.biz_data ?? data ?? json) as unknown;
}

export class DeepSeekWebClient {
  credential: DeepSeekCredential;
  fetchImpl: typeof fetch;
  base: string;
  private pow: Promise<PowSolver> | null = null;

  constructor(credential: DeepSeekCredential, fetchImpl: typeof fetch = globalThis.fetch, base = WEB_BASE) {
    this.credential = credential;
    this.fetchImpl = fetchImpl;
    this.base = base;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const c = this.credential;
    const out: Record<string, string> = {
      'content-type': 'application/json',
      accept: '*/*',
      authorization: `Bearer ${c.token}`,
      'x-client-version': CLIENT_VERSION,
      'x-client-platform': 'web',
      'x-client-bundle-id': 'com.deepseek.chat',
      'x-client-locale': 'zh_CN',
      origin: this.base,
      referer: `${this.base}/`,
      'user-agent': c.userAgent,
      ...extra,
    };
    if (c.deviceId) out['x-device-id'] = c.deviceId;
    if (c.cookie) out.cookie = c.cookie;
    return out;
  }

  private async api(path: string, body: unknown, extra: Record<string, string> = {}): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.base + path, {
        method: 'POST',
        headers: this.headers(extra),
        body: JSON.stringify(body ?? {}),
      });
    } catch (err) {
      throw new DeepSeekWebError(`${path}: network error: ${(err as Error).message}`, 0);
    }
    const text = await res.text().catch(() => '');
    let json: ApiEnvelope | null = null;
    try {
      json = text ? (JSON.parse(text) as ApiEnvelope) : null;
    } catch {
      /* an HTML body means the WAF answered instead of the API */
    }
    if (!json && text.startsWith('<')) {
      throw new DeepSeekWebError(`${path}: blocked by WAF (HTML response)`, res.status, undefined, text.slice(0, 400));
    }
    return unwrap(path, res.status, json, text);
  }

  /** The wasm is stateless; instantiate once per client and reuse it across turns. */
  private solver(): Promise<PowSolver> {
    if (!this.pow) this.pow = createPowSolver();
    return this.pow;
  }

  async powChallenge(targetPath = COMPLETION_PATH): Promise<PowChallenge> {
    const data = (await this.api('/api/v0/chat/create_pow_challenge', { target_path: targetPath })) as Record<string, unknown>;
    const challenge = (data?.challenge && typeof data.challenge === 'object' ? data.challenge : data) as PowChallenge;
    if (!challenge?.challenge || !challenge?.signature) {
      throw new DeepSeekWebError('create_pow_challenge: unexpected payload', 200, undefined, JSON.stringify(data).slice(0, 300));
    }
    return challenge;
  }

  async createSession(): Promise<WebSession> {
    const data = (await this.api('/api/v0/chat_session/create', {})) as Record<string, unknown>;
    const session = (data?.chat_session ?? data) as Record<string, unknown>;
    const id = typeof session?.id === 'string' ? session.id : '';
    if (!id) throw new DeepSeekWebError('chat_session/create: no id in response', 200, undefined, JSON.stringify(data).slice(0, 300));
    return { id, title: typeof session.title === 'string' ? session.title : undefined };
  }

  /** Solve the PoW for a completion request. */
  async powHeader(targetPath = COMPLETION_PATH): Promise<{ header: string; challenge: PowChallenge; answer: number }> {
    const challenge = await this.powChallenge(targetPath);
    const solver = await this.solver();
    const answer = solver.solve(challenge);
    return { header: solver.header(challenge, answer, targetPath), challenge, answer };
  }

  /**
   * Start a completion. Returns the raw Response: its body is the SSE stream, which the
   * caller feeds through web-stream.ts.
   */
  async completion(request: WebAskRequest): Promise<Response> {
    const { header } = await this.powHeader();
    if (!request.chatSessionId) {
      throw new DeepSeekWebError('completion: chatSessionId is required (call createSession() first)', 400);
    }
    // parent_message_id is a message number upstream; clients pass it as a string because
    // PostgREST serialises int8 as text. Coerce, and reject anything non-numeric loudly.
    let parentMessageId: number | null = null;
    if (request.parentMessageId !== null && request.parentMessageId !== undefined && request.parentMessageId !== '') {
      const parsed = Number(request.parentMessageId);
      if (!Number.isFinite(parsed)) {
        throw new DeepSeekWebError(`completion: parent_message_id must be numeric, got ${String(request.parentMessageId)}`, 400);
      }
      parentMessageId = parsed;
    }
    const body = {
      chat_session_id: request.chatSessionId,
      parent_message_id: parentMessageId,
      model_type: request.modelType ?? 'default',
      prompt: request.prompt,
      ref_file_ids: [],
      thinking_enabled: Boolean(request.thinking),
      search_enabled: Boolean(request.search),
      action: null,
      preempt: false,
    };

    let res: Response;
    try {
      res = await this.fetchImpl(this.base + COMPLETION_PATH, {
        method: 'POST',
        headers: this.headers({ 'x-ds-pow-response': header }),
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new DeepSeekWebError(`completion: network error: ${(err as Error).message}`, 0);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new DeepSeekWebError(`completion: HTTP ${res.status} ${text.slice(0, 300)}`, res.status, undefined, text);
    }
    return res;
  }

  /** Cheap authenticated call used to check a freshly pasted credential. */
  async verify(): Promise<{ ok: true } | never> {
    await this.powChallenge();
    return { ok: true };
  }
}
