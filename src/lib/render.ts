// Pure DOM builders for the clipboard list and the chat log. No state, no fetch, no
// CodeMirror — so they can be unit tested under jsdom.

import type { EntryMeta } from './api';
import type { ToolSummary } from './chat-reducer';
import { humanSize, relDeadline, relTime } from './dom-helpers';

export interface EntryHandlers {
  onCopy: (entry: EntryMeta) => void;
  onDownload: (entry: EntryMeta) => void;
  onDelete: (entry: EntryMeta) => void;
}

export function entryNode(entry: EntryMeta, handlers: EntryHandlers): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'entry';
  li.dataset.id = entry.id;

  const head = document.createElement('div');
  head.className = 'entry__head';

  const title = document.createElement('span');
  title.className = 'entry__title';
  title.textContent = entry.title || (entry.kind === 'file' ? entry.file_name || '未命名文件' : '无标题');
  head.append(title);

  const badge = document.createElement('span');
  badge.className = entry.kind === 'file' ? 'badge badge--file' : 'badge';
  badge.textContent = entry.kind === 'file' ? '文件' : '文本';
  head.append(badge);

  const meta = document.createElement('span');
  meta.className = 'entry__meta';
  const size = typeof entry.file_size === 'number' ? `${humanSize(entry.file_size)} · ` : '';
  meta.textContent = `${size}${relTime(entry.created_at)} · ${relDeadline(entry.expires_at)}到期`;
  head.append(meta);
  li.append(head);

  if (entry.kind === 'text' && typeof entry.body === 'string') {
    const body = document.createElement('pre');
    body.className = 'entry__body';
    body.textContent = entry.body.length > 4000 ? `${entry.body.slice(0, 4000)}…` : entry.body;
    li.append(body);
  }

  const actions = document.createElement('div');
  actions.className = 'entry__actions';

  const copy = document.createElement('button');
  copy.className = 'btn btn--ghost btn--sm';
  copy.type = 'button';
  copy.dataset.action = 'copy';
  copy.textContent = '复制';
  copy.addEventListener('click', () => handlers.onCopy(entry));
  actions.append(copy);

  if (entry.kind === 'file') {
    const download = document.createElement('button');
    download.className = 'btn btn--ghost btn--sm';
    download.type = 'button';
    download.dataset.action = 'download';
    download.textContent = '下载';
    download.addEventListener('click', () => handlers.onDownload(entry));
    actions.append(download);
  }

  const del = document.createElement('button');
  del.className = 'btn btn--ghost btn--sm btn--danger';
  del.type = 'button';
  del.dataset.action = 'delete';
  del.textContent = '删除';
  del.addEventListener('click', () => handlers.onDelete(entry));
  actions.append(del);

  li.append(actions);
  return li;
}

export function renderEntries(list: HTMLElement, entries: EntryMeta[], handlers: EntryHandlers): void {
  list.replaceChildren(...entries.map((entry) => entryNode(entry, handlers)));
}

export function messageNode(
  role: 'user' | 'assistant' | 'system',
  text: string,
  meta = '',
): HTMLDivElement {
  const node = document.createElement('div');
  node.className = `msg msg--${role}`;
  const body = document.createElement('div');
  body.textContent = text;
  node.append(body);
  if (meta) {
    const metaNode = document.createElement('div');
    metaNode.className = 'msg__meta';
    metaNode.textContent = meta;
    node.append(metaNode);
  }
  return node;
}

// ---------------------------------------------------------------------------
// assistant messages
// ---------------------------------------------------------------------------

export interface AssistantModel {
  text: string;
  thinking: string;
  tools: ToolSummary | null;
  meta: string;
  error: string | null;
}

/**
 * An assistant turn: reasoning (collapsed), the answer, a "调用了工具" chip when DeepSeek
 * searched or opened pages, and the latency line. Citations are intentionally not rendered —
 * the `[citation:N]` markers stay in the text, the chip says enough.
 */
export function assistantNode(model: AssistantModel): HTMLDivElement {
  const node = document.createElement('div');
  node.className = 'msg msg--assistant';
  node.append(document.createElement('details'), document.createElement('div'), document.createElement('div'));
  applyAssistantModel(node, model);
  return node;
}

export function applyAssistantModel(node: HTMLElement, model: AssistantModel): void {
  // assistantNode() always creates exactly these three children.
  const thinkingNode = node.children[0] as HTMLElement | undefined;
  const body = node.children[1] as HTMLElement | undefined;
  const footer = node.children[2] as HTMLElement | undefined;
  if (!thinkingNode || !body || !footer) return;

  // reasoning
  thinkingNode.className = 'msg__thinking';
  thinkingNode.textContent = '';
  if (model.thinking) {
    const summary = document.createElement('summary');
    summary.textContent = `思考过程（${model.thinking.length} 字）`;
    const pre = document.createElement('pre');
    pre.textContent = model.thinking;
    thinkingNode.append(summary, pre);
    thinkingNode.hidden = false;
  } else {
    thinkingNode.hidden = true;
  }

  // answer
  body.className = 'msg__body';
  body.textContent = model.text || (model.error ? '' : '…');

  // tool chip + latency / error line
  footer.textContent = '';
  footer.className = 'msg__footer';
  if (model.tools?.used) {
    const chip = document.createElement('span');
    chip.className = 'chip chip--tool';
    chip.textContent = `已调用工具：${model.tools.kinds.join('、') || '搜索'}`;
    if (model.tools.queries.length) chip.title = `搜索词：${model.tools.queries.join(' / ')}`;
    footer.append(chip);
    if (model.tools.mode && model.tools.mode !== 'DEFAULT') {
      const mode = document.createElement('span');
      mode.className = 'chip';
      mode.textContent = model.tools.mode === 'DEEP_SEARCH' ? '深度搜索模式' : model.tools.mode;
      footer.append(mode);
    }
  }
  if (model.meta) {
    const meta = document.createElement('span');
    meta.className = 'msg__meta';
    meta.textContent = model.meta;
    footer.append(meta);
  }
  if (model.error) {
    const err = document.createElement('span');
    err.className = 'msg__error';
    err.textContent = `错误：${model.error}`;
    footer.append(err);
  }
  footer.hidden = !footer.children.length;
}
