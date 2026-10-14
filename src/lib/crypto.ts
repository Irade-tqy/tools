// Client-side file encryption: AES-GCM with a PBKDF2 key derived from the clipboard
// password. Postgres only ever sees ciphertext + a random IV, so a leaked database (or a
// reading proxy) never exposes file contents. Text entries stay plaintext on purpose —
// they are meant to be copyable and greppable by every verified user.

export interface Sealed {
  /** base64 AES-GCM ciphertext */
  data: string;
  /** base64 12-byte IV */
  iv: string;
  /** base64 16-byte PBKDF2 salt */
  salt: string;
  /** algorithm marker so future format changes can be detected */
  alg: string;
}

export const ALG = 'AES-GCM/PBKDF2-SHA256/150000';
export const PBKDF2_ITERATIONS = 150_000;

export class CryptoUnavailable extends Error {}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) {
    throw new CryptoUnavailable(
      'WebCrypto 不可用：请通过 https 或 localhost 打开本页（file:// 下浏览器不提供 crypto.subtle）',
    );
  }
  return s;
}

export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < view.length; i += chunk) {
    binary += String.fromCharCode(...view.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.trim());
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  // crypto.getRandomValues refuses more than 65536 bytes per call.
  const chunk = 65_536;
  for (let offset = 0; offset < length; offset += chunk) {
    globalThis.crypto.getRandomValues(out.subarray(offset, Math.min(offset + chunk, length)));
  }
  return out;
}

export async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const base = await subtle().importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function seal(
  password: string,
  plaintext: ArrayBuffer | Uint8Array<ArrayBuffer>,
): Promise<Sealed> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(password, salt);
  const bytes = plaintext instanceof Uint8Array ? plaintext : new Uint8Array(plaintext);
  const cipher = await subtle().encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return { data: toBase64(cipher), iv: toBase64(iv), salt: toBase64(salt), alg: ALG };
}

export async function open(password: string, sealed: Sealed): Promise<ArrayBuffer> {
  if (sealed.alg && sealed.alg !== ALG) {
    throw new Error(`不支持的加密格式 ${sealed.alg}`);
  }
  const key = await deriveKey(password, fromBase64(sealed.salt));
  try {
    return await subtle().decrypt({ name: 'AES-GCM', iv: fromBase64(sealed.iv) }, key, fromBase64(sealed.data));
  } catch {
    throw new Error('解密失败：密码在文件上传后被改过');
  }
}
