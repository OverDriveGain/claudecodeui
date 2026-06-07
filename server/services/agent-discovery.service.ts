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
  channel_connected?: boolean;
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

// Stream a registered agent's file bytes from the daemon's /raw endpoint,
// forwarding the browser's Range header so <video>/<audio> can stream + seek.
// Returns the raw fetch Response (status + headers + body stream) for the
// caller to pipe through. 5-minute timeout covers large media downloads.
export async function discoveryRawResponse(
  agentId: string,
  filePath: string,
  rangeHeader?: string | null,
): Promise<Response> {
  const { base } = cfg();
  const url = `${base}/agents/${encodeURIComponent(agentId)}/raw?path=${encodeURIComponent(filePath)}`;
  const headers: Record<string, string> = authHeaders();
  if (rangeHeader) headers['range'] = rangeHeader;
  return fetch(url, { headers, signal: AbortSignal.timeout(300000) });
}

// Open the daemon's live transcript-follow (SSE) for an agent. Long-lived; the
// caller aborts via the signal when the browser disconnects. The daemon tails
// the agent's transcript and pushes each newly-appended record as it's written.
export async function discoveryFollowResponse(agentId: string, signal?: AbortSignal): Promise<Response> {
  const { base } = cfg();
  const url = `${base}/agents/${encodeURIComponent(agentId)}/transcript/follow`;
  return fetch(url, { headers: authHeaders(), signal });
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

// Live per-agent health (active check incl. zombie detection). Never throws.
export type AgentHealth = {
  id: string;
  label?: string;
  state: AgentState;
  working: boolean;
  alive: boolean;
  channel_connected: boolean;
  controllable?: boolean;
  last_seen?: number;
  last_activity?: number;
};

export async function discoveryAgentsHealth(
  { timeoutMs = 5000 }: { timeoutMs?: number } = {},
): Promise<AgentHealth[]> {
  try {
    const { status, json } = await discoveryCall('GET', '/agents/health', { timeoutMs });
    if (status < 200 || status >= 300 || !Array.isArray(json)) return [];
    return json.filter((h: any) => h && typeof h.id === 'string') as AgentHealth[];
  } catch {
    return [];
  }
}

// An outstanding interactive ask raised by the agent's channel `ask` tool.
export type PendingAsk = {
  request_id: string;
  questions: any[];
  ts?: number;
};

// Read the agent's current outstanding interactive ask (null if none). Cheap;
// polled by the send-bridge while a turn is in flight. Never throws.
export async function discoveryPendingAsk(
  agentId: string,
  { timeoutMs = 5000 }: { timeoutMs?: number } = {},
): Promise<PendingAsk | null> {
  try {
    const { status, json } = await discoveryCall('GET', `/agents/${encodeURIComponent(agentId)}/pending-ask`, { timeoutMs });
    if (status < 200 || status >= 300) return null;
    const pending = json?.pending;
    if (pending && typeof pending === 'object' && pending.request_id && Array.isArray(pending.questions)) {
      return pending as PendingAsk;
    }
    return null;
  } catch {
    return null;
  }
}

// Submit the operator's answer to an interactive ask. The daemon pushes it down
// the agent's channel SSE, unblocking the `ask` tool. Returns whether delivered.
export async function discoveryAnswer(
  agentId: string,
  requestId: string,
  answers: Record<string, string>,
  { timeoutMs = 6000 }: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number }> {
  try {
    const { status, json } = await discoveryCall('POST', `/agents/${encodeURIComponent(agentId)}/answer`, {
      body: { request_id: requestId, answers },
      timeoutMs,
    });
    return { ok: Boolean(json?.delivered), status };
  } catch {
    return { ok: false, status: 0 };
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
