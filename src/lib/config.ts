// Runtime configuration. The repo is public, so the Supabase URL and anon key are never
// baked into the bundle: they come from (in order) a git-ignored ./config.js next to
// index.html, the URL hash, or localStorage entered by the user on first visit.

export type Transport = 'auto' | 'edge' | 'browser';

export interface Config {
  url: string;
  anonKey: string;
  model: string;
  transport: Transport;
}

export const CONFIG_KEY = 'tools.config.v1';
export const TOKEN_KEY = 'tools.clipboard.token.v1';

declare global {
  interface Window {
    // Optional ./config.js escape hatch for self-hosted deployments.
    TOOLS_CONFIG?: Partial<Config>;
  }
}

const DEFAULTS: Pick<Config, 'model' | 'transport'> = {
  model: 'deepseek-chat',
  transport: 'auto',
};

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

// `#supabase=https://x.supabase.co&anon=eyJ…&model=deepseek-chat&transport=edge`
export function parseHashConfig(hash: string): Partial<Config> {
  const out: Partial<Config> = {};
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return out;
  const params = new URLSearchParams(raw);
  const url = params.get('supabase') || params.get('url');
  const anon = params.get('anon') || params.get('key');
  const model = params.get('model');
  const transport = params.get('transport');
  if (url) out.url = normalizeUrl(url);
  if (anon) out.anonKey = anon.trim();
  if (model) out.model = model;
  if (transport === 'auto' || transport === 'edge' || transport === 'browser') out.transport = transport;
  return out;
}

function readStored(): Partial<Config> {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
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
    model: flat.model || DEFAULTS.model,
    transport: flat.transport ?? DEFAULTS.transport,
  };
}

export function loadConfig(hash = ''): Config {
  return merge(readStored(), window.TOOLS_CONFIG, parseHashConfig(hash));
}

/**
 * Optional self-hosting escape hatch: a git-ignored ./config.js next to index.html may set
 * `window.TOOLS_CONFIG = { url, anonKey }`. Loaded at runtime (never bundled), so the
 * public repo stays free of credentials and a missing file is not a build error.
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
  return isValidUrl(cfg.url) && cfg.anonKey.length > 20;
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
