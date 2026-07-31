import { useSyncExternalStore } from 'react';

/**
 * Multi-host sessions — the "login inside the host I'm in, with the user from
 * the other host" paradigm (Manar, 2026-07-25).
 *
 * No central server, no backend peer registry, no host-to-host trust. Each CCUI
 * host stays fully independent; the CLIENT holds one authenticated session per
 * connected host (`{url, token, username}`, persisted in localStorage) and
 * merges what every host allows that host's user to see. Every resource is
 * served by the host that owns it — conversations over that host's WS, files
 * from that host's disk — so "cross-host" stops being a backend concern.
 *
 * Routing: when projects/agents are fetched from a host, their projectIds and
 * sessionIds are registered here; `hostForProject` / `hostForSession` then let
 * the api layer and the WS sendMessage pick the owning host transparently, so
 * call sites don't need to thread host objects around.
 */

export interface RemoteHost {
  url: string; // origin, no trailing slash, e.g. https://code.kikhia.ae
  token: string;
  username: string;
}

const STORAGE_KEY = 'remote-hosts';

function loadHosts(): RemoteHost[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (h): h is RemoteHost =>
        h && typeof h.url === 'string' && typeof h.token === 'string' && typeof h.username === 'string',
    );
  } catch {
    return [];
  }
}

let hosts: RemoteHost[] = loadHosts();

// Ownership maps: which connected host a project / session came from. Rebuilt
// on every projects fetch; entries are never load-bearing for the PRIMARY host
// (absence = primary), so staleness only ever misroutes toward the default.
const projectHostMap = new Map<string, string>(); // projectId -> host url
const sessionHostMap = new Map<string, string>(); // sessionId -> host url

const listeners = new Set<() => void>();
function emit(): void {
  for (const l of listeners) l();
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(hosts));
  } catch {
    /* storage full/blocked — session-only */
  }
}

export function normalizeHostUrl(input: string): string | null {
  let raw = (input || '').trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    const u = new URL(raw);
    if (u.origin === window.location.origin) return null; // that's the primary host
    return u.origin;
  } catch {
    return null;
  }
}

export function listRemoteHosts(): RemoteHost[] {
  return hosts;
}

export function getRemoteHost(url: string | null | undefined): RemoteHost | null {
  if (!url) return null;
  return hosts.find((h) => h.url === url) ?? null;
}

/** Authenticate against a peer host and remember the session. */
export async function connectRemoteHost(urlInput: string, username: string, password: string): Promise<RemoteHost> {
  const url = normalizeHostUrl(urlInput);
  if (!url) throw new Error('Invalid host URL (or it is this host)');
  const r = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = (await r.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!r.ok || !body.token) {
    throw new Error(body.error || `Login failed (${r.status})`);
  }
  const host: RemoteHost = { url, token: body.token, username };
  hosts = [...hosts.filter((h) => h.url !== url), host];
  persist();
  emit();
  return host;
}

export function disconnectRemoteHost(url: string): void {
  hosts = hosts.filter((h) => h.url !== url);
  for (const [k, v] of projectHostMap) if (v === url) projectHostMap.delete(k);
  for (const [k, v] of sessionHostMap) if (v === url) sessionHostMap.delete(k);
  persist();
  emit();
}

/** Re-register which projects/sessions a host owns (called after each fetch/push). */
export function registerHostOwnership(hostUrl: string, projectIds: string[], sessionIds: string[]): void {
  for (const [k, v] of projectHostMap) if (v === hostUrl && !projectIds.includes(k)) projectHostMap.delete(k);
  for (const [k, v] of sessionHostMap) if (v === hostUrl && !sessionIds.includes(k)) sessionHostMap.delete(k);
  for (const id of projectIds) projectHostMap.set(id, hostUrl);
  for (const id of sessionIds) sessionHostMap.set(id, hostUrl);
}

/** Drop ownership entries for ids that turned out to be primary-owned (dedupe). */
export function unregisterIds(projectIds: string[], sessionIds: string[]): void {
  for (const id of projectIds) projectHostMap.delete(id);
  for (const id of sessionIds) sessionHostMap.delete(id);
}

export function hostForProject(projectId: string | null | undefined): RemoteHost | null {
  if (!projectId) return null;
  return getRemoteHost(projectHostMap.get(projectId));
}

export function hostForSession(sessionId: string | null | undefined): RemoteHost | null {
  if (!sessionId) return null;
  return getRemoteHost(sessionHostMap.get(sessionId));
}

export function subscribeRemoteHosts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React subscription to the connected-hosts list (stable identity while unchanged). */
export function useRemoteHosts(): RemoteHost[] {
  return useSyncExternalStore(subscribeRemoteHosts, listRemoteHosts);
}
