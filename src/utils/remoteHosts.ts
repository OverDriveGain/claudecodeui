import { useSyncExternalStore } from 'react';

import { pickErrorMessage } from './readError';

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
  /** Tenant identity: one entry per (host, account) — the SAME host can be
   *  connected under several accounts, each with its own scope (multi-tenant,
   *  Manar 2026-08-01). */
  key: string;
}

/** Tenant key for a (host, account) pair. US separator never collides with URLs. */
export const tenantKey = (url: string, username: string): string => `${url}\u001f${username}`;
/** Does a tenant key belong to this host URL? (assignments store plain URLs). */
export const keyMatchesHostUrl = (key: string | null | undefined, url: string): boolean =>
  key === url || (typeof key === 'string' && key.startsWith(`${url}\u001f`));

const STORAGE_KEY = 'remote-hosts';

function loadHosts(): RemoteHost[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (h): h is RemoteHost =>
          h && typeof h.url === 'string' && typeof h.token === 'string' && typeof h.username === 'string',
      )
      .map((h) => ({ ...h, key: h.key || tenantKey(h.url, h.username) }));
  } catch {
    return [];
  }
}

let hosts: RemoteHost[] = loadHosts();

// Ownership maps: which connected host a project / session came from. Rebuilt
// on every projects fetch; entries are never load-bearing for the PRIMARY host
// (absence = primary), so staleness only ever misroutes toward the default.
const projectHostMap = new Map<string, string>(); // projectId -> tenant key
const sessionHostMap = new Map<string, string>(); // sessionId -> tenant key

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
    // Same-origin IS allowed: a second account (tenant) on the primary host.
    return u.origin;
  } catch {
    return null;
  }
}

export function listRemoteHosts(): RemoteHost[] {
  return hosts;
}

export function getRemoteHost(keyOrUrl: string | null | undefined): RemoteHost | null {
  if (!keyOrUrl) return null;
  return hosts.find((h) => h.key === keyOrUrl) ?? hosts.find((h) => h.url === keyOrUrl) ?? null;
}

/** Authenticate against a peer host and remember the session. */
export async function connectRemoteHost(urlInput: string, username: string, password: string): Promise<RemoteHost> {
  const url = normalizeHostUrl(urlInput);
  if (!url) throw new Error('Invalid host URL (or it is this host)');
  let r: Response;
  try {
    r = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  } catch {
    // Dead host / DNS / TLS / CORS — fetch rejects with no response body.
    throw new Error(`Couldn't reach ${url} — check the URL and that the host is online`);
  }
  const body = (await r.json().catch(() => null)) as unknown;
  const token = (body as { token?: string } | null)?.token;
  if (!r.ok || !token) {
    // Backend may answer with the structured envelope or a flat { error }; let
    // pickErrorMessage surface whichever, and fall back to the HTTP status.
    throw new Error(pickErrorMessage(body, r.status, r.statusText, 'Login failed'));
  }
  const host: RemoteHost = { url, token, username, key: tenantKey(url, username) };
  hosts = [...hosts.filter((h) => h.key !== host.key), host];
  persist();
  emit();
  return host;
}

export function disconnectRemoteHost(key: string): void {
  hosts = hosts.filter((h) => h.key !== key && h.url !== key);
  for (const [k, v] of projectHostMap) if (v === key) projectHostMap.delete(k);
  for (const [k, v] of sessionHostMap) if (v === key) sessionHostMap.delete(k);
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
