// App bootstrap: tab switching, the admin gate, runtime config, and a periodic health check.
//
// The public site is two tabs — 云剪贴板 and DeepSeek. The backend page (Supabase overrides,
// queue counters, the DeepSeek credential box) only exists when the URL asks for it with
// `?admin=1`, so a visitor never sees server plumbing.

import { ToolsApi } from './lib/api';
import { isAdminMode, isConfigured, loadConfig, loadRuntimeConfigFile, type Config } from './lib/config';
import { on, setStatus, toast } from './lib/dom';
import { initAdmin } from './views/admin';
import { initChat } from './views/chat';
import { initClipboard } from './views/clipboard';

type ViewName = 'clipboard' | 'chat' | 'admin';

// Optional ./config.js (self-hosted deployments) is loaded before anything else so a
// preconfigured site never shows the setup form.
await loadRuntimeConfigFile();

const adminMode = isAdminMode(location.search, location.hash);
let cfg: Config = loadConfig(location.hash);
const api = new ToolsApi(cfg);

const clipboard = initClipboard(api);
const chat = initChat(api);
const admin = initAdmin(api, cfg, (next) => {
  cfg = next;
  void chat.refreshHealth();
  void clipboard.refresh();
});

function showView(name: ViewName): void {
  if (name === 'admin' && !adminMode) name = 'clipboard';
  for (const tab of document.querySelectorAll<HTMLButtonElement>('.tab')) {
    const active = tab.dataset.view === name;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  for (const section of document.querySelectorAll<HTMLElement>('.view')) {
    const active = section.dataset.view === name && (adminMode || section.dataset.view !== 'admin');
    section.classList.toggle('is-active', active);
    section.hidden = !active;
  }
  if (name === 'chat' || name === 'admin') void chat.refreshHealth();
  if (name === 'clipboard') void clipboard.refresh();
}

if (adminMode) {
  const tab = document.querySelector<HTMLButtonElement>('.tab[data-view="admin"]');
  if (tab) tab.hidden = false;
}

for (const tab of document.querySelectorAll<HTMLButtonElement>('.tab')) {
  on(tab, 'click', () => showView((tab.dataset.view as ViewName) ?? 'clipboard'));
}

const requested = new URLSearchParams(location.hash.replace(/^#/, '')).get('view');
if (requested === 'chat' || requested === 'admin' || requested === 'clipboard') {
  showView(requested);
}

if (!isConfigured(cfg)) {
  showView(adminMode ? 'admin' : 'clipboard');
  setStatus('未配置', 'warn');
  toast('第一次使用：在后台页（?admin=1）填写 Supabase URL 与 anon key（只存本机浏览器）');
} else {
  setStatus('已连接', 'idle');
  void chat.refreshHealth();
}

// Keep the health strip fresh while the tab is visible.
setInterval(() => {
  if (document.visibilityState === 'visible' && isConfigured(cfg)) void chat.refreshHealth();
}, 15_000);

// Expose a small handle for debugging in the console.
Object.defineProperty(window, 'tools', { value: { api, cfg, chat, clipboard, admin, adminMode }, configurable: true });
