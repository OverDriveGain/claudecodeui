// rc.service.ts — app-facing wrapper around the remote-control engine.
//
// The engine (server/remote-control/rc-client.js) knows HOW to talk to Anthropic's
// CCR v2 relay. This service is the thin layer the rest of the app calls: it adds
// brief caching (so the sidebar refresh doesn't hammer the API), never-throws error
// handling (the view degrades to empty instead of crashing), the operator-only
// capture policy, and the `remote:<sessionId>` virtual-project id helpers.

// rc-client.js is plain ESM (allowJs build) — imported as untyped.
import {
  isRemoteControlConfigured,
  listAgents,
  getSessionCwd,
  hasMultipleAccounts,
  getAccountErrors,
} from '@/remote-control/rc-client.js';
import { currentAgentAllow } from '@/services/user-context.js';
import { resolveLocalSessionCwd } from '@/services/local-sessions.js';

// Paging the whole fleet is heavier than a single request. The roster itself
// changes slowly, but worker_status (the running dot) needs to feel live, and the
// /agent-status poll is served from this same cache — so keep it short enough that
// a working agent lights up within a few seconds, like claude.ai/code.
const LIST_TTL_MS = 5000;
const REMOTE_PREFIX = 'remote:';

export type RemoteAgent = {
  id: string; // cse_… / session_… — the live session id to drive
  title: string; // the agent's name (its session title)
  connected: boolean; // DRIVABLE: connected AND active (an archived session reports
  // connection_status=connected but 409s "not active" on send — so this is the
  // honest "can I talk to it" flag the GUI shows as the online dot)
  running: boolean; // worker_status==='running' — agent is mid-turn (sidebar dot)
  repo?: string | null; // stable identity across restarts (git repo)
  lastEventAt?: string; // recency — what the claude.ai "Recents" view orders by
  createdAt?: string;
  account?: string; // owning claude.ai account label — set only when >1 account
  // is configured (RC_ACCOUNTS), so single-account deployments stay unchanged.
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

/**
 * Narrow the (already deployment-filtered) agent list to what the CURRENT user is
 * allowed to see — their per-user `agent_allow` patterns (carried via the request
 * context). null/empty = unrestricted (admin). Applied on every read, so it gates
 * the list AND — because isAgentCaptureAllowed derives from this list — drive,
 * subscribe, history, and file access for that user too. Matches the cleaned
 * title (what the list already exposes).
 */
function filterByUser(agents: RemoteAgent[]): RemoteAgent[] {
  const allow = currentAgentAllow();
  if (!allow || allow.length === 0) return agents;
  const res = allow.map(globToRegExp);
  return agents.filter((a) => res.some((re) => re.test(a.title)));
}

// `value` is the collapsed one-leaf-per-agent list the GUI shows; `sessions` is the
// UNCOLLAPSED capture-filtered list (every session of every visible agent, cleaned
// titles). The visibility gate checks `sessions`: an agent restart rotates its leaf
// to a new session id, and a conversation/files view still open on the OLD id must
// keep working (files browse, history, drive) — the policy is per-agent, not
// per-session. Gating on the collapsed list silently 404'd/black-holed those views.
let agentCache: { at: number; value: RemoteAgent[]; sessions: RemoteAgent[] } | null = null;

/**
 * List the operator's agents — every `claude --remote-control` session, online and
 * offline — SUBJECT TO the capture policy, sorted online-first. Cached briefly;
 * returns [] (never throws) on error, serving the last good list if the API is
 * momentarily down.
 */
export async function listRemoteAgents({ force = false } = {}): Promise<RemoteAgent[]> {
  if (!remoteControlEnabled()) return [];
  const now = Date.now();
  if (!force && agentCache && now - agentCache.at < LIST_TTL_MS) return filterByUser(agentCache.value);
  try {
    const raw = await listAgents();
    // Only expose the account label when the deployment actually runs >1 account —
    // keeps single-account deployments visually and behaviourally identical.
    const multi = hasMultipleAccounts();
    type Mapped = RemoteAgent & { active: boolean };
    const mapped: Mapped[] = (Array.isArray(raw) ? raw : [])
      .map((s: Record<string, unknown>) => ({
        id: String(s.id ?? ''),
        title: String(s.title ?? 'agent').trim() || 'agent',
        connected: Boolean(s.connected),
        active: Boolean(s.active),
        running: Boolean(s.running),
        repo: s.repo ? String(s.repo) : null,
        lastEventAt: s.lastEventAt ? String(s.lastEventAt) : undefined,
        createdAt: s.createdAt ? String(s.createdAt) : undefined,
        account: multi && s.account ? String(s.account) : undefined,
      }))
      // Capture policy matches the agent NAME, so test the cleaned title — a
      // slash-launched session ("/environment") must still match the "environment"
      // allow pattern, otherwise the live session is filtered out and only dead
      // older sessions remain.
      .filter((s) => s.id && captureAllows(cleanAgentTitle(s.title)));

    // One agent has many sessions (each restart makes a new one). Collapse to one
    // leaf per agent, keyed on the CLEANED TITLE (the capture filter guarantees every
    // surviving session's cleaned title equals a roster agent name; cleanAgentTitle
    // absorbs the "/name" vs "name" slash drift). Among an agent's sessions, prefer
    // the most DRIVABLE one: connected+active beats connected-but-archived beats
    // disconnected. listAgents is most-recent-first, so within a tier the newest wins.
    // Without this, the newest session is picked even when archived — and a send to it
    // 409s "not active" (the exact bug where a green agent can't be messaged).
    const drivabilityTier = (a: Mapped): number =>
      a.connected && a.active ? 2 : a.connected ? 1 : 0;
    const byKey = new Map<string, Mapped>();
    for (const a of mapped) {
      const key = cleanAgentTitle(a.title) || a.repo || a.id;
      const cur = byKey.get(key);
      if (!cur || drivabilityTier(a) > drivabilityTier(cur)) byKey.set(key, a);
    }

    // Sort by recency (most-recently-active first), matching claude.ai "Recents".
    // Display the cleaned title; expose `connected` as the honest DRIVABLE state
    // (connected AND active) so the GUI's online dot reflects "can I message it".
    const value = [...byKey.values()]
      .map((a) => ({ ...a, title: cleanAgentTitle(a.title) || a.title, connected: a.connected && a.active }))
      .sort((a, b) =>
        String(b.lastEventAt ?? '').localeCompare(String(a.lastEventAt ?? '')),
      );
    agentCache = {
      at: now,
      value,
      sessions: mapped.map((a) => ({ ...a, title: cleanAgentTitle(a.title) || a.title })),
    };
    return filterByUser(value);
  } catch {
    return filterByUser(agentCache?.value ?? []);
  }
}

/**
 * True if a session id is allowed by the capture policy — used to gate driving and
 * history so the policy can't be bypassed by guessing a cse_ id from the browser.
 */
export async function isAgentCaptureAllowed(sessionId: string): Promise<boolean> {
  const agents = await listRemoteAgents(); // refreshes the cache (TTL-guarded)
  if (agents.some((a) => a.id === sessionId)) return true;
  // Not the current leaf — allow any OTHER session of a visible agent too (same
  // capture + per-user title filters). An agent restart rotates the leaf id; views
  // still open on the previous session must keep browsing/driving it.
  const sessions = agentCache?.sessions ?? [];
  return filterByUser(sessions).some((a) => a.id === sessionId);
}

/**
 * The agent's working directory (session_context.cwd from the relay), or null.
 * Capture-gated so a browser can't read an arbitrary agent's path by guessing an id.
 * Used to point the file browser at the live agent's real directory.
 */
export async function getRemoteAgentCwd(sessionId: string): Promise<string | null> {
  if (!sessionId || !(await isAgentCaptureAllowed(sessionId))) return null;
  // Prefer claude's own per-host session registry (~/.claude/sessions/*.json): it
  // holds the real cwd for a bridge session, which the relay reports as empty. This
  // resolves any agent running on THIS host with no relay round-trip. Cross-host
  // agents miss here and fall through to the relay (and, later, the peer mesh).
  const localCwd = resolveLocalSessionCwd(sessionId);
  if (localCwd) return localCwd;
  try {
    return (await getSessionCwd(sessionId)) || null;
  } catch {
    return null;
  }
}

export type AccountError = { label: string; status: number; message: string };

/**
 * Per-account roster-fetch errors from the last agent-list fanout — e.g. an expired
 * token on one login. Empty when every account is healthy. Lets the UI warn
 * "account X failed" without hiding the accounts that DID load. NOT gated on
 * multi-account: a single-account deployment whose lone login dies used to report
 * `{agents: [], accountErrors: []}` — an empty roster with zero diagnostic signal
 * (that exact silence cost a day on the 2026-07-22 box outage).
 */
export function listAccountErrors(): AccountError[] {
  try {
    return (getAccountErrors() as AccountError[]) ?? [];
  } catch {
    return [];
  }
}
