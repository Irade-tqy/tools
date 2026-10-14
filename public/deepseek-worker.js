/* eslint-disable */
// DeepSeek browser worker — zero dependencies, no build step.
//
// Why this exists: DeepSeek's web login cookie is SameSite-restricted, so a fetch from the
// toolbox origin cannot send it. A tab that is *already logged in to DeepSeek* can. This
// script runs in that tab, claims queued jobs from Supabase, calls DeepSeek same-origin, and
// streams the deltas back into deepseek_chunk. The toolbox UI renders them.
//
// Start it from a logged-in chat.deepseek.com tab (the toolbox Settings page copies this):
//   (()=>{const d=document,s=d.createElement('script');s.src='https://…/deepseek-worker.js';
//         s.dataset.url='https://<ref>.supabase.co';s.dataset.anon='<anon key>';d.head.append(s)})()
//
// Or in the console:
//   TOOLS_WORKER_START('https://<ref>.supabase.co', '<anon key>')
//
// Config (all optional):
//   dataset.url / dataset.anon   Supabase project + anon key
//   dataset.api                  chat completions endpoint (default https://api.deepseek.com/v1/chat/completions)
//   dataset.model                default model when a job does not carry one
//   dataset.interval             claim poll interval, ms (default 1500)
//   window.TOOLS_WORKER_KEY      optional Bearer key; when set it replaces the cookie route
//
// Stop with window.TOOLS_WORKER.stop().

