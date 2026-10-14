// The one-string credential contract: whatever format the operator pastes, the same parser
// runs in the browser preview, the node scripts and the Edge Function.

import { describe, expect, it } from 'vitest';
import {
  CANONICAL_PREFIX,
  DEFAULT_USER_AGENT,
  fingerprint,
  parseCredential,
  serializeCredential,
} from '../supabase/functions/_shared/credential';

const TOKEN = '1JXA560QrOspw58QGQOerKar1skqAAyymbKS27c9M8TL5sb+DxBO9GBubZDYU1yB9';
const DEVICE = '28abc89b-c6db-4fed-be58-615e18be02f1';

describe('parseCredential', () => {
  it('reads a bare userToken', () => {
    const result = parseCredential(`  ${TOKEN}\n`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credential.token).toBe(TOKEN);
    expect(result.credential.source).toBe('token');
    expect(result.credential.userAgent).toBe(DEFAULT_USER_AGENT);
  });

  it('reads DevTools "Copy as cURL" and pulls token, device id, cookie and UA out of it', () => {
    const curl =
      `curl 'https://chat.deepseek.com/api/v0/chat/completion' \\
  -H 'accept: */*' \\
  -H 'authorization: Bearer ${TOKEN}' \\
  -H 'content-type: application/json' \\
  -H 'user-agent: Mozilla/5.0 (Macintosh) Chrome/130' \\
  -H 'x-device-id: ${DEVICE}' \\
  -H 'x-ds-pow-response: eyJhbGciOiJIUzI1NiJ9.eyJhbGdvcml0aG0iOiJEZWVwU2Vla0hhc2hWMSJ9' \\
  -b 'smidV2=20260101_abc; tfstk=xyz' \\
  --data-raw '{"chat_session_id":null}'`;
    const result = parseCredential(curl);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credential.token).toBe(TOKEN);
    expect(result.credential.deviceId).toBe(DEVICE);
    expect(result.credential.cookie).toContain('smidV2=');
    expect(result.credential.userAgent).toBe('Mozilla/5.0 (Macintosh) Chrome/130');
    expect(result.credential.source).toBe('curl');
    // The PoW header is single-use; keeping it would break every later request.
    expect(result.warnings.join(' ')).toContain('x-ds-pow-response');
  });

  it('reads a JSON dump keyed by userToken', () => {
    const result = parseCredential(JSON.stringify({ userToken: TOKEN, deviceId: DEVICE }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credential.token).toBe(TOKEN);
    expect(result.credential.deviceId).toBe(DEVICE);
    expect(result.credential.source).toBe('json');
  });

  it('reads labelled key/value lines', () => {
    const result = parseCredential(`authorization: Bearer ${TOKEN}\nx-device-id: ${DEVICE}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credential.token).toBe(TOKEN);
    expect(result.credential.deviceId).toBe(DEVICE);
  });

  it('takes the device id out of a cookie when nothing else provides it', () => {
    const result = parseCredential(`token: ${TOKEN}\ncookie: smidV2=a; x-device-id=${DEVICE}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credential.deviceId).toBe(DEVICE);
  });

  it('rejects a cookie-only paste with an actionable message', () => {
    const result = parseCredential('smidV2=20260101_abc; tfstk=xyz');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('userToken');
  });

  it('rejects garbage instead of storing it', () => {
    for (const bad of ['', '   ', 'short', 'hello world', '{"note":"no token here"}']) {
      const result = parseCredential(bad);
      expect(result.ok, `should reject ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it('strips a stray Bearer prefix and quotes', () => {
    const result = parseCredential(`"${TOKEN}"`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credential.token).toBe(TOKEN);
  });
});

describe('canonical string', () => {
  it('round-trips through the reusable string', () => {
    const parsed = parseCredential(`curl -H 'authorization: Bearer ${TOKEN}' -H 'x-device-id: ${DEVICE}'`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const canonical = serializeCredential(parsed.credential);
    expect(canonical.startsWith(CANONICAL_PREFIX)).toBe(true);
    const again = parseCredential(canonical);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.credential.token).toBe(TOKEN);
    expect(again.credential.deviceId).toBe(DEVICE);
    expect(again.credential.userAgent).toBe(parsed.credential.userAgent);
    expect(again.credential.source).toBe('canonical');
    expect(serializeCredential(again.credential)).toBe(canonical);
  });

  it('survives non-ASCII (the UA may carry CJK)', () => {
    const parsed = parseCredential(`token: ${TOKEN}\nuser-agent: 浏览器/1.0`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const again = parseCredential(serializeCredential(parsed.credential));
    expect(again.ok && again.credential.userAgent).toBe('浏览器/1.0');
  });

  it('reports a truncated canonical string as such', () => {
    const result = parseCredential(`${CANONICAL_PREFIX}!!!not-base64!!!`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('base64');
  });
});

describe('fingerprint', () => {
  it('never prints the whole token', () => {
    const text = fingerprint({ token: TOKEN, deviceId: '', cookie: '', userAgent: '', source: 'token' });
    expect(text).not.toContain(TOKEN);
    expect(text).toContain(TOKEN.slice(0, 6));
    expect(text).toContain(String(TOKEN.length));
  });
});
