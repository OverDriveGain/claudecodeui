// deployment-policy.ts — deployment-wide capability lock.
//
// A single server switch (env `CCUI_LOCKDOWN=1`) that removes the destructive /
// structural actions at the API layer, so a deployment can be handed to users
// who should only view and hold conversations — never reshape or erase things.
//
// This is enforced SERVER-SIDE on purpose: hiding a button in the frontend is
// cosmetic and trivially bypassed (the browser console, or any script, can still
// hit the route). The lock lives here so every client — web, iOS, a raw curl —
// obeys it. The frontend reads the same flag only to hide the affordances it
// can no longer use.
//
// When ON:
//   - creating a new project        → blocked (403)
//   - deleting / removing a project  → blocked (403)
//   - permanently deleting a chat    → downgraded to ARCHIVE (never unlinks the
//                                       transcript; the conversation is only hidden)
// Still allowed: viewing, opening existing projects/agents, starting new
// conversations, driving agents, and archiving (recoverable).
//
// Read per-call so a deployment flips policy with a restart, never at runtime by
// a user. Default OFF — existing deployments are unaffected until they opt in.

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** Is this deployment locked to view + converse (no create/delete of projects,
 *  no permanent conversation deletion)? Controlled solely by server env. */
export function isLockdownEnabled(): boolean {
  return TRUTHY.has(String(process.env.CCUI_LOCKDOWN ?? '').trim().toLowerCase());
}
