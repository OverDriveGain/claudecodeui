import express from 'express';

import { agentHostAssignmentsDb } from '../modules/database/index.js';

const router = express.Router();

// --- Agent → host assignments (deployment-global, admin-set) -----------------
// Live agents never move machines, so which CCUI host an agent runs on is a
// MANUAL assignment made in the agents view (Manar, 2026-07-26), not discovery.
// The client uses the mapping to keep the assigned host's copy of the agent
// (when logged into that host), which routes sends — and therefore file
// landing — to the agent's real machine. `agentKey` is the same stable identity
// as user_hidden_agents (account label + title), never the relay session id.
// Everyone authenticated may READ (routing is universal); only an account
// owner may write.

function readBody(req) {
  const agentKey = typeof req.body?.agentKey === 'string' ? req.body.agentKey.trim() : '';
  const hostUrl = typeof req.body?.hostUrl === 'string' ? req.body.hostUrl.trim() : '';
  return { agentKey, hostUrl };
}

function requireAccountOwner(req, res) {
  if (!req.user?.account_owner) {
    res.status(403).json({ error: 'Only an account owner can assign agent hosts' });
    return false;
  }
  return true;
}

router.get('/', (req, res) => {
  try {
    const assignments = {};
    for (const row of agentHostAssignmentsDb.list()) {
      assignments[row.agent_key] = row.host_url;
    }
    res.json({ success: true, assignments });
  } catch (error) {
    console.error('Error listing agent host assignments:', error);
    res.status(500).json({ error: 'Failed to list agent host assignments' });
  }
});

router.put('/', (req, res) => {
  try {
    if (!requireAccountOwner(req, res)) return;
    const { agentKey, hostUrl } = readBody(req);
    if (!agentKey) {
      return res.status(400).json({ error: 'agentKey is required' });
    }
    if (!hostUrl || !/^https?:\/\//i.test(hostUrl)) {
      return res.status(400).json({ error: 'hostUrl must be an http(s) origin' });
    }
    agentHostAssignmentsDb.set(agentKey, new URL(hostUrl).origin);
    res.json({ success: true });
  } catch (error) {
    console.error('Error setting agent host assignment:', error);
    res.status(500).json({ error: 'Failed to set agent host assignment' });
  }
});

router.delete('/', (req, res) => {
  try {
    if (!requireAccountOwner(req, res)) return;
    const { agentKey } = readBody(req);
    if (!agentKey) {
      return res.status(400).json({ error: 'agentKey is required' });
    }
    agentHostAssignmentsDb.clear(agentKey);
    res.json({ success: true });
  } catch (error) {
    console.error('Error clearing agent host assignment:', error);
    res.status(500).json({ error: 'Failed to clear agent host assignment' });
  }
});

export default router;
