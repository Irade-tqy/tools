// Controlled experiment: let wasm_solve produce answers, then test which hash construction and
// predicate reproduces them. No guessing about the server — the wasm is the oracle.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const { instance } = await WebAssembly.instantiate(readFileSync(new URL('./vendor/sha3_wasm_bg.wasm', import.meta.url)), {});
const ex = instance.exports;
const enc = new TextEncoder();

function push(s) {
  const b = enc.encode(s);
  const p = ex.__wbindgen_export_0(b.length, 1) >>> 0;
  new Uint8Array(ex.memory.buffer).subarray(p, p + b.length).set(b);
  return { p, n: b.length };
}
function solve(ch, prefix, difficulty) {
  const sp = ex.__wbindgen_add_to_stack_pointer(-16);
  const a = push(ch);
  const b = push(prefix);
  ex.wasm_solve(sp, a.p, a.n, b.p, b.n, difficulty);
  const v = new DataView(ex.memory.buffer);
  const r = { status: v.getInt32(sp, true), answer: v.getFloat64(sp + 8, true) };
  ex.__wbindgen_add_to_stack_pointer(16);
  return r;
}

const sha3 = (parts) => {
  const h = createHash('sha3-256');
  for (const p of parts) h.update(p);
  return h.digest();
};
const P256 = 1n << 256n;
const asInt = (b) => BigInt('0x' + b.toString('hex'));

// Candidate constructions, all plausible from the wat reading.
const CANDIDATES = {
  'prefix|ch|dec': (ch, prefix, a) => [Buffer.from(prefix, 'utf8'), Buffer.from(ch, 'hex'), Buffer.from(String(a))],
  'ch|prefix|dec': (ch, prefix, a) => [Buffer.from(ch, 'hex'), Buffer.from(prefix, 'utf8'), Buffer.from(String(a))],
  'prefix|chhex|dec': (ch, prefix, a) => [Buffer.from(prefix, 'utf8'), Buffer.from(ch), Buffer.from(String(a))],
  'chhex|prefix|dec': (ch, prefix, a) => [Buffer.from(ch), Buffer.from(prefix, 'utf8'), Buffer.from(String(a))],
  'prefix|ch|hex': (ch, prefix, a) => [Buffer.from(prefix, 'utf8'), Buffer.from(ch, 'hex'), Buffer.from(a.toString(16))],
  'prefix|ch|be8': (ch, prefix, a) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(a));
    return [Buffer.from(prefix, 'utf8'), Buffer.from(ch, 'hex'), b];
  },
  'prefix|ch|le8': (ch, prefix, a) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(a));
    return [Buffer.from(prefix, 'utf8'), Buffer.from(ch, 'hex'), b];
  },
};
const PREDICATES = {
  'h*d<2^256': (h, d) => asInt(h) * BigInt(d) < P256,
  'be4<d': (h, d) => h.readUInt32BE(0) < d,
  'be8<d': (h, d) => Number(h.readBigUInt64BE(0)) < d,
  'le4<d': (h, d) => h.readUInt32LE(0) < d,
};

const CH = '9acdd1c4cb01c8292a8ec435a121d102c78bfd518aff8c5342af9652ca18dc4c';
const cases = [];
for (const difficulty of [1, 2, 5, 10, 100, 1000, 144000]) {
  for (const prefix of ['c57f92c8c327e496b9c2_1791965776617_', 'salt_', '']) {
    cases.push({ prefix, difficulty });
  }
}

let successes = 0;
const scores = {};
for (const { prefix, difficulty } of cases) {
  const r = solve(CH, prefix, difficulty);
  const line = `d=${String(difficulty).padEnd(7)} prefix=${JSON.stringify(prefix).slice(0, 26).padEnd(28)} status=${r.status} answer=${r.status === 0 ? r.answer : '-'}`;
  if (r.status !== 0) {
    console.log(line);
    continue;
  }
  successes += 1;
  const notes = [];
  for (const [cname, cf] of Object.entries(CANDIDATES)) {
    for (const [pname, pf] of Object.entries(PREDICATES)) {
      // the wasm's answer must satisfy the predicate, and every smaller answer must fail
      const okAt = (a) => pf(sha3(cf(CH, prefix, a)), difficulty);
      if (!okAt(r.answer)) continue;
      let first = true;
      for (let a = 0; a < r.answer; a++) {
        if (okAt(a)) {
          first = false;
          break;
        }
      }
      notes.push(`${cname} & ${pname}${first ? ' (FIRST)' : ''}`);
      const key = `${cname} & ${pname}`;
      scores[key] = (scores[key] || 0) + (first ? 1 : 0);
    }
  }
  console.log(`${line}  matches: ${notes.join(' | ') || 'NONE'}`);
}
console.log(`\nsuccesses: ${successes}/${cases.length}`);
console.log('scores (times this construction+predicate reproduced the FIRST hit):');
for (const [k, v] of Object.entries(scores).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
