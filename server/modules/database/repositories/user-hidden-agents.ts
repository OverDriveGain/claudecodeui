/**
 * Per-user hidden-agents repository.
 *
 * Backs the "Remove from view" display preference in the agents view. Each row is
 * a (user_id, agent_key) pair, where `agent_key` is a STABLE agent identity
 * (account label + agent title) rather than the volatile relay session id — so a
 * hidden agent stays hidden across relay/agent restarts. Pure display state: it
 * never gates access, only what THIS user sees listed.
 */

import { getConnection } from '@/modules/database/connection.js';

export const userHiddenAgentsDb = {
  /** Every agent_key this user has hidden. */
  listKeys(userId: number): string[] {
    const db = getConnection();
    const rows = db
      .prepare('SELECT agent_key FROM user_hidden_agents WHERE user_id = ? ORDER BY hidden_at DESC')
      .all(userId) as { agent_key: string }[];
    return rows.map((r) => r.agent_key);
  },

  /** Hide an agent for this user. Idempotent (no-op if already hidden). */
  hide(userId: number, agentKey: string): void {
    const db = getConnection();
    db.prepare(
      'INSERT OR IGNORE INTO user_hidden_agents (user_id, agent_key) VALUES (?, ?)'
    ).run(userId, agentKey);
  },

  /** Unhide an agent for this user. Idempotent. */
  unhide(userId: number, agentKey: string): void {
    const db = getConnection();
    db.prepare(
      'DELETE FROM user_hidden_agents WHERE user_id = ? AND agent_key = ?'
    ).run(userId, agentKey);
  },
};
