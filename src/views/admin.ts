// The backend page — hidden unless the URL says `?admin=1`.
//
// Its one real job is keeping the DeepSeek login alive: paste one string (localStorage.userToken,
// DevTools "Copy as cURL", a Cookie header, JSON, or a saved dscred1: string), and the Edge
// Function parses it, checks it against the live API and stores it. The parse preview runs the
// same parser the server uses, so a mistake is caught before it is sent.
//
// Everything else here (Supabase overrides, queue counters) is diagnostics for self-hosting.

import type { CredentialSetResult, CredentialStatus, ToolsApi } from '../lib/api';
import {
  clearConfig,
  isConfigured,
  isValidUrl,
  loadAdminToken,
  saveAdminToken,
  saveConfig,
  isModelType,
  type Config,
} from '../lib/config';
import { $, copyText, on, showError, toast } from '../lib/dom';
import { fingerprint, parseCredential, serializeCredential } from '../../supabase/functions/_shared/credential.ts';

export interface AdminView {
  render(): void;
  refreshHealth(): Promise<void>;
}

export function initAdmin(api: ToolsApi, cfg: Config, onChange: (next: Config) => void): AdminView {
  const form = $('config-form') as HTMLFormElement;
  const urlInput = $('cfg-url') as HTMLInputElement;
  const anonInput = $('cfg-anon') as HTMLInputElement;
  const fnInput = $('cfg-function') as HTMLInputElement;
  const modelSelect = $('cfg-model') as HTMLSelectElement;
  const errorNode = $('config-error');

  const adminTokenInput = $('admin-token') as HTMLInputElement;
  const credInput = $('cred-input') as HTMLTextAreaElement;
  const credPreview = $('cred-preview');
  const credErrorNode = $('cred-error');
  const credStatus = $('cred-status');
  const canonicalBox = $('cred-canonical') as HTMLTextAreaElement;
  const verifyBox = $('cred-verify') as HTMLInputElement;

  function render() {
    urlInput.value = cfg.url;
    anonInput.value = cfg.anonKey;
    fnInput.value = cfg.functionName;
    modelSelect.value = cfg.modelType;
    adminTokenInput.value = loadAdminToken();
  }

  function preview() {
    const raw = credInput.value.trim();
    if (!raw) {
      credPreview.textContent = '';
      return;
    }
    const parsed = parseCredential(raw);
    if (!parsed.ok) {
      credPreview.textContent = `解析失败：${parsed.error}`;
      return;
    }
    const c = parsed.credential;
    const bits = [
      `格式 ${c.source}`,
      `token ${fingerprint(c)}`,
      `device ${c.deviceId || '无'}`,
      `cookie ${c.cookie ? `${c.cookie.length} 字符` : '无'}`,
    ];
    credPreview.textContent = bits.join(' · ') + (parsed.warnings.length ? ` · ${parsed.warnings.join('；')}` : '');
  }

  async function refreshStatus() {
    // deepseek_credential_status() is a public RPC that returns no secret, so the backend
    // page reads its status from PostgREST directly — no admin token, no Edge Function.
    const status: CredentialStatus = await api
      .credentialStatusRpc()
      .catch((err) => ({ ok: false, error: (err as Error).message }));
    if (!status.ok) {
      credStatus.textContent = `读取失败：${status.error ?? '未知错误'}`;
      return;
    }
    credStatus.textContent = status.configured
      ? `已配置 · ${status.token_hint ?? ''} · ${status.age_minutes ?? '?'} 分钟前更新 · 来源 ${status.source || '未知'}` +
        `${status.last_error ? ` · 最近错误：${status.last_error}` : ''}`
      : '服务端还没有 DeepSeek 登录态。';
  }

  async function saveCredential() {
    showError(credErrorNode, '');
    const raw = credInput.value.trim();
    if (!raw) return void showError(credErrorNode, '先粘贴一个字符串。');
    const token = adminTokenInput.value.trim();
    if (!token) return void showError(credErrorNode, '先填管理令牌（TOOLS_ADMIN_TOKEN）。');
    saveAdminToken(token);

    const parsed = parseCredential(raw);
    if (!parsed.ok) return void showError(credErrorNode, parsed.error);

    const button = $('cred-save') as HTMLButtonElement;
    button.disabled = true;
    button.textContent = '验证中…';
    try {
      // Prefer the Edge Function: it checks the string against DeepSeek before storing it.
      // With the function undeployed the call 404s, and the same write goes through
      // PostgREST instead — gated by the admin token, marked unverified.
      let result: CredentialSetResult = { ok: false, error: 'unreachable' };
      let viaRest = false;
      try {
        result = await api.credentialSet(raw, token, verifyBox.checked);
        if (!result.ok && /HTTP 404|not[_ ]found|no such service|function.*not/i.test(result.error ?? '')) {
          viaRest = true;
        }
      } catch {
        viaRest = true;
      }
      if (viaRest) {
        result = await api.credentialSetViaRpc(parsed.credential, token);
        if (result.ok) result.canonical = serializeCredential(parsed.credential);
      }
      if (!result.ok) {
        showError(credErrorNode, result.error ?? '保存失败');
        return;
      }
      canonicalBox.value = result.canonical ?? '';
      credPreview.textContent =
        `已保存：${result.source} · ${result.fingerprint ?? result.token_hint ?? ''}` +
        (result.verified === false ? ' · 未经上游校验，下一轮请求会报告结果' : '') +
        (result.warnings?.length ? ` · ${result.warnings.join('；')}` : '');
      toast('DeepSeek 登录态已更新', 'ok');
      await refreshStatus();
    } catch (err) {
      showError(credErrorNode, (err as Error).message);
    } finally {
      button.disabled = false;
      button.textContent = '验证并保存';
    }
  }

  async function refreshHealth() {
    const kv = $('health-kv');
    kv.textContent = '';
    let health;
    try {
      health = await api.health();
    } catch (err) {
      const dt = document.createElement('dt');
      dt.textContent = '连接失败';
      const dd = document.createElement('dd');
      dd.textContent = (err as Error).message;
      kv.append(dt, dd);
      return;
    }
    // Liveness comes from the heartbeat table (deepseek_health), not from "did somebody
    // claim a job lately" — an idle relay is online, and that has to be visible here.
    const relays = Array.isArray(health.workers) ? health.workers : [];
    const relayText = relays.length
      ? `${health.workers_alive ?? relays.length} 个在线 · ${relays
          .map((w) => `${w.worker_id}（${w.turns} 轮，${w.age_seconds}s 前心跳）`)
          .join('、')}`
      : '没有通道在领取任务，消息会排队';
    const rows: Array<[string, string]> = [
      ['转发通道', relayText],
      ['正在领取', String(health.workers_claiming ?? 0)],
      ['队列中', String(health.queued ?? 0)],
      ['近 1 小时成功', String(health.done_last_hour ?? 0)],
      ['近 1 小时失败', String(health.error_last_hour ?? 0)],
      ['中位首字', health.median_ttft_ms ? `${health.median_ttft_ms}ms` : '—'],
      ['登录态', health.credential_configured ? `已配置（${health.credential_age_minutes ?? '?'} 分钟前）` : '未配置'],
      // admin_enabled is only reported by the Edge Function's own health action
      ['后台写操作', health.admin_enabled === true ? '已启用' : health.admin_enabled === false ? '未启用' : 'Edge Function 未部署'],
    ];
    kv.replaceChildren(
      ...rows.flatMap(([key, value]) => {
        const dt = document.createElement('dt');
        dt.textContent = key;
        const dd = document.createElement('dd');
        dd.textContent = value;
        return [dt, dd];
      }),
    );
  }

  on(form, 'submit', (event) => {
    event.preventDefault();
    showError(errorNode, '');
    const next: Config = {
      url: urlInput.value.trim().replace(/\/+$/, ''),
      anonKey: anonInput.value.trim(),
      functionName: fnInput.value.trim() || 'deepseek-chat',
      modelType: isModelType(modelSelect.value) ? modelSelect.value : 'default',
      // the queue is not a per-deployment knob in the form; #queue= covers staging relays
      queue: api.config.queue || 'default',
    };
    if (!isValidUrl(next.url)) {
      showError(errorNode, 'Supabase URL 需形如 https://<ref>.supabase.co');
      return;
    }
    if (next.anonKey.length < 20) {
      showError(errorNode, 'anon key 看起来太短了。');
      return;
    }
    saveConfig(next);
    api.setConfig(next);
    onChange(next);
    toast('已保存到本机', 'ok');
    void refreshHealth();
  });

  on($('cfg-clear'), 'click', () => {
    if (!window.confirm('清除本机保存的配置（含管理令牌）？')) return;
    clearConfig();
    location.reload();
  });

  on($('cred-save'), 'click', () => void saveCredential());
  on(credInput, 'input', preview);
  on(adminTokenInput, 'change', () => {
    saveAdminToken(adminTokenInput.value.trim());
    void refreshStatus();
  });
  on($('cred-status-refresh'), 'click', () => void refreshStatus());
  on($('cred-copy'), 'click', async () => {
    const value = canonicalBox.value.trim();
    if (!value) return void toast('还没有可复制的字符串', 'err');
    toast((await copyText(value)) ? '已复制可用字符串' : '复制失败', 'ok');
  });
  on($('health-refresh'), 'click', () => void refreshHealth());

  render();
  void refreshStatus();
  void refreshHealth();

  return { render, refreshHealth };
}

export function adminConfigured(cfg: Config): boolean {
  return isConfigured(cfg);
}
