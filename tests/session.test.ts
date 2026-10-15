// The conversation the UI keeps: two ids that continue a DeepSeek session, plus the visible
// transcript. Session management (several sessions at once) is out of scope, so the contract
// is exactly: persist, continue, or start over.

import { beforeEach, describe, expect, it } from 'vitest';

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
};

const { SESSION_KEY } = await import('../src/lib/config');
const { carryForwardPrompt, clearSession, loadSession, newSession, saveSession, sessionIsLive, sessionLabel } = await import(
  '../src/lib/session'
);

beforeEach(() => store.clear());

describe('a fresh session', () => {
  it('carries no DeepSeek ids, so the first turn opens a new conversation', () => {
    const session = newSession();
    expect(session.dsSessionId).toBeNull();
    expect(session.parentId).toBeNull();
    expect(sessionIsLive(session)).toBe(false);
    expect(sessionLabel(session)).toBe('新会话 · 0 轮');
  });

  it('is what loadSession returns when nothing was stored', () => {
    expect(loadSession().dsSessionId).toBeNull();
  });

  it('survives corrupt storage', () => {
    store.set(SESSION_KEY, '{oops');
    expect(loadSession().turns).toEqual([]);
    store.set(SESSION_KEY, JSON.stringify({ turns: 'not an array' }));
    expect(loadSession().turns).toEqual([]);
  });
});

describe('continuing a conversation', () => {
  it('keeps the ids the next turn needs after a reload', () => {
    const session = newSession();
    session.dsSessionId = 'sess-7';
    session.parentId = '42';
    session.title = '天气问题';
    session.turns.push({ role: 'user', content: '上海天气', at: 1 });
    session.turns.push({ role: 'assistant', content: '晴', thinking: '查一下', at: 2 });
    saveSession(session);

    const again = loadSession();
    expect(again.localId).toBe(session.localId);
    expect(again.dsSessionId).toBe('sess-7');
    expect(again.parentId).toBe('42');
    expect(again.title).toBe('天气问题');
    expect(again.turns.map((t) => [t.role, t.content])).toEqual([
      ['user', '上海天气'],
      ['assistant', '晴'],
    ]);
    expect(sessionIsLive(again)).toBe(true);
    expect(sessionLabel(again)).toBe('天气问题 · 1 轮');
  });

  it('keeps tool metadata so a reload still shows the "已调用工具" chip', () => {
    const session = newSession();
    session.turns.push({
      role: 'assistant',
      content: '晴[citation:1]',
      tools: { used: true, kinds: ['网页搜索 · 3 个结果'], queries: ['q'], resultCount: 3, pages: [], mode: 'DEEP_SEARCH' },
      at: 1,
    });
    saveSession(session);
    expect(loadSession().turns[0]?.tools?.kinds).toEqual(['网页搜索 · 3 个结果']);
  });

  it('caps what it stores so a long chat cannot blow the quota', () => {
    const session = newSession();
    for (let i = 0; i < 60; i += 1) session.turns.push({ role: 'user', content: `m${i}`, at: i });
    saveSession(session);
    const stored = loadSession();
    expect(stored.turns).toHaveLength(40);
    expect(stored.turns.at(-1)?.content).toBe('m59');
    expect(stored.turns[0]?.content).toBe('m20');
  });

  it('trims very long reasoning', () => {
    const session = newSession();
    session.turns.push({ role: 'assistant', content: 'a', thinking: 'x'.repeat(9000), at: 1 });
    saveSession(session);
    expect(loadSession().turns[0]?.thinking).toHaveLength(4000);
  });
});

describe('carrying a stopped turn forward', () => {
  const stopped = {
    role: 'assistant' as const,
    content: '北京市\n天津市\n河北省',
    thinking: '用户要列省级行政区，我应该一个一行。',
    at: 1,
    stopped: true,
  };

  it('hands the reasoning over only after a stop', () => {
    const prompt = carryForwardPrompt(stopped, '继续');
    expect(prompt).toContain('用户要列省级行政区');
    expect(prompt.endsWith('继续')).toBe(true);
    // The partial answer itself stays upstream (the message is stored truncated), so the prompt
    // only notes where it stopped rather than repeating the whole thing.
    expect(prompt).toContain('已经输出到');
  });

  it('leaves the prompt alone for a normal turn, a missing turn, or no reasoning', () => {
    expect(carryForwardPrompt({ ...stopped, stopped: false }, '继续')).toBe('继续');
    expect(carryForwardPrompt({ ...stopped, thinking: '' }, '继续')).toBe('继续');
    expect(carryForwardPrompt({ ...stopped, role: 'user' }, '继续')).toBe('继续');
    expect(carryForwardPrompt(undefined, '继续')).toBe('继续');
  });

  it('caps a long reasoning so the next request stays proportionate', () => {
    const prompt = carryForwardPrompt({ ...stopped, thinking: '想'.repeat(4000) }, '继续');
    expect(prompt).toContain('已截断');
    expect(prompt.length).toBeLessThan(1800);
  });

  it('survives a reload or an import, which is where the flag lives', () => {
    const session = newSession();
    session.turns.push({ ...stopped });
    saveSession(session);
    expect(loadSession().turns[0]?.stopped).toBe(true);
    expect(carryForwardPrompt(loadSession().turns[0], '继续')).toContain('用户要列省级行政区');
  });
});

describe('starting over', () => {
  it('drops the ids and the transcript', () => {
    const session = newSession();
    session.dsSessionId = 'sess-7';
    session.turns.push({ role: 'user', content: 'hi', at: 1 });
    saveSession(session);

    clearSession();
    const fresh = loadSession();
    expect(fresh.dsSessionId).toBeNull();
    expect(fresh.turns).toEqual([]);
    expect(fresh.localId).not.toBe(session.localId);
  });
});
