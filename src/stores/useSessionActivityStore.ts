import { useSyncExternalStore } from 'react';

/**
 * Tracks which sessions are currently *running* a turn, as inferred server-side
 * from the transcript files on disk (see sessions-watcher.service.ts).
 *
 * This is distinct from a session being "recently active" (modified in the last
 * few minutes) and from a GUI-owned session's own streaming state: it reflects
 * real-time activity of terminal-driven sessions the web UI does not own, so the
 * sidebar can show a live "working" indicator for them.
 *
 * Implemented as a tiny external store (no zustand in this project) consumed via
 * useSyncExternalStore, so components re-render only when their own session's
 * running boolean flips.
 */
// Server-inferred running sets (transcript file-watcher), one per SOURCE HOST
// (multi-host mode: `null` = the primary host, a URL = a connected peer). Each
// host's session_activity push replaces only its own scope; queries union all
// scopes. Authoritative for sessions the web UI does not own, but it lags — the
// watcher only sees a turn once the CLI flushes a transcript write, and a 90s
// idle-timeout keeps stale entries.
const runningByScope = new Map<string | null, Set<string>>();

// Locally-known running set: the session the user has OPEN in chat, keyed to that
// view's live websocket `isLoading`. The chat stream flips this instantly, so
// merging it in keeps the sidebar's "working" dot in lockstep with the chat loader
// instead of waiting on the file-watcher — the two surfaces now read one source of
// truth and can't show different values. Cleared when the turn ends / view closes.
const localRunningSessionIds: Set<string> = new Set<string>();

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export const sessionActivityStore = {
  setRunning(ids: string[], scope: string | null = null): void {
    runningByScope.set(scope, new Set(ids));
    emit();
  },
  /** Record the open chat view's live running state so the sidebar mirrors it at once. */
  setLocalRunning(sessionId: string, running: boolean): void {
    if (!sessionId) return;
    const had = localRunningSessionIds.has(sessionId);
    if (running === had) return;
    if (running) localRunningSessionIds.add(sessionId);
    else localRunningSessionIds.delete(sessionId);
    emit();
  },
  isRunning(sessionId: string): boolean {
    if (localRunningSessionIds.has(sessionId)) return true;
    for (const ids of runningByScope.values()) {
      if (ids.has(sessionId)) return true;
    }
    return false;
  },
  getRunningIds(): Set<string> {
    const union = new Set<string>();
    for (const ids of runningByScope.values()) {
      for (const id of ids) union.add(id);
    }
    return union;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/**
 * Subscribe a component to a single session's running state. Returns a stable
 * boolean so the component re-renders only when that session starts/stops. Merges
 * the server-inferred set with the open chat view's live state (see above), so the
 * sidebar and the chat always agree.
 */
export function useIsSessionRunning(sessionId: string): boolean {
  return useSyncExternalStore(
    sessionActivityStore.subscribe,
    () => sessionActivityStore.isRunning(sessionId),
  );
}
