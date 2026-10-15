// The one active DeepSeek conversation.
//
// DeepSeek's web API keeps context server-side, keyed by chat_session_id + the previous
// turn's response_message_id. So "continue this conversation" is two ids, and "start a new
// one" is dropping them — no history has to travel in the request. This module persists
// exactly that (plus the visible transcript, so a reload lands back in the same chat).
//
// Session *management* — listing, renaming, switching between several — is deliberately not
// here yet; there is one session at a time.

import { SESSION_KEY } from './config';
import type { ChatCitation, ToolSummary } from './chat-reducer';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  /** reasoning text, kept so a reload still shows what the model thought */
  thinking?: string;
  tools?: ToolSummary;
  citations?: ChatCitation[];
  mode?: string;
  at: number;
  /** Parent before this user turn, used to edit or regenerate the branch. */
  parentId?: string | null;
  /** names of the files attached to this turn (the ids live upstream once sent) */
  files?: string[];
  /** the user pressed Stop while this answer was streaming */
  stopped?: boolean;
}

/**
 * The prompt to send after a stopped turn.
 *
 * DeepSeek keeps the conversation itself, and a stopped message is stored truncated (INCOMPLETE),
 * so the next turn continues from the partial answer automatically. What it does *not* keep is
 * the reasoning: verified against the live API, a follow-up cannot recall the previous turn's
 * thinking at all. So the reasoning of a stopped turn is handed over explicitly — the model is
 * told it is its own unfinished thought, not something the user wrote.
 */
export function carryForwardPrompt(turn: ChatTurn | undefined, content: string): string {
  if (!turn || turn.role !== 'assistant' || !turn.stopped) return content;
  const thinking = (turn.thinking ?? '').trim();
  if (!thinking) return content;
  const CAP = 1200;
  const body = thinking.length > CAP ? `${thinking.slice(0, CAP)}…（已截断）` : thinking;
  const said = (turn.content ?? '').trim();
  const saidPart = said
    ? `，并且已经输出到：“${said.length > 200 ? `${said.slice(-200)}…` : said}”`
    : '';
  return [
    `（说明：上一轮你的回答${saidPart ? saidPart : ''}，被用户手动打断了。你当时的思考过程如下，请把它当作你自己还没说完的思路接着进行，不要重复它。）`,
    `<thinking>${body}</thinking>`,
    '',
    content,
  ].join('\n');
}

export interface ChatSession {
  /** our own id, only used as a localStorage key/label */
  localId: string;
  /** DeepSeek's chat_session_id; null until the first turn creates one */
  dsSessionId: string | null;
  /** the last response_message_id; the parent_message_id for the next turn */
  parentId: string | null;
  title: string;
  turns: ChatTurn[];
  startedAt: number;
}

const MAX_STORED_TURNS = 40;

function newLocalId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function newSession(): ChatSession {
  return { localId: newLocalId(), dsSessionId: null, parentId: null, title: '', turns: [], startedAt: Date.now() };
}

export function loadSession(): ChatSession {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return newSession();
    const parsed = JSON.parse(raw) as ChatSession;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.turns)) return newSession();
    return {
      localId: parsed.localId || newLocalId(),
      dsSessionId: typeof parsed.dsSessionId === 'string' ? parsed.dsSessionId : null,
      parentId: typeof parsed.parentId === 'string' ? parsed.parentId : null,
      title: typeof parsed.title === 'string' ? parsed.title : '',
      turns: parsed.turns.filter((t) => t && typeof t.content === 'string').slice(-MAX_STORED_TURNS),
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : Date.now(),
    };
  } catch {
    return newSession();
  }
}

export function saveSession(session: ChatSession): void {
  try {
    const trimmed: ChatSession = {
      ...session,
      turns: session.turns.slice(-MAX_STORED_TURNS).map((turn) => ({
        ...turn,
        // reasoning can be long; keep enough to be useful without risking the quota
        thinking: turn.thinking ? turn.thinking.slice(0, 4000) : undefined,
      })),
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(trimmed));
  } catch {
    /* quota — the conversation still works in memory */
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/** True once DeepSeek has actually created the conversation (i.e. we can continue it). */
export function sessionIsLive(session: ChatSession): boolean {
  return Boolean(session.dsSessionId);
}

export function sessionLabel(session: ChatSession): string {
  const turns = session.turns.filter((t) => t.role === 'user').length;
  const name = session.title || (session.dsSessionId ? `${session.dsSessionId.slice(0, 8)}…` : '新会话');
  return `${name} · ${turns} 轮`;
}

export function parseSession(raw: string): ChatSession {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object') throw new Error('会话文件格式不正确。');
  const s = value as Record<string, unknown>;
  if (typeof s.title !== 'string' || typeof s.startedAt !== 'number' || !Number.isFinite(s.startedAt)
    || !(s.dsSessionId === null || typeof s.dsSessionId === 'string')
    || !(s.parentId === null || typeof s.parentId === 'string') || !Array.isArray(s.turns)) {
    throw new Error('请选择 Tools 导出的 JSON 会话文件。');
  }
  const turns: ChatTurn[] = s.turns.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('会话包含无效消息。');
    const t = item as Record<string, unknown>;
    if ((t.role !== 'user' && t.role !== 'assistant') || typeof t.content !== 'string'
      || typeof t.at !== 'number' || !Number.isFinite(t.at)
      || (t.thinking !== undefined && typeof t.thinking !== 'string')
      || (t.stopped !== undefined && typeof t.stopped !== 'boolean')
      || (t.parentId !== undefined && t.parentId !== null && typeof t.parentId !== 'string')) {
      throw new Error('会话包含无效消息。');
    }
    // Only import display text and continuation ids, never arbitrary object properties. `stopped`
    // is on the list because the next turn's prompt depends on it: without it a reloaded or
    // imported session forgets that the reasoning has to be handed over by hand.
    return { role: t.role, content: t.content, at: t.at,
      thinking: t.thinking as string | undefined, parentId: t.parentId as string | null | undefined,
      stopped: t.stopped as boolean | undefined };
  });
  return { localId: newLocalId(), title: s.title, startedAt: s.startedAt,
    dsSessionId: s.dsSessionId as string | null, parentId: s.parentId as string | null, turns };
}
