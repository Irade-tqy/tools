import { $, showError } from './dom';

export type InsertKind = 'link' | 'image' | 'code' | 'table' | 'collapse';

export function insertDialog(kind: InsertKind, upload: (file: File) => Promise<string>): Promise<string | null> {
  const dialog = $('insert-dialog') as HTMLDialogElement;
  const form = $('insert-form') as HTMLFormElement;
  const fields = $('insert-fields');
  const error = $('insert-error');
  fields.replaceChildren();
  showError(error, '');
  $('insert-title').textContent = { link: '插入链接', image: '插入图片', code: '插入代码', table: '插入表格', collapse: '插入折叠框' }[kind];
  const inputs: Record<string, HTMLInputElement | HTMLTextAreaElement> = {};
  function field(key: string, label: string, value = '', multiline = false) {
    const wrapper = document.createElement('label');
    wrapper.className = 'field';
    wrapper.append(label);
    const input = document.createElement(multiline ? 'textarea' : 'input');
    input.value = value;
    if (input instanceof HTMLTextAreaElement) input.rows = 6;
    wrapper.append(input);
    fields.append(wrapper);
    inputs[key] = input;
  }
  if (kind === 'image' || kind === 'link') {
    field('url', kind === 'image' ? '图片链接' : '链接地址', '');
    field('text', kind === 'image' ? '图片描述（选填）' : '链接文字（选填）');
  } else if (kind === 'code') {
    field('language', '语言（选填）');
    field('content', '代码', '', true);
  } else if (kind === 'table') {
    field('rows', '行数（包含表头）', '3');
    field('columns', '列数', '2');
  } else {
    field('title', '标题', '展开查看');
    field('content', '内容', '', true);
  }
  let uploading = false;
  const submit = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
  submit.disabled = false;
  const controller = new AbortController();
  if (kind === 'image') {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/jpeg,image/png,image/webp,image/bmp,image/gif,image/tiff,image/avif';
    fileInput.hidden = true;
    const zone = document.createElement('button');
    zone.type = 'button';
    zone.className = 'upload-zone';
    zone.textContent = '选择、拖入或粘贴图片';
    const note = document.createElement('p');
    note.className = 'upload-note';
    note.textContent = '不超过 5 MB，自动缩放并转换为 WebP。图床链接公开可访问，请勿上传私密图片。';
    fields.prepend(zone, note, fileInput);
    const handleFile = async (file: File) => {
      if (uploading) return;
      uploading = true;
      submit.disabled = true;
      zone.disabled = true;
      zone.textContent = '转换并上传中…';
      showError(error, '');
      try {
        const url = await upload(file);
        if (!dialog.open) return;
        inputs.url!.value = url;
        zone.textContent = '已上传，点击可重新选择';
      } catch (err) { showError(error, (err as Error).message); zone.textContent = '上传失败，点击重试'; }
      finally { uploading = false; submit.disabled = false; zone.disabled = false; }
    };
    zone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => { const file = fileInput.files?.[0]; fileInput.value = ''; if (file) void handleFile(file); });
    zone.addEventListener('dragover', (event) => { event.preventDefault(); zone.classList.add('is-dragging'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('is-dragging'));
    zone.addEventListener('drop', (event) => { event.preventDefault(); zone.classList.remove('is-dragging'); const file = event.dataTransfer?.files[0]; if (file) void handleFile(file); });
    dialog.addEventListener('paste', (event) => {
      const file = Array.from(event.clipboardData?.items ?? []).find((item) => item.type.startsWith('image/'))?.getAsFile();
      if (file) { event.preventDefault(); void handleFile(file); }
    }, { signal: controller.signal });
  }
  return new Promise((resolve) => {
    let result: string | null = null;
    const close = () => dialog.close();
    $('insert-close').addEventListener('click', close, { signal: controller.signal });
    $('insert-cancel').addEventListener('click', close, { signal: controller.signal });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (uploading) return;
      const value = (key: string) => inputs[key]?.value ?? '';
      if (kind === 'image' || kind === 'link') {
        try {
          const url = new URL(value('url').trim());
          if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
          const href = url.href.replace(/[()]/g, (char) => encodeURIComponent(char));
          const text = (value('text') || (kind === 'link' ? href : '')).replace(/[\[\]\\]/g, '\\$&');
          result = `${kind === 'image' ? '!' : ''}[${text}](${href})`;
        } catch { return void showError(error, '请输入有效的 http 或 https 链接。'); }
      } else if (kind === 'code') {
        const content = value('content');
        const longest = Math.max(2, ...(content.match(/`+/g) ?? []).map((match) => match.length));
        const fence = '`'.repeat(longest + 1);
        result = `\n${fence}${value('language').replace(/[^\w+-]/g, '')}\n${content}\n${fence}\n`;
      } else if (kind === 'table') {
        const rows = Number(value('rows')), columns = Number(value('columns'));
        if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1 || rows > 100 || columns > 30) {
          return void showError(error, '行数需为 1–100，列数需为 1–30。');
        }
        const row = '| ' + Array(columns).fill(' ').join(' | ') + ' |';
        result = '\n| ' + Array(columns).fill('标题').join(' | ') + ' |\n| ' + Array(columns).fill('---').join(' | ') + ' |\n' + Array(rows - 1).fill(row).join('\n') + '\n';
      } else {
        result = `\n<details>\n<summary>${value('title').replace(/[<>&]/g, '')}</summary>\n\n${value('content')}\n\n</details>\n`;
      }
      close();
    }, { signal: controller.signal });
    dialog.addEventListener('close', () => { controller.abort(); resolve(result); }, { once: true });
    dialog.showModal();
  });
}

export async function imageToWebP(file: File): Promise<Blob> {
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/gif', 'image/tiff', 'image/avif'].includes(file.type)) throw new Error('请选择支持的图片格式。');
  if (file.size > 5 * 1024 * 1024) throw new Error('图片不能超过 5 MB。');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = Math.min(1, 3000 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器无法转换图片。');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('WebP 转换失败。')), 'image/webp', .8));
  } finally { URL.revokeObjectURL(url); }
}
