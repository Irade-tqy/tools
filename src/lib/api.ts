// PostgREST client for the RPCs defined in supabase/migrations. Deliberately thin and
// dependency-free for data calls (fetch only); supabase-js is used solely for Realtime.

import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import type { Config } from './config';

export type Envelope = Record<string, unknown> & { ok: boolean; error?: string | null };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface VerifyResult extends Envelope {
  token?: string;
  label?: string;
  expires_at?: string;
  retry_after_seconds?: number;
}

export interface EntryMeta {
  id: string;
  kind: 'text' | 'file';
  title: string;
  body?: string | null;
  file_name?: string | null;
  file_type?: string | null;
  file_size?: number | null;
  has_data?: boolean;
  iv?: string | null;
  kdf_salt?: string | null;
  data?: string | null;
  created_at: string;
  expires_at: string;
}

export interface JobStatus extends Envelope {
  job_id?: string;
  status?: 'queued' | 'claimed' | 'streaming' | 'done' | 'error' | 'cancelled';
  transport?: string | null;
  metrics?: Record<string, string | number>;
  error?: string | null;
  finished?: boolean;
  chunks?: { seq: number; payload: Record<string, unknown>; created_at: string }[];
}

export interface Health extends Envelope {
  pending?: number;
  queued?: number;
  workers_alive?: number;
  done_last_hour?: number;
  error_last_hour?: number;
}

