import { useSyncExternalStore } from 'react';

import type { Project } from '../types/app';

/**
 * Multi-host focus — hide one host's agents from the left panel so you can
 * concentrate on a single host's fleet at a time. Purely a client-side view
 * preference (no backend): the set of hidden host keys is persisted in
 * localStorage and the agents list filters against it.
 *
 * A "host key" is the same tenant key the multi-host store uses
 * (`urlusername`), which is what remote agents carry in `__hostUrl`.
 * Agents served by the primary host (this login) have no `__hostUrl`; their
 * host key is the empty string, matching the `''` key the Hosts dialog already
 * uses for the primary row.
 */

/** Primary host (this login) — agents from it carry no `__hostUrl`. */
export const PRIMARY_HOST_KEY = '';

/** The host a given agent project belongs to (tenant key, '' for primary). */
export function agentHostKey(p: Project): string {
  return (p as { __hostUrl?: string }).__hostUrl ?? PRIMARY_HOST_KEY;
}

/** Short, human label for a host origin: code.kaxtus.com → kaxtus,
 *  code-thinkpad.kaxtus.com → thinkpad, host:port kept verbatim. */
export function shortHostLabel(input: string): string {
  try {
    const u = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    const host = u.hostname;
    if (u.port && u.port !== '80' && u.port !== '443') return `${host}:${u.port}`;
    const labels = host.split('.');
    const first = labels[0] || host;
    if (first.startsWith('code-')) return first.slice('code-'.length);
    if ((first === 'code' || first === 'app' || first === 'www') && labels[1]) return labels[1];
    return first;
  } catch {
    return input;
  }
}

/**
 * Label for a host/tenant key. The multi-login flow is primarily "another USER on
 * the SAME host", so the label is user-centric: same-origin tenants read as the
 * username; a genuinely different host reads as `username@host` (or just the host).
 * `key === ''` is the primary login — labeled with `primaryLabel` (the current
 * user's name) when known.
 */
export function hostKeyLabel(key: string, primaryLabel?: string): string {
  if (!key) return primaryLabel || shortHostLabel(window.location.origin);
  const sep = String.fromCharCode(0x1f);
  const i = key.indexOf(sep);
  const url = i >= 0 ? key.slice(0, i) : key;
  const username = i >= 0 ? key.slice(i + 1) : '';
  let sameOrigin = false;
  try {
    sameOrigin = new URL(url).origin === window.location.origin;
  } catch {
    /* malformed url → treat as different host */
  }
  if (sameOrigin) return username || shortHostLabel(url);
  return username ? `${username}@${shortHostLabel(url)}` : shortHostLabel(url);
}

const STORAGE_KEY = 'hidden-host-agents';

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

let hidden: Set<string> = load();

const listeners = new Set<() => void>();
function emit(): void {
  for (const l of listeners) l();
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...hidden]));
  } catch {
    /* storage full/blocked — session-only */
  }
}

export function isHostHidden(key: string): boolean {
  return hidden.has(key);
}

export function toggleHostHidden(key: string): void {
  // New Set identity on every change so useSyncExternalStore re-renders.
  hidden = new Set(hidden);
  if (hidden.has(key)) hidden.delete(key);
  else hidden.add(key);
  persist();
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React subscription to the hidden-host-keys set (stable identity while unchanged). */
export function useHiddenHosts(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => hidden);
}
