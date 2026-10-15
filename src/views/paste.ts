import type { ToolsApi } from '../lib/api';
import { $, copyText, showError, toast } from '../lib/dom';
import { mountEditor } from '../lib/editor';
import { iconButton, setIcon, type IconName } from '../lib/icons';
import { imageToWebP, insertDialog, type InsertKind } from '../lib/insert-dialog';
import { renderMarkdown } from '../lib/markdown';
import { pasteError, pasteRequest, validPasteName, type PasteDocument, type PasteMode } from '../lib/paste';
import { routeUrl } from '../lib/routes';

export function initPaste(api: ToolsApi) {
  const root = $('paste-editor');
  const ground = $('paste-ground');
  const gate = $('paste-gate');
  const name = $('paste-name') as HTMLInputElement;
  const permission = $('paste-permission') as HTMLButtonElement;
  const password = $('paste-password') as HTMLInputElement;
  const preview = $('editor-preview');
  const divider = $('editor-divider');
  const editor = mountEditor($('editor'));
  const tools = $('format-tools');
  const error = $('paste-error');
  const modes: PasteMode[] = ['public', 'write_password', 'private'];
  const labels = { public: '任查任改', write_password: '任查密码改', private: '密查密改' };
  const permissionIcons: Record<PasteMode, IconName> = { public: 'globe', write_password: 'lockOpen', private: 'lock' };
  let document: PasteDocument | null = null;
  let token: string | null = null;
  let pendingMode: PasteMode | null = null;
  let displayMode = 'split';
  let dirty = false;
  let conflict = false;
  let applying = false;
  let mutating = false;
  let loading = false;
  let saving: Promise<boolean> | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let validationSequence = 0;
  let syncScroll = true;
  let draftRestored = false;
  let editingRequested = false;
  let lastAutomaticAttempt = '';

  function stored(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function store(key: string, value: string | null) {
    try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); }
    catch { toast('浏览器无法保存本机数据，请在离开前复制内容。', 'err'); }
  }
  const draftKey = () => `tools.paste.draft.${document?.id}`;
  function retainDraft() {
    if (document) store(draftKey(), JSON.stringify({ body: editor.get(), revision: document.revision }));
  }
  function args() {
    return { p_id: document?.id, p_token: token, p_revision: document?.revision };
  }
  function requireOk(result: PasteDocument): PasteDocument {
    if (!result.ok) throw new Error(pasteError(result.error));
    return result;
  }
  function setText(text: string) {
    applying = true;
    editor.set(text);
    renderMarkdown(preview, text);
    applying = false;
  }
  function restoreDraft() {
    if (draftRestored || !document?.can_write) return;
    draftRestored = true;
    const draft = stored(draftKey());
    if (!draft) return;
    try {
      const parsed = JSON.parse(draft) as { body?: unknown; revision?: number };
      if (typeof parsed.body === 'string' && parsed.body !== document.body && window.confirm('发现本机未保存的草稿，要恢复吗？')) {
        setText(parsed.body);
        dirty = true;
        conflict = parsed.revision !== document.revision;
        if (conflict) toast(pasteError('conflict'), 'err'); else void save();
      }
    } catch { /* leave unreadable drafts untouched */ }
  }
  function updateUrl() {
    if (!document) return;
    const url = new URL(routeUrl('paste/'), location.origin);
    url.searchParams.set('name', document.name);
    history.replaceState(null, '', url);
    window.document.title = `${document.name} · Tools`;
  }
  function renderAccess() {
    if (!document) return;
    password.disabled = false;
    password.required = true;
    gate.hidden = !pendingMode && document.can_read && (!editingRequested || document.can_write);
    ground.hidden = !gate.hidden;
    const mode = pendingMode ?? document.mode;
    name.value = document.name;
    name.readOnly = true;
    name.title = document.can_write ? '点击修改名称' : document.name;
    permission.disabled = (!document.can_write && !document.can_read) || mutating;
    permission.classList.toggle('is-readonly', !document.can_write);
    permission.title = `${labels[mode]}（${document.can_write ? '点击切换' : '输入密码以编辑'}）`;
    permission.setAttribute('aria-label', permission.title);
    setIcon(permission, permissionIcons[mode]);
    tools.querySelectorAll<HTMLButtonElement>('button').forEach((button) => { button.disabled = !document!.can_write || !!pendingMode || mutating; });
    ($('paste-copy') as HTMLButtonElement).disabled = !document.can_read;
    editor.setReadOnly(!document.can_write || !!pendingMode || mutating);
    root.dataset.mode = document.can_write ? displayMode : 'preview';
    $('paste-gate-title').textContent = pendingMode ? 'SET' : 'BLOCKED';
    $('paste-gate-caption').textContent = pendingMode ? '为剪贴板设置密码' : document.can_read ? '输入密码以编辑' : '输入密码以查看 / 编辑';
    $('paste-view-only').hidden = !!pendingMode || !document.can_read;
    $('paste-verify').setAttribute('aria-label', pendingMode ? '设置密码' : '验证密码');
    $('paste-saved-password').hidden = !pendingMode || !stored('tools.paste.password');
    if (pendingMode) password.value = stored('tools.paste.password') ?? '';
  }

  async function save(): Promise<boolean> {
    if (saving) return saving;
    if (!dirty) return true;
    if (conflict || !document?.can_write) return false;
    saving = (async () => {
      try {
        while (dirty && !conflict) {
          const text = editor.get();
          const result = await pasteRequest(api, 'save', { ...args(), p_body: text });
          if (result.error === 'conflict') conflict = true;
          document = requireOk(result);
          dirty = editor.get() !== text;
          if (!dirty) store(draftKey(), null);
          root.dataset.saveState = dirty ? 'pending' : 'saved';
          name.title = '已自动保存';
        }
        return true;
      } catch (err) {
        retainDraft();
        root.dataset.saveState = 'error';
        name.title = (err as Error).message;
        toast((err as Error).message, 'err');
        return false;
      } finally { saving = null; }
    })();
    return saving;
  }

  editor.onChange((text) => {
    if (applying || !document?.can_write) return;
    dirty = true;
    retainDraft();
    renderMarkdown(preview, text);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { if (!mutating) void save(); }, 650);
  });
  editor.saveShortcut(() => void save());
  editor.onSelection((line, column, selected, total) => {
    $('editor-position').textContent = `第 ${line} 行，第 ${column} 列`;
    $('editor-count').textContent = `${selected} 字 / 共 ${total} 字`;
  });

  function format(icon: IconName, label: string, value: string | [string, string], atLineStart = false) {
    tools.append(iconButton(icon, label, () => editor.insert(value, atLineStart)));
  }
  function separator() {
    const line = window.document.createElement('span');
    line.className = 'toolbar-divider';
    line.setAttribute('aria-hidden', 'true');
    tools.append(line);
  }
  format('bold', '粗体', ['**', '**']);
  format('strikethrough', '删除线', ['~~', '~~']);
  format('italic', '斜体', ['_', '_']);
  format('minus', '分割线', '\n\n---\n');
  separator();
  for (let level = 1; level <= 6; level++) {
    const button = iconButton('bold', `${level} 级标题`, () => editor.insert('#'.repeat(level) + ' ', true));
    button.textContent = `H${level}`;
    button.classList.add('toolbar-heading');
    tools.append(button);
  }
  separator();
  format('listUl', '无序列表', '- ', true);
  format('listOl', '有序列表', '1. ', true);
  separator();
  const insertButtons: [InsertKind, IconName, string][] = [
    ['image', 'image', '插入图片'], ['link', 'link', '插入链接'], ['code', 'code', '插入代码'],
    ['table', 'table', '插入表格'], ['collapse', 'chevronDown', '插入折叠框'],
  ];
  for (const [kind, icon, label] of insertButtons) tools.append(iconButton(icon, label, async () => {
    const text = await insertDialog(kind, uploadImage);
    if (text !== null && document?.can_write) editor.insert(text);
  }));
  separator();
  const viewButton = iconButton('columns', '同时编辑和预览', () => {
    displayMode = ['split', 'edit', 'preview'][(['split', 'edit', 'preview'].indexOf(displayMode) + 1) % 3]!;
    root.dataset.mode = displayMode;
    viewButton.title = { split: '同时编辑和预览', edit: '仅编辑', preview: '仅查看' }[displayMode]!;
    viewButton.setAttribute('aria-label', `${viewButton.title}（点击切换）`);
    setIcon(viewButton, displayMode === 'split' ? 'columns' : displayMode === 'edit' ? 'pen' : 'eye');
  });
  tools.append(viewButton);
  const syncButton = iconButton('lock', '停用滚动同步', () => {
    syncScroll = !syncScroll;
    setIcon(syncButton, syncScroll ? 'lock' : 'lockOpen');
    syncButton.title = syncScroll ? '停用滚动同步' : '启用滚动同步';
    syncButton.setAttribute('aria-label', syncButton.title);
    syncButton.setAttribute('aria-pressed', String(syncScroll));
  });
  syncButton.setAttribute('aria-pressed', 'true');
  tools.append(syncButton);

  async function uploadImage(file: File): Promise<string> {
    if (!document?.can_write) throw new Error('没有图片上传权限。');
    const blob = await imageToWebP(file);
    const imageId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const path = `${document.id}/${imageId}.webp`;
    const headers: Record<string, string> = {
      apikey: api.config.anonKey, Authorization: `Bearer ${api.config.anonKey}`,
      'Content-Type': 'image/webp', 'cache-control': 'max-age=31536000',
    };
    if (token) headers['x-clipboard-token'] = token;
    const response = await fetch(`${api.config.url}/storage/v1/object/tools-images/${path}`, { method: 'POST', headers, body: blob });
    if (!response.ok) throw new Error('图片上传失败，请确认编辑权限后重试。');
    return `${api.config.url}/storage/v1/object/public/tools-images/${path}`;
  }

  let resizing = false;
  function resize(clientX: number) {
    const rect = ground.getBoundingClientRect();
    const percent = Math.max(0, Math.min(100, (clientX - rect.left) / rect.width * 100));
    root.style.setProperty('--editor-width', `${percent}%`);
    divider.setAttribute('aria-valuenow', String(Math.round(percent)));
  }
  divider.addEventListener('pointerdown', (event) => {
    resizing = true;
    divider.setPointerCapture(event.pointerId);
    divider.classList.add('is-dragging');
    event.preventDefault();
    resize(event.clientX);
  });
  divider.addEventListener('pointermove', (event) => { if (resizing) resize(event.clientX); });
  const endResize = () => { resizing = false; divider.classList.remove('is-dragging'); };
  divider.addEventListener('pointerup', endResize);
  divider.addEventListener('pointercancel', endResize);
  divider.addEventListener('keydown', (event) => {
    const current = Number(divider.getAttribute('aria-valuenow'));
    const value = event.key === 'ArrowLeft' ? current - 5 : event.key === 'ArrowRight' ? current + 5 : event.key === 'Home' ? 0 : event.key === 'End' ? 100 : null;
    if (value === null) return;
    event.preventDefault();
    const percent = Math.max(0, Math.min(100, value));
    root.style.setProperty('--editor-width', `${percent}%`);
    divider.setAttribute('aria-valuenow', String(percent));
  });
  let syncing = false;
  for (const [source, target] of [[editor.scrollDOM, preview], [preview, editor.scrollDOM]]) {
    source!.addEventListener('scroll', () => {
      if (!syncScroll || syncing) return;
      syncing = true;
      const range = source!.scrollHeight - source!.clientHeight;
      target!.scrollTop = range > 0 ? source!.scrollTop / range * (target!.scrollHeight - target!.clientHeight) : 0;
      requestAnimationFrame(() => { syncing = false; });
    }, { passive: true });
  }

  name.addEventListener('click', () => {
    if (!document?.can_write) return;
    name.readOnly = false;
    name.select();
  });
  async function validateName(value = name.value): Promise<boolean> {
    const sequence = ++validationSequence;
    let valid = validPasteName(value);
    if (valid && document && value !== document.name) {
      try { valid = !(await api.rpc('paste_document', { p_action: 'exists', p_id: document.id, p_name: value }) as { exists?: boolean }).exists; }
      catch { valid = false; }
    }
    if (sequence === validationSequence) {
      name.classList.toggle('is-invalid', !valid);
      name.setAttribute('aria-invalid', String(!valid));
    }
    return valid && sequence === validationSequence;
  }
  name.addEventListener('input', () => { void validateName(); });
  name.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) name.blur();
    if (event.key === 'Escape' && document) { name.value = document.name; name.blur(); }
  });
  name.addEventListener('blur', async () => {
    if (!document || name.readOnly || mutating) return;
    const nextName = name.value;
    name.readOnly = true;
    if (nextName === document.name) return;
    mutating = true;
    renderAccess();
    try {
      if (!await validateName(nextName) || !await save()) return;
      document = requireOk(await pasteRequest(api, 'rename', { ...args(), p_name: nextName }));
      updateUrl();
    } catch (err) { toast((err as Error).message, 'err'); }
    finally {
      mutating = false;
      name.classList.remove('is-invalid'); name.setAttribute('aria-invalid', 'false'); renderAccess();
      if (dirty) void save();
    }
  });

  permission.addEventListener('click', async () => {
    if (document?.can_read && !document.can_write) {
      editingRequested = true;
      renderAccess();
      password.focus();
      return;
    }
    if (!document?.can_write || mutating) return;
    const next = modes[(modes.indexOf(pendingMode ?? document.mode) + 1) % modes.length]!;
    showError(error, '');
    if (!document.has_password && next !== 'public') {
      if (!await save()) return;
      pendingMode = next;
      renderAccess();
      password.focus();
      return;
    }
    pendingMode = null;
    mutating = true;
    renderAccess();
    try {
      if (!await save()) return;
      document = requireOk(await pasteRequest(api, 'mode', { ...args(), p_mode: next }));
      await restoreAccess();
    } catch (err) { toast((err as Error).message, 'err'); }
    finally { mutating = false; renderAccess(); if (dirty) void save(); }
  });

  async function unlock(value: string, automatic = false): Promise<boolean> {
    if (!document) return false;
    const result = await pasteRequest(api, pendingMode ? 'set_password' : 'unlock', {
      ...args(), p_password: value, p_mode: pendingMode,
    });
    if (!result.ok) {
      if (!automatic) showError(error, pasteError(result.error));
      return false;
    }
    const wasDirty = dirty;
    document = result;
    token = result.token ?? token;
    if (token) store(`tools.paste.token.${document.id}`, token);
    store('tools.paste.password', value);
    pendingMode = null;
    editingRequested = false;
    password.value = '';
    showError(error, '');
    if (!wasDirty) setText(document.body ?? '');
    restoreDraft();
    renderAccess();
    if (wasDirty) void save();
    return true;
  }
  async function restoreAccess() {
    if (!document || document.can_write) return;
    const savedPassword = stored('tools.paste.password');
    const attempt = `${document.id}:${document.revision}:${savedPassword}`;
    if (!savedPassword || attempt === lastAutomaticAttempt) return;
    lastAutomaticAttempt = attempt;
    await unlock(savedPassword, true);
  }
  $('paste-unlock').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!document) return void refresh();
    const button = $('paste-verify') as HTMLButtonElement;
    if (button.disabled) return;
    button.disabled = true;
    try { await unlock(password.value); }
    catch (err) { showError(error, (err as Error).message); }
    finally { button.disabled = false; }
  });
  $('paste-link').addEventListener('click', async () => toast(await copyText(location.href) ? '已复制剪贴板链接' : '复制失败，请复制地址栏链接'));
  $('paste-view-only').addEventListener('click', () => { editingRequested = false; renderAccess(); });
  $('paste-copy').addEventListener('click', async () => {
    if (document?.can_read) toast(await copyText(editor.get()) ? '已复制 Markdown 源码' : '复制失败，请选择内容复制');
  });

  async function refresh(): Promise<void> {
    if (loading || mutating || saving || window.document.activeElement === name) return;
    loading = true;
    try {
      const queryName = new URLSearchParams(location.search).get('name');
      const result = requireOk(await pasteRequest(api, document ? 'read' : queryName === null ? 'create' : 'read',
        document ? args() : { p_name: queryName }));
      if (document && dirty && result.revision !== document.revision) {
        conflict = true;
        retainDraft();
        toast(pasteError('conflict'), 'err');
        return;
      }
      if (dirty || pendingMode) return;
      const initial = !document;
      document = result;
      if (initial) {
        token = stored(`tools.paste.token.${document.id}`);
        if (token) document = requireOk(await pasteRequest(api, 'read', args()));
        updateUrl();
      }
      await restoreAccess();
      if (!dirty && (initial || editor.get() !== (document.body ?? ''))) setText(document.body ?? '');
      restoreDraft();
      renderAccess();
      showError(error, '');
    } catch (err) {
      if (!document) {
        ground.hidden = true;
        gate.hidden = false;
        $('paste-gate-caption').textContent = '暂时无法打开剪贴板';
        password.required = false;
        password.disabled = true;
        tools.querySelectorAll<HTMLButtonElement>('button').forEach((button) => { button.disabled = true; });
        permission.disabled = true;
        ($('paste-copy') as HTMLButtonElement).disabled = true;
      }
      showError(error, (err as Error).message);
      if (document) toast((err as Error).message, 'err');
    } finally { loading = false; }
  }
  window.addEventListener('beforeunload', (event) => {
    if (dirty) { retainDraft(); event.preventDefault(); }
  });
  window.document.addEventListener('visibilitychange', () => {
    if (window.document.visibilityState === 'visible') void refresh();
    else if (dirty) void save();
  });
  setInterval(() => { if (window.document.visibilityState === 'visible' && !dirty && !pendingMode) void refresh(); }, 5000);
  void refresh();
  return { refresh };
}
