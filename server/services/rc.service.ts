// rc.service.ts — app-facing wrapper around the remote-control engine.
//
// The engine (server/remote-control/rc-client.js) knows HOW to talk to Anthropic's
// CCR v2 relay. This service is the thin layer the rest of the app calls: it adds
// brief caching (so the sidebar refresh doesn't hammer the API), never-throws error
// handling (the view degrades to empty instead of crashing), the operator-only
// capture policy, and the `remote:<sessionId>` virtual-project id helpers.

// rc-client.js is plain ESM (allowJs build) — imported as untyped.
import { isRemoteControlConfigured, listConnectedAgents } from '@/remote-control/rc-client.js';

const LIST_TTL_MS = 8000;
const REMOTE_PREFIX = 'remote:';

export type RemoteAgent = {
  id: string; // cse_… / session_… — the live session id to drive
  title: string; // the agent's name (its session title)
  createdAt?: string;
};

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
 * List the operator's CONNECTED agents — every live `claude --remote-control`
 * session — SUBJECT TO the capture policy. Cached briefly; returns [] (never throws)
 * on error, serving the last good list if the API is momentarily down.
 */
export async function listRemoteAgents({ force = false } = {}): Promise<RemoteAgent[]> {
  if (!remoteControlEnabled()) return [];
  const now = Date.now();
  if (!force && agentCache && now - agentCache.at < LIST_TTL_MS) return agentCache.value;
  try {
    const raw = await listConnectedAgents();
    const value: RemoteAgent[] = (Array.isArray(raw) ? raw : [])
      .map((s: Record<string, unknown>) => ({
        id: String(s.id ?? ''),
        title: String(s.title ?? 'agent').trim() || 'agent',
        createdAt: s.createdAt ? String(s.createdAt) : undefined,
      }))
      .filter((s) => s.id && captureAllows(s.title));
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
