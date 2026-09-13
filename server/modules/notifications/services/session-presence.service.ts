import type { WebSocket } from 'ws';

/**
 * Session presence tracker — powers push suppression.
 *
 * A user "is present" on a session when they hold at least one live websocket
 * subscribed to it (the app is open on that conversation). While present we
 * suppress push notifications for that session: the user is already looking at
 * it, exactly like WhatsApp doesn't buzz your phone for the chat you're reading.
 *
 * When the iOS app is backgrounded/closed the websocket drops -> its close
 * handler calls clearSessionPresence -> the user is no longer present -> the
 * next turn completion pushes.
 *
 * Presence is process-local (in-memory), which is correct: it mirrors the
 * sockets this very server holds, and a socket only lives on the server it
 * connected to.
 */

const KEY_SEP = '␟';

// key `${userId}${SEP}${sessionId}` -> the set of live sockets watching it.
const socketsByKey = new Map<string, Set<WebSocket>>();
// reverse index so a socket close can drop all of its presence in O(keys-it-held).
const keysBySocket = new WeakMap<WebSocket, Set<string>>();

function normalizeUserId(userId: unknown): number | null {
  const numeric = Number(userId);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function presenceKey(userId: number, sessionId: string): string {
  return `${userId}${KEY_SEP}${sessionId}`;
}

function isOpen(ws: WebSocket): boolean {
  // 1 === OPEN across the `ws` library and browsers; avoid importing the enum.
  return ws.readyState === 1;
}

/** Records that `userId` is watching `sessionId` over `ws`. */
export function markSessionPresence(userId: unknown, sessionId: unknown, ws: WebSocket): void {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalizedUserId || !normalizedSessionId || !ws) return;

  const key = presenceKey(normalizedUserId, normalizedSessionId);
  let sockets = socketsByKey.get(key);
  if (!sockets) {
    sockets = new Set();
    socketsByKey.set(key, sockets);
  }
  sockets.add(ws);

  let keys = keysBySocket.get(ws);
  if (!keys) {
    keys = new Set();
    keysBySocket.set(ws, keys);
  }
  keys.add(key);
}

/** Drops every presence entry held by `ws` (call from the socket close handler). */
export function clearSessionPresence(ws: WebSocket): void {
  const keys = keysBySocket.get(ws);
  if (!keys) return;
  for (const key of keys) {
    const sockets = socketsByKey.get(key);
    if (!sockets) continue;
    sockets.delete(ws);
    if (sockets.size === 0) {
      socketsByKey.delete(key);
    }
  }
  keysBySocket.delete(ws);
}

/** True when `userId` has any live socket subscribed to `sessionId`. */
export function isUserPresentOnSession(userId: unknown, sessionId: unknown): boolean {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalizedUserId || !normalizedSessionId) return false;

  const sockets = socketsByKey.get(presenceKey(normalizedUserId, normalizedSessionId));
  if (!sockets || sockets.size === 0) return false;

  // Prune any sockets that closed without a clear (defensive) and report on
  // whatever remains open.
  for (const ws of sockets) {
    if (isOpen(ws)) return true;
    sockets.delete(ws);
  }
  if (sockets.size === 0) {
    socketsByKey.delete(presenceKey(normalizedUserId, normalizedSessionId));
  }
  return false;
}
