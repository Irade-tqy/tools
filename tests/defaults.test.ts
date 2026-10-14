// Guard for the one file that is allowed to carry configuration in the repo.
// The Supabase URL and the anon key are public client values; anything with a
// service_role (or non-anon) role claim is a secret and must never be committed.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FUNCTION_NAME,
  DEFAULT_MODEL_TYPE,
  DEFAULT_SUPABASE_ANON_KEY,
  DEFAULT_SUPABASE_URL,
} from '../src/lib/defaults';

const source = readFileSync(new URL('../src/lib/defaults.ts', import.meta.url), 'utf8');

function decodeJwt(key: string): Record<string, unknown> {
  const payload = key.split('.')[1];
  expect(payload, 'value is not a JWT').toBeTruthy();
  return JSON.parse(Buffer.from(payload as string, 'base64url').toString('utf8'));
}

describe('committed defaults', () => {
  it('points at an https Supabase project', () => {
    const url = new URL(DEFAULT_SUPABASE_URL);
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toMatch(/^[a-z]{14,20}\.supabase\.co$/);
    expect(DEFAULT_SUPABASE_URL.endsWith('/')).toBe(false);
  });

  it('carries an anon key whose claims match the project', () => {
    const claims = decodeJwt(DEFAULT_SUPABASE_ANON_KEY);
    expect(claims.role).toBe('anon');
    expect(claims.iss).toBe('supabase');
    expect(claims.ref).toBe(new URL(DEFAULT_SUPABASE_URL).hostname.split('.')[0]);
  });

  it('is a long-lived publishable key, not a short-lived token', () => {
    const claims = decodeJwt(DEFAULT_SUPABASE_ANON_KEY);
    const lifetimeYears = (Number(claims.exp) - Number(claims.iat)) / (365 * 86_400);
    expect(lifetimeYears).toBeGreaterThan(1);
  });

  it('contains no credential other than the URL, the anon key and the model', () => {
    // Every JWT in the file must be the anon key; a pasted service key fails here.
    const jwtLike = source.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) || [];
    expect(jwtLike.length).toBeGreaterThan(0);
    for (const token of jwtLike) {
      expect(decodeJwt(token).role, 'a non-anon JWT was committed').toBe('anon');
      expect(token).toBe(DEFAULT_SUPABASE_ANON_KEY);
    }
    // Comments may mention secrets; only code lines are scanned.
    const code = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/service_role|SERVICE_ROLE_KEY|DEEPSEEK_WEB_COOKIE|DEEPSEEK_CREDENTIAL|ADMIN_TOKEN|DB_PASSWORD/i);
  });

  it('bakes in the public function name and model type', () => {
    expect(DEFAULT_FUNCTION_NAME).toBe('deepseek-chat');
    expect(DEFAULT_MODEL_TYPE).toBe('default');
  });
});
