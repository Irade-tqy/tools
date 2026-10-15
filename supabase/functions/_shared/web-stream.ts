// DeepSeek's *web* stream protocol, decoded. Pure — no fetch, no Deno globals — so vitest
// can replay recorded streams (tests/fixtures/stream-*.txt) against it, and both the Edge
// Function and the node probe import this one implementation.
//
// What the wire actually looks like (recorded from chat.deepseek.com):
//
//   event: ready                     {"request_message_id":1,"response_message_id":2,…}
//   data: {"v":{"response":{…,"fragments":[{"id":2,"type":"RESPONSE","content":"OK"}]}}}
//   data: {"v":"OK"}                                            whole-delta for the last fragment
//   data: {"p":"response/fragments","o":"APPEND","v":[{…}]}     a new fragment starts
//   data: {"p":"content","o":"APPEND","v":"…"}                  delta for the current fragment
//   data: {"p":"results","o":"SET","v":[{cite_index:1,…}]}      search results
//   data: {"p":"response","o":"BATCH","v":[…]}                  several patches at once
//   data: {"p":"response/status","o":"SET","v":"FINISHED"}      turn over
//   event: title / update_session / close
//
// The trap: a message is not one text stream. It is a list of *fragments*, each typed
// RESPONSE / THINK / SEARCH / TOOL_SEARCH / TOOL_OPEN / TOOL_FIND / TIP / FILE. Only
// RESPONSE is the answer; concatenating everything (the obvious first attempt) leaks tool
// chatter into the reply and drops the first delta of every new fragment.

export const ANSWER_TYPES = new Set(['RESPONSE', 'TEMPLATE_RESPONSE']);
export const THINK_TYPES = new Set(['THINK']);
export const TOOL_TYPES = new Set(['SEARCH', 'TOOL_SEARCH', 'TOOL_OPEN', 'TOOL_FIND', 'TIP', 'FILE']);

export interface WebResult {
  cite_index: number | null;
  title: string;
  url: string;
  site_name: string;
  snippet: string;
}

export interface WebTool {
  id: number;
  type: string;
  status: string;
  /** the fragment's own label, e.g. "搜索到 6 个网页" */
  label: string;
  queries: string[];
  results: WebResult[];
  /** TOOL_OPEN carries a single page it opened */
  page: { url: string; title: string } | null;
}

export interface WebStreamState {
  text: string;
  thinking: string;
  finished: boolean;
  failed: string | null;
  mode: string;
  searchTriggered: boolean;
  tools: WebTool[];
  /** TOOL_OPEN pages in arrival order — `[reference:N]` indexes into this, 0-based. */
  opened: { id: number; url: string }[];
  fragments: Map<number, { type: string; len: number }>;
  currentId: number | null;
  requestMessageId: number | null;
  responseMessageId: number | null;
  title: string;
  tokenUsage: number;
  /** ms epoch of the first answer delta, for latency accounting */
  firstDeltaAt: number | null;
  eventNames: string[];
  frames: number;
}

export function createWebStreamState(): WebStreamState {
  return {
    text: '',
    thinking: '',
    finished: false,
    failed: null,
    mode: 'DEFAULT',
    searchTriggered: false,
    tools: [],
    opened: [],
    fragments: new Map(),
    currentId: null,
    requestMessageId: null,
    responseMessageId: null,
    title: '',
    tokenUsage: 0,
    firstDeltaAt: null,
    eventNames: [],
    frames: 0,
  };
}

// ---------------------------------------------------------------------------
// SSE framing (event: + data:, blank-line separated, chunk boundaries anywhere)
// ---------------------------------------------------------------------------

export interface WebFrame {
  event: string;
  data: string;
}

export interface WebFrameParser {
  (text: string): WebFrame[];
  /** Emit the trailing frame when the stream ends without a final blank line. */
  flush(): WebFrame[];
}

