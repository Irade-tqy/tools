// Runtime configuration. The Supabase URL, anon key and function name are baked into the
// bundle (scripts/defaults-sync.mjs) because they are public client values — Row Level
// Security is the actual boundary — so the deployed site needs zero setup. The layers below
// only exist for self-hosting and for the hidden admin page:
//   baked defaults → localStorage → ./config.js → the URL hash.

import {
  DEFAULT_FUNCTION_NAME,
  DEFAULT_MODEL_TYPE,
  DEFAULT_SUPABASE_ANON_KEY,
  DEFAULT_SUPABASE_URL,
} from './defaults';

export type ModelType = 'default' | 'expert' | 'vision';

export const MODEL_TYPES: { value: ModelType; label: string; hint: string }[] = [
  { value: 'default', label: '默认', hint: '快速回答' },
  { value: 'expert', label: '专家', hint: '深度推理，可能调用搜索工具' },
  { value: 'vision', label: '视觉', hint: '可理解图片' },
];

export interface Config {
  url: string;
  anonKey: string;
  functionName: string;
  modelType: ModelType;
  /**
   * Which relay queue to use. 'default' is what the public site and the production relay
   * share; the test suites point at 'test' so a live relay cannot claim their turns.
   */
  queue: string;
}

export const CONFIG_KEY = 'tools.config.v1';
export const TOKEN_KEY = 'tools.clipboard.token.v1';
export const ADMIN_TOKEN_KEY = 'tools.admin.token.v1';
export const SESSION_KEY = 'tools.chat.session.v1';

declare global {
  interface Window {
    /** Optional ./config.js escape hatch for self-hosted deployments. */
    TOOLS_CONFIG?: Partial<Config>;
  }
}

export function normalizeUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

export function isValidUrl(raw: string): boolean {
  try {
    const u = new URL(normalizeUrl(raw));
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export function projectRef(raw: string): string {
  try {
    return new URL(normalizeUrl(raw)).hostname.split('.')[0] ?? '';
  } catch {
    return '';
  }
}

export function isModelType(value: unknown): value is ModelType {
  return value === 'default' || value === 'expert' || value === 'vision';
}

/**
 * `#supabase=https://x.supabase.co&anon=eyJ…&function=deepseek-chat&model=expert`
 * The same hash also carries routing (`#view=chat`), and `#admin=1` unlocks the backend page.
 */
export function parseHashConfig(hash: string): Partial<Config> {
  const out: Partial<Config> = {};
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return out;
  const params = new URLSearchParams(raw);
  const url = params.get('supabase') || params.get('url');
  const anon = params.get('anon') || params.get('key');
  const fn = params.get('function') || params.get('fn');
  const model = params.get('model');
  const queue = params.get('queue');
  if (queue) out.queue = queue.trim().slice(0, 32);
  if (url) out.url = normalizeUrl(url);
  if (anon) out.anonKey = anon.trim();
  if (fn) out.functionName = fn.trim();
  if (isModelType(model)) out.modelType = model;
  return out;
}

/** `?admin=1` (query) or `#admin=1` (hash) reveals the backend page. */
export function isAdminMode(search = location.search, hash = location.hash): boolean {
  const flag = (value: string) => {
    const raw = value.startsWith('#') ? value.slice(1) : value;
    return new URLSearchParams(raw).get('admin') === '1';
  };
  return flag(search) || flag(hash);
}

function readStored(key: string): Partial<Config> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Partial<Config>) : {};
  } catch {
    return {};
  }
}

function merge(...parts: Array<Partial<Config> | undefined>): Config {
  const flat: Partial<Config> = {};
  for (const part of parts) {
    if (!part) continue;
    for (const [k, v] of Object.entries(part)) {
      if (typeof v === 'string' ? v.trim() !== '' : v !== undefined) {
        (flat as Record<string, unknown>)[k] = typeof v === 'string' ? v.trim() : v;
      }
    }
  }
  return {
    url: flat.url ? normalizeUrl(flat.url) : '',
    anonKey: flat.anonKey ?? '',
    functionName: flat.functionName || DEFAULT_FUNCTION_NAME,
    modelType: isModelType(flat.modelType) ? flat.modelType : DEFAULT_MODEL_TYPE,
    queue: flat.queue && /^[a-z0-9_-]{1,32}$/i.test(flat.queue) ? flat.queue : 'default',
  };
}

export function loadConfig(hash = ''): Config {
  return merge(
    { url: DEFAULT_SUPABASE_URL, anonKey: DEFAULT_SUPABASE_ANON_KEY, functionName: DEFAULT_FUNCTION_NAME, queue: 'default' },
    readStored(CONFIG_KEY),
    window.TOOLS_CONFIG,
    parseHashConfig(hash),
  );
}

/**
 * Optional self-hosting escape hatch: a git-ignored ./config.js next to index.html may set
 * `window.TOOLS_CONFIG = { url, anonKey }`. Loaded at runtime (never bundled), so the public
 * repo stays free of credentials and a missing file is not a build error.
 */
export function loadRuntimeConfigFile(timeoutMs = 1500): Promise<Partial<Config> | undefined> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') return resolve(undefined);
    const script = document.createElement('script');
    script.src = new URL('./config.js', location.href).href;
    const done = () => resolve(window.TOOLS_CONFIG);
    script.onload = done;
    script.onerror = () => resolve(undefined);
    setTimeout(() => resolve(window.TOOLS_CONFIG), timeoutMs);
    document.head.append(script);
  });
}

export function isConfigured(cfg: Config): boolean {
  return isValidUrl(cfg.url) && cfg.anonKey.length > 20 && Boolean(cfg.functionName);
}

export function saveConfig(cfg: Config): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  } catch {
    /* private mode / quota — the in-memory config still works for this session */
  }
}

export function clearConfig(): void {
  try {
    localStorage.removeItem(CONFIG_KEY);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export function loadAdminToken(): string {
  try {
    return localStorage.getItem(ADMIN_TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function saveAdminToken(token: string): void {
  try {
    if (token) localStorage.setItem(ADMIN_TOKEN_KEY, token);
    else localStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export interface StoredToken {
  token: string;
  expiresAt: string;
  label?: string;
}

export function loadToken(): StoredToken | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredToken;
    if (!parsed?.token) return null;
    if (parsed.expiresAt && new Date(parsed.expiresAt).getTime() < Date.now() + 30_000) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveToken(stored: StoredToken | null): void {
  try {
    if (!stored) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, JSON.stringify(stored));
  } catch {
    /* ignore */
  }
}
