#!/usr/bin/env node
// Remote browser on a port: drive the DeepSeek sign-in from another machine.
//
// The machine has no VNC stack, and the login needs a human (fengkongcloud image CAPTCHA)
// plus the SMS code. So: a headless Chromium driven by Playwright, streamed as a JPEG
// snapshot over HTTP, with clicks / keys / wheel forwarded back. Open the printed URL over
// Tailscale, solve the CAPTCHA, type the SMS code, then press 导出 Cookie.
//
//   node scripts/browser-relay.mjs [--port 8888] [--phone 17317329061]
//                                  [--url https://chat.deepseek.com/sign_in]
//                                  [--idle-timeout 1800] [--headful]
//
// The profile (.tmp/deepseek-profile) is persistent, so the session survives a restart and
// scripts/deepseek-login.mjs can reuse it.
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { env, exportDeepseekCookie, exportDeepseekToken, rootDir } from './lib.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback = '') => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const value = args[i + 1];
  return value && !value.startsWith('--') ? value : fallback;
};

const PORT = Number(flag('--port', env.TOOLS_RELAY_PORT || '8888'));
const HOST = flag('--host', '0.0.0.0');
const START_URL = flag('--url', 'https://chat.deepseek.com/sign_in');
const PHONE = (flag('--phone', env.TOOLS_DEEPSEEK_PHONE || '')).replace(/\D/g, '');
const IDLE_MS = Number(flag('--idle-timeout', '1800')) * 1000;
const headless = !args.includes('--headful');

const profileDir = resolve(rootDir, '.tmp/deepseek-profile');
mkdirSync(profileDir, { recursive: true, mode: 0o700 });

const log = (...parts) => console.log(`${new Date().toISOString().slice(11, 19)} ${parts.join(' ')}`);

const { chromium } = await import('playwright');

// Prefer a system Chrome/Chromium: Playwright's own headless shell is not always downloaded,
// and a real Chrome binary also looks less like a bot to the CAPTCHA provider.
async function findBrowser() {
  const { existsSync } = await import('node:fs');
  const candidates = [
    process.env.PLAYWRIGHT_BROWSER_PATH,
    '/usr/bin/google-chrome',
    '/snap/bin/chromium',
  ].filter(Boolean);
  return candidates.find((path) => existsSync(path));
}

const executablePath = await findBrowser();
const context = await chromium.launchPersistentContext(profileDir, {
  headless,
  executablePath,
  viewport: { width: 1280, height: 900 },
  locale: 'zh-CN',
  userAgent:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  args: ['--no-first-run', '--no-default-browser-check'],
});
const page = context.pages()[0] || (await context.newPage());
let active = page;

// TCaptcha (and friends) often open the challenge in a separate popup window, so the relay
// has to follow the newest window and fall back when it closes.
context.on('page', async (p) => {
  log(`popup opened: ${p.url()}`);
  try {
    await p.waitForLoadState('domcontentloaded', { timeout: 15_000 });
  } catch {}
  active = p;
  log(`focus -> ${p.url()}`);
});

function P() {
  if (active && !active.isClosed()) return active;
  const open = context.pages().filter((p) => !p.isClosed() && p.url() !== 'about:blank');
  active = open[open.length - 1] || context.pages().find((p) => !p.isClosed()) || page;
  return active;
}

let lastTouch = Date.now();
const touch = () => {
  lastTouch = Date.now();
};

async function state() {
  const cookies = await context.cookies('https://chat.deepseek.com');
  const auth = cookies.find(
    (c) => /session|auth|token/i.test(c.name) && c.name !== 'ds_session_id' && String(c.value).length > 20,
  );
  const captcha = await page
    .evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('iframe,img,div'));
      return nodes.some((n) =>
        /fengkongcloud|captcha|geetest|tcaptcha/i.test(`${n.src || ''} ${n.className || ''} ${n.id || ''}`),
      );
    })
    .catch(() => false);
  return {
    url: P().url(),
    title: await P().title().catch(() => ''),
    windows: context.pages().filter((p) => !p.isClosed()).length,
    signedIn: Boolean(auth) && !/sign_in/.test(P().url()),
    captcha,
    cookieNames: cookies.map((c) => c.name),
  };
}

