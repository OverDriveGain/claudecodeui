import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../utils/api';
import { agentDisplayKey } from '../utils/agentKey';
import type { Project } from '../types/app';

type HiddenAgentProject = Pick<Project, 'displayName' | 'remoteAccount'>;

/**
 * Per-user "Remove from view" state for the agents view. Loads the current user's
 * hidden agent keys once, then hides/unhides optimistically (the row disappears
 * immediately; the DB write follows and rolls back on failure).
 *
 * The key is a STABLE agent identity (account + title), never the volatile relay
 * session id, so a hidden agent stays hidden across relay/agent restarts.
 */
export function useHiddenAgents() {
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set());

  const reload = useCallback(async () => {
    try {
      const res = await authenticatedFetch('/api/user/hidden-agents');
      if (!res.ok) return;
      const data = (await res.json()) as { hiddenAgentKeys?: unknown };
      const keys = Array.isArray(data.hiddenAgentKeys)
        ? data.hiddenAgentKeys.filter((k): k is string => typeof k === 'string')
        : [];
      setHiddenKeys(new Set(keys));
    } catch {
      // Non-fatal: an unreachable preference endpoint just means nothing is hidden.
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const isHidden = useCallback(
    (project: HiddenAgentProject) => hiddenKeys.has(agentDisplayKey(project)),
    [hiddenKeys],
  );

  const hideAgent = useCallback(async (project: HiddenAgentProject) => {
    const key = agentDisplayKey(project);
    if (!key) return;
    setHiddenKeys((prev) => new Set(prev).add(key));
    try {
      const res = await authenticatedFetch('/api/user/hidden-agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentKey: key }),
      });
      if (!res.ok) throw new Error('hide failed');
    } catch {
      setHiddenKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, []);

  const unhideAgent = useCallback(async (project: HiddenAgentProject) => {
    const key = agentDisplayKey(project);
    if (!key) return;
    setHiddenKeys((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    try {
      const res = await authenticatedFetch('/api/user/hidden-agents', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentKey: key }),
      });
      if (!res.ok) throw new Error('unhide failed');
    } catch {
      setHiddenKeys((prev) => new Set(prev).add(key));
    }
  }, []);

  return { hiddenKeys, isHidden, hideAgent, unhideAgent };
}
