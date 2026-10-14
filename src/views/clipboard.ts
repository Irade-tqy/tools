// Clipboard view: unlock gate, CodeMirror editor, shared entry list, encrypted uploads.

import type { EntryMeta, ToolsApi } from '../lib/api';
import { loadToken, saveToken } from '../lib/config';
import { open, seal } from '../lib/crypto';
import { humanSize } from '../lib/dom-helpers';
import { $, copyText, on, showError, setStatus, toast } from '../lib/dom';
import type { ClipboardEditor } from '../lib/editor';
import { renderEntries } from '../lib/render';

export interface ClipboardView {
  refresh(): Promise<void>;
  isUnlocked(): boolean;
  /** Ask for the password again (needed to decrypt files after a token-only restore). */
  requirePassword(reason: string): void;
}

interface Limits {
  maxFileBytes: number;
  textMaxBytes: number;
  retentionDays: number;
}

const DEFAULT_LIMITS: Limits = { maxFileBytes: 6 * 1024 * 1024, textMaxBytes: 256 * 1024, retentionDays: 7 };

function describeFailure(body: Record<string, unknown> | null, err?: unknown): string {
  const error = (body?.error as string) || '';
  if (error === 'invalid_password') return '密码不在允许列表内。';
  if (error === 'rate_limited') {
    const wait = Math.ceil(Number(body?.retry_after_seconds ?? 900) / 60);
    return `尝试次数过多，请约 ${wait} 分钟后再试。`;
  }
  if (error === 'unauthorized') return '令牌已过期，请重新验证。';
  if (error === 'text_too_large') return `文本超过 ${humanSize(Number(body?.max_bytes ?? 0))} 上限。`;
  if (error === 'file_too_large') return `文件超过 ${humanSize(Number(body?.max_bytes ?? 0))} 上限。`;
  if (error === 'empty_text') return '内容为空。';
  if (error === 'not_found') return '这条内容已经不在了（可能刚被他人删除或到期）。';
  if (err instanceof Error && err.message) return err.message;
  return error || '请求失败。';
}

