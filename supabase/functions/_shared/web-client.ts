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
export const UPLOAD_PATH = '/api/v0/file/upload_file';
export const FILES_PATH = '/api/v0/file/fetch_files';
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
  /** ids from uploadFile(); upstream expects them in ref_file_ids */
  fileIds?: string[];
}

export interface WebSession {
  id: string;
  title?: string;
}

/**
 * One uploaded attachment. Upstream parses the file out of band — `status` walks through
 * FileParseStatus values — so a caller should poll filesStatus() before referencing the id, the
 * same way the web app gates its send button on parsing finishing.
 */
export interface WebFile {
  id: string;
  name: string;
  size: number;
  status: string;
  isImage: boolean;
  signedPath?: string;
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
      ref_file_ids: Array.isArray(request.fileIds) ? request.fileIds.filter((id) => typeof id === 'string' && id) : [],
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
    // A refusal comes back as HTTP 200 with a JSON envelope instead of an event stream — e.g.
    // biz_code 11 "message still wip" when the previous turn was stopped a second ago and
    // upstream has not finalized it yet. Reading that as a stream produced zero frames and the
    // user saw "upstream closed without an answer" for a perfectly ordinary retryable state.
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      const text = await res.text().catch(() => '');
      let json: ApiEnvelope | null = null;
      try {
        json = text ? (JSON.parse(text) as ApiEnvelope) : null;
      } catch {
        /* fall through to the generic error below */
      }
      unwrap(COMPLETION_PATH, res.status, json, text);
      throw new DeepSeekWebError(`completion: expected an event stream, got ${contentType || 'no content-type'}`, res.status, undefined, text.slice(0, 300));
    }
    return res;
  }

  /**
   * Tell upstream the user stopped. The web app does exactly this (POST /api/v0/chat/stop_stream
   * {chat_session_id, message_id}) after aborting its own connection, and it matters: without
   * it upstream keeps generating and stores the *whole* answer, so the next turn is continued
   * from a message the user never saw. With it the stored message is marked INCOMPLETE and holds
   * precisely the text that was streamed — verified against /api/v0/chat/history_messages.
   */
  async stopStream(chatSessionId: string, messageId: number | string | null): Promise<void> {
    if (!chatSessionId || messageId === null || messageId === undefined || messageId === '') return;
    const id = typeof messageId === 'number' ? messageId : Number(messageId);
    if (!Number.isFinite(id)) return;
    await this.api('/api/v0/chat/stop_stream', { chat_session_id: chatSessionId, message_id: id });
  }

  /** Parse an API response the same way api() does, for the non-JSON-body calls. */
  private async envelope(path: string, res: Response): Promise<unknown> {
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

  /**
   * Upload one attachment the way the web app does: multipart POST with the field named `file`,
   * carrying a PoW answer bound to the upload path itself — create_pow_challenge issues a
   * challenge per target_path, and the upload scene asks for UPLOAD_PATH, not the completion one.
   */
  async uploadFile(input: { name: string; type?: string; bytes: Uint8Array | ArrayBuffer }): Promise<WebFile> {
    const bytes = input.bytes instanceof ArrayBuffer ? new Uint8Array(input.bytes) : input.bytes;
    const { header } = await this.powHeader(UPLOAD_PATH);
    const form = new FormData();
    form.append('file', new Blob([bytes as BlobPart], { type: input.type || 'application/octet-stream' }), input.name);
    // headers() pins content-type: application/json for the JSON API. Sending that on a FormData
    // body suppresses the generated `multipart/form-data; boundary=…` and upstream answers
    // HTTP 400 "Invalid `boundary`", so the header has to go and let fetch set it.
    const headers = this.headers({ 'x-ds-pow-response': header });
    delete headers['content-type'];
    let res: Response;
    try {
      res = await this.fetchImpl(this.base + UPLOAD_PATH, {
        method: 'POST',
        headers,
        body: form,
      });
    } catch (err) {
      throw new DeepSeekWebError(`upload_file: network error: ${(err as Error).message}`, 0);
    }
    const data = (await this.envelope(UPLOAD_PATH, res)) as Record<string, unknown>;
    const info = (data?.file && typeof data.file === 'object' ? data.file : data) as Record<string, unknown>;
    const id = typeof info?.id === 'string' ? info.id : '';
    if (!id) throw new DeepSeekWebError('upload_file: no file id in response', res.status, undefined, JSON.stringify(data).slice(0, 300));
    return {
      id,
      name: input.name,
      size: typeof info.file_size === 'number' ? info.file_size : bytes.byteLength,
      status: typeof info.status === 'string' ? info.status : '',
      isImage: info.is_image === true,
      signedPath: typeof info.signed_path === 'string' ? info.signed_path : undefined,
    };
  }

  /** Poll the out-of-band parse status of uploaded files. */
  async filesStatus(ids: string[]): Promise<WebFile[]> {
    const wanted = ids.filter((id) => typeof id === 'string' && id);
    if (!wanted.length) return [];
    const query = wanted.map((id) => `file_ids=${encodeURIComponent(id)}`).join('&');
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${FILES_PATH}?${query}`, { method: 'GET', headers: this.headers() });
    } catch (err) {
      throw new DeepSeekWebError(`fetch_files: network error: ${(err as Error).message}`, 0);
    }
    const data = (await this.envelope(FILES_PATH, res)) as Record<string, unknown>;
    const files = Array.isArray(data?.files) ? (data.files as Record<string, unknown>[]) : [];
    return files.map((f) => ({
      id: String(f.id ?? ''),
      name: String(f.file_name ?? f.name ?? ''),
      size: typeof f.file_size === 'number' ? f.file_size : 0,
      status: typeof f.status === 'string' ? f.status : '',
      isImage: f.is_image === true,
      signedPath: typeof f.signed_path === 'string' ? f.signed_path : undefined,
    }));
  }

  /** Cheap authenticated call used to check a freshly pasted credential. */
  async verify(): Promise<{ ok: true } | never> {
    await this.powChallenge();
    return { ok: true };
  }
}