(function () {
  'use strict';

  var script =
    document.currentScript ||
    (function () {
      var all = document.getElementsByTagName('script');
      for (var i = all.length - 1; i >= 0; i -= 1) {
        if (/deepseek-worker\.js/.test(all[i].src)) return all[i];
      }
      return null;
    })();

  var data = (script && script.dataset) || {};

  function start(userUrl, userAnon) {
    var url = (userUrl || data.url || localStorage.getItem('tools.worker.url') || '').replace(/\/+$/, '');
    var anon = userAnon || data.anon || localStorage.getItem('tools.worker.anon') || '';
    if (!url || !anon) {
      console.warn('[deepseek-worker] 缺少 Supabase 配置：start(url, anonKey)');
      return null;
    }
    localStorage.setItem('tools.worker.url', url);
    localStorage.setItem('tools.worker.anon', anon);

    var api = data.api || localStorage.getItem('tools.worker.api') || 'https://api.deepseek.com/v1/chat/completions';
    var defaultModel = data.model || localStorage.getItem('tools.worker.model') || 'deepseek-chat';
    var interval = Math.max(500, Number(data.interval || 1500));
    var workerId = sessionStorage.getItem('tools.worker.id');
    if (!workerId) {
      workerId = 'tab-' + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem('tools.worker.id', workerId);
    }

    var stopped = false;
    var timer = null;

    function rpc(fn, args) {
      return fetch(url + '/rest/v1/rpc/' + fn, {
        method: 'POST',
        headers: {
          apikey: anon,
          Authorization: 'Bearer ' + anon,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(args || {}),
      }).then(function (res) {
        return res.json().catch(function () {
          return { ok: false, error: 'bad_json_' + res.status };
        });
      });
    }

    function log() {
      var args = Array.prototype.slice.call(arguments);
      args.unshift('[deepseek-worker ' + workerId + ']');
      console.log.apply(console, args);
    }

    // Parse SSE text that may split anywhere, mirroring src/lib/sse.ts.
    function makeParser(onData) {
      var buffer = '';
      return function (text) {
        buffer += text;
        var match;
        while ((match = /\r\n|\r|\n/.exec(buffer))) {
          var line = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          if (line.indexOf('data:') !== 0) continue;
          var payload = line.slice(5).replace(/^ /, '');
          if (payload && payload !== '[DONE]') onData(payload);
        }
      };
    }

    async function runJob(job) {
      var seq = 0;
      var started = Date.now();
      var ttfb = null;
      var ttft = null;
      var controller = new AbortController();
      var metrics = { transport: 'browser', worker_id: workerId };

      var headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
      var init = { method: 'POST', headers: headers, body: JSON.stringify({ model: job.model || defaultModel, messages: job.messages, stream: true }), credentials: 'include' };
      if (window.TOOLS_WORKER_KEY) {
        init.headers.Authorization = 'Bearer ' + window.TOOLS_WORKER_KEY;
        init.credentials = 'omit';
      }

      var res;
      try {
        res = await fetch(api, init);
      } catch (err) {
        await rpc('deepseek_complete', { p_job_id: job.job_id, p_ok: false, p_error: 'upstream fetch failed: ' + err.message, p_metrics: metrics });
        return;
      }
      ttfb = Date.now() - started;
      metrics.upstream_ttfb_ms = ttfb;

      if (!res.ok || !res.body) {
        var text = await res.text().catch(function () { return ''; });
        await rpc('deepseek_complete', {
          p_job_id: job.job_id,
          p_ok: false,
          p_error: 'HTTP ' + res.status + ' ' + text.slice(0, 300),
          p_metrics: metrics,
        });
        log('upstream HTTP', res.status, '(登录态不可用？)', text.slice(0, 120));
        return;
      }

      var reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      var cancelled = false;
      var pending = [];
      var flushing = false;

      async function flush() {
        if (flushing || !pending.length) return;
        flushing = true;
        var batch = pending.splice(0, pending.length);
        for (var i = 0; i < batch.length; i += 1) {
          var out = await rpc('deepseek_append', { p_job_id: job.job_id, p_seq: batch[i].seq, p_payload: batch[i].payload });
          if (!out.ok) {
            if (out.error === 'job_cancelled') cancelled = true;
            break;
          }
        }
        flushing = false;
      }

      var parse = makeParser(function (payload) {
        var obj;
        try {
          obj = JSON.parse(payload);
        } catch (e) {
          return;
        }
        var delta = (obj.choices && obj.choices[0] && obj.choices[0].delta) || {};
        if (ttft === null && (delta.content || delta.reasoning_content)) {
          ttft = Date.now() - started;
          metrics.upstream_ttft_ms = ttft;
        }
        obj._transport = 'browser';
        pending.push({ seq: seq++, payload: obj });
        if (pending.length >= 3) void flush();
      });

      try {
        while (!stopped && !cancelled) {
          var step = await reader.read();
          if (step.done) break;
          parse(step.value);
        }
      } catch (err) {
        log('stream error', err.message);
      }

      await flush();
      metrics.upstream_total_ms = Date.now() - started;
      metrics.upstream_chunks = seq;

      if (cancelled) {
        await rpc('deepseek_complete', { p_job_id: job.job_id, p_ok: false, p_error: 'cancelled by user', p_metrics: metrics });
        log('job cancelled', job.job_id);
        return;
      }
      var done = await rpc('deepseek_complete', { p_job_id: job.job_id, p_ok: true, p_metrics: metrics });
      log('job done', job.job_id, 'chunks', seq, 'ttft', ttft === null ? 'n/a' : ttft + 'ms', done.ok ? '' : done.error);
    }

    async function tick() {
      if (stopped) return;
      var claim;
      try {
        claim = await rpc('deepseek_claim', { p_worker_id: workerId });
      } catch (err) {
        log('claim failed', err.message);
        timer = setTimeout(tick, interval * 2);
        return;
      }
      if (claim && claim.claimed) {
        log('claimed', claim.job_id);
        await runJob(claim);
        timer = setTimeout(tick, 0);
        return;
      }
      timer = setTimeout(tick, interval);
    }

    tick();
    log('worker started; api =', api);

    return {
      stop: function () {
        stopped = true;
        if (timer) clearTimeout(timer);
        log('worker stopped');
      },
      status: function () {
        return { workerId: workerId, url: url, api: api, stopped: stopped };
      },
    };
  }

  window.TOOLS_WORKER_START = start;
  if (!window.TOOLS_WORKER) {
    window.TOOLS_WORKER = start(data.url, data.anon);
  }
})();
