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
let runningSessionIds: Set<string> = new Set<string>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export const sessionActivityStore = {
  setRunning(ids: string[]): void {
    runningSessionIds = new Set(ids);
    emit();
  },
  getRunningIds(): Set<string> {
    return runningSessionIds;
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
 * boolean so the component re-renders only when that session starts/stops.
 */
export function useIsSessionRunning(sessionId: string): boolean {
  return useSyncExternalStore(
    sessionActivityStore.subscribe,
    () => runningSessionIds.has(sessionId),
  );
}