function framesFromBlock(block: string): WebFrame[] {
  let name = 'message';
  let data = '';
  for (const line of block.split(/\r\n|\n|\r/)) {
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  return data ? [{ event: name, data }] : [];
}

export function createWebFrameParser(): WebFrameParser {
  let buffer = '';
  const parse = ((text: string) => {
    buffer += text;
    const frames: WebFrame[] = [];
    const parts = buffer.split(/\r\n\r\n|\n\n|\r\r/);
    buffer = parts.pop() ?? '';
    for (const part of parts) frames.push(...framesFromBlock(part));
    return frames;
  }) as WebFrameParser;

  parse.flush = () => {
    const rest = buffer;
    buffer = '';
    return rest.trim() ? framesFromBlock(rest) : [];
  };
  return parse;
}

// ---------------------------------------------------------------------------
// result / tool helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toResult(value: unknown): WebResult | null {
  const raw = asRecord(value);
  const url = str(raw.url);
  const title = str(raw.title);
  if (!url && !title) return null;
  const cite = typeof raw.cite_index === 'number' ? raw.cite_index : null;
  return {
    cite_index: cite,
    title: title.slice(0, 300),
    url,
    site_name: str(raw.site_name),
    snippet: str(raw.snippet ?? raw.web_snippet).slice(0, 400),
  };
}

function resultKey(result: WebResult): string {
  return `${result.cite_index ?? ''}|${result.url || result.title}`;
}

function toolFor(state: WebStreamState, id: number, type?: string): WebTool {
  let tool = state.tools.find((t) => t.id === id);
  if (!tool) {
    tool = { id, type: type ?? 'UNKNOWN', status: 'WIP', label: '', queries: [], results: [], page: null };
    state.tools.push(tool);
  }
  if (type) tool.type = type;
  return tool;
}

function currentTool(state: WebStreamState): WebTool | null {
  // Only SEARCH / TOOL_* fragments carry tool payloads. A status patch on a RESPONSE
  // fragment must not invent a phantom tool.
  const frag = state.currentId === null ? undefined : state.fragments.get(state.currentId);
  if (!frag || !TOOL_TYPES.has(frag.type)) return null;
  return toolFor(state, state.currentId as number, frag.type);
}

function addResults(tool: WebTool, values: unknown[]): void {
  for (const value of values) {
    const result = toResult(value);
    if (!result) continue;
    const key = resultKey(result);
    if (tool.results.some((r) => resultKey(r) === key)) continue;
    tool.results.push(result);
  }
}

// ---------------------------------------------------------------------------
// content routing
// ---------------------------------------------------------------------------

export interface WebDelta {
  /** answer text (RESPONSE fragments only) */
  text: string;
  /** reasoning text (THINK fragments only) */
  thinking: string;
  /** a tool payload changed: the caller may want to surface it */
  tool: WebTool | null;
}

type Emit = (delta: WebDelta) => void;

function appendContent(state: WebStreamState, id: number | null, chunk: string, emit: Emit): void {
  if (!chunk) return;
  const frag = state.fragments.get(id ?? -1) ?? { type: 'RESPONSE', len: 0 };
  frag.len += chunk.length;
  if (id !== null) state.fragments.set(id, frag);

  if (TOOL_TYPES.has(frag.type)) {
    const tool = toolFor(state, id as number, frag.type);
    tool.label += chunk;
    emit({ text: '', thinking: '', tool });
    return;
  }
  if (THINK_TYPES.has(frag.type)) {
    state.thinking += chunk;
    emit({ text: '', thinking: chunk, tool: null });
    return;
  }
  if (state.firstDeltaAt === null) state.firstDeltaAt = Date.now();
  state.text += chunk;
  emit({ text: chunk, thinking: '', tool: null });
}

function setContent(state: WebStreamState, id: number | null, value: unknown, emit: Emit): void {
  // A BATCH sets a fragment's content outright (the SEARCH fragment gets its
  // "搜索到 N 个网页" label this way). Emit only what the stream has not already delivered.
  if (typeof value !== 'string') return;
  const frag = state.fragments.get(id ?? -1) ?? { type: 'RESPONSE', len: 0 };
  if (value.length <= frag.len) return;
  appendContent(state, id, value.slice(frag.len), emit);
}

