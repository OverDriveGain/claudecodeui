import type { Project } from '../types/app';

/**
 * Stable identity for a remote-control agent, used as the key for the per-user
 * "Remove from view" preference.
 *
 * WHY NOT the relay session id: a remote agent's id (cse_… / session_…) ROTATES
 * every time the agent restarts, so keying a hide on it would silently un-hide the
 * agent the moment it restarts. The agent's TITLE (its session name, e.g.
 * "environment") is stable across restarts, and — when the deployment runs more
 * than one claude.ai login (RC_ACCOUNTS) — the account label disambiguates two
 * agents that happen to share a title across accounts.
 *
 * Key = `accounttitle` when an account label is present, else just `title`
 * ( = ASCII unit separator, so it never collides with title text). This
 * mirrors exactly what the sidebar already renders (displayName + remoteAccount),
 * so the client can compute it with no extra server round-trip.
 */
export function agentDisplayKey(project: Pick<Project, 'displayName' | 'remoteAccount'>): string {
  const title = (project.displayName ?? '').trim();
  const account =
    typeof project.remoteAccount === 'string' ? project.remoteAccount.trim() : '';
  return account ? `${account}${title}` : title;
}
