// Proof-of-work for DeepSeek's web API, computed with DeepSeek's own wasm.
//
// /api/v0/chat/completion rejects a request without `x-ds-pow-response`. The challenge is
// hex-decoded to 32 bytes and hashed (SHA3-256) as prefix || challenge || decimal(answer);
// rather than reimplement DeepSeekHashV1 we run the vendored module (scripts/pow-vendor.mjs
// embeds it as base64, tests/pow.test.ts pins its hash).
//
// Works in Deno, node and the browser: WebAssembly + TextEncoder + atob only.

import { POW_WASM_BASE64 } from './pow-wasm.ts';

export interface PowChallenge {
  algorithm: string;
  challenge: string;
  salt: string;
  expire_at: number | string;
  difficulty: number;
  signature: string;
  target_path?: string;
}

export interface PowSolver {
  /** the decimal answer that satisfies the challenge */
  solve: (challenge: PowChallenge) => number;
  /** the x-ds-pow-response header value */
  header: (challenge: PowChallenge, answer: number, targetPath?: string) => string;
}

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

interface WasmExports {
  memory: WebAssembly.Memory;
  __wbindgen_export_0: (size: number, align: number) => number;
  __wbindgen_add_to_stack_pointer: (delta: number) => number;
  wasm_solve: (stack: number, aPtr: number, aLen: number, bPtr: number, bLen: number, difficulty: number) => void;
}

export async function createPowSolver(wasmBytes?: Uint8Array): Promise<PowSolver> {
  const bytes = wasmBytes ?? decodeBase64(POW_WASM_BASE64);
  // The buffer overload returns { instance }, but the DOM lib's WebAssembly typings only
  // declare the Response overload, so narrow it here rather than at every call site.
  const result = (await WebAssembly.instantiate(bytes, {})) as unknown as { instance: { exports: object } };
  const ex = result.instance.exports as unknown as WasmExports;
  const encoder = new TextEncoder();

  const writeString = (value: string): { ptr: number; len: number } => {
    const encoded = encoder.encode(value);
    const ptr = ex.__wbindgen_export_0(encoded.length, 1) >>> 0;
    new Uint8Array(ex.memory.buffer).subarray(ptr, ptr + encoded.length).set(encoded);
    return { ptr, len: encoded.length };
  };

  const solve = (challenge: PowChallenge): number => {
    const stack = ex.__wbindgen_add_to_stack_pointer(-16);
    try {
      const a = writeString(challenge.challenge);
      const b = writeString(`${challenge.salt}_${challenge.expire_at}_`);
      ex.wasm_solve(stack, a.ptr, a.len, b.ptr, b.len, challenge.difficulty);
      const view = new DataView(ex.memory.buffer);
      // The wasm stores `flag ^ 1`, so 1 means "solution found" (the app's own glue reads
      // `0 === status ? undefined : answer`).
      const found = view.getInt32(stack, true) === 1;
      const answer = view.getFloat64(stack + 8, true);
      if (!found || !Number.isFinite(answer)) throw new Error('pow_no_solution');
      return Math.trunc(answer);
    } finally {
      ex.__wbindgen_add_to_stack_pointer(16);
    }
  };

  const header = (challenge: PowChallenge, answer: number, targetPath = '/api/v0/chat/completion'): string =>
    base64FromBytes(
      encoder.encode(
        JSON.stringify({
          algorithm: challenge.algorithm,
          challenge: challenge.challenge,
          salt: challenge.salt,
          answer,
          signature: challenge.signature,
          target_path: targetPath,
        }),
      ),
    );

  return { solve, header };
}
