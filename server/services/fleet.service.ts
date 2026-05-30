// fleet.service.ts — single source of truth for the agent fleet inside ccui.
//
// Wraps the agents-discover service and maintains an in-memory registry
// mapping a live agent's session_id
// -> agent metadata. That registry is how the rest of ccui recognises a
// "virtual" fleet project/session without any DB row:
//   - the project list synthesises one virtual project per live agent
//   - session history fetches the transcript over HTTP instead of local disk
//   - the websocket send path injects into the live agent instead of spawning
//
// Config (env): FLEET_DISCOVERY_URL (default http://10.10.0.4:9201 = box),
//               FLEET_DOMAIN (default manar).

const LIST_TTL_MS = 8000;

export type FleetAgent = {
  agent: string;
  domain?: string;
  host: string;
  alive: boolean;
  bot_alive?: boolean;
  cwd: string;
  session_id: string;
  transcript: string;
  last_activity?: number;
};

type DiscoveryOptions = {
  query?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
};

function cfg() {
  return {
    base: (process.env.FLEET_DISCOVERY_URL || 'http://10.10.0.4:9201').replace(/\/+$/, ''),
    domain: process.env.FLEET_DOMAIN || 'manar',
  };
}

// The discovery service gates its JSON endpoints behind a bearer token
// (DISCOVER_API_TOKEN on its side). We send it as FLEET_DISCOVERY_TOKEN. Distinct
// from the plugin:control CONTROL_TOKEN — do not confuse them.
function authHeaders(): Record<string, string> {
  const token = process.env.FLEET_DISCOVERY_TOKEN || '';
  return token ? { authorization: `Bearer ${token}` } : {};
}

const registry = new Map<string, FleetAgent>();
let listCache: { at: number; agents: FleetAgent[] } = { at: 0, agents: [] };

// Stable virtual identifiers so the frontend can address a fleet project/agent.
export const fleetProjectId = (name: string): string => `fleet:${name}`;
export const isFleetProjectId = (id: unknown): id is string =>
  typeof id === 'string' && id.startsWith('fleet:');
export const agentFromProjectId = (id: string): string | null =>
  isFleetProjectId(id) ? id.slice('fleet:'.length) : null;

// Raw discovery call. Returns { status, json }. Never used directly for the
// project list (that goes through listAgents) but powers history/send/proxy.
export async function discoveryCall(
  method: string,
  subpath: string,
  { query, body, timeoutMs = 6000 }: DiscoveryOptions = {},
): Promise<{ status: number; json: any }> {
  const { base } = cfg();
  const qs = query ? `?${new URLSearchParams(query)}` : '';
  const url = `${base}${subpath}${qs}`;
  const headers: Record<string, string> = authHeaders();
  if (body !== undefined) headers['content-type'] = 'application/json';
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(url, init);
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json };
}

// List agents for this domain (cached ~8s). Includes offline (alive:false) agents
// from the fleet roster so their last session history is navigable. Refreshes the
// session registry. Never throws — returns last-known/[] if discovery is unreachable.
export async function listAgents({ force = false }: { force?: boolean } = {}): Promise<FleetAgent[]> {
  const now = Date.now();
  if (!force && now - listCache.at < LIST_TTL_MS) return listCache.agents;
  try {
    const { domain } = cfg();
    const { status, json } = await discoveryCall('GET', '/agents', { query: { domain } });
    // Filter out discovery sentinel objects (e.g. {_peers_failed: [...]}).
    const raw: unknown[] = status >= 200 && status < 300 && Array.isArray(json) ? json : [];
    const agents: FleetAgent[] = raw.filter(
      (a): a is FleetAgent => typeof a === 'object' && a !== null && 'agent' in a,
    );
    listCache = { at: now, agents };
    // Register ALL agents (alive or not) so history lookups work for offline agents.
    for (const a of agents) {
      if (a.session_id) registry.set(a.session_id, a);
    }
    return agents;
  } catch {
    return listCache.agents;
  }
}

// Fetch + parse the discovery transcript endpoint. It returns the FULL transcript
// as NDJSON (one JSON record per line, content-type application/x-ndjson); size
// and session id come via X-Transcript-Size / X-Session-Id headers. The `since`
// query param is currently ignored server-side, so callers tail by record count,
// not byte offset.
export async function discoveryTranscript(
  agentName: string,
  { timeoutMs = 8000 }: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; size: number; sessionId: string; records: any[] }> {
  const { base } = cfg();
  const url = `${base}/agents/${encodeURIComponent(agentName)}/transcript`;
  try {
    const r = await fetch(url, { headers: authHeaders(), signal: AbortSignal.timeout(timeoutMs) });
    const ok = r.status >= 200 && r.status < 300;
    const size = Number(r.headers.get('x-transcript-size') || 0);
    const sessionId = r.headers.get('x-session-id') || '';
    const records: any[] = [];
    if (ok) {
      const text = await r.text();
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { records.push(JSON.parse(t)); } catch { /* skip malformed line */ }
      }
    }
    return { ok, status: r.status, size, sessionId, records };
  } catch {
    return { ok: false, status: 0, size: 0, sessionId: '', records: [] };
  }
}

export function lookupBySession(sessionId: string | null | undefined): FleetAgent | null {
  return (sessionId && registry.get(sessionId)) || null;
}

export function getAgentByName(name: string): FleetAgent | null {
  return listCache.agents.find((a) => a.agent === name) || null;
}

export function fleetConfig() {
  return cfg();
}