const CLIENT = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DeepSeek 远程登录</title>
<style>
 body{margin:0;background:#0e1116;color:#e6edf3;font:14px/1.5 system-ui,"Noto Sans SC",sans-serif}
 #bar{position:sticky;top:0;display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:8px 10px;background:#151a21;border-bottom:1px solid #232c38;z-index:5}
 button,input{font:inherit;border-radius:7px;border:1px solid #2b3644;background:#1b222b;color:#e6edf3;padding:6px 10px}
 button{cursor:pointer}button:hover{border-color:#3b4a5c}
 #go{background:#4c8dff;border-color:#4c8dff;color:#fff}
 #wrap{display:flex;justify-content:center;padding:10px}
 #shot{max-width:100%;height:auto;border:1px solid #232c38;border-radius:8px;cursor:crosshair;touch-action:manipulation}
 #st{font-size:12px;color:#97a4b3;margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:38vw}
 .ok{color:#35b46a}.warn{color:#d9a13b}
</style></head><body>
<div id="bar">
  <button id="reload">重载官网</button>
  <button id="win">切换窗口</button>
  <button id="send">发送验证码</button>
  <button id="solve">自动解验证码</button>
  <button id="go">导出 Cookie</button>
  <input id="txt" placeholder="输入文本/验证码" style="width:150px">
  <button id="type">输入</button>
  <button id="enter">回车</button>
  <button id="esc">关闭</button>
  <span id="st">连接中…</span>
</div>
<div id="wrap"><img id="shot" alt="DeepSeek"></div>
<script>
const img=document.getElementById('shot'),st=document.getElementById('st');
let busy=false,src='';
async function post(path,body){
  const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});
  return r.json().catch(()=>({}));
}
async function shoot(){
  if(busy)return;busy=true;
  try{
    const r=await fetch('/shot.jpg?ts='+Date.now());
    if(r.ok){
      const blob=await r.blob();
      if(src)URL.revokeObjectURL(src);
      src=URL.createObjectURL(blob);img.src=src;
    }
  }finally{busy=false}
}
async function poll(){
  try{
    const s=await (await fetch('/state')).json();
    st.innerHTML=(s.signedIn?'<span class=ok>已登录</span>':s.captcha?'<span class=warn>有验证码：请在图上点选/拖动</span>':'等待中')+' · '+(s.windows>1?s.windows+' 个窗口 · ':'')+s.url.replace('https://','');
  }catch(e){st.textContent='连接断开'}
}
function coords(e){
  const r=img.getBoundingClientRect();
  return {x:Math.round((e.clientX-r.left)*(img.naturalWidth/r.width)),y:Math.round((e.clientY-r.top)*(img.naturalHeight/r.height))};
}
let down=null;
img.addEventListener('mousedown',e=>{down=coords(e);e.preventDefault()});
img.addEventListener('mouseup',async e=>{
  const up=coords(e);
  if(down&&Math.hypot(up.x-down.x,up.y-down.y)>12){await post('/drag',{x1:down.x,y1:down.y,x2:up.x,y2:up.y})}
  else{await post('/click',up)}
  down=null;shoot();
});
img.addEventListener('contextmenu',async e=>{e.preventDefault();await post('/click',{...coords(e),button:'right'});shoot()});
const tp=(t)=>{const r=img.getBoundingClientRect();const p=t.touches[0]||t.changedTouches[0];return {x:Math.round((p.clientX-r.left)*(img.naturalWidth/r.width)),y:Math.round((p.clientY-r.top)*(img.naturalHeight/r.height))}};
img.addEventListener('touchstart',e=>{down=tp(e)},{passive:true});
img.addEventListener('touchend',async e=>{
  const up=tp(e);
  if(down&&Math.hypot(up.x-down.x,up.y-down.y)>12){await post('/drag',{x1:down.x,y1:down.y,x2:up.x,y2:up.y})}
  else{await post('/click',up)}
  down=null;shoot();
});
img.addEventListener('wheel',async e=>{e.preventDefault();await post('/wheel',{x:coords(e).x,y:coords(e).y,dy:Math.round(e.deltaY)});shoot()},{passive:false});
document.addEventListener('keydown',async e=>{
  if(e.target.id==='txt')return;
  if(e.key==='Enter'){await post('/key',{key:'Enter'})}
  else if(e.key==='Backspace'){await post('/key',{key:'Backspace'})}
  else if(e.key==='Escape'){await post('/key',{key:'Escape'})}
  else if(e.key.length===1){await post('/type',{text:e.key})}
  else return;
  e.preventDefault();shoot();
});
async function act(path,body,btn){
  const el=document.getElementById(btn);if(el)el.disabled=true;
  try{const r=await post(path,body);if(r.note)st.textContent=r.note;}finally{if(el)el.disabled=false}
  shoot();
}
document.getElementById('reload').onclick=()=>act('/goto',{url:'https://chat.deepseek.com/sign_in'},'reload');
document.getElementById('win').onclick=async()=>{
  const r=await fetch('/pages').then(x=>x.json()).catch(()=>({pages:[]}));
  const ps=r.pages||[];
  if(ps.length<2){st.textContent='只有 1 个窗口';return}
  const i=ps.findIndex(p=>p.focused);
  const next=ps[(i+1)%ps.length];
  await act('/focus',{url:next.url},'win');
};
document.getElementById('send').onclick=()=>act('/send-code',{},'send');
document.getElementById('go').onclick=()=>act('/export',{},'go');
document.getElementById('solve').onclick=()=>act('/solve-shumei',{},'solve');
document.getElementById('enter').onclick=()=>act('/key',{key:'Enter'},'enter');
document.getElementById('esc').onclick=()=>act('/key',{key:'Escape'},'esc');
document.getElementById('type').onclick=()=>{const v=document.getElementById('txt').value;if(v)act('/type',{text:v},'type')};
document.getElementById('txt').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();document.getElementById('type').click()}});
setInterval(shoot,900);setInterval(poll,2500);shoot();poll();
</script></body></html>`;

async function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function body(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const SHUMEI_COLORS = {
  黄: '(r,g,b)=>r>150&&g>110&&b<Math.min(r,g)-45',
  橙: '(r,g,b)=>r>170&&g>80&&g<175&&b<g-45',
  红: '(r,g,b)=>r>130&&g<95&&b<95&&r-g>55',
  蓝: '(r,g,b)=>b>140&&b-r>45&&b-g>20',
  绿: '(r,g,b)=>g>110&&g-r>30&&g-b>30',
  紫: '(r,g,b)=>b>130&&r>90&&b-g>45',
  粉: '(r,g,b)=>r>180&&g>110&&g<200&&b>120&&r-b>40',
  白: '(r,g,b)=>r>205&&g>205&&b>205',
  黑: '(r,g,b)=>r<60&&g<60&&b<60',
};

// Flood-fill one colour inside the puzzle image; runs in the page so the bitmap can be decoded
// without a Node image dependency. Anti-aliased shapes get merged back together by proximity.
function buildShumeiScan(src, predicate) {
  return `(async () => {
  const resp = await fetch(${JSON.stringify(src)}, { mode: 'cors' });
  const bmp = await createImageBitmap(await resp.blob());
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0);
  const img = g.getImageData(0, 0, bmp.width, bmp.height);
  const data = img.data, width = img.width, height = img.height;
  const hit = ${predicate};
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    if (hit(data[o], data[o + 1], data[o + 2])) mask[i] = 1;
  }
  const seen = new Uint8Array(width * height);
  const raw = [];
  const stack = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = y * width + x;
      if (seen[start] || !mask[start]) continue;
      let area = 0, sx = 0, sy = 0, minX = x, maxX = x, minY = y, maxY = y;
      stack.push(start); seen[start] = 1;
      while (stack.length) {
        const j = stack.pop();
        const jx = j % width, jy = (j - jx) / width;
        area++; sx += jx; sy += jy;
        if (jx < minX) minX = jx; if (jx > maxX) maxX = jx;
        if (jy < minY) minY = jy; if (jy > maxY) maxY = jy;
        const nb = [j - 1, j + 1, j - width, j + width];
        for (let n = 0; n < 4; n++) {
          const k = nb[n];
          if (k < 0 || k >= width * height) continue;
          if (n < 2 && Math.floor(k / width) !== jy) continue;
          if (seen[k]) continue;
          seen[k] = 1;
          if (mask[k]) stack.push(k);
        }
      }
      if (area >= 8) raw.push({ cx: sx / area, cy: sy / area, area, w: maxX - minX + 1, h: maxY - minY + 1 });
    }
  }
  const merged = [];
  for (const b of raw) {
    let joined = false;
    for (const m of merged) {
      if (Math.abs(m.cx - b.cx) < 14 && Math.abs(m.cy - b.cy) < 14) {
        m.area += b.area; m.cx = (m.cx * (m.area - b.area) + b.cx * b.area) / m.area; m.cy = (m.cy * (m.area - b.area) + b.cy * b.area) / m.area;
        m.w = Math.max(m.w, b.w); m.h = Math.max(m.h, b.h); joined = true; break;
      }
    }
    if (!joined) merged.push({ ...b });
  }
  merged.sort((a, b) => a.area - b.area);
  return { width, height, blobs: merged.slice(0, 30).map((b) => ({ cx: Math.round(b.cx), cy: Math.round(b.cy), area: b.area, w: b.w, h: b.h })) };
})()`;
}

// Record what the web app actually sends upstream — the auth scheme is not documented, so the
// only trustworthy source is the browser's own request.
const netLog = [];
const NET_RE = /api\.deepseek\.com|chat\.deepseek\.com\/api|\/chat\/completions/i;
context.on('request', (req) => {
  if (!NET_RE.test(req.url())) return;
  netLog.push({
    ts: Date.now(),
    method: req.method(),
    url: req.url().slice(0, 160),
    headers: req.headers(),
    postData: (req.postData() || '').slice(0, 900),
    status: null,
  });
  if (netLog.length > 40) netLog.shift();
  const entry = netLog[netLog.length - 1];
  req.response().then((r) => {
    entry.status = r.status();
  }).catch(() => {});
});

const server = createServer(async (req, res) => {
  touch();
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  try {
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(CLIENT);
      return;
    }
    if (path === '/shot.jpg') {
      const shot = await P().screenshot({ type: 'jpeg', quality: 60 });
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
      res.end(shot);
      return;
    }
    if (path === '/state') {
      await json(res, await state());
      return;
    }
    if (path === '/workers') {
      await json(res, { ok: true, workers: P().workers().map((w) => ({ url: w.url() })) });
      return;
    }
    if (path === '/worker-js') {
      // The PoW miner runs in a dedicated worker; Playwright can evaluate inside it, which is how
      // we get to read the real hash rule instead of guessing it.
      const needle = String(data.url || '');
      const workers = P().workers();
      const w = needle ? workers.find((x) => x.url().includes(needle)) : workers[workers.length - 1];
      if (!w) {
        await json(res, { ok: false, error: 'no matching worker', workers: workers.map((x) => x.url()) }, 404);
        return;
      }
      const value = await w.evaluate(String(data.expr || 'null'));
      await json(res, { ok: true, url: w.url(), value });
      return;
    }
    if (path === '/net') {
      const raw = url.searchParams.has('raw');
      const redact = (v) => (v && v.length > 12 ? `${v.slice(0, 10)}…${v.slice(-4)} (len ${v.length})` : v);
      const entries = netLog.map((e) => ({
        method: e.method,
        url: e.url,
        status: e.status,
        postData: e.postData,
        headers: Object.fromEntries(
          Object.entries(e.headers)
            .filter(([k]) => !['cookie', 'accept-encoding', 'accept-language', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'referer', 'user-agent', 'priority', 'content-length'].includes(k))
            .map(([k, v]) => [k, !raw && /authorization|token|auth|x-/.test(k) ? redact(v) : v]),
        ),
      }));
      await json(res, { ok: true, count: entries.length, entries: entries.slice(-12) });
      return;
    }
    if (path === '/pages') {
      const list = [];
      for (const p of context.pages()) {
        if (p.isClosed()) continue;
        list.push({ url: p.url(), title: await p.title().catch(() => ''), focused: p === P() });
      }
      await json(res, { ok: true, pages: list });
      return;
    }
    if (req.method !== 'POST') {
      await json(res, { error: 'use POST' }, 405);
      return;
    }
    const data = await body(req);

    if (path === '/click') {
      await P().mouse.click(Math.round(data.x || 0), Math.round(data.y || 0), {
        button: data.button === 'right' ? 'right' : 'left',
      });
      await json(res, { ok: true });
      return;
    }
    if (path === '/move') {
      await P().mouse.move(Math.round(data.x || 0), Math.round(data.y || 0));
      await json(res, { ok: true });
      return;
    }
    if (path === '/wheel') {
      await P().mouse.move(Math.round(data.x || 0), Math.round(data.y || 0));
      await P().mouse.wheel(0, Math.round(data.dy || 0));
      await json(res, { ok: true });
      return;
    }
    if (path === '/drag') {
      // TCaptcha sliders need a press-move-release gesture; a plain click does nothing.
      const x1 = Math.round(data.x1 || 0);
      const y1 = Math.round(data.y1 || 0);
      const x2 = Math.round(data.x2 || x1 + 300);
      const y2 = Math.round(data.y2 || y1);
      const steps = Math.max(4, Math.round(data.steps || 24));
      await P().mouse.move(x1, y1);
      await P().mouse.down();
      await P().waitForTimeout(120);
      for (let i = 1; i <= steps; i += 1) {
        const t = i / steps;
        await P().mouse.move(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, { steps: 2 });
      }
      await P().waitForTimeout(120);
      await P().mouse.up();
      await json(res, { ok: true });
      return;
    }
    if (path === '/click-text') {
      const text = String(data.text || '');
      const selector = String(data.selector || '');
      const target = selector ? P().locator(selector).first() : P().getByText(new RegExp(text, 'i')).first();
      await target.click({ timeout: 8_000 });
      await json(res, { ok: true, note: `已点击 ${selector || text}` });
      return;
    }
    if (path === '/focus') {
      const needle = String(data.url || '');
      const match = context.pages().filter((p) => !p.isClosed()).find((p) => p.url().includes(needle));
      if (!match) {
        await json(res, { ok: false, error: `no open page matching ${needle}` }, 404);
        return;
      }
      active = match;
      await match.bringToFront().catch(() => {});
      await json(res, { ok: true, note: `已切到 ${match.url()}` });
      return;
    }
    if (path === '/solve-shumei') {
      // DeepSeek's captcha is Shumei (数美) "click the N-th coloured object". No vision model is
      // wired up here, so solve it by colour segmentation: fetch the puzzle bitmap inside the page
      // (CORS, so the canvas stays untainted), flood-fill matching pixels, and click the centroid
      // of the smallest/largest blob the instruction asks for.
      const info = await P().evaluate(() => {
        const wrap = document.querySelector('[id$="shumei_captcha_wrapper"]') || document.querySelector('.shumei_captcha_wrapper');
        const img = document.querySelector('img.shumei_captcha_loaded_img_bg') || (wrap && wrap.querySelector('img'));
        if (!img) return null;
        const tips = document.querySelector('.shumei_captcha_slide_tips') || wrap;
        const r = img.getBoundingClientRect();
        return {
          instruction: ((tips && tips.innerText) || '').trim(),
          src: img.src,
          rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        };
      });
      if (!info) {
        await json(res, { ok: false, error: '页面上没有数美验证码' }, 404);
        return;
      }
      const instruction = info.instruction;
      const colorKey = Object.keys(SHUMEI_COLORS).find((k) => instruction.includes(k)) || '黄';
      const wantLargest = /最大/.test(instruction);
      const wantsSequence = /依次|按顺序/.test(instruction);
      const scan = await P().evaluate(
        buildShumeiScan(info.src, SHUMEI_COLORS[colorKey]),
      );
      const blobs = (scan.blobs || []).filter((b) => b.area >= 12);
      blobs.sort((a, b) => (wantLargest ? b.area - a.area : a.area - b.area));
      const target = blobs[0];
      const out = {
        ok: Boolean(target),
        instruction,
        colorKey,
        wantLargest,
        wantsSequence,
        image: { w: scan.width, h: scan.height, shown: Math.round(info.rect.w) },
        blobs: blobs.slice(0, 8),
        target: target || null,
      };
      if (!target) {
        await json(res, { ...out, error: '没找到符合颜色的色块' }, 422);
        return;
      }
      const x = info.rect.x + target.cx * (info.rect.w / scan.width);
      const y = info.rect.y + target.cy * (info.rect.h / scan.height);
      out.clicked = { x: Math.round(x), y: Math.round(y) };
      if (!data.preview) {
        await P().mouse.move(Math.round(x) - 14, Math.round(y) - 9);
        await P().waitForTimeout(90);
        await P().mouse.move(Math.round(x), Math.round(y), { steps: 6 });
        await P().waitForTimeout(70);
        await P().mouse.click(Math.round(x), Math.round(y));
        const confirm = P().locator('[id$="shumei_captcha_wrapper"] button, .shumei_captcha_wrapper button').filter({ hasText: /确认|提交|完成/ }).first();
        if (await confirm.count().catch(() => 0)) {
          await confirm.click({ timeout: 3_000 }).catch(() => {});
          out.confirmed = true;
        }
        out.note = `已点击 ${colorKey}色${wantLargest ? '最大' : '最小'}色块（面积 ${target.area}px）`;
      } else {
        out.note = '只分析未点击';
      }
      await json(res, out);
      return;
    }
    if (path === '/js') {
      // Escape hatch for the CAPTCHA: run one expression in the page (or in a cross-origin
      // iframe selected by a URL substring) and read the result back.
      const expr = String(data.expr || 'null');
      const needle = String(data.frame || '');
      if (needle) {
        const handle = await P().evaluateHandle(
          (n) => Array.from(document.querySelectorAll('iframe')).find((f) => (f.src || '').includes(n)),
          needle,
        );
        const element = handle.asElement();
        if (!element) {
          await json(res, { ok: false, error: `no iframe matching ${needle}` }, 404);
          return;
        }
        const offset = await element.boundingBox().catch(() => null);
        const frame = await element.contentFrame();
        if (!frame) {
          await json(res, { ok: false, error: 'iframe has no accessible frame (cross-origin?)' }, 404);
          return;
        }
        const value = await frame.evaluate(expr);
        await json(res, { ok: true, offset, value });
        return;
      }
      const value = await P().evaluate(expr);
      await json(res, { ok: true, value });
      return;
    }
    if (path === '/type') {
      await P().keyboard.type(String(data.text || ''), { delay: 40 });
      await json(res, { ok: true });
      return;
    }
    if (path === '/key') {
      await P().keyboard.press(String(data.key || 'Enter'));
      await json(res, { ok: true });
      return;
    }
    if (path === '/goto') {
      await P().goto(String(data.url || START_URL), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await json(res, { ok: true, note: `已跳转 ${P().url()}` });
      return;
    }
    if (path === '/send-code') {
      const button = P().getByText(/发送验证码|获取验证码/).first();
      await button.click({ timeout: 8_000 });
      await json(res, { ok: true, note: '已点击发送验证码；若出现验证码请在图上点选' });
      return;
    }
    if (path === '/export') {
      const cookies = await context.cookies(['https://chat.deepseek.com', 'https://api.deepseek.com']);
      const result = exportDeepseekCookie(cookies);
      // The real credential is localStorage.userToken (the app sends it as a Bearer token).
      const userToken = await P()
        .evaluate(() => {
          try {
            const raw = localStorage.getItem('userToken');
            return raw ? (JSON.parse(raw).value || raw) : '';
          } catch {
            return '';
          }
        })
        .catch(() => '');
      const tokenResult = exportDeepseekToken(userToken);
      const current = await state();
      await json(res, {
        ...result,
        token: tokenResult,
        signedIn: current.signedIn || tokenResult.written,
        note: tokenResult.written
          ? `已写入 DEEPSEEK_WEB_TOKEN（${tokenResult.length} 字符）+ DEEPSEEK_WEB_COOKIE`
          : result.written
            ? '只写入了 Cookie；还没登录，所以没有 userToken'
            : '还没有 deepseek.com 的 cookie，先完成登录',
      });
      log(`export: token=${tokenResult.written} cookie=${result.written} signedIn=${current.signedIn}`);
      return;
    }
    await json(res, { error: `unknown ${path}` }, 404);
  } catch (err) {
    await json(res, { error: String(err && err.message ? err.message : err) }, 500);
  }
});

server.listen(PORT, HOST, async () => {
  log(`relay on http://${HOST}:${PORT}/  (browser ${headless ? 'headless' : 'headed'})`);
  try {
    await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    log(`opened ${page.url()}`);
    if (PHONE) {
      const phoneInput = page.locator('input[placeholder="请输入手机号"]').first();
      await phoneInput.waitFor({ state: 'visible', timeout: 15_000 });
      await phoneInput.fill(PHONE);
      log(`phone pre-filled: ${PHONE.slice(0, 3)}****${PHONE.slice(-4)}`);
    }
  } catch (err) {
    log(`initial navigation failed: ${err.message}`);
  }
});

const idle = setInterval(() => {
  if (Date.now() - lastTouch > IDLE_MS) {
    log(`idle for ${Math.round(IDLE_MS / 60000)} min — shutting down`);
    clearInterval(idle);
    server.close();
    context.close().finally(() => process.exit(0));
  }
}, 15_000);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('signal — closing');
    server.close();
    context.close().finally(() => process.exit(0));
  });
}
