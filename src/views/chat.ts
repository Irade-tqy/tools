// DeepSeek chat view.
//
// One turn = one prompt plus the two ids that place it in a conversation (chat_session_id,
// parent_message_id). DeepSeek keeps the history, so continuing means passing them back and
// "新会话" means dropping them. The answer arrives over the Edge Function's SSE, Realtime, or
// a polling fallback — all three feed the same reducer, which dedupes by the exact seq and
// asks for the lowest missing one so a late chunk is never stranded.

import type { ToolsApi } from '../lib/api';
import {
  applyChunk,
  applyStatus,
  chunkCursor,
  createChatState,
  describeLatency,
  flushPending,
  latencyOf,
  toolSummaryOf,
  type ChatState,
  type ChunkPayload,
} from '../lib/chat-reducer';
import { isModelType } from '../lib/config';
import { $, copyText, on, setStatus, toast } from '../lib/dom';
import { iconButton } from '../lib/icons';
import { applyAssistantModel, assistantNode, messageNode } from '../lib/render';
import { readSse, SSE_DONE, type SseEvent } from '../lib/sse';
import {
  clearSession,
  loadSession,
  newSession,
  parseSession,
  saveSession,
  sessionLabel,
  type ChatSession,
} from '../lib/session';

const POLL_INTERVAL_MS = 400;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface ChatView {
  send(text: string): Promise<void>;
  stop(): Promise<void>;
  refreshHealth(): Promise<void>;
  startNewSession(): void;
  currentSession(): ChatSession;
}

