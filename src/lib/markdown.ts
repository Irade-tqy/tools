import MarkdownIt from 'markdown-it';
import createDOMPurify from 'dompurify';
import katex from 'katex';
import texmath from 'markdown-it-texmath';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import 'highlight.js/styles/github.css';
import { copyText, toast } from './dom';
import { iconButton } from './icons';

for (const [name, language] of Object.entries({ bash, c, cpp, css, java, javascript, json, python, sql, typescript })) {
  hljs.registerLanguage(name, language);
}

const markdown = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: true,
  highlight(code, info) {
    const language = info.trim().split(/\s+/, 1)[0]?.toLowerCase();
    if (!language || !/^[a-z0-9_+-]+$/i.test(language) || !hljs.getLanguage(language)) return '';
    try {
      const highlighted = hljs.highlight(code, { language, ignoreIllegals: true }).value;
      return `<pre class="hljs"><code class="language-${language}">${highlighted}</code></pre>`;
    } catch {
      return '';
    }
  },
}).use(texmath, {
  engine: katex,
  delimiters: ['dollars', 'brackets'],
  katexOptions: { trust: false, throwOnError: false, output: 'mathml' },
});

export function renderMarkdown(node: HTMLElement, text: string): void {
  const purifier = createDOMPurify(node.ownerDocument.defaultView!);
  node.innerHTML = purifier.sanitize(markdown.render(text).trim(), {
    ADD_TAGS: ['details', 'summary'],
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe'],
    FORBID_ATTR: ['style'],
  });
  node.querySelectorAll('pre').forEach((pre) => {
    const wrapper = node.ownerDocument.createElement('div');
    wrapper.className = 'code-block';
    pre.before(wrapper);
    const copyButton = iconButton('copy', '复制代码', async () => {
      toast(await copyText(pre.querySelector('code')?.textContent ?? '') ? '代码已复制' : '复制失败，请手动选择代码');
    });
    copyButton.classList.add('code-copy');
    wrapper.append(pre, copyButton);
  });
  node.querySelectorAll<HTMLAnchorElement>('a').forEach((link) => {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  });
}
