import { useSyncExternalStore } from 'react';

/**
 * Roster-reader health for the remote-agent list, fed by the agent-status poll in
 * useProjectsState. When a claude.ai reader login dies (expired/wiped OAuth token)
 * the roster silently degrades to its last-good cache — or to nothing — and the
 * Agents tab used to show an empty list with zero diagnostic signal (the
 * 2026-07-22 outage). The server now reports per-account roster errors even for
 * single-account deployments; this store carries them to the sidebar banner.
 *
 * Same tiny external-store idiom as useSessionActivityStore (no zustand here).
 */
export type AgentAccountError = { label: string; status: number; message: string };

let accountErrors: AgentAccountError[] = [];
let serialized = '[]';

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export const agentHealthStore = {
  /** Replace the error list; no-ops (no re-render) when nothing changed. */
  setAccountErrors(errors: AgentAccountError[]): void {
    const next = JSON.stringify(errors);
    if (next === serialized) return;
    serialized = next;
    accountErrors = errors;
    emit();
  },
  getAccountErrors(): AgentAccountError[] {
    return accountErrors;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** Subscribe a component to the roster-reader error list (stable identity while unchanged). */
export function useAgentAccountErrors(): AgentAccountError[] {
  return useSyncExternalStore(agentHealthStore.subscribe, agentHealthStore.getAccountErrors);
}
