/**
 * Session event log — the single, id-keyed, time-ordered source of truth for a
 * conversation's messages.
 *
 * This replaces the old three-list merge (server history + realtime overlay +
 * optimistic echoes reconciled by heuristics), which raced: a stale server fetch
 * could clobber the realtime tail (reply "swallowed"), and out-of-arrival-order
 * frames rendered scrambled. Here every message lives in ONE Map keyed by id;
 * every source (server backfill, live frames, optimistic echoes, the streaming
 * placeholder) UPSERTS into the same map by id. Rendering derives a sorted,
 * deduped array. Consequences:
 *   - A late/duplicate/out-of-order write is idempotent — re-upserting an id can
 *     only refresh that one entry, never drop the rest.
 *   - Order is by timestamp, not arrival, so replay/reconnect can't scramble it.
 *
 * Two content-based dedups remain unavoidable because optimistic echoes and the
 * streaming placeholder carry client-side ids that differ from the server's ids
 * for the same logical message; they collapse those at render time.
 */

import type { LLMProvider } from '../types/app';

export type MessageKind =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'stream_delta'
  | 'stream_end'
  | 'error'
  | 'system'
  | 'complete'
  | 'status'
  | 'permission_request'
  | 'permission_cancelled'
  | 'session_created'
  | 'interactive_prompt'
  | 'task_notification';

export interface NormalizedMessage {
  id: string;
  sessionId: string;
  timestamp: string;
  provider: LLMProvider;
  kind: MessageKind;

  // kind-specific fields (flat for simplicity)
  role?: 'user' | 'assistant';
  content?: string;
  /**
   * Mirrors optional transcript metadata from the server.
   *
   * These fields are currently used by Claude history normalization so local
   * slash commands, local stdout, and compact summaries do not disappear when
   * the session store hydrates from REST history.
   */
  displayText?: string;
  commandName?: string;
  commandMessage?: string;
  commandArgs?: string;
  isLocalCommand?: boolean;
  isLocalCommandStdout?: boolean;
  isCompactSummary?: boolean;
  /** system-notice severity (compact_boundary/informational): 'info' | 'warning' | 'error' */
  level?: string;
  isSystemNotice?: boolean;
  images?: string[];
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  toolResult?: { content: string; isError: boolean; toolUseResult?: unknown } | null;
  isError?: boolean;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  tokenBudget?: unknown;
  requestId?: string;
  input?: unknown;
  context?: unknown;
  newSessionId?: string;
  status?: string;
  summary?: string;
  exitCode?: number;
  actualSessionId?: string;
  parentToolUseId?: string;
  subagentTools?: unknown[];
  isFinal?: boolean;
  // Cursor-specific ordering
  sequence?: number;
  rowid?: number;
}

/**
 * Value-equality for two messages with the same id. Used so an idle/background
 * refetch that returns identical content is a no-op: keeping the EXISTING object
 * reference means React re-renders nothing, so an in-progress text selection isn't
 * torn down. (Cheap enough — only runs on fetch, never per render.)
 */
export function sameMessage(a: NormalizedMessage, b: NormalizedMessage): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

// ─── Ordering ────────────────────────────────────────────────────────────────

/**
 * Compare by timestamp. Equal or unparseable timestamps return 0 so a stable sort
 * preserves their existing (insertion) order — important because a tool_use and
 * its text from the same assistant turn share one event timestamp and must keep
 * emission order. `Array.prototype.sort` is stable (ES2019+).
 */
export function compareMessagesByTimestamp(left: NormalizedMessage, right: NormalizedMessage): number {
  const leftTime = Date.parse(left.timestamp);
  const rightTime = Date.parse(right.timestamp);
  if (Number.isNaN(leftTime) || Number.isNaN(rightTime) || leftTime === rightTime) return 0;
  return leftTime - rightTime;
}

// ─── Content-based dedup (optimistic echoes + streaming placeholder) ──────────

function userTextFingerprint(m: NormalizedMessage): string | null {
  if (m.kind !== 'text' || m.role !== 'user') return null;
  const t = (m.content || '').trim();
  return t.length > 0 ? t : null;
}

/**
 * Collapse the streaming placeholder (`stream_delta`) and any synthetic finalized
 * assistant `text` against the server's persisted copy of the same reply, which
 * arrives with a different id. When two assistant rows carry the same trimmed text
 * back-to-back (after chronological sort), keep one.
 */
export function dedupeAdjacentAssistantEchoes(list: NormalizedMessage[]): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (const m of list) {
    const prev = out[out.length - 1];
    if (prev) {
      if (prev.kind === 'stream_delta' && m.kind === 'text' && m.role === 'assistant') {
        const ps = (prev.content || '').trim();
        const ms = (m.content || '').trim();
        if (ps.length > 0 && ps === ms) {
          out[out.length - 1] = m; // promote the real row in place
          continue;
        }
      }
      if (prev.kind === 'text' && m.kind === 'text' && prev.role === 'assistant' && m.role === 'assistant') {
        const ms = (m.content || '').trim();
        if (ms.length > 0 && ms === (prev.content || '').trim()) continue;
      }
    }
    out.push(m);
  }
  return out;
}

/**
 * Drop optimistic user rows (`local_*` ids) whose text also exists as a real
 * (non-local) user row anywhere in the list — the server fetch OR the live stream
 * (the relay echoes the user's own message with a non-local id) supplies the real
 * copy. Stops a sent message showing twice (or thrice when queued).
 */
export function dedupeOptimisticUserEchoes(list: NormalizedMessage[]): NormalizedMessage[] {
  const realUserTexts = new Set<string>();
  for (const m of list) {
    if (m.id.startsWith('local_')) continue;
    const fp = userTextFingerprint(m);
    if (fp) realUserTexts.add(fp);
  }
  if (realUserTexts.size === 0) return list;
  return list.filter((m) => {
    if (!m.id.startsWith('local_')) return true;
    const fp = userTextFingerprint(m);
    return !(fp && realUserTexts.has(fp));
  });
}

// ─── Derivation ──────────────────────────────────────────────────────────────

/**
 * Render view from the id-keyed log: chronological (stable), then echo-deduped.
 * `byId` insertion order is the tiebreak for equal timestamps, so re-upserting an
 * existing id (Map.set keeps position) never reorders it.
 */
export function deriveLog(byId: Map<string, NormalizedMessage>): NormalizedMessage[] {
  if (byId.size === 0) return EMPTY;
  const all = Array.from(byId.values());
  all.sort(compareMessagesByTimestamp); // stable: equal timestamps keep insertion order
  return dedupeOptimisticUserEchoes(dedupeAdjacentAssistantEchoes(all));
}

export const EMPTY: NormalizedMessage[] = [];

/**
 * Rewrite a message's sessionId (and the streaming placeholder's id) when a
 * provisional session id is replaced by the real one announced by the provider.
 */
export function rewriteMessageSessionId(
  msg: NormalizedMessage,
  fromSessionId: string,
  toSessionId: string,
): NormalizedMessage {
  const streamingSourceId = `__streaming_${fromSessionId}`;
  const nextId = msg.id === streamingSourceId ? `__streaming_${toSessionId}` : msg.id;
  if (msg.sessionId === toSessionId && nextId === msg.id) return msg;
  return { ...msg, id: nextId, sessionId: toSessionId };
}
