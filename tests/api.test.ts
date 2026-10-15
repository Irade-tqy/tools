import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  channels: [] as Array<{ name: string; handlers: Array<Record<string, unknown>>; subscribed: unknown[] }>,
  removed: [] as unknown[],
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: (url: string, key: string) => {
    void url;
    void key;
    return {
      channel(name: string) {
        const record = { name, handlers: [] as Array<Record<string, unknown>>, subscribed: [] as unknown[] };
        mocks.channels.push(record);
        const channel = {
          on(type: string, config: Record<string, unknown>, cb: unknown) {
            record.handlers.push({ type, config, cb });
            return channel;
          },
          subscribe(cb: unknown) {
            record.subscribed.push(cb);
            return channel;
          },
        };
        return channel;
      },
      removeChannel(handle: unknown) {
        mocks.removed.push(handle);
      },
    };
  },
}));

const { ApiError: ApiErrorCtor, ToolsApi } = await import('../src/lib/api');
type ApiError = InstanceType<typeof ApiErrorCtor>;

const URL = 'https://demo.supabase.co';
const KEY = 'anon-key-0123456789';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let requests: Recorded[] = [];

function stubFetch(response: unknown, init: { status?: number; ok?: boolean } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init2?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init2?.method ?? 'GET',
        headers: (init2?.headers ?? {}) as Record<string, string>,
        body: init2?.body ? JSON.parse(String(init2.body)) : undefined,
      });
      return {
        ok: init.ok ?? true,
        status: init.status ?? 200,
        text: async () => (typeof response === 'string' ? response : JSON.stringify(response)),
      };
    }),
  );
}

