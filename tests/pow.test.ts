// The vendored proof-of-work module. DeepSeek rejects /api/v0/chat/completion without a
// valid x-ds-pow-response, so a silently truncated or swapped wasm means the relay is dead —
// these tests pin the bytes and a known challenge/answer pair.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { POW_WASM_BASE64, POW_WASM_SHA256 } from '../supabase/functions/_shared/pow-wasm';
import { base64FromBytes, createPowSolver, decodeBase64, type PowChallenge } from '../supabase/functions/_shared/pow';

// Recorded from the live API (scripts/deepseek-pow-node.mjs). The wasm is deterministic, so
// this pair is a fixed check on the solver, not a network test.
const RECORDED: { challenge: PowChallenge; answer: number } = {
  challenge: {
    algorithm: 'DeepSeekHashV1',
    challenge: 'bb3a237ae3a403cbf2a52b8cfeb77111a68748c910c74f2e3f8b878d4ee1af05',
    salt: '593dd6dda7708462ddd2',
    signature: '3583e8171942b021b690ecd81d0fc7212323c6e7a31f8a1cbb529ab08f5b9179',
    difficulty: 144000,
    expire_at: 1791975536431,
  },
  answer: 45487,
};

describe('vendored wasm payload', () => {
  it('decodes to the module whose hash is recorded in the file', () => {
    const bytes = decodeBase64(POW_WASM_BASE64);
    const digest = createHash('sha256').update(bytes).digest('hex');
    expect(digest).toBe(POW_WASM_SHA256);
  });

  it('is a complete wasm module, not a truncated chunk', () => {
    const bytes = decodeBase64(POW_WASM_BASE64);
    expect(Array.from(bytes.slice(0, 8))).toEqual([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    // The generator joins base64 chunks with `+`; a missing one truncates silently (ASI),
    // so the byte count is asserted explicitly.
    expect(bytes.length).toBe(26612);
  });

  it('matches scripts/vendor/sha3_wasm_bg.wasm when the source file is present', () => {
    const path = new URL('../scripts/vendor/sha3_wasm_bg.wasm', import.meta.url);
    if (!existsSync(path)) return;
    expect(readFileSync(path).toString('base64')).toBe(POW_WASM_BASE64);
  });
});

describe('pow solver', () => {
  it('reproduces a recorded challenge/answer pair', async () => {
    const solver = await createPowSolver();
    expect(solver.solve(RECORDED.challenge)).toBe(RECORDED.answer);
  });

  it('is deterministic across calls', async () => {
    const solver = await createPowSolver();
    const first = solver.solve(RECORDED.challenge);
    for (let i = 0; i < 3; i += 1) expect(solver.solve(RECORDED.challenge)).toBe(first);
  });

  it('finds the smallest solution regardless of the difficulty bound', async () => {
    const solver = await createPowSolver();
    expect(solver.solve({ ...RECORDED.challenge, difficulty: 1_000_000 })).toBe(RECORDED.answer);
  });

  it('throws instead of returning garbage when no solution is in range', async () => {
    // The wasm stores `flag ^ 1` and leaves the answer slot uninitialised on failure, so a
    // solver that ignored the status flag would happily return a random number here.
    const solver = await createPowSolver();
    expect(() => solver.solve({ ...RECORDED.challenge, salt: 'ffffdddda7708462ddd2' })).toThrow(/pow_no_solution/);
    expect(() => solver.solve({ ...RECORDED.challenge, difficulty: 100 })).toThrow(/pow_no_solution/);
    expect(() => solver.solve({ ...RECORDED.challenge, challenge: '00'.repeat(32) })).toThrow(/pow_no_solution/);
  });

  it('builds the header DeepSeek expects', async () => {
    const solver = await createPowSolver();
    const header = solver.header(RECORDED.challenge, RECORDED.answer);
    const decoded = JSON.parse(new TextDecoder().decode(decodeBase64(header)));
    expect(decoded).toEqual({
      algorithm: 'DeepSeekHashV1',
      challenge: RECORDED.challenge.challenge,
      salt: RECORDED.challenge.salt,
      answer: RECORDED.answer,
      signature: RECORDED.challenge.signature,
      target_path: '/api/v0/chat/completion',
    });
  });

  it('round-trips arbitrary bytes through base64', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 128, 127]);
    expect(Array.from(decodeBase64(base64FromBytes(bytes)))).toEqual(Array.from(bytes));
  });
});
