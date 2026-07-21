/**
 * Per-request user context.
 *
 * Carries the authenticated user's remote-agent visibility (their `agent_allow`
 * patterns) through the call stack via AsyncLocalStorage, so the central capture
 * checks in `rc.service` can enforce per-user scoping WITHOUT threading a user
 * argument through every agent/list/subscribe/drive/history/file call site.
 *
 * It is set in exactly two places — the HTTP auth middleware and the chat
 * WebSocket message handler — both of which run only for an authenticated user.
 * Anything reached from there (route handlers, services, WS dispatch) sees the
 * store. Code with no context (internal/admin tasks) reads `null` = unrestricted.
 *
 * SECURITY: this is the load-bearing enforcement point. A restricted user's
 * agent list is filtered AND every drive/subscribe/history/file path re-checks
 * the same allow-list, so a hand-crafted request for an out-of-scope agent is
 * rejected — visibility is never UI-only.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface UserContext {
  /** null = unrestricted (admin). Otherwise: only agents whose name matches one. */
  agentAllow: string[] | null;
  /**
   * Per-user LOCAL project + file visibility, kept SEPARATE from agentAllow so
   * "which remote agents show" and "which local projects show" are independent
   * concerns. null = unrestricted (see every local project/file). A restricted
   * tenant inherits agentAllow here (see runWithUserContext) so multi-tenant
   * project isolation keeps working with no re-provisioning; a user who should
   * see all projects but only some agents gets `*` (or an explicit list).
   */
  projectAllow: string[] | null;
}

const storage = new AsyncLocalStorage<UserContext>();

/** Parse a stored `agent_allow` string into patterns. Empty/whitespace → null. */
export function parseAgentAllow(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  const patterns = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return patterns.length > 0 ? patterns : null;
}

/** Compile one `agent_allow` glob (case-insensitive, `*` = wildcard) to a RegExp. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Whether `name` is visible to a user with the given `agentAllow` patterns. null/empty
 * = unrestricted (true for everything). Pure — takes the patterns explicitly, so it
 * works off the request context (isNameAllowedForUser) AND off a stored per-connection
 * allow-list (the watcher's per-client broadcast).
 */
export function isNameAllowedFor(name: string, agentAllow: string[] | null | undefined): boolean {
  if (!agentAllow || agentAllow.length === 0) return true;
  return agentAllow.some((pattern) => globToRegExp(pattern).test(name));
}

/**
 * Whether a LOCAL project/file `name` is visible to the CURRENT request's user.
 * Returns true when the user is unrestricted (admin / context-less). Otherwise the
 * name must match one of their PROJECT patterns (projectAllow — which inherits
 * agent_allow for a restricted tenant). Used to gate the project list, file reads
 * and history for local projects, independently of remote-agent visibility.
 */
export function isNameAllowedForUser(name: string): boolean {
  return isNameAllowedFor(name, currentProjectAllow());
}

/**
 * Resolve the effective PROJECT allow-list from the raw column values. A null
 * `project_allow` inherits `agent_allow`, so existing single-column tenants stay
 * isolated with no migration; a value of `*` (or a list) overrides it — the way a
 * user sees all projects while still having a filtered agent list.
 */
function effectiveProjectRaw(
  agentAllowRaw: string | null | undefined,
  projectAllowRaw: string | null | undefined,
): string | null | undefined {
  return projectAllowRaw != null ? projectAllowRaw : agentAllowRaw;
}

/** Parse the effective project patterns from the raw column values. */
export function resolveProjectAllow(
  agentAllowRaw: string | null | undefined,
  projectAllowRaw: string | null | undefined,
): string[] | null {
  return parseAgentAllow(effectiveProjectRaw(agentAllowRaw, projectAllowRaw));
}

/** Run `fn` with the given user's agent- AND project-visibility context active. */
export function runWithUserContext<T>(
  agentAllowRaw: string | null | undefined,
  projectAllowRaw: string | null | undefined,
  fn: () => T,
): T {
  return storage.run(
    {
      agentAllow: parseAgentAllow(agentAllowRaw),
      projectAllow: resolveProjectAllow(agentAllowRaw, projectAllowRaw),
    },
    fn,
  );
}

/**
 * The current request's agent allow-list. `null` means "no restriction" — either
 * an admin user (no agent_allow set) or a context-less internal call.
 */
export function currentAgentAllow(): string[] | null {
  return storage.getStore()?.agentAllow ?? null;
}

/**
 * The current request's LOCAL project/file allow-list. `null` = unrestricted.
 * Separate from currentAgentAllow so project visibility is independent of which
 * remote agents the user may see.
 */
export function currentProjectAllow(): string[] | null {
  return storage.getStore()?.projectAllow ?? null;
}