beforeEach(() => {
  requests = [];
  mocks.channels.length = 0;
  mocks.removed.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('rpc plumbing', () => {
  it('posts to the rpc endpoint with the anon key on both headers', async () => {
    stubFetch({ ok: true });
    const api = new ToolsApi({ url: URL, anonKey: KEY, functionName: 'deepseek-chat', modelType: 'default' , queue: 'default' });
    await api.list();
    const req = requests[0]!;
    expect(req.url).toBe(`${URL}/rest/v1/rpc/clipboard_list`);
    expect(req.method).toBe('POST');
    expect(req.headers.apikey).toBe(KEY);
    expect(req.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(req.headers['Content-Type']).toBe('application/json');
  });

  it('sends the clipboard token header once unlocked', async () => {
    stubFetch({ ok: true, entries: [] });
    const api = new ToolsApi({ url: URL, anonKey: KEY, functionName: 'fn', modelType: 'default' , queue: 'default' });
    api.setToken('tok-123');
    await api.list(20);
    expect(requests[0]!.headers['x-clipboard-token']).toBe('tok-123');
    expect(requests[0]!.body).toEqual({ p_limit: 20 });
  });

  it('never leaks the clipboard token into verify', async () => {
    stubFetch({ ok: true, token: 't' });
    const api = new ToolsApi({ url: URL, anonKey: KEY, functionName: 'fn', modelType: 'default' , queue: 'default' }, 'stale-token');
    await api.verify('pw', 60);
    expect(requests[0]!.headers['x-clipboard-token']).toBeUndefined();
    expect(requests[0]!.body).toEqual({ p_password: 'pw', p_ttl_seconds: 60 });
  });

  it('uploads files with kind, ciphertext, iv and salt', async () => {
    stubFetch({ ok: true });
    const api = new ToolsApi({ url: URL, anonKey: KEY, functionName: 'fn', modelType: 'default' , queue: 'default' }, 'tok');
    await api.putFile({ fileName: 'a.txt', fileType: 'text/plain', data: 'ZGF0YQ==', iv: 'aXY=', salt: 'c2FsdA==' });
    expect(requests[0]!.body).toEqual({
      p_kind: 'file',
      p_title: 'a.txt',
      p_file_name: 'a.txt',
      p_file_type: 'text/plain',
      p_data: 'ZGF0YQ==',
      p_iv: 'aXY=',
      p_salt: 'c2FsdA==',
    });
  });

  it('sends the session ids that place a turn in a conversation', async () => {
    stubFetch({ ok: true });
    const api = new ToolsApi({ url: URL, anonKey: KEY, functionName: 'deepseek-chat', modelType: 'default' , queue: 'default' });
    await api.ask({ prompt: 'hi', sessionId: 'sess-1', parentId: '42', thinking: true });
    await api.ask({ prompt: 'new' });
    await api.jobStatus('job-1', 3);
    expect(requests.map((r) => r.url.split('/rpc/')[1])).toEqual(['deepseek_ask', 'deepseek_ask', 'deepseek_status']);
    expect(requests[0]!.body).toEqual({
      p_prompt: 'hi',
      p_session_id: 'sess-1',
      p_parent_message_id: 42,
      p_model_type: 'default',
      p_thinking: true,
      p_search: false,
      p_queue: 'default',
      p_file_ids: null,
    });
    // A new conversation sends no ids at all.
    expect(requests[1]!.body).toMatchObject({ p_prompt: 'new', p_session_id: null, p_parent_message_id: null });
    expect(requests[2]!.body).toEqual({ p_job_id: 'job-1', p_since_seq: 3 });
  });

  it('queues uploaded file ids with the turn', async () => {
    stubFetch({ ok: true });
    const api = new ToolsApi({ url: URL, anonKey: KEY, functionName: 'deepseek-chat', modelType: 'default', queue: 'default' });
    await api.ask({ prompt: '读这份文件', fileIds: ['file-446dbaf9-1b17-482f-b733-007992af73b5'] });
    expect(requests[0]!.body).toMatchObject({ p_file_ids: ['file-446dbaf9-1b17-482f-b733-007992af73b5'] });
  });

  it('uploads an attachment as multipart without pinning a content-type', async () => {
    // DeepSeek answers HTTP 400 "Invalid `boundary`" if a content-type header is sent on the
    // FormData body, because it suppresses the multipart boundary fetch would otherwise generate.
    // The shared RPC headers pin application/json, so this guards the one call that must not.
    const seen: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body });
        return { ok: true, status: 200, json: async () => ({ ok: true, file: { id: 'file-446dbaf9-1b17-482f-b733-007992af73b5', name: 'a.txt', size: 3, status: 'PENDING' } }) };
      }),
    );
    const api = new ToolsApi({ url: URL, anonKey: KEY, functionName: 'deepseek-chat', modelType: 'default', queue: 'default' });
    const out = await api.uploadFile(new File(['abc'], 'a.txt', { type: 'text/plain' }));
    expect(out.ok).toBe(true);
    expect(out.file?.id).toBe('file-446dbaf9-1b17-482f-b733-007992af73b5');
    expect(seen[0]!.url).toContain('/functions/v1/deepseek-chat');
    expect(seen[0]!.body).toBeInstanceOf(FormData);
    expect(Object.keys(seen[0]!.headers).map((k) => k.toLowerCase())).not.toContain('content-type');
    expect(seen[0]!.headers.apikey).toBe(KEY);
    vi.unstubAllGlobals();
  });

  it('turns an HTTP error into an ApiError carrying the Postgres message', async () => {
    stubFetch({ code: '42883', message: 'operator does not exist' }, { ok: false, status: 400 });
    const api = new ToolsApi({ url: URL, anonKey: KEY, functionName: 'fn', modelType: 'default' , queue: 'default' });
    await expect(api.list()).rejects.toThrowError(ApiErrorCtor);
    try {
      await api.list();
    } catch (err) {
      expect((err as ApiError).status).toBe(400);
      expect((err as ApiError).code).toBe('42883');
      expect((err as ApiError).message).toContain('operator does not exist');
    }
  });

  it('reports unreachable networks as status 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    const api = new ToolsApi({ url: URL, anonKey: KEY, functionName: 'fn', modelType: 'default' , queue: 'default' });
    const error = await api.list().catch((err: ApiError) => err);
    expect(error).toBeInstanceOf(ApiErrorCtor);
    expect((error as ApiError).status).toBe(0);
    expect((error as ApiError).message).toContain('网络不可达');
  });

  it('survives a non-JSON body', async () => {
    stubFetch('<html>502 bad gateway</html>');
    const api = new ToolsApi({ url: URL, anonKey: KEY, functionName: 'fn', modelType: 'default' , queue: 'default' });
    const body = await api.list();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('bad_json');
  });

  it('treats an empty 204 body as a failure envelope', async () => {
    stubFetch('');
    const api = new ToolsApi({ url: URL, anonKey: KEY, functionName: 'fn', modelType: 'default' , queue: 'default' });
    expect((await api.list()).error).toBe('empty_response');
  });

  it('rebuilds the realtime client when the project changes', async () => {
    stubFetch({ ok: true });
    const api = new ToolsApi({ url: URL, anonKey: KEY, functionName: 'fn', modelType: 'default' , queue: 'default' });
    api.subscribeJob('job-a', { onChunk: () => {} });
    api.setConfig({ url: 'https://other.supabase.co', anonKey: 'other-key-0123456789', functionName: 'fn', modelType: 'default', queue: 'default' });
    api.subscribeJob('job-b', { onChunk: () => {} });
    expect(mocks.channels.map((c) => c.name)).toEqual(['job-job-a', 'job-job-b']);
  });
});