export interface PutFileInput {
  fileName: string;
  fileType: string;
  data: string;
  iv: string;
  salt: string;
  title?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class ToolsApi {
  private realtimeClient: SupabaseClient | null = null;

  constructor(
    private cfg: Config,
    private clipboardToken: string | null = null,
  ) {}

  get config(): Config {
    return this.cfg;
  }

  setConfig(cfg: Config): void {
    if (cfg.url !== this.cfg.url || cfg.anonKey !== this.cfg.anonKey) {
      this.realtimeClient = null;
    }
    this.cfg = cfg;
  }

  setToken(token: string | null): void {
    this.clipboardToken = token;
  }

  get token(): string | null {
    return this.clipboardToken;
  }

  async rpc<T extends Envelope = Envelope>(
    fn: string,
    args: Record<string, unknown> = {},
    opts: { token?: string | null } = {},
  ): Promise<T> {
    const token = 'token' in opts ? opts.token : this.clipboardToken;
    const headers: Record<string, string> = {
      apikey: this.cfg.anonKey,
      Authorization: `Bearer ${this.cfg.anonKey}`,
      'Content-Type': 'application/json',
    };
    if (token) headers['x-clipboard-token'] = token;

    let res: Response;
    try {
      res = await fetch(`${this.cfg.url}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(args),
      });
    } catch (err) {
      throw new ApiError(`网络不可达：${(err as Error).message}`, 0, 'network');
    }

    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { ok: false, error: 'bad_json', raw: text.slice(0, 400) };
      }
    }
    if (!res.ok) {
      const b = (body ?? {}) as { message?: string; code?: string };
      throw new ApiError(b.message || `HTTP ${res.status}`, res.status, b.code);
    }
    return (body ?? { ok: false, error: 'empty_response' }) as T;
  }

  // --- clipboard -----------------------------------------------------------
  verify(password: string, ttlSeconds = 3600) {
    return this.rpc<VerifyResult>('clipboard_verify', { p_password: password, p_ttl_seconds: ttlSeconds }, { token: null });
  }
  status() {
    return this.rpc<Envelope & Record<string, number>>('clipboard_status');
  }
  list(limit = 50) {
    return this.rpc<Envelope & { entries?: EntryMeta[] }>('clipboard_list', { p_limit: limit });
  }
  get(id: string) {
    return this.rpc<Envelope & { entry?: EntryMeta }>('clipboard_get', { p_id: id });
  }
  putText(body: string, title = '') {
    return this.rpc<Envelope & { entry?: EntryMeta }>('clipboard_put', { p_kind: 'text', p_body: body, p_title: title });
  }
  putFile(input: PutFileInput) {
    return this.rpc<Envelope & { entry?: EntryMeta }>('clipboard_put', {
      p_kind: 'file',
      p_title: input.title ?? input.fileName,
      p_file_name: input.fileName,
      p_file_type: input.fileType,
      p_data: input.data,
      p_iv: input.iv,
      p_salt: input.salt,
    });
  }
  remove(id: string) {
    return this.rpc<Envelope>('clipboard_delete', { p_id: id });
  }
  clear() {
    return this.rpc<Envelope & { deleted?: number }>('clipboard_clear');
  }

  // --- deepseek ------------------------------------------------------------
  enqueue(messages: ChatMessage[], model?: string) {
    return this.rpc<Envelope & { job_id?: string }>('deepseek_enqueue', {
      p_messages: messages,
      p_model: model ?? this.cfg.model,
    });
  }
  jobStatus(jobId: string, sinceSeq = -1) {
    return this.rpc<JobStatus>('deepseek_status', { p_job_id: jobId, p_since_seq: sinceSeq });
  }
  cancelJob(jobId: string) {
    return this.rpc<Envelope>('deepseek_cancel', { p_job_id: jobId });
  }
  health() {
    return this.rpc<Health>('deepseek_health');
  }

  // Transport side (used by public/deepseek-worker.js and the edge function).
  claim(workerId: string) {
    return this.rpc<Envelope & { claimed?: boolean; job_id?: string; messages?: ChatMessage[]; model?: string }>(
      'deepseek_claim',
      { p_worker_id: workerId },
    );
  }
  appendChunk(jobId: string, seq: number, payload: unknown) {
    return this.rpc<Envelope>('deepseek_append', { p_job_id: jobId, p_seq: seq, p_payload: payload });
  }
  completeJob(jobId: string, ok: boolean, error?: string, metrics?: Record<string, unknown>) {
    return this.rpc<Envelope>('deepseek_complete', {
      p_job_id: jobId,
      p_ok: ok,
      p_error: error ?? null,
      p_metrics: metrics ?? {},
    });
  }

  // --- edge function -------------------------------------------------------
  // Returns the raw Response so the caller can stream the SSE body.
  callEdgeFunction(name: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    return fetch(`${this.cfg.url}/functions/v1/${name}`, {
      method: 'POST',
      headers: {
        apikey: this.cfg.anonKey,
        Authorization: `Bearer ${this.cfg.anonKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
  }

  // --- realtime ------------------------------------------------------------
  private realtime(): SupabaseClient {
    if (!this.realtimeClient) {
      this.realtimeClient = createClient(this.cfg.url, this.cfg.anonKey, {
        global: { headers: { apikey: this.cfg.anonKey } },
        realtime: { params: { eventsPerSecond: 20 } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
    }
    return this.realtimeClient;
  }

  // Subscribe to a job's chunk inserts + status updates. Returns a disposer.
  subscribeJob(
    jobId: string,
    handlers: {
      onChunk: (row: { seq: number; payload: Record<string, unknown>; created_at: string }) => void;
      onJob?: (row: { status: string; metrics?: Record<string, unknown>; error?: string | null }) => void;
      onError?: (err: unknown) => void;
    },
  ): () => void {
    const client = this.realtime();
    let channel: RealtimeChannel | null = null;
    try {
      channel = client
        .channel(`job-${jobId}`)
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'deepseek_chunk',
          filter: `job_id=eq.${jobId}`,
        }, (payload) => handlers.onChunk(payload.new as never))
        .on('postgres_changes', {
          event: 'UPDATE',
          schema: 'public',
          table: 'deepseek_job',
          filter: `id=eq.${jobId}`,
        }, (payload) => handlers.onJob?.(payload.new as never))
        .subscribe((status, err) => {
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') handlers.onError?.(err ?? status);
        });
    } catch (err) {
      handlers.onError?.(err);
    }
    return () => {
      if (channel) void client.removeChannel(channel);
    };
  }
}
