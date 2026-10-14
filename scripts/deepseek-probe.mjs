#!/usr/bin/env node
// Measure the DeepSeek upstream directly, so the "≤ 5s slower than the official site"
// target is answered with numbers instead of assumptions.
//
//   node scripts/deepseek-probe.mjs [--prompt "..."] [--urls a,b,c]
//
// Reads DEEPSEEK_API_KEY (Bearer route) or DEEPSEEK_WEB_COOKIE (login-cookie route) from
// .env.local. Prints TTFB / time-to-first-token / total per endpoint.
import { env } from './lib.mjs';
import {
  buildRequestBody,
  createSseParser,
  extractDelta,
  resolveUpstream,
} from '../supabase/functions/_shared/deepseek.ts';

const args = process.argv.slice(2);
const flag = (name, fallback = '') => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const value = args[i + 1];
  return value && !value.startsWith('--') ? value : fallback;
};

const prompt = flag('--prompt', '用一句话回答：1+1 等于几？');
const model = flag('--model', 'deepseek-chat');

const upstream = resolveUpstream(env);
if (upstream.mode === 'none') {
  console.error(upstream.reason);
  console.error('run: node scripts/deepseek-login.mjs --phone <number>   (or set DEEPSEEK_API_KEY)');
  process.exit(1);
}

const candidates = (flag('--urls') || process.env.TOOLS_DEEPSEEK_URLS || upstream.url)
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean);

const messages = [{ role: 'user', content: prompt }];

function ms(value) {
  if (value === null || value === undefined) return '—';
  return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(2)}s`;
}

async function probe(url) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: upstream.headers,
      body: buildRequestBody(messages, model, true),
    });
    const ttfb = Date.now() - started;
    let ttft = null;
    let text = '';
    let finishReason = null;
    let error = null;

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { url, status: res.status, ttfb, ttft: null, total: Date.now() - started, chars: 0, error: body.slice(0, 160) };
    }

    const parse = createSseParser();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const event of parse(decoder.decode(value, { stream: true }))) {
        if (event.data === '[DONE]') continue;
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch {
          continue;
        }
        const delta = extractDelta(payload);
        if (delta.error) error = delta.error;
        if (delta.content || delta.reasoning) {
          if (ttft === null) ttft = Date.now() - started;
          text += delta.content;
        }
        if (delta.finishReason) finishReason = delta.finishReason;
      }
    }
    return {
      url,
      status: res.status,
      ttfb,
      ttft,
      total: Date.now() - started,
      chars: text.length,
      finishReason,
      error,
      sample: text.slice(0, 60),
    };
  } catch (err) {
    return { url, status: 0, ttfb: null, ttft: null, total: Date.now() - started, chars: 0, error: err.message };
  }
}

console.log(`mode: ${upstream.mode}  model: ${model}`);
console.log(`route: ${upstream.mode === 'api' ? `Bearer ${env.DEEPSEEK_API_KEY.slice(0, 6)}…` : `cookie (${env.DEEPSEEK_WEB_COOKIE.length} chars)`}\n`);

let anyOk = false;
for (const url of candidates) {
  const result = await probe(url);
  const ok = result.status === 200 && result.chars > 0;
  anyOk = anyOk || ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${result.url}`);
  console.log(`     HTTP ${result.status} · TTFB ${ms(result.ttfb)} · 首字 ${ms(result.ttft)} · 总 ${ms(result.total)} · ${result.chars} 字`);
  if (result.sample) console.log(`     “${result.sample}”`);
  if (result.error) console.log(`     error: ${result.error}`);
  console.log('');
}

if (!anyOk) {
  console.log('结论：当前凭据打不通上游。cookie 路线常被 WAF/PoW 拦截，或需要 DEEPSEEK_API_URL 指向网页端点。');
  console.log('下一步：设置 DEEPSEEK_API_URL 重试，或改用 DEEPSEEK_API_KEY（官方 API）。');
  process.exit(1);
}
console.log('结论：上游可用。把“首字”与官网同问题的耗时对比，即为工具箱引入的额外延迟基线。');
