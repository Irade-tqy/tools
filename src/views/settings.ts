// Settings view: runtime Supabase credentials, model/transport choice, and the snippet
// that starts the browser-side DeepSeek worker in a logged-in tab.

import type { ToolsApi } from '../lib/api';
import {
  clearConfig,
  isConfigured,
  isValidUrl,
  saveConfig,
  type Config,
  type Transport,
} from '../lib/config';
import { $, copyText, on, showError, toast } from '../lib/dom';

export interface SettingsView {
  render(): void;
}

export function initSettings(
  api: ToolsApi,
  cfg: Config,
  onChange: (next: Config) => void,
): SettingsView {
  const form = $('config-form') as HTMLFormElement;
  const urlInput = $('cfg-url') as HTMLInputElement;
  const anonInput = $('cfg-anon') as HTMLInputElement;
  const modelInput = $('cfg-model') as HTMLInputElement;
  const transportSelect = $('cfg-transport') as HTMLSelectElement;
  const errorNode = $('config-error');

  function render() {
    urlInput.value = cfg.url;
    anonInput.value = cfg.anonKey;
    modelInput.value = cfg.model;
    transportSelect.value = cfg.transport;
  }

  on(form, 'submit', (event) => {
    event.preventDefault();
    showError(errorNode, '');
    const next: Config = {
      url: urlInput.value.trim().replace(/\/+$/, ''),
      anonKey: anonInput.value.trim(),
      model: modelInput.value.trim() || 'deepseek-chat',
      transport: transportSelect.value as Transport,
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
  });

  on($('cfg-clear'), 'click', () => {
    if (!window.confirm('清除本机保存的 Supabase 配置与令牌？')) return;
    clearConfig();
    location.reload();
  });

  on($('copy-worker'), 'click', async () => {
    if (!isConfigured(cfg)) return void toast('先保存 Supabase 配置', 'err');
    const base = new URL('./deepseek-worker.js', location.href).href;
    const snippet =
      `(()=>{const d=document,s=d.createElement('script');` +
      `s.src=${JSON.stringify(base)};s.dataset.url=${JSON.stringify(cfg.url)};` +
      `s.dataset.anon=${JSON.stringify(cfg.anonKey)};d.head.append(s)})()`;
    toast((await copyText(snippet)) ? '已复制：粘贴到 DeepSeek 标签页的控制台即可' : '复制失败', 'ok');
  });

  const workerLink = $('worker-link') as HTMLAnchorElement;
  workerLink.href = new URL('./deepseek-worker.js', location.href).href;

  render();
  return { render };
}
