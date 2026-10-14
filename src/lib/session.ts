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
