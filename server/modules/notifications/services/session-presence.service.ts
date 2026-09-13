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

// A socket only counts as "present" if it has shown client-originated activity
// (a message, ping, or pong) within this window. The server heartbeat pings every
// 30s and a healthy foreground client answers (auto-pong) or sends its own
// keepalive, so a foregrounded app refreshes well inside this bound; a
// backgrounded/suspended iOS app goes silent (the process is frozen) and falls
// stale, so the next turn-completion pushes instead of being wrongly suppressed.
// This is the server-only liveness bound; an app that sends presence.release (or
// closes its socket) on background releases instantly and doesn't wait it out.
const PRESENCE_TTL_MS = Math.max(
  30_000,
  Number.parseInt(process.env.PRESENCE_TTL_MS || '', 10) || 60_000,
);

// key `${userId}${SEP}${sessionId}` -> the set of live sockets watching it.
const socketsByKey = new Map<string, Set<WebSocket>>();
// reverse index so a socket close can drop all of its presence in O(keys-it-held).
const keysBySocket = new WeakMap<WebSocket, Set<string>>();
// last time this socket showed client-originated activity (liveness for the TTL).
const lastSeenBySocket = new WeakMap<WebSocket, number>();

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
  lastSeenBySocket.set(ws, Date.now());
  console.log('[push] presence marked', { userId: normalizedUserId, sessionId: normalizedSessionId });
}

/** Refreshes the liveness clock for `ws` (call on any client-originated frame:
 *  message, ping, or pong). A socket that stops refreshing falls stale after
 *  PRESENCE_TTL_MS and no longer suppresses pushes. */
export function touchSessionPresence(ws: WebSocket): void {
  if (ws) lastSeenBySocket.set(ws, Date.now());
}

/** Explicitly release every presence entry held by `ws` WITHOUT closing it —
 *  the clean "app went to background" signal. Same effect as a socket close for
 *  suppression purposes, but the socket stays open for a fast foreground resume. */
export function releaseSessionPresence(ws: WebSocket): void {
  const keys = keysBySocket.get(ws);
  const held = keys ? keys.size : 0;
  clearSessionPresence(ws);
  if (held > 0) console.log('[push] presence released (client signal)', { keys: held });
}

/** Drops every presence entry held by `ws` (call from the socket close handler). */
export function clearSessionPresence(ws: WebSocket): void {
  const keys = keysBySocket.get(ws);
  if (!keys) return;
  if (keys.size > 0) console.log('[push] presence cleared (socket closed)', { keys: keys.size });
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

  // A socket counts only if it is OPEN *and* recently active. iOS keeps a
  // backgrounded socket's TCP connection nominally OPEN for up to a minute (until
  // the server heartbeat terminates it), during which a naive readyState check
  // wrongly reports "present" and eats the push. Requiring recent activity closes
  // that window: a suspended app stops answering pings/keepalives and falls stale.
  const now = Date.now();
  let present = false;
  for (const ws of sockets) {
    if (!isOpen(ws)) {
      sockets.delete(ws);
      continue;
    }
    const lastSeen = lastSeenBySocket.get(ws) ?? 0;
    if (now - lastSeen < PRESENCE_TTL_MS) {
      present = true;
      break;
    }
  }
  if (sockets.size === 0) {
    socketsByKey.delete(presenceKey(normalizedUserId, normalizedSessionId));
  }
  return present;
}
