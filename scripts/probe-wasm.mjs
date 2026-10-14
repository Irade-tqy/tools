// Probe the vendored wasm: what does wasm_deepseek_hash_v1 produce, and which prefix makes
// wasm_solve succeed? Answers the "what is DeepSeekHashV1" question without guessing.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const bytes = readFileSync(new URL('../scripts/vendor/sha3_wasm_bg.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(bytes, {});
const ex = instance.exports;
const enc = new TextEncoder();
const dec = new TextDecoder();

const push = (s) => {
  const b = enc.encode(s);
  const p = ex.__wbindgen_export_0(b.length, 1) >>> 0;
  new Uint8Array(ex.memory.buffer).subarray(p, p + b.length).set(b);
  return { p, n: b.length };
};
const view = () => new DataView(ex.memory.buffer);

function callHash(input) {
  const sp = ex.__wbindgen_add_to_stack_pointer(-16);
  const s = push(input);
  ex.wasm_deepseek_hash_v1(sp, s.p, s.n);
  const v = view();
  const ptr = v.getInt32(sp, true);
  const len = v.getInt32(sp + 4, true);
  const out = dec.decode(new Uint8Array(ex.memory.buffer, ptr, len));
  ex.__wbindgen_add_to_stack_pointer(16);
  ex.__wbindgen_export_2(ptr, len, 1);
  return out;
}

function callSolve(challenge, prefix, difficulty) {
  const sp = ex.__wbindgen_add_to_stack_pointer(-16);
  const a = push(challenge);
  const b = push(prefix);
  ex.wasm_solve(sp, a.p, a.n, b.p, b.n, difficulty);
  const v = view();
  const status = v.getInt32(sp, true);
  const answer = v.getFloat64(sp + 8, true);
  ex.__wbindgen_add_to_stack_pointer(16);
  return { status, answer };
}

console.log('hash("abc") =', callHash('abc'));
console.log('sha3_256("abc") =', createHash('sha3-256').digest('hex'));
console.log('sha3_256("abc") via node =', createHash('sha3-256').update('abc').digest('hex'));
console.log('keccak-ish check hash("") =', callHash(''));

// Known-good sample captured from the live app (its expireAt is unknown, so probe prefixes).
const CH = '9acdd1c4cb01c8292a8ec435a121d102c78bfd518aff8c5342af9652ca18dc4c';
const SALT = 'c57f92c8c327e496b9c2';
for (const prefix of [`${SALT}_`, `${SALT}_1791966906972_`, `${SALT}_0_`, '', SALT]) {
  const r = callSolve(CH, prefix, 144000);
  console.log(`solve(prefix=${JSON.stringify(prefix).slice(0, 34)}) ->`, r);
}
