import { ToolsApi } from './lib/api';
import { isAdminMode, isModelType, loadConfig, loadRuntimeConfigFile, loadToken, saveToken } from './lib/config';
import { $, on, showError, toast } from './lib/dom';
import { initIcons, setIcon } from './lib/icons';
import { appBase } from './lib/routes';
import { initAdmin } from './views/admin';
import { initChat } from './views/chat';

initIcons();
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-reveal]')) {
  on(button, 'click', () => {
    const input = $(button.dataset.reveal!) as HTMLInputElement;
    input.type = input.type === 'password' ? 'text' : 'password';
    button.setAttribute('aria-label', input.type === 'password' ? '显示密码' : '隐藏密码');
    button.setAttribute('aria-pressed', String(input.type === 'text'));
    setIcon(button, input.type === 'password' ? 'eye' : 'eyeSlash');
  });
}

const oldView = new URLSearchParams(location.hash.replace(/^#/, '')).get('view');
if (!/(?:chat|paste)\/?$/.test(location.pathname)) {
  const url = new URL(`${appBase()}${oldView === 'clipboard' ? 'paste/' : 'chat/'}`, location.origin);
  url.search = location.search;
  url.hash = location.hash;
  location.replace(url);
} else {
  await loadRuntimeConfigFile();
  const cfg = loadConfig(location.hash);
  const api = new ToolsApi(cfg);
  if (/paste\/?$/.test(location.pathname)) {
    document.title = 'Tools · Paste';
    $('view-clipboard').hidden = false;
    const { initPaste } = await import('./views/paste');
    const clipboard = initPaste(api);
    Object.defineProperty(window, 'tools', { value: { api, cfg, clipboard }, configurable: true });
  } else {
    document.title = 'Tools · Chat';
    $('view-chat').hidden = false;
    const chat = initChat(api);
    const adminMode = isAdminMode(location.search, location.hash);
    let admin;
    if (adminMode) {
      $('admin-settings').hidden = false;
      $('view-admin').hidden = false;
      admin = initAdmin(api, cfg, () => { void chat.refreshHealth(); });
    }
    const gate = $('chat-gate');
    const work = $('chat-work');
    const loginPassword = $('chat-password') as HTMLInputElement;
    const loginError = $('chat-login-error');
    const storedPasswordKey = 'tools.chat.password';
    const sendMode = $('send-mode') as HTMLSelectElement;
    const modelSelect = $('chat-model') as HTMLSelectElement;
    const thinkingBox = $('chat-thinking') as HTMLInputElement;
    const searchBox = $('chat-search') as HTMLInputElement;
    const composerKey = 'tools.chat.composer';
    modelSelect.value = cfg.modelType;
    try { sendMode.value = localStorage.getItem('tools.chat.send-mode') || 'enter'; } catch { /* default */ }
    on(sendMode, 'change', () => { try { localStorage.setItem('tools.chat.send-mode', sendMode.value); } catch { /* session preference only */ } });
    try {
      const saved = JSON.parse(localStorage.getItem(composerKey) || '{}') as Record<string, unknown>;
      if (isModelType(saved.model)) modelSelect.value = saved.model;
      if (typeof saved.thinking === 'boolean') thinkingBox.checked = saved.thinking;
      if (typeof saved.search === 'boolean') searchBox.checked = saved.search;
    } catch { /* use defaults */ }
    const rememberComposer = () => {
      try {
        localStorage.setItem(composerKey, JSON.stringify({
          model: modelSelect.value,
          thinking: thinkingBox.checked,
          search: searchBox.checked,
        }));
      } catch { /* session preferences still work until reload */ }
    };
    on(modelSelect, 'change', rememberComposer);
    on(thinkingBox, 'change', rememberComposer);
    on(searchBox, 'change', rememberComposer);
    function showWork() {
      gate.hidden = true;
      work.hidden = false;
      void chat.refreshHealth();
    }
    async function login(value: string, target: HTMLElement, automatic = false): Promise<boolean> {
      if (!value) return false;
      try {
        const result = await api.verify(value, 12 * 3600);
        if (!result.ok || !result.token) {
          if (!automatic) showError(target, result.error === 'rate_limited' ? '尝试过于频繁，请稍后重试。' : '登录码无效，请重试。');
          return false;
        }
        api.setToken(result.token);
        saveToken({ token: result.token, expiresAt: result.expires_at ?? '', label: result.label });
        try { localStorage.setItem(storedPasswordKey, value); }
        catch { toast('浏览器无法保存登录码，下次访问可能需要重新登录。'); }
        showError(target, '');
        showWork();
        return true;
      } catch (err) {
        if (!automatic) showError(target, (err as Error).message);
        return false;
      }
    }
    on($('chat-login'), 'submit', async (event) => {
      event.preventDefault();
      const submit = $('chat-login').querySelector<HTMLButtonElement>('button[type=submit]')!;
      if (submit.disabled) return;
      submit.disabled = true;
      try { if (await login(loginPassword.value, loginError)) loginPassword.value = ''; }
      finally { submit.disabled = false; }
    });
    document.addEventListener('paste', (event) => {
      if (gate.hidden || (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable=true]'))) return;
      const text = event.clipboardData?.getData('text/plain');
      if (!text) return;
      event.preventDefault();
      loginPassword.value = text.trim();
      ($('chat-login') as HTMLFormElement).requestSubmit();
    });
    const loginFile = $('login-file') as HTMLInputElement;
    on($('login-upload'), 'click', () => loginFile.click());
    on(loginFile, 'change', async () => {
      const file = loginFile.files?.[0];
      loginFile.value = '';
      if (!file) return;
      try {
        if (file.size > 64 * 1024) throw new Error('登录码文件不能超过 64 KB。');
        let value = (await file.text()).trim();
        if (value.startsWith('{')) {
          const data = JSON.parse(value) as { password?: unknown; code?: unknown };
          const code = data.password ?? data.code;
          if (typeof code !== 'string') throw new Error('JSON 文件需要包含 password 或 code 字符串。');
          value = code;
        }
        loginPassword.value = value;
        ($('chat-login') as HTMLFormElement).requestSubmit();
      } catch (err) { showError(loginError, (err as Error).message); }
    });
    function settings(open: boolean) {
      $('chat-settings-panel').hidden = !open;
      $('chat-conversation').hidden = open;
      window.scrollTo(0, 0);
      if (open) $('settings-close').focus(); else $('chat-input').focus();
    }
    on($('chat-settings'), 'click', () => settings($('chat-settings-panel').hidden));
    on($('settings-close'), 'click', () => settings(false));
    on($('change-login'), 'submit', async (event) => {
      event.preventDefault();
      const input = $('settings-password') as HTMLInputElement;
      const button = $('change-login').querySelector<HTMLButtonElement>('button[type=submit]')!;
      if (button.disabled) return;
      button.disabled = true;
      try { if (await login(input.value, $('settings-login-error'))) { input.value = ''; toast('登录码已切换', 'ok'); } }
      finally { button.disabled = false; }
    });
    const stored = loadToken();
    document.addEventListener('tools:auth-expired', async () => {
      api.setToken(null);
      saveToken(null);
      let saved: string | null = null;
      try { saved = localStorage.getItem(storedPasswordKey); } catch { /* show login */ }
      if (saved && await login(saved, loginError, true)) return;
      gate.hidden = false;
      work.hidden = true;
      showError(loginError, '登录已过期，请重新验证。');
    });
    if (stored) { api.setToken(stored.token); showWork(); }
    else {
      let saved: string | null = null;
      try { saved = localStorage.getItem(storedPasswordKey); } catch { /* show login */ }
      if (saved) await login(saved, loginError, true);
    }
    if (adminMode && oldView === 'admin' && api.token) settings(true);
    setInterval(() => { if (document.visibilityState === 'visible' && api.token) void chat.refreshHealth(); }, 15_000);
    Object.defineProperty(window, 'tools', { value: { api, cfg, chat, admin, adminMode }, configurable: true });
  }
}
