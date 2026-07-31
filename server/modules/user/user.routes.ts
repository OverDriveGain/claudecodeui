import express from 'express';

import type { createUserService } from './user.service.js';
// MYMU
import { userHiddenAgentsDb } from '@/modules/database/index.js';

type AuthenticatedRequest = express.Request & { user?: { id?: number | string } };

function readUserId(request: express.Request): number {
  const rawUserId = (request as AuthenticatedRequest).user?.id;
  return Number(rawUserId);
}

/** Creates thin user routes that parse authenticated input and call the service. */
export function createUserRouter(service: ReturnType<typeof createUserService>): express.Router {
  const router = express.Router();

  router.get('/git-config', async (req, res, next) => {
    try {
      res.json(await service.getGitConfig(readUserId(req)));
    } catch (error) {
      next(error);
    }
  });

  router.post('/git-config', async (req, res, next) => {
    try {
      const body = req.body as { gitName?: unknown; gitEmail?: unknown };
      res.json(await service.updateGitConfig(readUserId(req), body.gitName, body.gitEmail));
    } catch (error) {
      next(error);
    }
  });

  router.post('/complete-onboarding', (req, res, next) => {
    try {
      res.json(service.completeOnboarding(readUserId(req)));
    } catch (error) {
      next(error);
    }
  });

  router.get('/onboarding-status', (req, res, next) => {
    try {
      res.json(service.getOnboardingStatus(readUserId(req)));
    } catch (error) {
      next(error);
    }
  });

  // MYMU: per-user "hide agent from my view" preference (FORK.md S1). Auth is
  // applied at the mount (`/api/user` uses authenticateToken); req.user is set.
  router.get('/hidden-agents', (req, res) => {
    try {
      const userId = (req as { user?: { id?: number } }).user?.id as number;
      res.json({ success: true, hiddenAgentKeys: userHiddenAgentsDb.listKeys(userId) });
    } catch (error) {
      console.error('Error listing hidden agents:', error);
      res.status(500).json({ error: 'Failed to list hidden agents' });
    }
  });

  router.post('/hidden-agents', (req, res) => {
    try {
      const userId = (req as { user?: { id?: number } }).user?.id as number;
      const raw = (req.body as { agentKey?: unknown } | undefined)?.agentKey;
      const agentKey = typeof raw === 'string' ? raw.trim() : '';
      if (!agentKey) {
        return res.status(400).json({ error: 'agentKey is required' });
      }
      userHiddenAgentsDb.hide(userId, agentKey);
      res.json({ success: true, hiddenAgentKeys: userHiddenAgentsDb.listKeys(userId) });
    } catch (error) {
      console.error('Error hiding agent:', error);
      res.status(500).json({ error: 'Failed to hide agent' });
    }
  });

  router.delete('/hidden-agents', (req, res) => {
    try {
      const userId = (req as { user?: { id?: number } }).user?.id as number;
      const raw = (req.body as { agentKey?: unknown } | undefined)?.agentKey;
      const agentKey = typeof raw === 'string' ? raw.trim() : '';
      if (!agentKey) {
        return res.status(400).json({ error: 'agentKey is required' });
      }
      userHiddenAgentsDb.unhide(userId, agentKey);
      res.json({ success: true, hiddenAgentKeys: userHiddenAgentsDb.listKeys(userId) });
    } catch (error) {
      console.error('Error unhiding agent:', error);
      res.status(500).json({ error: 'Failed to unhide agent' });
    }
  });

  return router;
}
