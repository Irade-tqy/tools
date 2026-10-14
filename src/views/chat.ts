// DeepSeek chat view: enqueue a job, then render the stream from whichever transport
// answers first (edge function SSE, Realtime rows, or a polling fallback). All three feed
// the same reducer, which dedupes by seq, so nothing renders twice.

import type { ChatMessage, ToolsApi } from '../lib/api';
import {
  applyChunk,
  applyStatus,
  createChatState,
  describeLatency,
  latencyOf,
  type ChatState,
  type ChunkPayload,
} from '../lib/chat-reducer';
import { $, on, setStatus, toast } from '../lib/dom';
import { messageNode } from '../lib/render';
import { readSse, SSE_DONE, type SseEvent } from '../lib/sse';

const POLL_INTERVAL_MS = 400;

export interface ChatView {
  send(text: string): Promise<void>;
  stop(): Promise<void>;
  refreshHealth(): Promise<void>;
}

/** One SSE payload from the edge function: a DeepSeek chunk plus its seq. */
type SseLine = ChunkPayload & { seq?: number };

export function initChat(api: ToolsApi, getConfig: () => { model: string; transport: string }): ChatView {
  const log = $('chat-log');
  const form = $('chat-form') as HTMLFormElement;
  const input = $('chat-input') as HTMLTextAreaElement;
  const statusLine = $('chat-status');
  const sendButton = $('chat-send') as HTMLButtonElement;
  const stopButton = $('chat-stop') as HTMLButtonElement;

  const history: ChatMessage[] = [];
  let state: ChatState | null = null;
  let assistantNode: HTMLElement | null = null;
  let unsubscribe: (() => void) | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let abortController: AbortController | null = null;
  let sseSeq = 0;

  function renderAssistant() {
    if (!state) return;
    if (!assistantNode) {
      assistantNode = messageNode('assistant', '');
      log.append(assistantNode);
    }
    const body = assistantNode.firstElementChild;
    if (body) body.textContent = (state.reasoning ? `${state.reasoning}\n\n` : '') + state.text || '…';
    log.scrollTop = log.scrollHeight;
  }

  function renderStatus() {
    if (!state) return;
    const parts = [state.error ? `错误：${state.error}` : `状态：${state.status}`];
    parts.push(describeLatency(state));
    statusLine.textContent = parts.join(' · ');
    if (assistantNode) {
      let meta = assistantNode.querySelector('.msg__meta');
      if (!meta) {
        meta = document.createElement('div');
        meta.className = 'msg__meta';
        assistantNode.append(meta);
      }
      meta.textContent = state.done ? describeLatency(state) : '';
    }
  }

  function setBusy(busy: boolean) {
    sendButton.disabled = busy;
    stopButton.hidden = !busy;
    input.disabled = false;
  }

  function teardown() {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    if (abortController) abortController.abort();
    abortController = null;
  }

  function finish(reason?: string) {
    if (!state) return;
    state.done = true;
    state.finishedAt = state.finishedAt ?? Date.now();
    if (reason) state.error = reason;
    teardown();
    setBusy(false);
    renderAssistant();
    renderStatus();
    const report = latencyOf(state);
    if (report.ttftMs !== null) {
      setStatus(
        report.withinBudget === false
          ? `DeepSeek：首字 ${Math.round(report.ttftMs)}ms，超出 5s 预算`
          : `DeepSeek：首字 ${Math.round(report.ttftMs)}ms`,
        report.withinBudget === false ? 'warn' : 'ok',
      );
    }
    if (state.text) history.push({ role: 'assistant', content: state.text });
  }

  function pump() {
    // Poll fallback: covers the case where Realtime is unavailable (blocked websocket,
    // table not in the publication) and the edge function is not configured.
    if (!state?.jobId || !state || state.done) return;
    pollTimer = setTimeout(async () => {
      if (!state?.jobId || state.done) return;
      try {
        const res = await api.jobStatus(state.jobId, state.lastSeq);
        if (res.ok) {
          applyStatus(state, res);
          renderAssistant();
          renderStatus();
          if (res.finished) return void finish();
        }
      } catch {
        /* transient network error; keep polling */
      }
      pump();
    }, POLL_INTERVAL_MS);
  }

  async function streamFromEdge(jobId: string): Promise<void> {
    if (!api.config.url) return;
    abortController = new AbortController();
    try {
      const res = await api.callEdgeFunction('deepseek-chat', { job_id: jobId }, abortController.signal);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // 501/503 means "no credentials configured" — the browser worker can still take over.
        state!.metrics = { ...state!.metrics, edge_status: res.status, edge_note: body.slice(0, 200) };
        renderStatus();
        return;
      }
      await readSse(res, {
        signal: abortController.signal,
        onEvent: (event: SseEvent) => {
          if (!state || state.done) return;
          if (event.data === SSE_DONE) return void finish();
          let parsed: SseLine;
          try {
            parsed = JSON.parse(event.data) as SseLine;
          } catch {
            return;
          }
          const seq = typeof parsed.seq === 'number' ? parsed.seq : sseSeq++;
          applyChunk(state, seq, parsed);
          renderAssistant();
          renderStatus();
          if (state.done) finish();
        },
      });
    } catch (err) {
      if ((err as Error).name !== 'AbortError' && state && !state.done) {
        state.metrics = { ...state.metrics, edge_error: String((err as Error).message).slice(0, 200) };
        renderStatus();
      }
    }
  }

  async function send(text: string): Promise<void> {
    const content = text.trim();
    if (!content || (state && !state.done)) return;
    const cfg = getConfig();
    log.querySelectorAll('.muted').forEach((node) => node.remove());
    log.append(messageNode('user', content));
    history.push({ role: 'user', content });

    state = createChatState();
    assistantNode = null;
    sseSeq = 0;
    setBusy(true);
    setStatus('DeepSeek：排队中', 'idle');
    statusLine.textContent = '';

    let enqueued;
    try {
      enqueued = await api.enqueue(history.slice(-20), cfg.model);
    } catch (err) {
      setBusy(false);
      log.append(messageNode('system', `无法入队：${(err as Error).message}`));
      return;
    }
    if (!enqueued.ok || !enqueued.job_id) {
      setBusy(false);
      const why = enqueued.error === 'rate_limited' ? '发送太快，稍等 1 分钟' : enqueued.error || '入队失败';
      log.append(messageNode('system', String(why)));
      return;
    }

    state.jobId = enqueued.job_id;
    state.status = 'queued';
    renderAssistant();
    renderStatus();

    unsubscribe = api.subscribeJob(enqueued.job_id, {
      onChunk: (row) => {
        if (!state || state.done) return;
        applyChunk(state, row.seq, row.payload);
        renderAssistant();
        renderStatus();
      },
      onJob: (row) => {
        if (!state || state.done) return;
        applyStatus(state, { status: row.status, metrics: row.metrics as never, error: row.error });
        renderStatus();
        if (row.status === 'done' || row.status === 'error' || row.status === 'cancelled') finish();
      },
      onError: () => {
        if (state) state.metrics = { ...state.metrics, realtime: 'unavailable' };
      },
    });

    pump();

    if (cfg.transport !== 'browser') void streamFromEdge(enqueued.job_id);
  }

  async function stop(): Promise<void> {
    if (!state?.jobId) return;
    try {
      await api.cancelJob(state.jobId);
    } catch {
      /* best effort */
    }
    finish('已手动停止');
  }

  async function refreshHealth(): Promise<void> {
    try {
      const health = await api.health();
      if (!health.ok) return;
      const rows: Array<[string, string]> = [
        ['队列中', String(health.queued ?? 0)],
        ['存活 worker', String(health.workers_alive ?? 0)],
        ['近 1 小时成功', String(health.done_last_hour ?? 0)],
        ['近 1 小时失败', String(health.error_last_hour ?? 0)],
      ];
      const kv = $('health-kv');
      kv.replaceChildren(
        ...rows.flatMap(([key, value]) => {
          const dt = document.createElement('dt');
          dt.textContent = key;
          const dd = document.createElement('dd');
          dd.textContent = value;
          return [dt, dd];
        }),
      );
      const transport = getConfig().transport;
      const noEdge = transport !== 'edge';
      const noWorker = transport !== 'browser' && (health.workers_alive ?? 0) === 0;
      if (noEdge && noWorker) {
        toast('还没有可用的 DeepSeek 转发通道：部署 Edge Function，或在已登录的 DeepSeek 标签页运行 worker', 'err');
      }
    } catch {
      /* settings panel shows the failure */
    }
  }

  on(form, 'submit', (event) => {
    event.preventDefault();
    const value = input.value;
    input.value = '';
    void send(value);
  });

  input.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  on(stopButton, 'click', () => void stop());

  return { send, stop, refreshHealth };
}
