// MYMU: one shared minute ticker for relative timestamps ("2 hours ago").
// A single module-level interval serves every subscriber — hundreds of chat
// messages must NOT each own a setInterval. The interval only runs while at
// least one component is mounted and subscribed.
import { useSyncExternalStore } from 'react';

const TICK_MS = 60 * 1000;

let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): number {
  return now;
}

/** Epoch ms, refreshed once a minute app-wide. */
export function useMinuteNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