export function initClipboard(api: ToolsApi): ClipboardView {
  const gate = $('clipboard-gate');
  const work = $('clipboard-work');
  const form = $('unlock-form') as HTMLFormElement;
  const passwordInput = $('password-input') as HTMLInputElement;
  const rememberBox = $('remember-token') as HTMLInputElement;
  const unlockError = $('unlock-error');
  const titleInput = $('entry-title') as HTMLInputElement;
  const editorHost = $('editor');
  const editorHint = $('editor-hint');
  const saveButton = $('save-text') as HTMLButtonElement;
  const fileInput = $('file-input') as HTMLInputElement;
  const listEl = $('entry-list');
  const listMeta = $('list-meta');

  let password: string | null = null;
  let editor: ClipboardEditor | null = null;
  let limits: Limits = DEFAULT_LIMITS;
  let busy = false;

  async function showWork(): Promise<void> {
    gate.hidden = true;
    work.hidden = false;
    if (!editor) {
      // CodeMirror is the heaviest dependency; only pay for it once the editor is visible.
      const { mountEditor } = await import('../lib/editor');
      editor = mountEditor(editorHost);
      const current = editor;
      current.saveShortcut(() => void saveText());
      const update = (text: string) => {
        const bytes = new TextEncoder().encode(text).length;
        editorHint.textContent = `${text.length} 字 · ${humanSize(bytes)} / ${humanSize(limits.textMaxBytes)}`;
      };
      current.onChange(update);
      update('');
      current.focus();
    }
  }

  function showGate(message = '') {
    work.hidden = true;
    gate.hidden = false;
    showError(unlockError, message);
    passwordInput.focus();
  }

  async function refresh(): Promise<void> {
    if (!api.token) return;
    busy = true;
    saveButton.disabled = true;
    try {
      const [listRes, statusRes] = await Promise.all([api.list(50), api.status()]);
      if (!listRes.ok) {
        if (listRes.error === 'unauthorized') {
          api.setToken(null);
          saveToken(null);
          showGate('令牌已过期，请重新验证。');
        } else {
          toast(describeFailure(listRes), 'err');
        }
        return;
      }
      if (statusRes.ok) {
        limits = {
          maxFileBytes: Number(statusRes.max_file_bytes ?? limits.maxFileBytes),
          textMaxBytes: 256 * 1024,
          retentionDays: Number(statusRes.retention_days ?? limits.retentionDays),
        };
        listMeta.textContent = `${listRes.entries?.length ?? 0} 条 · 共 ${humanSize(Number(statusRes.bytes ?? 0))} · 保留 ${limits.retentionDays} 天`;
      }
      renderEntries(listEl, listRes.entries ?? [], {
        onCopy: (entry) => void handleCopy(entry),
        onDownload: (entry) => void handleDownload(entry),
        onDelete: (entry) => void handleDelete(entry),
      });
      setStatus(`已连接 · ${listRes.entries?.length ?? 0} 条共享内容`, 'ok');
    } catch (err) {
      toast(describeFailure(null, err), 'err');
    } finally {
      busy = false;
      saveButton.disabled = false;
    }
  }

  async function handleCopy(entry: EntryMeta): Promise<void> {
    if (entry.kind === 'file') return void (await handleDownload(entry));
    const text = entry.body ?? '';
    toast((await copyText(text)) ? '已复制到系统剪贴板' : '复制失败，请手动选择文本', 'ok');
  }

  async function handleDownload(entry: EntryMeta): Promise<void> {
    if (!password) {
      requirePassword('解密文件需要原始密码（令牌本身不含密钥）。请输入密码。');
      return;
    }
    try {
      const res = await api.get(entry.id);
      const item = res.entry;
      if (!res.ok || !item?.data || !item.iv || !item.kdf_salt) {
        toast(describeFailure(res), 'err');
        return;
      }
      const plain = await open(password, {
        data: item.data,
        iv: item.iv,
        salt: item.kdf_salt,
        alg: 'AES-GCM/PBKDF2-SHA256/150000',
      });
      const blob = new Blob([plain], { type: item.file_type || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = item.file_name || 'clipboard.bin';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast(`已解密 ${item.file_name ?? '文件'}`, 'ok');
    } catch (err) {
      toast(describeFailure(null, err), 'err');
    }
  }

  async function handleDelete(entry: EntryMeta): Promise<void> {
    if (!window.confirm('删除这条共享内容？所有用户都会看不到它。')) return;
    try {
      const res = await api.remove(entry.id);
      if (!res.ok) toast(describeFailure(res), 'err');
      else toast('已删除', 'ok');
    } catch (err) {
      toast(describeFailure(null, err), 'err');
    }
    await refresh();
  }

  async function saveText(): Promise<void> {
    if (busy || !editor) return;
    const body = editor.get().trim();
    if (!body) return void toast('先写点内容', 'err');
    saveButton.disabled = true;
    try {
      const res = await api.putText(body, titleInput.value.trim());
      if (!res.ok) {
        toast(describeFailure(res), 'err');
        return;
      }
      titleInput.value = '';
      editor.set('');
      toast('已保存到共享剪贴板', 'ok');
      await refresh();
    } catch (err) {
      toast(describeFailure(null, err), 'err');
    } finally {
      saveButton.disabled = false;
    }
  }

  async function uploadFiles(files: FileList | null): Promise<void> {
    if (!files?.length) return;
    if (!password) {
      requirePassword('加密上传需要原始密码。请输入密码。');
      return;
    }
    for (const file of Array.from(files)) {
      if (file.size > limits.maxFileBytes) {
        toast(`${file.name} ${humanSize(file.size)} 超过上限 ${humanSize(limits.maxFileBytes)}，已跳过`, 'err');
        continue;
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const sealed = await seal(password, bytes);
        const res = await api.putFile({
          fileName: file.name,
          fileType: file.type || 'application/octet-stream',
          data: sealed.data,
          iv: sealed.iv,
          salt: sealed.salt,
          title: file.name,
        });
        if (!res.ok) toast(`${file.name}: ${describeFailure(res)}`, 'err');
        else toast(`已加密上传 ${file.name}（${humanSize(file.size)}）`, 'ok');
      } catch (err) {
        toast(`${file.name}: ${describeFailure(null, err)}`, 'err');
      }
    }
    fileInput.value = '';
    await refresh();
  }

  function requirePassword(reason: string): void {
    password = null;
    gate.hidden = false;
    showError(unlockError, reason);
    passwordInput.focus();
  }

  on(form, 'submit', async (event) => {
    event.preventDefault();
    showError(unlockError, '');
    const value = passwordInput.value;
    if (!value) return;
    const button = form.querySelector('button[type=submit]') as HTMLButtonElement | null;
    if (button) button.disabled = true;
    try {
      const res = await api.verify(value, 12 * 3600);
      if (!res.ok || !res.token) {
        showError(unlockError, describeFailure(res));
        return;
      }
      password = value;
      passwordInput.value = '';
      api.setToken(res.token);
      if (rememberBox.checked) {
        saveToken({ token: res.token, expiresAt: res.expires_at ?? '', label: res.label });
      } else {
        saveToken(null);
      }
      setStatus(`已验证（${res.label ?? '共享'}）`, 'ok');
      await showWork();
      await refresh();
    } catch (err) {
      showError(unlockError, describeFailure(null, err));
    } finally {
      if (button) button.disabled = false;
    }
  });

  on(saveButton, 'click', () => void saveText());
  on($('upload-file'), 'click', () => fileInput.click());
  on(fileInput, 'change', () => void uploadFiles(fileInput.files));
  on($('refresh-list'), 'click', () => void refresh());
  on($('copy-all'), 'click', async () => {
    const res = await api.list(1);
    const latest = res.entries?.[0];
    if (!latest) return void toast('剪贴板是空的', 'err');
    await handleCopy(latest);
  });
  on($('clear-all'), 'click', async () => {
    if (!window.confirm('清空整个共享剪贴板？此操作对所有人生效。')) return;
    try {
      const res = await api.clear();
      if (!res.ok) toast(describeFailure(res), 'err');
      else toast(`已清空 ${res.deleted ?? 0} 条`, 'ok');
    } catch (err) {
      toast(describeFailure(null, err), 'err');
    }
    await refresh();
  });

  // Restore a still-valid token, if the user asked us to remember it.
  const stored = loadToken();
  if (stored?.token) {
    api.setToken(stored.token);
    void showWork().then(() => refresh());
  }

  return {
    refresh,
    isUnlocked: () => Boolean(api.token) && !work.hidden,
    requirePassword,
  };
}
