// Tiny DOM helpers — no framework, no virtual DOM.

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

export function on<K extends keyof HTMLElementEventMap>(
  node: HTMLElement,
  type: K,
  handler: (event: HTMLElementEventMap[K], node: HTMLElement) => void,
): void {
  node.addEventListener(type, (event) => handler(event as HTMLElementEventMap[K], node));
}

export function create<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('data-')) node.setAttribute(k, v);
    else node.setAttribute(k, v);
  }
  for (const child of children) node.append(child);
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function toast(message: string, kind: 'ok' | 'err' | 'info' = 'info'): void {
  const node = $('toast');
  node.hidden = false;
  node.textContent = message;
  node.className = `toast${kind === 'err' ? ' toast--err' : kind === 'ok' ? ' toast--ok' : ''}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, kind === 'err' ? 6000 : 2600);
}

export function setStatus(text: string, kind: 'idle' | 'ok' | 'warn' | 'err' = 'idle'): void {
  const dot = $('status-dot');
  dot.className = `dot dot--${kind === 'idle' ? 'idle' : kind}`;
  $('status-text').textContent = text;
}

export function showError(node: HTMLElement, message: string): void {
  node.textContent = message;
  node.hidden = !message;
}

export async function copyText(text: string, timeoutMs = 800): Promise<boolean> {
  try {
    // The async clipboard can stall behind a permission prompt, so race it and fall back.
    await Promise.race([
      navigator.clipboard.writeText(text),
      new Promise((_, reject) => setTimeout(() => reject(new Error('clipboard timeout')), timeoutMs)),
    ]);
    return true;
  } catch {
    // http:// or a browser without the async clipboard API
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
