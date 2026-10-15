// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { initIcons } from '../src/lib/icons';
import { renderMarkdown } from '../src/lib/markdown';
import { validPasteName } from '../src/lib/paste';
import { appBase } from '../src/lib/routes';
import { newSession, parseSession } from '../src/lib/session';

describe('frontend trust boundaries', () => {
  it('counts Unicode code points without restricting input length', () => {
    expect(validPasteName('中😀'.repeat(7) + '文')).toBe(true);
    expect(validPasteName('😀'.repeat(16))).toBe(false);
    expect(validPasteName('')).toBe(false);
  });
  it('imports an exported session and rejects malformed turns', () => {
    const session = newSession();
    session.turns.push({ role: 'user', content: 'hello', at: 1, parentId: null });
    expect(parseSession(JSON.stringify(session)).turns).toEqual(session.turns);
    expect(() => parseSession(JSON.stringify({ ...session, turns: [{ role: 'system', content: 'bad', at: 1 }] }))).toThrow();
    expect(() => parseSession('{}')).toThrow();
  });
  it('renders Markdown, both math delimiters, and safe collapses without executable HTML', () => {
    const node = document.createElement('article');
    renderMarkdown(node, '# Title\n\n$1+2$ and \\(3+4\\)\n\n\\[\\frac{2m}{n}\\le L\\]\n\n<details><summary>More</summary>Safe</details>\n\n<img src=x onerror=alert(1)><script>alert(2)</script><a href="javascript:alert(3)">bad</a><div style="position:fixed">bad CSS</div>');
    expect(node.querySelector('h1')?.textContent).toBe('Title');
    expect(node.querySelectorAll('math')).toHaveLength(3);
    expect(node.querySelector('details summary')?.textContent).toBe('More');
    expect(node.querySelector('script, [onerror], [style], a[href^="javascript:"]')).toBeNull();
  });
  it('declares every icon used in the HTML shell', () => {
    const html = readFileSync('index.html', 'utf8');
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    document.body.replaceChildren(...Array.from(parsed.body.children));
    expect(() => initIcons()).not.toThrow();
    const declarations = document.querySelectorAll('[data-icon]:not(svg)');
    expect(declarations.length).toBeGreaterThan(10);
    expect(Array.from(declarations).every((node) => node.querySelector('svg'))).toBe(true);
  });
  it('keeps nested routes inside their static deployment prefix', () => {
    expect(appBase('/tools/chat/')).toBe('/tools/');
    expect(appBase('/tools/paste/')).toBe('/tools/');
    expect(appBase('/chat/')).toBe('/');
    expect(appBase('/tools/')).toBe('/tools/');
  });
});
