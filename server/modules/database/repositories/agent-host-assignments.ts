/**
 * Agent → host assignment repository.
 *
 * Deployment-global (admin-set) pinning of a live agent to the CCUI host it runs
 * on. Live agents never move machines, so this is a manual mapping edited in the
 * agents view — no discovery. The client uses it to keep the assigned host's
 * copy of the agent (when logged into that host), which routes sends — and
 * therefore file landing — to the agent's real machine. `agent_key` is the same
 * STABLE identity used by user_hidden_agents (account label + agent title),
 * never the volatile relay session id.
 */

import { getConnection } from '@/modules/database/connection.js';

export const agentHostAssignmentsDb = {
  /** All assignments as { agent_key, host_url } rows. */
  list(): { agent_key: string; host_url: string }[] {
    const db = getConnection();
    return db
      .prepare('SELECT agent_key, host_url FROM agent_host_assignments ORDER BY agent_key')
      .all() as { agent_key: string; host_url: string }[];
  },

  /** Assign (or reassign) an agent to a host. */
  set(agentKey: string, hostUrl: string): void {
    const db = getConnection();
    db.prepare(
      `INSERT INTO agent_host_assignments (agent_key, host_url) VALUES (?, ?)
       ON CONFLICT(agent_key) DO UPDATE SET host_url = excluded.host_url, assigned_at = CURRENT_TIMESTAMP`
    ).run(agentKey, hostUrl);
  },

  /** Remove an assignment (agent falls back to default primary-host routing). */
  clear(agentKey: string): void {
    const db = getConnection();
    db.prepare('DELETE FROM agent_host_assignments WHERE agent_key = ?').run(agentKey);
  },
};
