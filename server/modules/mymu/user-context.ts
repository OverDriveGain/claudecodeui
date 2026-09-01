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
   * The linux user this account maps to (one-instance-per-host). Local projects
   * under /home/<linuxUser>/ are theirs BY PATH regardless of naming. null =
   * unrestricted (owner) or unmapped.
   */
  linuxUser: string | null;
  /**
   * Per-user agent BLOCK-list (`agent_deny`). null/empty = nothing blocked.
   * Evaluated LAST and unconditionally: a denied name is invisible even when the
   * allow-list matches it, even when the project lives in the user's own home,
   * and even for an `account_owner`. See `isNameDeniedFor`.
   */
  agentDeny: string[] | null;
}

const storage = new AsyncLocalStorage<UserContext>();

/** Parse a stored `agent_allow` string into patterns. Empty/whitespace → null. */
export function parseAgentAllow(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  const patterns = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return patterns.length > 0 ? patterns : null;
}

/**
 * Parse a stored `agent_deny` string into patterns. Same glob syntax as
 * `agent_allow`, but comma OR whitespace separated (agent names never contain
 * spaces, so this is strictly more forgiving). Empty/whitespace → null.
 */
export function parseAgentDeny(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  const patterns = raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
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
 * Whether `name` is visible to the CURRENT request's user. Returns true when the
 * user is unrestricted (admin / context-less). Otherwise the name must match one of
 * their `agent_allow` patterns. Used to scope a restricted user to the local project
 * (and remote agent) that shares its agent's name — the same name match the agent
 * list uses — so the per-user filter is one consistent rule across list/history/files.
 */
export function isNameAllowedForUser(name: string): boolean {
  return isNameAllowedFor(name, currentAgentAllow());
}

/**
 * Whether `name` is BLOCKED by the given `agent_deny` patterns. null/empty = nothing
 * blocked (false for everything). Same case-insensitive glob syntax as the allow-list.
 *
 * SECURITY: deny is the OVERRIDE. Every visibility decision is
 * `denied ? hidden : (allowed || path-owned)`, so a block cannot be defeated by an
 * allow pattern that also matches, by the project living in the user's own home, or
 * by the account being an `account_owner`. Pure — takes the patterns explicitly, so
 * it works off the request context (isNameDeniedForUser) AND off a stored
 * per-connection block-list (the watcher's per-client broadcast).
 */
export function isNameDeniedFor(name: string, agentDeny: string[] | null | undefined): boolean {
  if (!agentDeny || agentDeny.length === 0) return false;
  if (!name) return false;
  return agentDeny.some((pattern) => globToRegExp(pattern).test(name));
}

/** Whether `name` is blocked for the CURRENT request's user. */
export function isNameDeniedForUser(name: string): boolean {
  return isNameDeniedFor(name, currentAgentDeny());
}

/** Run `fn` with the given user's agent-visibility context active. */
export function runWithUserContext<T>(
  agentAllowRaw: string | null | undefined,
  fn: () => T,
  linuxUser: string | null = null,
  agentDenyRaw: string | null | undefined = null,
): T {
  return storage.run(
    {
      agentAllow: parseAgentAllow(agentAllowRaw),
      linuxUser,
      agentDeny: parseAgentDeny(agentDenyRaw),
    },
    fn,
  );
}

/** The linux user the CURRENT request's account maps to (null = owner/unmapped). */
export function currentLinuxUser(): string | null {
  return storage.getStore()?.linuxUser ?? null;
}

/**
 * Which linux user a account maps to for PATH-based visibility. Owners are
 * unrestricted (null); everyone else maps to linux_user, defaulting to their
 * username. Pure companion of effectiveAgentAllowRaw.
 */
export function effectiveLinuxUser(user: VisibilityUser | null | undefined): string | null {
  if (!user) return null;
  if (user.account_owner) return null;
  const lu = (user.linux_user ?? user.username ?? '').trim();
  return lu || null;
}

/** Is `projectPath` inside the given linux user's home? The path-ownership rule. */
export function isPathOwnedByLinuxUser(projectPath: string, linuxUser: string | null | undefined): boolean {
  if (!linuxUser) return false;
  return projectPath === `/home/${linuxUser}` || projectPath.startsWith(`/home/${linuxUser}/`);
}

/** The user fields the visibility rule reads (subset of the users row). */
export interface VisibilityUser {
  username?: string | null;
  agent_allow?: string | null;
  agent_deny?: string | null;
  linux_user?: string | null;
  account_owner?: number | boolean | null;
}

/**
 * One-instance-per-host mapping rule (Manar, 2026-07-25). Resolves the RAW
 * allow string to run a user's context with:
 *   1. `account_owner` → null (unrestricted): sees every agent the deployment
 *      surfaces (RC_AGENT_ALLOW/DENY still apply — that is the host's scope).
 *   2. explicit `agent_allow` → wins as before (hand-tuned scoping).
 *   3. otherwise DERIVE from the linux user this account maps to
 *      (`linux_user`, defaulting to the username — aliases like wael→bti are
 *      just a different linux_user): `<lu>` and `<lu>-*`. The account name maps
 *      directly to its agents; no per-user pattern maintenance.
 * Legacy note: agent_allow-NULL users used to mean "admin". The migration
 * stamps those with account_owner=1, so old deployments keep exact behavior.
 */
export function effectiveAgentAllowRaw(user: VisibilityUser | null | undefined): string | null {
  if (!user) return null;
  if (user.account_owner) return null;
  const explicit = (user.agent_allow ?? '').trim();
  if (explicit) return explicit;
  const lu = (user.linux_user ?? user.username ?? '').trim();
  if (!lu) return null;
  return `${lu},${lu}-*`;
}

/**
 * The RAW block-list to run a user's context with. Unlike `effectiveAgentAllowRaw`
 * this is INDEPENDENT of `account_owner` and never derived: it is exactly what an
 * operator stored on the account, or null. Same axis-separation reasoning as
 * `model_deny` (F8) — a targeted block must apply to whoever it is set on, and an
 * account that has no `agent_deny` (the common case) is entirely unaffected.
 */
export function effectiveAgentDenyRaw(user: VisibilityUser | null | undefined): string | null {
  if (!user) return null;
  const explicit = (user.agent_deny ?? '').trim();
  return explicit || null;
}

/**
 * The current request's agent allow-list. `null` means "no restriction" — either
 * an admin user (no agent_allow set) or a context-less internal call.
 */
export function currentAgentAllow(): string[] | null {
  return storage.getStore()?.agentAllow ?? null;
}

/**
 * The current request's agent block-list. `null` means "nothing blocked" — the
 * common case, including owners and context-less internal calls.
 */
export function currentAgentDeny(): string[] | null {
  return storage.getStore()?.agentDeny ?? null;
}
