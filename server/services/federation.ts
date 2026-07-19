// federation.ts — cross-host file federation between CCUI instances.
//
// An agent shown in the Agents view may run on a DIFFERENT host than the CCUI
// instance serving the browser. That host's files are not on this machine's
// disk, so the file browser can't read them directly. Instead, CCUI instances
// federate: each instance can resolve+serve files for the agents running on ITS
// OWN host (via the per-host session registry, see local-sessions.ts), and a
// CCUI that can't resolve a session locally forwards the request to the peer
// that owns it.
//
// SECURITY MODEL (host-to-host trust, NOT per-user):
//   - Peer-serving endpoints are authed by a shared `CCUI_FEDERATION_TOKEN`, not
//     a user JWT. They resolve ANY local session by id and serve it cwd-jailed,
//     read-only. They do NOT know the calling user's agent allow-list.
//   - Per-user scoping is enforced by the CALLING instance BEFORE it proxies: it
//     checks the authenticated user may see the agent (isAgentCaptureAllowed),
//     then forwards. A restricted user can never reach an out-of-scope agent's
//     files because their own instance refuses to proxy for it.
//   - Peers are expected to be reachable only over a trusted network (e.g. a
//     WireGuard mesh). The token gates access; the network limits exposure.

const PEER_RESOLVE_TIMEOUT_MS = 2500;
// A session's owning host is stable for the life of the agent, so cache the
// session→peer mapping (including negative "no peer owns it" results) briefly.
const PEER_CACHE_TTL_MS = 15000;

export interface FederationPeer {
  name: string;
  url: string; // base URL, no trailing slash
}

/** Parse `CCUI_FILE_PEERS` = "box=http://10.10.0.3:10099,tp=http://10.10.0.5:10099". */
function parsePeers(raw: string | undefined): FederationPeer[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const eq = entry.indexOf('=');
      const name = eq >= 0 ? entry.slice(0, eq).trim() : '';
      const url = (eq >= 0 ? entry.slice(eq + 1) : entry).trim().replace(/\/+$/, '');
      return { name: name || url.replace(/^https?:\/\//, ''), url };
    })
    .filter((p) => p.url.length > 0);
}

/** Configured peer CCUI instances (empty = no outbound federation). */
export function federationPeers(): FederationPeer[] {
  return parsePeers(process.env.CCUI_FILE_PEERS);
}

/** Shared host-to-host token. Required on both the serving and calling side. */
export function federationToken(): string | null {
  const token = process.env.CCUI_FEDERATION_TOKEN;
  return token && token.length > 0 ? token : null;
}

/** True if this instance can FORWARD to peers (peers configured + token set). */
export function outboundFederationEnabled(): boolean {
  return federationPeers().length > 0 && federationToken() !== null;
}

/** True if this instance can SERVE peer requests (token set). */
export function inboundFederationEnabled(): boolean {
  return federationToken() !== null;
}

type PeerCacheEntry = { at: number; url: string | null };
const sessionPeerCache = new Map<string, PeerCacheEntry>();

/** Authenticated fetch to a peer's federation endpoint. */
export function peerFetch(
  peer: FederationPeer,
  pathAndQuery: string,
  init: { headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<Response> {
  const token = federationToken();
  return fetch(`${peer.url}${pathAndQuery}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
    signal: init.signal,
  });
}

/**
 * Find the peer that owns a session by fanning out `/api/federation/resolve` to
 * every configured peer; the first that reports 200 owns it. Cached (incl. the
 * negative result) so repeated file reads don't re-probe the whole mesh.
 */
export async function resolveSessionPeer(sessionId: string): Promise<FederationPeer | null> {
  if (!sessionId || !outboundFederationEnabled()) return null;

  const peers = federationPeers();
  const now = Date.now();
  const cached = sessionPeerCache.get(sessionId);
  if (cached && now - cached.at < PEER_CACHE_TTL_MS) {
    return cached.url ? peers.find((p) => p.url === cached.url) ?? null : null;
  }

  const probe = (peer: FederationPeer): Promise<FederationPeer> =>
    peerFetch(peer, `/api/federation/resolve?session=${encodeURIComponent(sessionId)}`, {
      signal: AbortSignal.timeout(PEER_RESOLVE_TIMEOUT_MS),
    }).then((r) => {
      if (!r.ok) throw new Error(`peer ${peer.name} ${r.status}`);
      return peer;
    });

  let owner: FederationPeer | null = null;
  try {
    // First peer to answer 200 wins; ignore the rest (which reject/timeout).
    owner = await Promise.any(peers.map(probe));
  } catch {
    owner = null;
  }

  sessionPeerCache.set(sessionId, { at: now, url: owner ? owner.url : null });
  return owner;
}