function registerFragment(state: WebStreamState, value: unknown, emit: Emit): void {
  const f = asRecord(value);
  if (typeof f.id !== 'number') return;
  const id = f.id;
  state.currentId = id;
  const frag = state.fragments.get(id) ?? { type: str(f.type) || 'RESPONSE', len: 0 };
  if (f.type) frag.type = str(f.type);
  state.fragments.set(id, frag);

  if (TOOL_TYPES.has(frag.type)) {
    const tool = toolFor(state, id, frag.type);
    if (f.status) tool.status = str(f.status);
    for (const q of Array.isArray(f.queries) ? f.queries : []) {
      const query = str(asRecord(q).query) || (typeof q === 'string' ? q : '');
      if (query && !tool.queries.includes(query)) tool.queries.push(query);
    }
    if (Array.isArray(f.results)) addResults(tool, f.results);
    const page = toResult(f.result);
    if (page?.url) {
      tool.page = { url: page.url, title: page.title };
      if (!state.opened.some((o) => o.id === id)) state.opened.push({ id, url: page.url });
    }
    emit({ text: '', thinking: '', tool });
  }

  if (typeof f.content === 'string' && f.content.length > frag.len) {
    appendContent(state, id, f.content.slice(frag.len), emit);
  }
}

// ---------------------------------------------------------------------------
// patch application
// ---------------------------------------------------------------------------

/** `base` says whether a relative sub-path refers to the last fragment or to the message. */
function applyPatch(state: WebStreamState, obj: Record<string, unknown>, base: string, emit: Emit): boolean {
  const path = str(obj.p);
  const onFragment = path.startsWith('response/fragments') || base === 'fragment';
  const op = str(obj.o).toUpperCase();

  if (path === 'content' || path.endsWith('/content')) {
    // Upstream leaves `o` out of a lot of patches — {"p":"response/fragments/-1/content",
    // "v":"曼"} is a delta, and the web app's own reducer defaults a missing op to APPEND.
    // Reading the omission as SET made setContent compare the patch's length against the
    // fragment's length, and a 1-character patch on a 1-character fragment looked like "no new
    // text": the answer's first character, which always arrives as its own patch, vanished.
    const value = typeof obj.v === 'string' ? obj.v : '';
    if (op === '' || op === 'APPEND') appendContent(state, state.currentId, value, emit);
    else setContent(state, state.currentId, obj.v, emit);
    return true;
  }
  if (path === 'results' || path.endsWith('/results')) {
    const tool = currentTool(state);
    if (tool && Array.isArray(obj.v)) addResults(tool, obj.v);
    emit({ text: '', thinking: '', tool });
    return true;
  }
  if (path === 'result' || path.endsWith('/result')) {
    const tool = currentTool(state);
    const page = toResult(obj.v);
    if (tool && page?.url) {
      tool.page = { url: page.url, title: page.title };
      const opened = state.opened.find((o) => o.id === tool.id);
      if (opened) opened.url = page.url;
      else state.opened.push({ id: tool.id, url: page.url });
    }
    emit({ text: '', thinking: '', tool });
    return true;
  }
  if (path === 'status' || path.endsWith('/status')) {
    if (onFragment) {
      const tool = currentTool(state);
      if (tool) tool.status = str(obj.v);
      emit({ text: '', thinking: '', tool });
      return true;
    }
    if (obj.v === 'FINISHED') state.finished = true;
    if (obj.v === 'FAILED') state.failed = 'FAILED';
    return true;
  }
  if (path === 'quasi_status') return true;
  if (path === 'accumulated_token_usage' && typeof obj.v === 'number') {
    state.tokenUsage = obj.v;
    return true;
  }
  if (path === 'conversation_mode' || path === 'response/conversation_mode') {
    state.mode = str(obj.v);
    return true;
  }
  if (path === 'search_triggered' || path === 'response/search_triggered') {
    state.searchTriggered = Boolean(obj.v);
    return true;
  }
  if (path === 'response/status') {
    if (obj.v === 'FINISHED') state.finished = true;
    if (obj.v === 'FAILED') state.failed = 'FAILED';
    return true;
  }
  if (path === 'error' || path === 'response/error' || path === 'incomplete_message') {
    if (obj.v) state.failed = JSON.stringify(obj.v).slice(0, 300);
    return true;
  }
  if (path === 'response/fragments' || path === 'fragments') {
    // New fragments arrive bare ({p:"response/fragments",o:"APPEND",v:[…]}) or inside a BATCH
    // on `response`. Both must register, otherwise the following deltas get attributed to the
    // previous fragment and the answer lands in the wrong bucket.
    if (Array.isArray(obj.v)) for (const f of obj.v) registerFragment(state, f, emit);
    else if (obj.v && typeof obj.v === 'object') registerFragment(state, obj.v, emit);
    return true;
  }
  if (op === 'BATCH' && Array.isArray(obj.v)) {
    const nextBase = path === 'response' ? 'response' : 'fragment';
    for (const op2 of obj.v) {
      const item = asRecord(op2);
      if (item.p === 'fragments' && str(item.o).toUpperCase() === 'APPEND' && Array.isArray(item.v)) {
        for (const f of item.v) registerFragment(state, f, emit);
      } else {
        applyPatch(state, item, nextBase, emit);
      }
    }
    return true;
  }
  return false;
}

