import { describe, expect, it } from 'vitest';
import { createCipheriv, createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { ALG, PBKDF2_ITERATIONS, fromBase64, open, randomBytes, seal, toBase64 } from '../src/lib/crypto';

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('base64 helpers', () => {
  it('round-trips arbitrary bytes', () => {
    for (const length of [0, 1, 15, 16, 17, 255, 4096]) {
      const bytes = randomBytes(length);
      expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    }
  });

  it('handles the >32k chunking path', () => {
    const big = randomBytes(70_000);
    expect(fromBase64(toBase64(big))).toEqual(big);
  });
});

describe('seal / open', () => {
  it('round-trips a file', async () => {
    const plaintext = '文件内容 — hello 世界\n'.repeat(50);
    const sealed = await seal('correct horse', enc.encode(plaintext));
    expect(sealed.alg).toBe(ALG);
    expect(sealed.iv).toBeTruthy();
    expect(sealed.salt).toBeTruthy();
    expect(fromBase64(sealed.iv)).toHaveLength(12);
    expect(fromBase64(sealed.salt)).toHaveLength(16);
    const opened = await open('correct horse', sealed);
    expect(dec.decode(opened)).toBe(plaintext);
  });

  it('never stores the plaintext', async () => {
    const sealed = await seal('pw', enc.encode('TOP-SECRET-MARKER'));
    expect(toBase64(fromBase64(sealed.data))).toBe(sealed.data);
    expect(Buffer.from(sealed.data, 'base64').toString('latin1')).not.toContain('TOP-SECRET-MARKER');
  });

  it('uses a fresh iv and salt per call', async () => {
    const a = await seal('pw', enc.encode('same'));
    const b = await seal('pw', enc.encode('same'));
    expect(a.iv).not.toBe(b.iv);
    expect(a.salt).not.toBe(b.salt);
    expect(a.data).not.toBe(b.data);
  });

  it('fails loudly with the wrong password', async () => {
    const sealed = await seal('right', enc.encode('data'));
    await expect(open('wrong', sealed)).rejects.toThrow(/解密失败/);
  });

  it('rejects an unknown algorithm marker', async () => {
    const sealed = await seal('pw', enc.encode('data'));
    await expect(open('pw', { ...sealed, alg: 'AES-CBC/legacy' })).rejects.toThrow(/不支持的加密格式/);
  });
});

describe('wire format compatibility with node:crypto', () => {
  // scripts/db-test.mjs decrypts what the browser encrypts using node:crypto. If the
  // browser implementation drifted from PBKDF2-SHA256/150000 + AES-256-GCM (tag appended),
  // this test fails before the live test does.
  it('node can decrypt a browser-sealed file', async () => {
    const plaintext = 'interop check';
    const sealed = await seal('shared-secret', enc.encode(plaintext));
    const key = pbkdf2Sync(
      'shared-secret',
      fromBase64(sealed.salt),
      PBKDF2_ITERATIONS,
      32,
      'sha256',
    );
    const raw = Buffer.from(sealed.data, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, fromBase64(sealed.iv));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const out = Buffer.concat([
      decipher.update(raw.subarray(0, raw.length - 16)),
      decipher.final(),
    ]);
    expect(out.toString('utf8')).toBe(plaintext);
  });

  it('the browser can decrypt a node-sealed file', async () => {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = pbkdf2Sync('shared-secret', salt, PBKDF2_ITERATIONS, 32, 'sha256');
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update('from node', 'utf8'), cipher.final()]);
    const sealed = {
      data: toBase64(Buffer.concat([body, cipher.getAuthTag()])),
      iv: toBase64(iv),
      salt: toBase64(salt),
      alg: ALG,
    };
    expect(dec.decode(await open('shared-secret', sealed))).toBe('from node');
  });

  it('pins the KDF parameters the database test relies on', () => {
    expect(PBKDF2_ITERATIONS).toBe(150_000);
    expect(ALG).toBe('AES-GCM/PBKDF2-SHA256/150000');
  });
});
