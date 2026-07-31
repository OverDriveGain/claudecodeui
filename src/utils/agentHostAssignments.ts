import { useSyncExternalStore } from 'react';

import { authenticatedFetch } from './api';

/**
 * Agent → host assignments (Manar, 2026-07-26): live agents never move
 * machines, so which CCUI host an agent runs on is a MANUAL admin assignment,
 * not discovery. Stored on the PRIMARY host; loaded once per app session and
 * kept as a synchronous map so the projects dedupe can consult it inline.
 *
 * Effect: when an agent is assigned to a connected peer host, the client keeps
 * THAT host's copy of the agent (see dedupeAgainstPrimary), so ownership
 * registration — and with it WS sends, history fetches and file landing — all
 * route to the machine the agent actually runs on. Without a login to the
 * assigned host, everything falls back to today's primary routing.
 */

let assignments = new Map<string, string>(); // agent_key -> host origin
let snapshot: Record<string, string> = {};
let loadPromise: Promise<void> | null = null;

const listeners = new Set<() => void>();
function emit(): void {
  snapshot = Object.fromEntries(assignments);
  for (const l of listeners) l();
}

async function fetchAssignments(): Promise<void> {
  try {
    const res = await authenticatedFetch('/api/agent-hosts');
    if (!res.ok) return;
    const data = (await res.json()) as { assignments?: Record<string, unknown> };
    const next = new Map<string, string>();
    for (const [key, url] of Object.entries(data.assignments ?? {})) {
      if (typeof url === 'string' && url) next.set(key, url);
    }
    assignments = next;
    emit();
  } catch {
    // Unreachable endpoint just means default (primary) routing — non-fatal.
  }
}

/** Load once (subsequent calls reuse the same promise until a reload). */
export function loadAgentHostAssignments(): Promise<void> {
  if (!loadPromise) loadPromise = fetchAssignments();
  return loadPromise;
}

export function reloadAgentHostAssignments(): Promise<void> {
  loadPromise = fetchAssignments();
  return loadPromise;
}

/** Synchronous lookup for the dedupe path. */
export function assignedHostFor(agentKey: string): string | null {
  return assignments.get(agentKey) ?? null;
}

/** Assign an agent to a host (optimistic; admin-only server-side). */
export async function assignAgentHost(agentKey: string, hostUrl: string): Promise<boolean> {
  const prev = assignments.get(agentKey);
  assignments.set(agentKey, hostUrl);
  emit();
  try {
    const res = await authenticatedFetch('/api/agent-hosts', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentKey, hostUrl }),
    });
    if (!res.ok) throw new Error('assign failed');
    return true;
  } catch {
    if (prev === undefined) assignments.delete(agentKey);
    else assignments.set(agentKey, prev);
    emit();
    return false;
  }
}

/** Clear an assignment (agent falls back to primary routing). */
export async function clearAgentHost(agentKey: string): Promise<boolean> {
  const prev = assignments.get(agentKey);
  if (prev === undefined) return true;
  assignments.delete(agentKey);
  emit();
  try {
    const res = await authenticatedFetch('/api/agent-hosts', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentKey }),
    });
    if (!res.ok) throw new Error('clear failed');
    return true;
  } catch {
    assignments.set(agentKey, prev);
    emit();
    return false;
  }
}

export function subscribeAgentHostAssignments(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React subscription: agent_key -> host origin (stable identity while unchanged). */
export function useAgentHostAssignments(): Record<string, string> {
  return useSyncExternalStore(subscribeAgentHostAssignments, () => snapshot);
}
