import express from 'express';

import type { createAdminService } from './admin.service.js';

type AuthenticatedRequest = express.Request & { user?: { account_owner?: unknown } };

// Every route here is owner-only. Mounted behind authenticateToken, so req.user
// is always set; this gate additionally requires the operator role.
function requireAccountOwner(req: express.Request, res: express.Response): boolean {
  if (!(req as AuthenticatedRequest).user?.account_owner) {
    res.status(403).json({ error: 'Only an account owner can manage users', code: 'ADMIN_FORBIDDEN' });
    return false;
  }
  return true;
}

/** Owner-only user administration routes (list / create / reset password). */
export function createAdminRouter(service: ReturnType<typeof createAdminService>): express.Router {
  const router = express.Router();

  router.get('/users', (req, res, next) => {
    try {
      if (!requireAccountOwner(req, res)) return;
      res.json(service.listUsers());
    } catch (error) {
      next(error);
    }
  });

  router.post('/users', async (req, res, next) => {
    try {
      if (!requireAccountOwner(req, res)) return;
      const body = req.body as { username?: unknown };
      res.json(await service.createUser(body.username, req.body));
    } catch (error) {
      next(error);
    }
  });

  router.post('/users/:id/reset-password', async (req, res, next) => {
    try {
      if (!requireAccountOwner(req, res)) return;
      res.json(await service.resetPassword(req.params.id));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
