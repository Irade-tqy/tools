// App bootstrap: tab switching, runtime config gate, and periodic backend health checks.

import { ToolsApi } from './lib/api';
import { isConfigured, loadConfig, loadRuntimeConfigFile, type Config } from './lib/config';
import { on, setStatus, toast } from './lib/dom';import { initChat } from './views/chat';
import { initClipboard } from './views/clipboard';
import { initSettings } from './views/settings';

type ViewName = 'clipboard' | 'chat' | 'settings';

// Optional ./config.js (self-hosted deployments) is loaded before anything else so a
// preconfigured site never shows the setup form.
await loadRuntimeConfigFile();

let cfg: Config = loadConfig(location.hash);
const api = new ToolsApi(cfg);

const clipboard = initClipboard(api);
const chat = initChat(api, () => ({ model: cfg.model, transport: cfg.transport }));
const settings = initSettings(api, cfg, (next) => {
  cfg = next;
  void chat.refreshHealth();
  void clipboard.refresh();
});

function showView(name: ViewName): void {
  for (const tab of document.querySelectorAll<HTMLButtonElement>('.tab')) {
    const active = tab.dataset.view === name;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  for (const section of document.querySelectorAll<HTMLElement>('.view')) {
    section.classList.toggle('is-active', section.dataset.view === name);
  }
  if (name === 'chat' || name === 'settings') void chat.refreshHealth();
  if (name === 'clipboard') void clipboard.refresh();
}

for (const tab of document.querySelectorAll<HTMLButtonElement>('.tab')) {
  on(tab, 'click', () => showView((tab.dataset.view as ViewName) ?? 'clipboard'));
}

const requested = new URLSearchParams(location.hash.replace(/^#/, '')).get('view');
if (requested === 'chat' || requested === 'settings' || requested === 'clipboard') {
  showView(requested);
}

if (!isConfigured(cfg)) {
  showView('settings');
  setStatus('未配置', 'warn');
  toast('第一次使用：填写 Supabase URL 与 anon key（只存在本机浏览器里）');
} else {
  setStatus('已配置', 'idle');
  void chat.refreshHealth();
}

// Keep the health strip fresh while the tab is visible.
setInterval(() => {
  if (document.visibilityState === 'visible' && isConfigured(cfg)) void chat.refreshHealth();
}, 15_000);

// Expose a tiny handle for debugging in the console.
Object.defineProperty(window, 'tools', { value: { api, cfg, clipboard, chat, settings }, configurable: true });
