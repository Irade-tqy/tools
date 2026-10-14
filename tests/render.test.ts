// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../src/lib/api';
import type { ToolSummary } from '../src/lib/chat-reducer';
import { applyAssistantModel, assistantNode, entryNode, messageNode, renderEntries } from '../src/lib/render';

const now = Date.now();
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

function entry(overrides: Partial<EntryMeta> = {}): EntryMeta {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    kind: 'text',
    title: 'greeting',
    body: 'hello shared world',
    created_at: iso(-60_000),
    expires_at: iso(6 * 86_400_000),
    ...overrides,
  };
}

const handlers = { onCopy: vi.fn(), onDownload: vi.fn(), onDelete: vi.fn() };

describe('entryNode', () => {
  it('renders a text entry with a preview and no download action', () => {
    const node = entryNode(entry(), handlers);
    expect(node.querySelector('.entry__title')?.textContent).toBe('greeting');
    expect(node.querySelector('.entry__body')?.textContent).toBe('hello shared world');
    expect(node.querySelector('.badge')?.textContent).toBe('文本');
    expect(node.querySelector('[data-action=copy]')).toBeTruthy();
    expect(node.querySelector('[data-action=download]')).toBeNull();
    expect(node.querySelector('[data-action=delete]')).toBeTruthy();
  });

  it('renders a file entry with its name, size and download action', () => {
    const node = entryNode(
      entry({ kind: 'file', title: '', file_name: 'report.pdf', file_size: 2048, body: null }),
      handlers,
    );
    expect(node.querySelector('.entry__title')?.textContent).toBe('report.pdf');
    expect(node.querySelector('.badge--file')?.textContent).toBe('文件');
    expect(node.querySelector('.entry__meta')?.textContent).toContain('2.0 KB');
    expect(node.querySelector('[data-action=download]')).toBeTruthy();
    expect(node.querySelector('.entry__body')).toBeNull();
  });

  it('falls back to a placeholder title', () => {
    const node = entryNode(entry({ title: '', body: 'x' }), handlers);
    expect(node.querySelector('.entry__title')?.textContent).toBe('无标题');
  });

  it('truncates very long bodies', () => {
    const node = entryNode(entry({ body: 'a'.repeat(5000) }), handlers);
    const body = node.querySelector('.entry__body')?.textContent ?? '';
    expect(body.length).toBeLessThanOrEqual(4001);
    expect(body.endsWith('…')).toBe(true);
  });

  it('shows expiry as a deadline, not an elapsed time', () => {
    const node = entryNode(entry({ expires_at: iso(2 * 86_400_000) }), handlers);
    expect(node.querySelector('.entry__meta')?.textContent).toContain('2 天后到期');
  });

  it('wires the actions to the handlers with the right entry', () => {
    const item = entry();
    const node = entryNode(item, handlers);
    (node.querySelector('[data-action=copy]') as HTMLButtonElement).click();
    (node.querySelector('[data-action=delete]') as HTMLButtonElement).click();
    expect(handlers.onCopy).toHaveBeenCalledWith(item);
    expect(handlers.onDelete).toHaveBeenCalledWith(item);
  });
});

describe('renderEntries', () => {
  it('replaces the list contents in order', () => {
    const list = document.createElement('ul');
    list.append(document.createElement('li'));
    renderEntries(list, [entry({ id: 'a'.repeat(36) }), entry({ id: 'b'.repeat(36) })], handlers);
    const ids = Array.from(list.children).map((child) => (child as HTMLElement).dataset.id);
    expect(ids).toEqual(['a'.repeat(36), 'b'.repeat(36)]);
  });

  it('renders an empty list without leftovers', () => {
    const list = document.createElement('ul');
    list.append(document.createElement('li'));
    renderEntries(list, [], handlers);
    expect(list.children).toHaveLength(0);
  });
});

