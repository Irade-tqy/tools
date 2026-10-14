import { beforeEach, describe, expect, it } from 'vitest';

// config.ts touches browser globals at call time, so stub them before importing.
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
};
(globalThis as unknown as { window: Record<string, unknown> }).window = {};

const config = await import('../src/lib/config');

const {
  CONFIG_KEY,
  TOKEN_KEY,
  clearConfig,
  isConfigured,
  isValidUrl,
  loadConfig,
  loadToken,
  normalizeUrl,
  parseHashConfig,
  projectRef,
  saveConfig,
  saveToken,
} = config;
const { DEFAULT_SUPABASE_ANON_KEY, DEFAULT_SUPABASE_URL } = await import('../src/lib/defaults');

const win = globalThis as unknown as { window: { TOOLS_CONFIG?: Record<string, string> } };

beforeEach(() => {
  store.clear();
  win.window.TOOLS_CONFIG = undefined;
});

describe('parseHashConfig', () => {
  it('reads url, anon key, model and transport', () => {
    expect(
      parseHashConfig('#supabase=https://x.supabase.co/&anon=abc123&model=r1&transport=browser'),
    ).toEqual({ url: 'https://x.supabase.co', anonKey: 'abc123', model: 'r1', transport: 'browser' });
  });

  it('accepts the url/key aliases and a leading hash or none', () => {
    expect(parseHashConfig('url=https://y.supabase.co&key=zz')).toEqual({
      url: 'https://y.supabase.co',
      anonKey: 'zz',
    });
  });

  it('ignores unknown and invalid transport values', () => {
    expect(parseHashConfig('#view=chat&transport=nope')).toEqual({});
  });

  it('returns nothing for an empty hash', () => {
    expect(parseHashConfig('')).toEqual({});
  });
});

describe('url helpers', () => {
  it('normalises trailing slashes', () => {
    expect(normalizeUrl(' https://x.supabase.co/// ')).toBe('https://x.supabase.co');
  });

  it('validates schemes', () => {
    expect(isValidUrl('https://x.supabase.co')).toBe(true);
    expect(isValidUrl('http://127.0.0.1:54321')).toBe(true);
    expect(isValidUrl('x.supabase.co')).toBe(false);
    expect(isValidUrl('')).toBe(false);
  });

  it('extracts the project ref', () => {
    expect(projectRef('https://vrrvgdajkvlgz.supabase.co')).toBe('vrrvgdajkvlgz');
    expect(projectRef('nonsense')).toBe('');
  });
});

describe('loadConfig precedence', () => {
  const longKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaaaaaaaaaa';

  it('falls back to the baked-in public defaults', () => {
    expect(loadConfig('')).toEqual({
      url: DEFAULT_SUPABASE_URL,
      anonKey: DEFAULT_SUPABASE_ANON_KEY,
      model: 'deepseek-chat',
      transport: 'auto',
    });
  });

  it('localStorage is the base layer', () => {
    store.set(CONFIG_KEY, JSON.stringify({ url: 'https://stored.supabase.co', anonKey: longKey }));
    expect(loadConfig('').url).toBe('https://stored.supabase.co');
  });

  it('config.js overrides localStorage', () => {
    store.set(CONFIG_KEY, JSON.stringify({ url: 'https://stored.supabase.co', anonKey: longKey }));
    win.window.TOOLS_CONFIG = { url: 'https://baked.supabase.co' };
    expect(loadConfig('').url).toBe('https://baked.supabase.co');
  });

  it('the URL hash wins over everything', () => {
    store.set(CONFIG_KEY, JSON.stringify({ url: 'https://stored.supabase.co', anonKey: longKey }));
    win.window.TOOLS_CONFIG = { url: 'https://baked.supabase.co' };
    expect(loadConfig('#supabase=https://hash.supabase.co').url).toBe('https://hash.supabase.co');
  });

  it('empty values never clobber lower layers', () => {
    store.set(CONFIG_KEY, JSON.stringify({ url: 'https://stored.supabase.co', anonKey: longKey }));
    win.window.TOOLS_CONFIG = { url: '   ' };
    expect(loadConfig('').url).toBe('https://stored.supabase.co');
  });

  it('survives corrupt stored JSON', () => {
    store.set(CONFIG_KEY, '{not json');
    expect(loadConfig('').url).toBe(DEFAULT_SUPABASE_URL);
  });
});

describe('isConfigured', () => {
  it('is satisfied by the baked-in defaults alone', () => {
    expect(isConfigured(loadConfig(''))).toBe(true);
  });

  it('requires a plausible url and a real-looking key', () => {
    const base = { url: 'https://x.supabase.co', anonKey: 'x'.repeat(40), model: 'm', transport: 'auto' as const };
    expect(isConfigured(base)).toBe(true);
    expect(isConfigured({ ...base, url: 'nope' })).toBe(false);
    expect(isConfigured({ ...base, anonKey: 'short' })).toBe(false);
  });
});

describe('persistence', () => {
  it('saves and clears config plus token together', () => {
    saveConfig({ url: 'https://x.supabase.co', anonKey: 'k'.repeat(30), model: 'm', transport: 'edge' });
    saveToken({ token: 't', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(store.has(CONFIG_KEY)).toBe(true);
    clearConfig();
    expect(store.has(CONFIG_KEY)).toBe(false);
    expect(store.has(TOKEN_KEY)).toBe(false);
  });

  it('drops a token that is expired or about to expire', () => {
    saveToken({ token: 't', expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(loadToken()).toBeNull();
    saveToken({ token: 't', expiresAt: new Date(Date.now() + 10_000).toISOString() });
    expect(loadToken()).toBeNull(); // inside the 30s safety margin
    saveToken({ token: 't', expiresAt: new Date(Date.now() + 600_000).toISOString() });
    expect(loadToken()?.token).toBe('t');
  });

  it('tolerates a garbage token blob', () => {
    store.set(TOKEN_KEY, 'nonsense');
    expect(loadToken()).toBeNull();
  });
});
