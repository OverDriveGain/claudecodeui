// rc.service.ts — app-facing wrapper around the remote-control engine.
//
// The engine (server/remote-control/rc-client.js) knows HOW to talk to Anthropic's
// CCR v2 relay. This service is the thin layer the rest of the app calls: it adds
// brief caching (so the sidebar refresh doesn't hammer the API), never-throws error
// handling (the view degrades to empty instead of crashing), the operator-only
// capture policy, and the `remote:<sessionId>` virtual-project id helpers.

// rc-client.js is plain ESM (allowJs build) — imported as untyped.
import { isRemoteControlConfigured, listAgents, getSessionCwd } from '@/remote-control/rc-client.js';

// Paging the whole fleet is heavier than a single request. The roster itself
// changes slowly, but worker_status (the running dot) needs to feel live, and the
// /agent-status poll is served from this same cache — so keep it short enough that
// a working agent lights up within a few seconds, like claude.ai/code.
const LIST_TTL_MS = 5000;
const REMOTE_PREFIX = 'remote:';

export type RemoteAgent = {
  id: string; // cse_… / session_… — the live session id to drive
  title: string; // the agent's name (its session title)
  connected: boolean; // honest online/offline (claude.ai's Recents view hides this)
  running: boolean; // worker_status==='running' — agent is mid-turn (sidebar dot)
  repo?: string | null; // stable identity across restarts (git repo)
  lastEventAt?: string; // recency — what the claude.ai "Recents" view orders by
  createdAt?: string;
};

/** Drop the leading slash a slash-command launch leaves on a session title. */
function cleanAgentTitle(title: string): string {
  return title.replace(/^\/+\s*/, '').trim();
}

/** Stable virtual-project id for a connected agent. */
export function remoteProjectId(sessionId: string): string {
  return `${REMOTE_PREFIX}${sessionId}`;
}

/** True if a project/session id refers to a remote-control agent. */
export function isRemoteProjectId(projectId: string | null | undefined): boolean {
  return typeof projectId === 'string' && projectId.startsWith(REMOTE_PREFIX);
}

/** Extract the agent session id from a `remote:<sessionId>` project id. */
export function sessionIdFromProjectId(projectId: string): string {
  return projectId.startsWith(REMOTE_PREFIX) ? projectId.slice(REMOTE_PREFIX.length) : projectId;
}

/** Is the proxy usable on this host (operator OAuth present)? */
export function remoteControlEnabled(): boolean {
  try {
    return Boolean(isRemoteControlConfigured());
  } catch {
    return false;
  }
}

/**
 * Operator-only capture policy: which connected agents this deployment is allowed
 * to surface/drive. Configured ONLY via server env (deployment env file / systemd
 * unit) — there is no UI surface, so a CCUI user cannot widen it.
 *
 *   RC_AGENT_ALLOW  comma-separated glob patterns matched on the agent title
 *                   (case-insensitive, `*` = wildcard). UNSET → allow all.
 *                   If set → ONLY titles matching a pattern are shown.
 *   RC_AGENT_DENY   comma-separated globs always excluded (applied after allow).
 *                   Use to hide scratch / personal sessions.
 *
 * Read per-call, so a deployment changes policy with a restart — never at runtime
 * by the user.
 */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}
function parsePatterns(raw: string | undefined): RegExp[] {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean).map(globToRegExp);
}
function captureAllows(title: string): boolean {
  const allow = parsePatterns(process.env.RC_AGENT_ALLOW);
  const deny = parsePatterns(process.env.RC_AGENT_DENY);
  if (deny.some((re) => re.test(title))) return false;
  if (allow.length > 0 && !allow.some((re) => re.test(title))) return false;
  return true;
}

let agentCache: { at: number; value: RemoteAgent[] } | null = null;

/**
 * List the operator's agents — every `claude --remote-control` session, online and
 * offline — SUBJECT TO the capture policy, sorted online-first. Cached briefly;
 * returns [] (never throws) on error, serving the last good list if the API is
 * momentarily down.
 */
export async function listRemoteAgents({ force = false } = {}): Promise<RemoteAgent[]> {
  if (!remoteControlEnabled()) return [];
  const now = Date.now();
  if (!force && agentCache && now - agentCache.at < LIST_TTL_MS) return agentCache.value;
  try {
    const raw = await listAgents();
    const mapped: RemoteAgent[] = (Array.isArray(raw) ? raw : [])
      .map((s: Record<string, unknown>) => ({
        id: String(s.id ?? ''),
        title: String(s.title ?? 'agent').trim() || 'agent',
        connected: Boolean(s.connected),
        running: Boolean(s.running),
        repo: s.repo ? String(s.repo) : null,
        lastEventAt: s.lastEventAt ? String(s.lastEventAt) : undefined,
        createdAt: s.createdAt ? String(s.createdAt) : undefined,
      }))
      // Capture policy matches the agent NAME, so test the cleaned title — a
      // slash-launched session ("/environment") must still match the "environment"
      // allow pattern, otherwise the live session is filtered out and only dead
      // older sessions remain.
      .filter((s) => s.id && captureAllows(cleanAgentTitle(s.title)));

    // One agent has many sessions (each restart makes a new one). Collapse to one
    // leaf per agent. Key on the CLEANED TITLE first: the capture filter above
    // already guarantees every surviving session's cleaned title equals a roster
    // agent name (and cleanAgentTitle absorbs the "/name" vs "name" slash drift), so
    // the title is the stable identity here. Keying on repo first was WRONG — the
    // same agent's sessions inconsistently carry a git repo (some do, some don't),
    // which split one agent (e.g. bti-website) into a repo-keyed leaf AND a
    // title-keyed leaf, surfacing stale duplicates. Fall back to repo, then id, only
    // when a title is somehow absent. listAgents is most-recent-first, so the first
    // session per key is the live one to drive — dead older sessions are dropped.
    const byKey = new Map<string, RemoteAgent>();
    for (const a of mapped) {
      const key = cleanAgentTitle(a.title) || a.repo || a.id;
      if (!byKey.has(key)) byKey.set(key, a);
    }

    // Sort by recency (most-recently-active first), matching claude.ai "Recents".
    // Display the cleaned title so a slash-launched name shows normally.
    const value = [...byKey.values()]
      .map((a) => ({ ...a, title: cleanAgentTitle(a.title) || a.title }))
      .sort((a, b) =>
        String(b.lastEventAt ?? '').localeCompare(String(a.lastEventAt ?? '')),
      );
    agentCache = { at: now, value };
    return value;
  } catch {
    return agentCache?.value ?? [];
  }
}

/**
 * True if a session id is allowed by the capture policy — used to gate driving and
 * history so the policy can't be bypassed by guessing a cse_ id from the browser.
 */
export async function isAgentCaptureAllowed(sessionId: string): Promise<boolean> {
  const agents = await listRemoteAgents();
  return agents.some((a) => a.id === sessionId);
}

/**
 * The agent's working directory (session_context.cwd from the relay), or null.
 * Capture-gated so a browser can't read an arbitrary agent's path by guessing an id.
 * Used to point the file browser at the live agent's real directory.
 */
export async function getRemoteAgentCwd(sessionId: string): Promise<string | null> {
  if (!sessionId || !(await isAgentCaptureAllowed(sessionId))) return null;
  try {
    return (await getSessionCwd(sessionId)) || null;
  } catch {
    return null;
  }
}
