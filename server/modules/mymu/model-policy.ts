/**
 * Per-user model block-list.
 *
 * A pure policy layer (no DB, no request coupling) shared by the two enforcement
 * points so "hidden from the picker" and "rejected at send" always agree:
 *   1. the `/:provider/models` route filters the catalog before returning it,
 *   2. the chat WebSocket send path rejects a turn whose model is blocked.
 *
 * SECURITY: hiding is convenience; the send-time reject is the real gate. A
 * session already recorded with a now-blocked model, or a hand-crafted request,
 * is refused there — the restriction is never UI-only.
 *
 * Unlike agent visibility, this is INDEPENDENT of `account_owner`: model
 * cost-control is a separate axis, so a block applies to whoever it is set on,
 * operator or not. It is purely opt-in — a user with no `model_deny` (the common
 * case, including owners) is entirely unaffected.
 */

/** The user fields the model policy reads (subset of the users row). */
export interface ModelPolicyUser {
  model_deny?: string | null;
}

/**
 * Parse a stored `model_deny` string into a set of blocked model values.
 * Comma- or whitespace-separated; matched case-insensitively against a model's
 * `value`. Empty/whitespace → empty array (no restriction).
 */
export function parseModelDeny(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * The effective block-list for a user: their parsed `model_deny`. A null/absent
 * user is an internal/context-less call and is unrestricted. Owners are NOT
 * special-cased — a block set on an operator account still applies.
 */
export function effectiveModelDeny(user: ModelPolicyUser | null | undefined): string[] {
  if (!user) return [];
  return parseModelDeny(user.model_deny);
}

/** Whether `model` is on the given block-list (case-insensitive exact match). */
export function isModelBlocked(model: string | null | undefined, deny: string[]): boolean {
  if (deny.length === 0) return false;
  const normalized = typeof model === 'string' ? model.trim().toLowerCase() : '';
  if (!normalized) return false;
  return deny.includes(normalized);
}
