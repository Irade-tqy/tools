import type { Envelope, ToolsApi } from './api';

export type PasteMode = 'public' | 'write_password' | 'private';
export interface PasteDocument extends Envelope {
  id: string;
  name: string;
  body: string | null;
  mode: PasteMode;
  has_password: boolean;
  can_read: boolean;
  can_write: boolean;
  revision: number;
  token?: string | null;
}

export function validPasteName(name: string): boolean {
  return [...name].length >= 1 && [...name].length <= 15;
}

export function pasteRequest(api: ToolsApi, action: string, args: Record<string, unknown> = {}): Promise<PasteDocument> {
  return api.rpc<PasteDocument>('paste_document', { p_action: action, ...args }, { token: null });
}

export function pasteError(error?: string | null): string {
  const messages: Record<string, string> = {
    not_found: '找不到这个剪贴板，请检查链接中的名称。',
    invalid_password: '密码不正确，请重试。',
    unauthorized: '编辑权限已失效，请重新输入密码。',
    rate_limited: '尝试过于频繁，请稍后重试。',
    conflict: '另一台设备修改了文档。本机草稿已保留，请复制后刷新页面合并。',
    text_too_large: '文档超过 256 KB，内容已保留在本机。',
    name_exists: '名称已存在。',
    invalid_name: '名称需要包含 1 至 15 个字符。',
    password_already_set: '这个剪贴板已经设置过密码，请刷新后重试。',
  };
  return messages[error ?? ''] ?? error ?? '请求失败，请重试。';
}
