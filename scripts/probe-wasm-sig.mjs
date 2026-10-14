// Minimal WASM section reader: prints the exact signature of each exported function.
import { readFileSync } from 'node:fs';

const buf = readFileSync(new URL('./vendor/sha3_wasm_bg.wasm', import.meta.url));
let pos = 8; // magic + version

function leb() {
  let result = 0;
  let shift = 0;
  for (;;) {
    const byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) break;
    shift += 7;
  }
  return result >>> 0;
}

const types = [];
const funcType = [];
const exports = [];

while (pos < buf.length) {
  const id = buf[pos++];
  const size = leb();
  const end = pos + size;
  if (id === 1) {
    const n = leb();
    for (let i = 0; i < n; i++) {
      if (buf[pos++] !== 0x60) throw new Error('bad functype');
      const np = leb();
      const params = [];
      for (let j = 0; j < np; j++) params.push(valType(buf[pos++]));
      const nr = leb();
      const results = [];
      for (let j = 0; j < nr; j++) results.push(valType(buf[pos++]));
      types.push({ params, results });
    }
  } else if (id === 3) {
    const n = leb();
    for (let i = 0; i < n; i++) funcType.push(leb());
  } else if (id === 7) {
    const n = leb();
    for (let i = 0; i < n; i++) {
      const len = leb();
      const name = buf.subarray(pos, pos + len).toString();
      pos += len;
      const kind = buf[pos++];
      const idx = leb();
      exports.push({ name, kind, idx });
    }
  }
  pos = end;
}

function valType(b) {
  return { 0x7f: 'i32', 0x7e: 'i64', 0x7d: 'f32', 0x7c: 'f64' }[b] || `0x${b.toString(16)}`;
}

for (const e of exports) {
  if (e.kind !== 0) {
    console.log(`${e.name} kind=${e.kind}`);
    continue;
  }
  const t = types[funcType[e.idx]];
  console.log(`${e.name}(${t.params.join(', ')}) -> ${t.results.join(', ') || 'void'}`);
}