describe('subscribeJob', () => {
  it('watches chunk inserts and job updates for one job only', async () => {
    stubFetch({ ok: true });
    const api = new ToolsApi({ url: URL, anonKey: KEY, functionName: 'fn', modelType: 'default' , queue: 'default' });
    const chunks: unknown[] = [];
    const jobs: unknown[] = [];
    api.subscribeJob('job-42', { onChunk: (row) => chunks.push(row), onJob: (row) => jobs.push(row) });

    const channel = mocks.channels[0]!;
    expect(channel.name).toBe('job-job-42');
    const [insert, update] = channel.handlers;
    expect(insert?.config).toMatchObject({ event: 'INSERT', table: 'deepseek_chunk', filter: 'job_id=eq.job-42' });
    expect(update?.config).toMatchObject({ event: 'UPDATE', table: 'deepseek_job', filter: 'id=eq.job-42' });

    (insert?.cb as (payload: { new: unknown }) => void)({ new: { seq: 0, payload: {} } });
    (update?.cb as (payload: { new: unknown }) => void)({ new: { status: 'done' } });
    expect(chunks).toEqual([{ seq: 0, payload: {} }]);
    expect(jobs).toEqual([{ status: 'done' }]);
  });

  it('removes the channel when disposed', async () => {
    stubFetch({ ok: true });
    const api = new ToolsApi({ url: URL, anonKey: KEY, functionName: 'fn', modelType: 'default' , queue: 'default' });
    const dispose = api.subscribeJob('job-1', { onChunk: () => {} });
    dispose();
    expect(mocks.removed).toHaveLength(1);
  });

  it('reports realtime failures to the caller instead of throwing', async () => {
    stubFetch({ ok: true });
    const api = new ToolsApi({ url: URL, anonKey: KEY, functionName: 'fn', modelType: 'default' , queue: 'default' });
    let reported: unknown = null;
    api.subscribeJob('job-1', { onChunk: () => {}, onError: (err) => (reported = err) });
    const cb = mocks.channels[0]!.subscribed[0] as (status: string) => void;
    cb('TIMED_OUT');
    expect(reported).toBe('TIMED_OUT');
  });
});

describe('callEdgeFunction', () => {
  it('posts the job id to the function endpoint', async () => {
    stubFetch({ ok: true });
    const api = new ToolsApi({ url: URL, anonKey: KEY, functionName: 'fn', modelType: 'default' , queue: 'default' });
    await api.callEdgeFunction({ job_id: 'j1' });
    // the configured function name is what gets called
    expect(requests[0]!.url).toBe(`${URL}/functions/v1/fn`);
    expect(requests[0]!.headers.apikey).toBe(KEY);
    expect(requests[0]!.body).toEqual({ job_id: 'j1' });
  });
});
