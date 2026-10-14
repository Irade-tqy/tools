// The backend page — hidden unless the URL says `?admin=1`.
//
// Its one real job is keeping the DeepSeek login alive: paste one string (localStorage.userToken,
// DevTools "Copy as cURL", a Cookie header, JSON, or a saved dscred1: string), and the Edge
// Function parses it, checks it against the live API and stores it. The parse preview runs the
// same parser the server uses, so a mistake is caught before it is sent.
//
// Everything else here (Supabase overrides, queue counters) is diagnostics for self-hosting.

import type { CredentialStatus, ToolsApi } from '../lib/api';
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
import { fingerprint, parseCredential } from '../../supabase/functions/_shared/credential.ts';

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
    const token = adminTokenInput.value.trim();
    if (!token) {
      credStatus.textContent = '未填管理令牌：只显示公开状态。';
      const health = await api.health().catch(() => null);
      if (health?.ok) {
        credStatus.textContent =
          health.credential_configured === false
            ? '服务端还没有 DeepSeek 登录态。'
            : `服务端已配置（${health.credential_age_minutes ?? '?'} 分钟前更新）${health.credential_error ? ` · ${health.credential_error}` : ''}`;
      }
      return;
    }
    const status: CredentialStatus = await api
      .credentialStatus(token)
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
      const result = await api.credentialSet(raw, token, verifyBox.checked);
      if (!result.ok) {
        showError(credErrorNode, result.error ?? '保存失败');
        return;
      }
      canonicalBox.value = result.canonical ?? '';
      credPreview.textContent =
        `已保存：${result.source} · ${result.fingerprint}` +
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
    const rows: Array<[string, string]> = [
      ['转发通道', health.transport ?? '—'],
      ['队列中', String(health.queued ?? 0)],
      ['近 1 小时成功', String(health.done_last_hour ?? 0)],
      ['近 1 小时失败', String(health.error_last_hour ?? 0)],
      ['中位首字', health.median_ttft_ms ? `${health.median_ttft_ms}ms` : '—'],
      ['登录态', health.credential_configured ? `已配置（${health.credential_age_minutes ?? '?'} 分钟前）` : '未配置'],
      ['管理令牌', health.admin_enabled ? '已启用' : '未启用'],
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
