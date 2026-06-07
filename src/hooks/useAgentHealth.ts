import { useEffect, useState } from 'react';
import { authenticatedFetch } from '../utils/api';

// Live, actively-polled health for registered agents. The daemon's /agents/health
// runs a real liveness/zombie check (the channel SSE is parked AND a backing
// claude process is alive), so `working` is a true "is it actually working"
// signal — stronger than the cached project-list state.
export type AgentHealth = {
  id: string;
  label?: string;
  state: 'ONLINE' | 'CONTROLLABLE' | 'DISCONNECTED';
  working: boolean;
  alive: boolean;
  channel_connected: boolean;
  controllable?: boolean;
  last_seen?: number;
  last_activity?: number;
};

const POLL_MS = 10000;

// Module-level singleton: one poller no matter how many components subscribe.
let healthMap: Record<string, AgentHealth> = {};
let lastSerialized = '';
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let refCount = 0;

async function poll() {
  try {
    const res = await authenticatedFetch('/api/agents/health');
    if (!res.ok) return;
    const data = await res.json();
    const arr: AgentHealth[] = Array.isArray(data?.agents) ? data.agents : [];
    const next: Record<string, AgentHealth> = {};
    for (const h of arr) if (h && h.id) next[h.id] = h;
    const serialized = JSON.stringify(next);
    if (serialized === lastSerialized) return; // no change → skip re-renders
    healthMap = next;
    lastSerialized = serialized;
    listeners.forEach((l) => l());
  } catch {
    // daemon unreachable — keep last-known; components fall back to list state
  }
}

function start() {
  if (timer) return;
  void poll();
  timer = setInterval(() => void poll(), POLL_MS);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Subscribe to the shared agent-health map (id → health). Re-renders on change. */
export function useAgentHealth(): Record<string, AgentHealth> {
  const [, force] = useState(0);
  useEffect(() => {
    refCount += 1;
    const l = () => force((n) => n + 1);
    listeners.add(l);
    start();
    return () => {
      listeners.delete(l);
      refCount -= 1;
      if (refCount <= 0) stop();
    };
  }, []);
  return healthMap;
}
