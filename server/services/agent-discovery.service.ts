// agent-discovery.service.ts — clean, general agent registry client for claudeui.
//
// Talks to the agent-discovery daemon (https://github.com/claudecodeui/agent-discovery).
// Config: AGENT_DISCOVERY_URL (default http://127.0.0.1:9301),
//         AGENT_DISCOVERY_TOKEN (required for gated endpoints).
//
// No fleet/domain/customer coupling. Register-only: on a fresh daemon with nothing
// registered, listAgents() returns []. Agents are addressed by stable UUID.

const LIST_TTL_MS = 8000;

export type AgentState = 'ONLINE' | 'CONTROLLABLE' | 'DISCONNECTED';

export type RegisteredAgent = {
  id: string;
  label: string;
  state: AgentState;
  alive: boolean;
  controllable: boolean;
  pid?: number;
  cwd: string;
  session_id?: string;
  transcript?: string;
  last_activity?: number;
  last_seen?: number;
  registered_at?: number;
  uptime_seconds?: number;
  rss_bytes?: number;
  control_url?: string | null;
  dtach_socket?: string;
};

type DiscoveryOptions = {
  query?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
};

function cfg() {
  return {
    base: (process.env.AGENT_DISCOVERY_URL || 'http://127.0.0.1:9301').replace(/\/+$/, ''),
    token: process.env.AGENT_DISCOVERY_TOKEN || '',
  };
}

function authHeaders(): Record<string, string> {
  const { token } = cfg();
  return token ? { authorization: `Bearer ${token}` } : {};
}

const registry = new Map<string, RegisteredAgent>();
let listCache: { at: number; agents: RegisteredAgent[] } = { at: 0, agents: [] };

// Stable virtual project identifiers — neutral, ID-addressed.
export const agentProjectId = (id: string): string => `agent:${id}`;
export const isAgentProjectId = (id: unknown): id is string =>
  typeof id === 'string' && id.startsWith('agent:');
export const agentIdFromProjectId = (id: string): string | null =>
  isAgentProjectId(id) ? id.slice('agent:'.length) : null;

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

// List all registered agents (ONLINE, CONTROLLABLE, DISCONNECTED). Cached ~8s.
// Never throws — returns last-known/[] if daemon is unreachable.
export async function listAgents({ force = false }: { force?: boolean } = {}): Promise<RegisteredAgent[]> {
  const now = Date.now();
  if (!force && now - listCache.at < LIST_TTL_MS) return listCache.agents;
  try {
    const { status, json } = await discoveryCall('GET', '/agents');
    const raw: unknown[] = status >= 200 && status < 300 && Array.isArray(json) ? json : [];
    const agents: RegisteredAgent[] = raw.filter(
      (a): a is RegisteredAgent =>
        typeof a === 'object' && a !== null && 'id' in a && 'label' in a && 'state' in a,
    );
    listCache = { at: now, agents };
    for (const a of agents) {
      if (a.session_id) registry.set(a.session_id, a);
    }
    return agents;
  } catch {
    return listCache.agents;
  }
}

// Fetch and parse the transcript for an agent by ID. Returns NDJSON records.
export async function discoveryTranscript(
  agentId: string,
  { timeoutMs = 8000 }: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; size: number; sessionId: string; records: any[] }> {
  const { base } = cfg();
  const url = `${base}/agents/${encodeURIComponent(agentId)}/transcript`;
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
        try { records.push(JSON.parse(t)); } catch { /* skip malformed */ }
      }
    }
    return { ok, status: r.status, size, sessionId, records };
  } catch {
    return { ok: false, status: 0, size: 0, sessionId: '', records: [] };
  }
}

export function lookupBySession(sessionId: string | null | undefined): RegisteredAgent | null {
  return (sessionId && registry.get(sessionId)) || null;
}

export function getAgentById(id: string): RegisteredAgent | null {
  return listCache.agents.find((a) => a.id === id) || null;
}

export function discoveryConfig() {
  return cfg();
}