function applySnapshot(state: WebStreamState, obj: Record<string, unknown>, emit: Emit): void {
  const response = asRecord(asRecord(obj.v).response);
  if (!Object.keys(response).length) return;
  if (typeof response.message_id === 'number') state.responseMessageId = response.message_id;
  if (typeof response.parent_id === 'number') state.requestMessageId = response.parent_id;
  if (response.conversation_mode) state.mode = str(response.conversation_mode);
  if (response.search_triggered !== undefined) state.searchTriggered = Boolean(response.search_triggered);
  if (response.status === 'FAILED') state.failed = 'FAILED';
  for (const f of Array.isArray(response.fragments) ? response.fragments : []) registerFragment(state, f, emit);
}

// ---------------------------------------------------------------------------
// frame dispatch
// ---------------------------------------------------------------------------

/**
 * Feed one SSE frame. `emit` receives every delta as it is decoded, which is what the
 * streaming transports need; the accumulated state is readable afterwards.
 */
export function applyWebFrame(
  state: WebStreamState,
  frame: WebFrame,
  emit: Emit = () => {},
): void {
  state.frames += 1;
  if (!state.eventNames.includes(frame.event)) state.eventNames.push(frame.event);

  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(frame.data);
    if (typeof parsed === 'string') {
      appendContent(state, state.currentId, parsed, emit);
      return;
    }
    obj = asRecord(parsed);
  } catch {
    return; // keep-alive or a non-JSON frame
  }

  if (frame.event === 'ready') {
    if (typeof obj.request_message_id === 'number') state.requestMessageId = obj.request_message_id;
    if (typeof obj.response_message_id === 'number') state.responseMessageId = obj.response_message_id;
    return;
  }
  if (frame.event === 'title') {
    state.title = str(obj.content);
    return;
  }
  if (frame.event === 'close') {
    state.finished = true;
    return;
  }
  if (frame.event === 'error') {
    state.failed = str(obj.msg) || str(obj.message) || JSON.stringify(obj).slice(0, 300);
    return;
  }
  if (frame.event === 'hint') {
    // DeepSeek reports degradation out of band: instead of an SSE error frame it sends
    //   event: hint  data: {"type":"error","content":"服务器暂时不可用","clear_response":true,
    //                "finish_reason":"backend_err"}
    // and then closes. Ignoring hints turned a real upstream outage into "upstream closed
    // without an answer", which tells the user nothing and hides that retrying is the fix.
    if (str(obj.type) === 'error') {
      const content = str(obj.content) || 'DeepSeek 返回错误';
      const reason = str(obj.finish_reason);
      state.failed = `${content}${reason ? `（${reason}）` : ''}`.slice(0, 300);
      state.finished = true;
    }
    return;
  }

  const code = obj.code;
  if (code !== undefined && code !== 0 && code !== '0') {
    state.failed = `code ${String(code)}: ${str(obj.msg)}`.slice(0, 300);
    return;
  }

  if (obj.p !== undefined) applyPatch(state, obj, 'fragment', emit);
  else if (typeof obj.v === 'string') appendContent(state, state.currentId, obj.v, emit);
  else if (obj.v && typeof obj.v === 'object') applySnapshot(state, obj, emit);
}

