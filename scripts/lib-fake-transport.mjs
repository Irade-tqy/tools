// Stand in for the Edge Function / logged-in relay: claim whatever the UI queued, append the
// same normalized v1 frames the real relay sends, then complete the job with the conversation ids
// so the UI can continue the session.
//
// Shared by scripts/browser-smoke.mjs (the local build) and scripts/live-smoke.mjs (the deployed
// site). Both need conversation continuation asserted, and neither should depend on DeepSeek being
// up to prove it: the claim payload carries the session_id / parent_message_id the browser queued,
// which is exactly the wiring that makes "keep talking in the same chat" and "start a new chat"
// work. Whether DeepSeek itself remembers is a separate, live-only question.
/**
 * @param rpc        (fn, args) => Promise<any> — the PostgREST RPC caller to use
 * @param opts.queue which relay queue to drain (default 'test', so a run never starves the
 *                   public site's 'default' queue)
 */
export async function fakeTransport(
  rpc,
  {
    respondWith,
    abortOnSeq,
    sessionId,
    replyMessageId,
    withTool,
    outOfOrderTool,
    failWith,
    queue = 'test',
    claimAttempts = 200,
    chunkDelayMs = 40,
  },
) {
  const workerId = `smoke-${Math.random().toString(36).slice(2, 8)}`;
  const started = Date.now();
  const session = sessionId ?? `sess-${workerId}`;
  const reply = replyMessageId ?? 7;
  for (let attempt = 0; attempt < claimAttempts; attempt += 1) {
    const claim = await rpc('deepseek_claim', { p_worker_id: workerId, p_queue: queue });
    if (!claim.claimed) {
      await new Promise((r) => setTimeout(r, 150));
      continue;
    }
    const pieces = respondWith.match(/.{1,3}/gu) || [];
    const toolPayload = withTool
      ? {
          v: 1,
          _transport: 'smoke',
          tool: {
            id: 1,
            type: 'SEARCH',
            status: 'FINISHED',
            label: '搜索到 2 个网页',
            queries: ['上海天气'],
            results: [
              { cite_index: 1, title: '气象台', url: 'https://a.example', site_name: 'a.example', snippet: '晴' },
              { cite_index: 2, title: '天气网', url: 'https://b.example', site_name: 'b.example', snippet: '多云' },
            ],
            page: null,
          },
        }
      : null;
    // The live race, made deterministic: the browser subscribes after the relay writes the first
    // chunk, so the tool payload (seq 0) can reach it last. Writing seq 0 last reproduces that
    // ordering on every run instead of waiting for the race to happen by luck.
    let seq = toolPayload && outOfOrderTool ? 1 : 0;
    const append = async (payload, atSeq) => {
      const use = atSeq ?? seq;
      const out = await rpc('deepseek_append', { p_job_id: claim.job_id, p_seq: use, p_payload: payload });
      if (atSeq == null) seq += 1;
      return out;
    };
    if (toolPayload && !outOfOrderTool) await append(toolPayload);
    for (const piece of pieces) {
      await new Promise((r) => setTimeout(r, chunkDelayMs));
      const out = await append({ v: 1, _transport: 'smoke', text: piece });
      if (!out.ok && abortOnSeq != null && seq >= abortOnSeq) return { job_id: claim.job_id, cancelled: true, seq, claim };
    }
    if (toolPayload && outOfOrderTool) await append(toolPayload, 0);
    if (failWith) {
      // A turn the upstream refused: the relay still learns which DeepSeek conversation it
      // tried to join, and the next turn has to continue that same one.
      await append({
        v: 1,
        _transport: 'smoke',
        done: true,
        ok: false,
        error: failWith,
        job_id: claim.job_id,
        session_id: session,
      });
      await rpc('deepseek_complete', {
        p_job_id: claim.job_id,
        p_ok: false,
        p_error: failWith,
        p_metrics: { upstream_total_ms: Date.now() - started, transport: 'smoke' },
        p_session_id: session,
      });
      return { job_id: claim.job_id, seq, failed: true, claim };
    }
    await append({
      v: 1,
      _transport: 'smoke',
      done: true,
      ok: true,
      job_id: claim.job_id,
      session_id: session,
      reply_message_id: reply,
      title: '冒烟测试会话',
      mode: withTool ? 'DEEP_SEARCH' : 'DEFAULT',
      search_triggered: Boolean(withTool),
      token_usage: 128,
      citations: [],
    });
    await rpc('deepseek_complete', {
      p_job_id: claim.job_id,
      p_ok: true,
      p_metrics: { upstream_ttft_ms: 700, upstream_total_ms: Date.now() - started, transport: 'smoke' },
      p_session_id: session,
      p_reply_message_id: reply,
    });
    return { job_id: claim.job_id, seq, delivered: respondWith, claim };
  }
  return { error: 'never claimed' };
}