export function initChat(api: ToolsApi): ChatView {
  const log = $('chat-log');
  const form = $('chat-form') as HTMLFormElement;
  const input = $('chat-input') as HTMLTextAreaElement;
  const statusLine = $('chat-status');
  const sendButton = $('chat-send') as HTMLButtonElement;
  const stopButton = $('chat-stop') as HTMLButtonElement;
  const sessionLine = $('chat-session');
  const newSessionButton = $('chat-new-session') as HTMLButtonElement;
  const modelSelect = $('chat-model') as HTMLSelectElement;
  const thinkingBox = $('chat-thinking') as HTMLInputElement;
  const searchBox = $('chat-search') as HTMLInputElement;

  let session: ChatSession = loadSession();
  let state: ChatState | null = null;
  let assistant: HTMLElement | null = null;
  let unsubscribe: (() => void) | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let abortController: AbortController | null = null;
  let sseSeq = 0;
  let finishing = false;
  // The answer can finish before the job does: the last chunk carries the conversation ids,
  // and the job row carries them only once the transport has completed the job. So the poll
  // loop is gated on the *job*, never on the rendered answer.
  let jobFinished = false;
  let editingIndex: number | null = null;
  let followOutput = true;
  window.addEventListener('scroll', () => {
    followOutput = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
  }, { passive: true });

  function scrollToBottom() {
    if (followOutput && !$('chat-work').hidden && !$('chat-conversation').hidden) window.scrollTo(0, document.documentElement.scrollHeight);
  }

  function messageActions(node: HTMLElement, text: string, edit?: () => void, retry?: () => void) {
    if (node.querySelector('.msg-actions')) return;
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    if (edit) actions.append(iconButton('pen', '编辑消息', edit));
    actions.append(iconButton('copy', '复制消息', async () => {
      toast(await copyText(text) ? '已复制' : '复制失败，请选择文本复制');
    }));
    if (retry) actions.append(iconButton('rotateRight', '重新生成', retry));
    node.append(actions);
  }

  function editTurn(index: number, retry = false) {
    if (state && !state.done) return void toast('请先停止当前回复。');
    const turn = session.turns[index];
    if (!turn || turn.role !== 'user') return;
    editingIndex = index;
    input.value = turn.content;
    input.dispatchEvent(new Event('input'));
    input.focus();
    statusLine.textContent = '编辑后发送会替换这一轮及后续回复。按 Esc 取消。';
    if (retry) form.requestSubmit();
  }

  // --- rendering -----------------------------------------------------------

  function renderAssistant() {
    if (!state) return;
    if (!assistant) {
      assistant = assistantNode({ text: '', thinking: '', tools: null, meta: '', error: null });
      log.append(assistant);
    }
    applyAssistantModel(assistant, {
      text: state.text,
      thinking: state.reasoning,
      tools: state.tools.length || state.searchTriggered ? toolSummaryOf(state) : null,
      meta: state.done ? describeLatency(state) : '',
      error: state.error,
    });
    scrollToBottom();
  }

  function renderStatus() {
    if (!state) return;
    const parts: string[] = [];
    if (state.error) parts.push(`错误：${state.error}`);
    else if (!state.done) parts.push(`状态：${state.status}`);
    if (state.done) parts.push(describeLatency(state));
    else if (state.text || state.reasoning) parts.push('生成中…');
    // A queued turn with nobody claiming it means the relay is not running — say so instead of
    // letting the user stare at "排队中". The public page never names the Edge Function or any
    // other server plumbing: the backend stays off-screen there.
    if (!state.done && state.status === 'queued' && Date.now() - state.startedAt > 15_000) {
      parts.push('DeepSeek 暂时没有响应，请稍后再试');
    }
    statusLine.textContent = parts.join(' · ');
  }

  function renderSession() {
    sessionLine.textContent = sessionLabel(session);
    sessionLine.title = session.dsSessionId ? `DeepSeek 会话 ${session.dsSessionId}` : '下一条消息会新建一个 DeepSeek 会话';
    newSessionButton.disabled = !session.turns.length;
  }

  function renderTranscript() {
    log.textContent = '';
    if (!session.turns.length) {
      const hint = document.createElement('div');
      hint.className = 'chat-empty';
      const heading = document.createElement('h1');
      heading.textContent = '今天想聊些什么？';
      hint.append(heading);
      log.append(hint);
      return;
    }
    for (const [index, turn] of session.turns.entries()) {
      if (turn.role === 'user') {
        const node = messageNode('user', turn.content);
        messageActions(node, turn.content, () => editTurn(index));
        log.append(node);
        continue;
      }
      const node = assistantNode({
          text: turn.content,
          thinking: turn.thinking ?? '',
          tools: turn.tools ?? null,
          meta: '',
          error: null,
        });
      messageActions(node, turn.content, undefined, () => editTurn(index - 1, true));
      log.append(node);
    }
    scrollToBottom();
  }

  function setBusy(busy: boolean) {
    sendButton.disabled = busy;
    sendButton.hidden = busy;
    stopButton.hidden = !busy;
    newSessionButton.disabled = busy || !session.turns.length;
    ($('chat-import') as HTMLButtonElement).disabled = busy;
  }

  function teardown() {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    if (abortController) abortController.abort();
    abortController = null;
  }

  /** Record the turn and hand the conversation ids back to the session. */
  function commitTurn() {
    if (!state) return;
    if (state.sessionId) session.dsSessionId = state.sessionId;
    if (state.replyMessageId) session.parentId = state.replyMessageId;
    if (state.title) session.title = state.title;
    if (state.text) {
      session.turns.push({
        role: 'assistant',
        content: state.text,
        thinking: state.reasoning || undefined,
        tools: state.tools.length || state.searchTriggered ? toolSummaryOf(state) : undefined,
        mode: state.mode || undefined,
        at: Date.now(),
      });
    }
    saveSession(session);
    renderSession();
  }

  async function finish(reason?: string) {
    if (!state || finishing) return;
    finishing = true;
    // Realtime delivers the job UPDATE on a different channel than the chunk INSERTs, so a job
    // can look finished before the last chunks — and the conversation ids, title and upstream
    // timings live in those last frames. The job row only reaches a terminal status once the
    // transport has completed it, so poll until it does, then commit.
    jobFinished = true;
    if (state.jobId) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          const res = await api.jobStatus(state.jobId, chunkCursor(state));
          if (!res.ok) break;
          applyStatus(state, res);
          if (res.finished) break;
        } catch {
          break; // keep whatever we already streamed
        }
        await sleep(150);
      }
    }
    // Whatever is still buffered belongs to this answer; a hole the polls have not refilled by
    // now is a chunk the relay could not write at all.
    flushPending(state, Date.now());
    state.done = true;
    state.finishedAt = state.finishedAt ?? Date.now();
    if (reason) state.error = reason;
    teardown();
    commitTurn();
    setBusy(false);
    renderAssistant();
    if (assistant && state.text) messageActions(assistant, state.text, undefined, () => editTurn(session.turns.length - 2, true));
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
    finishing = false;
  }

  // --- transports ----------------------------------------------------------

  function pump() {
    // Poll fallback: covers Realtime being unavailable (blocked websocket, table missing
    // from the publication) and the SSE connection dropping mid-stream.
    if (!state?.jobId || jobFinished) return;
    pollTimer = setTimeout(async () => {
      if (!state?.jobId || jobFinished) return;
      // A gap that three polls have not refilled is not coming back; release what is behind it
      // instead of freezing the answer at "…".
      if (state.pending.size && state.pendingSince !== null && Date.now() - state.pendingSince > 3 * POLL_INTERVAL_MS) {
        flushPending(state, Date.now());
        renderAssistant();
      }
      try {
        const res = await api.jobStatus(state.jobId, chunkCursor(state));
        if (res.ok) {
          applyStatus(state, res);
          renderAssistant();
          renderStatus();
          if (res.finished) {
            jobFinished = true;
            return void finish();
          }
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
      const res = await api.callEdgeFunction({ job_id: jobId, queue: api.config.queue }, abortController.signal);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // 503 means the server has no usable DeepSeek credential; the DB path still renders.
        state!.metrics = { ...state!.metrics, edge_status: res.status, edge_note: body.slice(0, 200) };
        renderStatus();
        return;
      }
      await readSse(res, {
        signal: abortController.signal,
        onEvent: (event: SseEvent) => {
          if (!state || state.jobId !== jobId) return;
          if (event.data === SSE_DONE) return;
          let parsed: ChunkPayload & { seq?: number };
          try {
            parsed = JSON.parse(event.data) as ChunkPayload & { seq?: number };
          } catch {
            return;
          }
          const seq = typeof parsed.seq === 'number' ? parsed.seq : sseSeq++;
          applyChunk(state, seq, parsed);
          renderAssistant();
          renderStatus();
          if (state.done) void finish();
        },
      });
    } catch (err) {
      if ((err as Error).name !== 'AbortError' && state && !state.done) {
        state.metrics = { ...state.metrics, edge_error: String((err as Error).message).slice(0, 200) };
        renderStatus();
      }
    }
  }

  // --- actions -------------------------------------------------------------

  async function send(text: string): Promise<void> {
    const content = text.trim();
    if (!content || (state && !state.done)) return;

    if (!api.token) return void toast('请先验证登录码。', 'err');
    const previousSession = structuredClone(session);
    const previousEditingIndex = editingIndex;
    function restoreFailedSend(message: string) {
      session = previousSession;
      editingIndex = previousEditingIndex;
      state = null;
      assistant = null;
      saveSession(session);
      renderTranscript();
      renderSession();
      setBusy(false);
      input.value = content;
      input.dispatchEvent(new Event('input'));
      log.append(messageNode('system', message));
    }
    if (editingIndex !== null) {
      const original = session.turns[editingIndex];
      if (original?.parentId === undefined && editingIndex > 0) {
        session = newSession();
        toast('旧会话缺少分支信息，已从新会话发送。');
      } else {
        session.parentId = original?.parentId ?? null;
        session.turns = session.turns.slice(0, editingIndex);
      }
      editingIndex = null;
      renderTranscript();
    }
    followOutput = true;
    log.querySelector('.chat-empty')?.remove();
    const userNode = messageNode('user', content);
    const turnIndex = session.turns.length;
    messageActions(userNode, content, () => editTurn(turnIndex));
    log.append(userNode);
    session.turns.push({ role: 'user', content, at: Date.now(), parentId: session.parentId });
    renderSession();

    state = createChatState();
    assistant = null;
    sseSeq = 0;
    finishing = false;
    jobFinished = false;
    setBusy(true);
    setStatus('DeepSeek：排队中', 'idle');
    statusLine.textContent = '';

    let enqueued;
    try {
      enqueued = await api.ask({
        prompt: content,
        sessionId: session.dsSessionId,
        parentId: session.parentId,
        modelType: isModelType(modelSelect.value) ? modelSelect.value : 'default',
        thinking: thinkingBox.checked,
        search: searchBox.checked,
      });
    } catch (err) {
      restoreFailedSend(`无法入队：${(err as Error).message}`);
      return;
    }
    if (!enqueued.ok || !enqueued.job_id) {
      const why =
        enqueued.error === 'rate_limited'
          ? '发送太快，稍等 1 分钟'
          : enqueued.error === 'no_credentials'
            ? '服务端还没有 DeepSeek 登录态'
            : String(enqueued.error || '入队失败');
      restoreFailedSend(why);
      if (enqueued.error === 'unauthorized') document.dispatchEvent(new Event('tools:auth-expired'));
      return;
    }

    // The turn is queued against a conversation; remember which one even if the stream dies.
    if (enqueued.session_id) session.dsSessionId = enqueued.session_id;
    saveSession(session);

    state.jobId = enqueued.job_id;
    state.status = 'queued';
    renderAssistant();
    renderStatus();

    unsubscribe = api.subscribeJob(enqueued.job_id, {
      onChunk: (row) => {
        // No `state.done` guard here: applyChunk dedupes by seq, and a chunk that arrives
        // after the answer looked finished (the done frame's session ids) still has to land.
        if (!state) return;
        applyChunk(state, row.seq, row.payload as ChunkPayload);
        renderAssistant();
        renderStatus();
      },
      onJob: (row) => {
        if (!state) return;
        applyStatus(state, { status: row.status, metrics: row.metrics as never, error: row.error });
        renderStatus();
        if (row.status === 'done' || row.status === 'error' || row.status === 'cancelled') {
          jobFinished = true;
          void finish();
        }
      },
      onError: () => {
        if (state) state.metrics = { ...state.metrics, realtime: 'unavailable' };
      },
    });

    pump();
    void streamFromEdge(enqueued.job_id);
  }

  async function stop(): Promise<void> {
    if (!state?.jobId) return;
    try {
      await api.cancelJob(state.jobId);
    } catch {
      /* best effort */
    }
    void finish('已手动停止');
  }

  function startNewSession(): void {
    if (state && !state.done) return void toast('请先停止当前回复。');
    teardown();
    state = null;
    assistant = null;
    session = newSession();
    editingIndex = null;
    input.value = '';
    statusLine.textContent = '';
    clearSession();
    saveSession(session);
    renderTranscript();
    renderSession();
    renderStatus();
    setBusy(false);
    toast('已开始新会话', 'ok');
  }

  async function refreshHealth(): Promise<void> {
    try {
      const health = await api.health();
      if (!health.ok) return;
      if (health.credential_configured === false) {
        setStatus('DeepSeek 未配置登录态', 'warn');
        return;
      }
      if (health.credential_error) {
        setStatus(`DeepSeek 登录态异常：${String(health.credential_error).slice(0, 60)}`, 'err');
        return;
      }
      // The credential being configured is not the same as a relay being live: if jobs are
      // sitting in the queue and nothing has claimed one, the Edge Function is missing.
      if ((health.pending ?? 0) > 0 && (health.workers_alive ?? 0) === 0) {
        setStatus('DeepSeek：队列积压，没有可用转发通道', 'warn');
        return;
      }
      const median = typeof health.median_ttft_ms === 'number' ? `，中位首字 ${Math.round(health.median_ttft_ms)}ms` : '';
      setStatus(`DeepSeek 就绪${median}`, 'ok');
    } catch {
      /* the admin page reports connection failures */
    }
  }

  on(form, 'submit', (event) => {
    event.preventDefault();
    if (state && !state.done) return;
    const value = input.value;
    if (!value.trim()) return;
    input.value = '';
    input.dispatchEvent(new Event('input'));
    void send(value);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && editingIndex !== null) {
      editingIndex = null;
      input.value = '';
      statusLine.textContent = '';
    }
    let mode = 'enter';
    try { mode = localStorage.getItem('tools.chat.send-mode') || 'enter'; } catch { /* use default */ }
    if (!event.isComposing && event.key === 'Enter' && !event.shiftKey
      && ((event.ctrlKey || event.metaKey) || mode === 'enter')) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(210, input.scrollHeight)}px`;
  });

  const sessionFile = $('session-file') as HTMLInputElement;
  on($('chat-import'), 'click', () => sessionFile.click());
  on(sessionFile, 'change', async () => {
    const file = sessionFile.files?.[0];
    sessionFile.value = '';
    if (!file || (state && !state.done)) return;
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('会话文件超过 10 MB。');
      const imported = parseSession(await file.text());
      if (session.turns.length && !window.confirm('读取后会替换本机当前会话，建议先导出。继续？')) return;
      teardown();
      state = null;
      assistant = null;
      session = imported;
      editingIndex = null;
      input.value = '';
      statusLine.textContent = '';
      saveSession(session);
      renderTranscript();
      renderSession();
      setBusy(false);
      toast('已读取会话', 'ok');
    } catch (error) { toast((error as Error).message, 'err'); }
  });
  on($('chat-export'), 'click', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `tools-chat-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  on(stopButton, 'click', () => void stop());
  on(newSessionButton, 'click', () => startNewSession());

  renderTranscript();
  renderSession();

  return { send, stop, refreshHealth, startNewSession, currentSession: () => session };
}