// ---------------------------------------------------------------------------
// citations + tool summary
// ---------------------------------------------------------------------------

export interface Citation {
  marker: string;
  kind: 'citation' | 'reference';
  index: number;
  resolved: boolean;
  title: string;
  url: string;
  site_name: string;
}

/**
 * `[citation:N]` resolves to the result whose `cite_index === N` (the app's own
 * convertCiteIndexToListIndex does the same — it is *not* array position), and
 * `[reference:N]` to the N-th TOOL_OPEN page.
 */
export function resolveCitations(state: WebStreamState, text = state.text): Citation[] {
  const byCiteIndex = new Map<number, WebResult>();
  for (const tool of state.tools) {
    if (tool.type !== 'SEARCH' && tool.type !== 'TOOL_SEARCH') continue;
    for (const r of tool.results) {
      if (r.cite_index !== null && !byCiteIndex.has(r.cite_index)) byCiteIndex.set(r.cite_index, r);
    }
  }
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const match of text.matchAll(/\[(citation|reference):(\d+)\]/g)) {
    const kind = match[1] as 'citation' | 'reference';
    const index = Number(match[2]);
    const marker = `${kind}:${index}`;
    if (seen.has(marker)) continue;
    seen.add(marker);
    if (kind === 'reference') {
      const page = state.opened[index];
      out.push({
        marker,
        kind,
        index,
        resolved: Boolean(page),
        title: '',
        url: page?.url ?? '',
        site_name: '',
      });
      continue;
    }
    const result = byCiteIndex.get(index);
    out.push({
      marker,
      kind,
      index,
      resolved: Boolean(result),
      title: result?.title ?? '',
      url: result?.url ?? '',
      site_name: result?.site_name ?? '',
    });
  }
  return out;
}

export interface ToolSummary {
  used: boolean;
  /** human labels, e.g. ["网页搜索 · 6 个结果", "打开页面"] */
  kinds: string[];
  queries: string[];
  resultCount: number;
  pages: { url: string; title: string }[];
  /** DEEP_SEARCH means the expert model ran multiple tool rounds */
  mode: string;
}

const TOOL_LABELS: Record<string, string> = {
  SEARCH: '网页搜索',
  TOOL_SEARCH: '深度搜索',
  TOOL_OPEN: '打开页面',
  TOOL_FIND: '页内查找',
  TIP: '提示',
  FILE: '文件',
};

export function toolSummary(state: WebStreamState): ToolSummary {
  const real = state.tools.filter((t) => TOOL_TYPES.has(t.type));
  const kinds: string[] = [];
  const pages: { url: string; title: string }[] = [];
  const queries: string[] = [];
  let resultCount = 0;
  for (const tool of real) {
    const label = TOOL_LABELS[tool.type] ?? tool.type;
    const withCount = tool.results.length ? `${label} · ${tool.results.length} 个结果` : label;
    if (!kinds.includes(withCount)) kinds.push(withCount);
    for (const q of tool.queries) if (!queries.includes(q)) queries.push(q);
    resultCount += tool.results.length;
    if (tool.page?.url && !pages.some((p) => p.url === tool.page?.url)) {
      pages.push({ url: tool.page.url, title: tool.page.title });
    }
  }
  return {
    used: real.length > 0 || state.searchTriggered,
    kinds,
    queries,
    resultCount,
    pages,
    mode: state.mode,
  };
}
