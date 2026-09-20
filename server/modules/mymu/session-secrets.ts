// session-secrets.ts — in-memory per-user login secrets for the password-auth
// (model "b") cross-user access path.
//
// When a MyMu account authenticates against its LINUX password (PAM/`su`), that
// password is stashed here for the life of the session so `user-fs` can become
// the linux user with `su` — no root sudo seam, no on-disk secret. Keyed by the
// linux username (the thing `su` needs). Access is what proves consent, so the
// value is the user's OWN password used only to reach the user's OWN files.
//
// Deliberately RAM-only: nothing is written to disk, and a process restart wipes
// every secret — a mapped user must sign in again before their files/agents are
// reachable. That is the accepted tradeoff for not holding a durable credential.

type SecretEntry = { password: string; touchedAt: number };

const SECRETS = new Map<string, SecretEntry>();

// Sliding idle lifetime. Matches the 7-day JWT so an active session never loses
// file access mid-life; refreshed on every use. Overridable for tests.
const TTL_MS = Number(process.env.CCUI_SECRET_TTL_MS) || 7 * 24 * 60 * 60 * 1000;

/** Store (or refresh) the linux password for a user's active session. */
export function setUserSecret(linuxUser: string, password: string): void {
  if (!linuxUser || typeof password !== 'string') return;
  SECRETS.set(linuxUser, { password, touchedAt: Date.now() });
}

/**
 * The stored password for a linux user, or null if none / expired. Reading it
 * slides the idle timer so an in-use session stays authenticated.
 */
export function getUserSecret(linuxUser: string): string | null {
  const entry = SECRETS.get(linuxUser);
  if (!entry) return null;
  if (Date.now() - entry.touchedAt > TTL_MS) {
    SECRETS.delete(linuxUser);
    return null;
  }
  entry.touchedAt = Date.now();
  return entry.password;
}

/** True when a live secret exists — used to pick the `su` path over `sudo`. */
export function hasUserSecret(linuxUser: string): boolean {
  return getUserSecret(linuxUser) !== null;
}

/** Forget a user's secret (logout / explicit revoke). */
export function clearUserSecret(linuxUser: string): void {
  if (linuxUser) SECRETS.delete(linuxUser);
}
