// DeepSeek web credential: one string in, structured data out.
//
// Refreshing the login used to mean driving a browser. Instead the operator pastes *any*
// one of the strings below and parseCredential() works out what it is:
//
//   1. canonical   `dscred1:<base64url(json)>`            — what serializeCredential() emits
//   2. cURL        `curl 'https://chat.deepseek.com/…' -H 'authorization: Bearer …' …`
//                  (DevTools → Network → Copy as cURL)
//   3. JSON        {"userToken":"…","deviceId":"…","cookie":"…"} or a localStorage dump
//   4. cookie      `smidV2=…; tfstk=…`                    (the raw Cookie header)
//   5. bare token  the value of localStorage.userToken
//   6. key: value  `token: …` / `x-device-id: …` lines, in any order
//
// Pure + dependency-free: vitest tests it, the Edge Function and the node scripts both
// import it, and the browser admin panel uses it for the live preview.

export type CredentialSource = 'canonical' | 'curl' | 'json' | 'cookie' | 'token' | 'kv';

export interface DeepSeekCredential {
  /** Authorization: Bearer <token> — the web app's localStorage.userToken. */
  token: string;
  /** x-device-id header. Optional, but reusing the browser's id keeps the WAF calm. */
  deviceId: string;
  /** Optional Cookie header (smidV2 etc.). The token alone is enough today. */
  cookie: string;
  /** Optional User-Agent, kept with the credential so headers stay self-consistent. */
  userAgent: string;
  source: CredentialSource;
}

export type ParseResult =
  | { ok: true; credential: DeepSeekCredential; warnings: string[] }
  | { ok: false; error: string };

export const CANONICAL_PREFIX = 'dscred1:';
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const MIN_TOKEN_LENGTH = 20;

// ---------------------------------------------------------------------------
// base64url (works in the browser, Deno and node — no Buffer, no node:crypto)
// ---------------------------------------------------------------------------

function bytesToBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToText(value: string): string {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// field helpers
// ---------------------------------------------------------------------------

function clean(value: unknown): string {
  if (typeof value !== 'string') return '';
  let out = value.trim();
  // strip one layer of matching quotes, and a trailing comma from pasted JSON fragments
  if (out.length >= 2 && ((out[0] === '"' && out.endsWith('"')) || (out[0] === "'" && out.endsWith("'")))) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

function stripBearer(value: string): string {
  return value.replace(/^Bearer\s+/i, '').trim();
}

/** A usable bearer token: no whitespace, no `k=v` shape, long enough to be real. */
function looksLikeToken(value: string): boolean {
  return value.length >= MIN_TOKEN_LENGTH && !/\s/.test(value) && !value.includes('=');
}

function looksLikeCookie(value: string): boolean {
  return /^[A-Za-z0-9_.%~+\-/=;,\s]+$/.test(value) && value.includes('=') && !/\s/.test(value.replace(/;\s*/g, ';'));
}

function cookieValue(cookie: string, ...names: string[]): string {
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim().toLowerCase();
    if (names.includes(name)) return part.slice(eq + 1).trim();
  }
  return '';
}

function empty(source: CredentialSource): DeepSeekCredential {
  return { token: '', deviceId: '', cookie: '', userAgent: '', source };
}

function withDeviceIdFromCookie(credential: DeepSeekCredential): DeepSeekCredential {
  if (!credential.deviceId && credential.cookie) {
    const fromCookie = cookieValue(credential.cookie, 'x-device-id', 'device_id', 'deviceid', 'ds_device_id');
    if (fromCookie) credential.deviceId = fromCookie;
  }
  return credential;
}

function fail(reason: string, hint: string): { ok: false; error: string } {
  return { ok: false, error: `${reason}${hint ? ` — ${hint}` : ''}` };
}

// ---------------------------------------------------------------------------
// per-format parsers
// ---------------------------------------------------------------------------

const HEADER_FLAG = /(?:^|\s)(?:-H|--header)\s+(['"])(.*?)\1/is;
const ALL_HEADER_FLAGS = /(?:^|\s)(?:-H|--header)\s+(['"])(.*?)\1/gis;
const COOKIE_FLAG = /(?:^|\s)(?:-b|--cookie)\s+(['"])(.*?)\1/is;

function parseCurl(text: string): ParseResult {
  const credential = empty('curl');
  const warnings: string[] = [];
  const headers: Record<string, string> = {};
  const pattern = new RegExp(ALL_HEADER_FLAGS.source, 'gis');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const raw = clean(match[2]);
    const colon = raw.indexOf(':');
    if (colon <= 0) continue;
    headers[raw.slice(0, colon).trim().toLowerCase()] = raw.slice(colon + 1).trim();
  }

  credential.token = stripBearer(headers['authorization'] ?? headers['auth'] ?? '');
  credential.deviceId = headers['x-device-id'] ?? headers['x-ds-device-id'] ?? '';
  credential.userAgent = headers['user-agent'] ?? '';
  const cookieFlag = COOKIE_FLAG.exec(text);
  credential.cookie = clean(cookieFlag ? cookieFlag[2] : '') || headers['cookie'] || '';

  // A cURL copied from the completion request carries the PoW header too; it is single-use
  // and expires, so drop it rather than replaying a stale one forever.
  if (headers['x-ds-pow-response']) warnings.push('已忽略 cURL 里的 x-ds-pow-response（一次性，转发时会自动重新计算）');

  if (!credential.token) {
    return fail('curl_no_token', '这段 cURL 里没有 authorization 头，请从 chat.deepseek.com 的请求上右键 Copy as cURL');
  }
  return { ok: true, credential: withDeviceIdFromCookie(credential), warnings };
}

function parseJson(text: string): ParseResult {
  const credential = empty('json');
  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'string') return parseInput(parsed, true);
    if (!parsed || typeof parsed !== 'object') return fail('bad_json', '期望 JSON 对象');
    value = parsed as Record<string, unknown>;
  } catch (err) {
    return fail('bad_json', (err as Error).message);
  }

  // Accept a raw localStorage dump ({"userToken": "…"}), a Supabase-shaped row, or our own
  // canonical payload (short keys t/d/c/u, see serializeCredential).
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const found = clean(value[key]);
      if (found) return found;
    }
    return '';
  };
  credential.token = stripBearer(
    pick('token', 'userToken', 'user_token', 'authorization', 'access_token', 'bearer', 'api_key', 'apiKey', 't'),
  );
  credential.deviceId = pick('deviceId', 'device_id', 'x-device-id', 'deviceIdHeader', 'd');
  credential.cookie = pick('cookie', 'Cookie', 'cookieHeader', 'cookies', 'c');
  credential.userAgent = pick('userAgent', 'user_agent', 'user-agent', 'ua', 'u');
  if (!credential.token && credential.cookie) {
    // {"cookie": "…"} alone: the token may be inside the cookie on some setups.
    credential.token = cookieValue(credential.cookie, 'usertoken', 'user_token', 'token', 'access_token');
  }
  if (!credential.token) return fail('json_no_token', 'JSON 里需要 token / userToken 字段');
  return { ok: true, credential: withDeviceIdFromCookie(credential), warnings: [] };
}

const KV_LINE = /^\s*(authorization|auth|token|user[-_]?token|access[-_]?token|x[-_]?device[-_]?id|device[-_]?id|cookie|user[-_]?agent|ua)\s*[:=]\s*(.+)$/i;

function parseKeyValue(text: string): ParseResult {
  const credential = empty('kv');
  for (const line of text.split(/\r?\n/)) {
    const match = KV_LINE.exec(line);
    if (!match) continue;
    const key = (match[1] ?? '').toLowerCase().replace(/[-_ ]/g, '');
    const value = clean(match[2] ?? '');
    if (!value) continue;
    if (key === 'authorization' || key === 'auth' || key === 'token' || key === 'usertoken' || key === 'accesstoken') {
      credential.token = stripBearer(value);
    } else if (key === 'xdeviceid' || key === 'deviceid') {
      credential.deviceId = value;
    } else if (key === 'cookie') {
      credential.cookie = value;
    } else if (key === 'useragent' || key === 'ua') {
      credential.userAgent = value;
    }
  }
  if (!credential.token) return fail('kv_no_token', '没找到 token；支持 token: … / authorization: Bearer … 这样的行');
  return { ok: true, credential: withDeviceIdFromCookie(credential), warnings: [] };
}

function parseCanonical(text: string): ParseResult {
  const body = text.slice(CANONICAL_PREFIX.length).trim();
  if (!body) return fail('bad_canonical', 'dscred1: 后面是空的');
  let json: string;
  try {
    json = base64UrlToText(body);
  } catch {
    return fail('bad_canonical', 'base64 解不开，可能被换行截断了');
  }
  const result = parseJson(json);
  if (result.ok) result.credential.source = 'canonical';
  return result;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

function parseInput(raw: string, nested = false): ParseResult {
  const text = raw.trim();
  if (!text) return fail('empty', '粘贴内容为空');

  if (text.toLowerCase().startsWith(CANONICAL_PREFIX)) return parseCanonical(text);

  if (!nested && /^\s*[{[]/.test(text)) return parseJson(text);

  if (!nested && /\bcurl\b/i.test(text) && (HEADER_FLAG.test(text) || COOKIE_FLAG.test(text) || /--data|--url|-X\s/.test(text))) {
    return parseCurl(text);
  }

  // Single line, no separators: either a bare token or a bare cookie header.
  const single = text.includes('\n') ? '' : clean(text);
  if (single) {
    if (looksLikeToken(single)) {
      return { ok: true, credential: { ...empty('token'), token: stripBearer(single) }, warnings: [] };
    }
    if (looksLikeCookie(single)) {
      const credential = withDeviceIdFromCookie({ ...empty('cookie'), cookie: single });
      const fromCookie = cookieValue(single, 'usertoken', 'user_token', 'token', 'access_token');
      if (fromCookie) credential.token = fromCookie;
      if (!credential.token) {
        return fail(
          'cookie_without_token',
          '这里只有 Cookie；DeepSeek 的登录态在 localStorage.userToken，请粘贴它或整段 Copy as cURL',
        );
      }
      return { ok: true, credential, warnings: [] };
    }
  }

  // Multi-line or labelled: fall back to a key: value scan.
  const kv = parseKeyValue(text);
  if (kv.ok) return kv;

  return fail('unrecognized', `${kv.error}；支持 dscred1:…、Copy as cURL、JSON、Cookie、userToken`);
}

export function parseCredential(raw: string): ParseResult {
  const result = parseInput(raw);
  if (!result.ok) return result;
  const credential = result.credential;
  if (!looksLikeToken(credential.token)) {
    return fail('bad_token', `token 看起来不对（长度 ${credential.token.length}，需要 ≥ ${MIN_TOKEN_LENGTH} 且不含空格）`);
  }
  if (!credential.userAgent) credential.userAgent = DEFAULT_USER_AGENT;
  return result;
}

/** The single reusable string: paste it back anywhere, or hand it to someone else. */
export function serializeCredential(credential: DeepSeekCredential): string {
  return CANONICAL_PREFIX + bytesToBase64Url(
    JSON.stringify({
      t: credential.token,
      d: credential.deviceId || undefined,
      c: credential.cookie || undefined,
      u: credential.userAgent || undefined,
    }),
  );
}

/** Never print the whole secret: this is what the UI and logs show. */
export function fingerprint(credential: DeepSeekCredential): string {
  const token = credential.token;
  if (!token) return '(无 token)';
  return `${token.slice(0, 6)}…${token.slice(-4)} (${token.length} 字符)`;
}