describe('messageNode', () => {
  it('marks the role and keeps text verbatim', () => {
    const node = messageNode('assistant', '多行\n文本');
    expect(node.className).toBe('msg msg--assistant');
    expect(node.firstChild?.textContent).toBe('多行\n文本');
  });

  it('adds a meta line only when given one', () => {
    expect(messageNode('user', 'hi').querySelector('.msg__meta')).toBeNull();
    expect(messageNode('system', 'hi', '首字 800ms').querySelector('.msg__meta')?.textContent).toBe(
      '首字 800ms',
    );
  });
});

// --- assistant turns -------------------------------------------------------

const emptyTools: ToolSummary = { used: false, kinds: [], queries: [], resultCount: 0, pages: [], mode: '' };
const searchTools: ToolSummary = {
  used: true,
  kinds: ['网页搜索 · 6 个结果'],
  queries: ['上海天气'],
  resultCount: 6,
  pages: [],
  mode: 'DEEP_SEARCH',
};

describe('assistantNode', () => {
  it('renders the answer and hides the empty thinking block', () => {
    const node = assistantNode({ text: '今天晴', thinking: '', tools: null, meta: '', error: null });
    expect(node.querySelector('.msg__body')?.textContent).toBe('今天晴');
    expect(node.querySelector('.msg__thinking')?.hasAttribute('hidden')).toBe(true);
    expect(node.querySelector('.chip')).toBeNull();
  });

  it('shows no chip for an empty tool summary', () => {
    const node = assistantNode({ text: 'a', thinking: '', tools: emptyTools, meta: '', error: null });
    expect(node.querySelector('.chip')).toBeNull();
  });

  it('shows a "已调用工具" chip instead of trying to render citations', () => {
    const node = assistantNode({ text: '今天晴[citation:2]', thinking: '', tools: searchTools, meta: '', error: null });
    const chip = node.querySelector('.chip--tool');
    expect(chip?.textContent).toBe('已调用工具：网页搜索 · 6 个结果');
    expect(chip?.getAttribute('title')).toContain('上海天气');
    expect(node.querySelector('.msg__body')?.textContent).toContain('[citation:2]');
  });

  it('collapses reasoning into a details block', () => {
    const node = assistantNode({ text: 'a', thinking: '先算 9.11', tools: null, meta: '', error: null });
    const details = node.querySelector('.msg__thinking');
    expect(details?.hasAttribute('hidden')).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toContain('思考过程');
    expect(details?.querySelector('pre')?.textContent).toBe('先算 9.11');
  });

  it('renders the latency line and an error line side by side', () => {
    const node = assistantNode({ text: 'a', thinking: '', tools: null, meta: '首字 700ms', error: '超时' });
    expect(node.querySelector('.msg__meta')?.textContent).toBe('首字 700ms');
    expect(node.querySelector('.msg__error')?.textContent).toContain('超时');
  });

  it('updates in place while streaming without duplicating nodes', () => {
    const node = assistantNode({ text: '', thinking: '', tools: null, meta: '', error: null });
    applyAssistantModel(node, { text: '你', thinking: '', tools: null, meta: '', error: null });
    applyAssistantModel(node, { text: '你好', thinking: '想想', tools: searchTools, meta: '首字 1s', error: null });
    expect(node.querySelectorAll('.msg__body')).toHaveLength(1);
    expect(node.querySelector('.msg__body')?.textContent).toBe('你好');
    expect(node.querySelectorAll('.chip--tool')).toHaveLength(1);
    expect(node.querySelectorAll('.msg__thinking pre')).toHaveLength(1);
  });

  it('hides the footer when there is nothing to say', () => {
    const node = assistantNode({ text: 'a', thinking: '', tools: null, meta: '', error: null });
    expect(node.querySelector('.msg__footer')?.hasAttribute('hidden')).toBe(true);
  });

  it('keeps the plain messageNode shape for user turns', () => {
    const node = messageNode('user', 'hi');
    expect(node.className).toBe('msg msg--user');
    expect(node.textContent).toBe('hi');
  });
});
