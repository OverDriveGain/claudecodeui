import express from 'express';

import { createProject, updateProjectDisplayName } from '@/modules/projects/services/project-management.service.js';
import { startCloneProject } from '@/modules/projects/services/project-clone.service.js';
import { getProjectTaskMaster } from '@/modules/projects/services/projects-has-taskmaster.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';
import { getArchivedProjectsWithSessions, getProjectSessionsPage, getProjectsWithSessions } from '@/modules/projects/services/projects-with-sessions-fetch.service.js';
import { deleteOrArchiveProject, restoreArchivedProject } from '@/modules/projects/services/project-delete.service.js';
import { applyLegacyStarredProjectIds, toggleProjectStar } from '@/modules/projects/services/project-star.service.js';
// MYMU
import { isLockdownEnabled, startAgentForTenant, TenantExecError } from '@/modules/mymu/index.js';
// MYMU: live relay agents roster (FORK.md S1)
import { listRemoteAgents, listAccountErrors } from '@/services/rc.service.js';
// MYMU
import { userHiddenAgentsDb } from '@/modules/database/index.js';

const router = express.Router();

// MYMU: deployment lockdown — reject structural mutations when locked (FORK.md S6)
function assertNotLocked(action: string): void {
  if (isLockdownEnabled()) {
    throw new AppError(`${action} is disabled on this deployment.`, {
      code: 'DEPLOYMENT_LOCKED',
      statusCode: 403,
    });
  }
}

type AuthenticatedUser = {
  id?: number | string;
};

function readQueryStringValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }

  return '';
}

function readOptionalNumericQueryValue(value: unknown): number | null {
  const rawValue = readQueryStringValue(value).trim();
  if (!rawValue) {
    return null;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isNaN(parsedValue) ? null : parsedValue;
}

function parseNonNegativeIntQuery(value: unknown, name: string, fallback: number): number {
  const rawValue = readQueryStringValue(value).trim();
  if (!rawValue) {
    return fallback;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsedValue) || parsedValue < 0) {
    throw new AppError(`${name} must be a non-negative integer`, {
      code: 'INVALID_QUERY_PARAMETER',
      statusCode: 400,
    });
  }

  return parsedValue;
}

function resolveRouteErrorMessage(error: unknown): string {
  if (error instanceof AppError) {
    return error.message;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Failed to clone repository';
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const skipSynchronization =
      readQueryStringValue(req.query.skipSynchronization).trim() === '1' ||
      readQueryStringValue(req.query.skipSync).trim() === '1';
    const sessionsLimit = readOptionalNumericQueryValue(req.query.sessionsLimit) ?? undefined;
    const sessionsOffset = readOptionalNumericQueryValue(req.query.sessionsOffset) ?? undefined;
    const projects = await getProjectsWithSessions({
      skipSynchronization,
      sessionsLimit,
      sessionsOffset,
    });
    // MYMU: apply the requesting user's per-user "hidden agents" preference to
    // relay leaves server-side, so the stock UI shows the curated roster.
    // Key = account + US(0x1f) + title (stable across relay restarts — same
    // format the web client's agentDisplayKey computes). ?includeHidden=1
    // reveals everything (the "Show online" affordance).
    let visible = projects;
    try {
      const userId = (req as { user?: { id?: number } }).user?.id;
      const includeHidden = req.query.includeHidden === '1' || req.query.includeHidden === 'true';
      if (userId && !includeHidden) {
        const hidden = new Set(userHiddenAgentsDb.listKeys(userId));
        if (hidden.size > 0) {
          visible = projects.filter((p) => {
            if (!p.isRemoteAgent) return true;
            const title = (p.displayName ?? '').trim();
            const account = typeof p.remoteAccount === 'string' ? p.remoteAccount.trim() : '';
            const key = account ? `${account}\u001f${title}` : title;
            return !hidden.has(key);
          });
        }
      }
    } catch { /* never let the preference break the listing */ }
    res.json(visible);
  }),
);


// MYMU: Lightweight live status for remote-control agents — { id, running,
// connected } per connected agent. Cheap (rc.service cache), polled every few
// seconds by clients to drive the running dot. Never throws.
router.get(
  '/agent-status',
  asyncHandler(async (_req, res) => {
    let agents: Array<{ id: string; running: boolean; connected: boolean }> = [];
    try {
      const list = await listRemoteAgents();
      agents = list.map((a) => ({ id: a.id, running: a.running, connected: a.connected }));
    } catch {
      agents = [];
    }
    let accountErrors: Array<{ label: string; status: number; message: string }> = [];
    try {
      accountErrors = listAccountErrors();
    } catch {
      accountErrors = [];
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ agents, accountErrors });
  }),
);

// MYMU: Bring an OFFLINE agent online by running this account's configured
// start command (users.agent_start_cmd, e.g. `spawn-agents {name}`) AS the
// account's linux_user. The client only names the agent; the command template
// is server-side per-tenant config (Settings → Agents). Never exposes a raw
// shell to the client.
router.post(
  '/agent-start',
  asyncHandler(async (req, res) => {
    const uid = Number((req as express.Request & { user?: { id?: number } }).user?.id);
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    res.setHeader('Cache-Control', 'no-store');
    try {
      const result = await startAgentForTenant(uid, name);
      res.status(result.ok ? 200 : 502).json(result);
    } catch (err) {
      if (err instanceof TenantExecError) {
        res.status(err.statusCode).json({ ok: false, error: err.message });
        return;
      }
      throw err;
    }
  }),
);

router.get(
  '/archived',
  asyncHandler(async (_req, res) => {
    const projects = await getArchivedProjectsWithSessions();
    res.json(createApiSuccessResponse({ projects }));
  }),
);

router.get(
  '/:projectId/sessions',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const limit = parseNonNegativeIntQuery(req.query.limit, 'limit', 20);
    const offset = parseNonNegativeIntQuery(req.query.offset, 'offset', 0);
    const sessionsPage = await getProjectSessionsPage(projectId, { limit, offset });
    res.json(sessionsPage);
  }),
);

router.post(
  '/create-project',
  asyncHandler(async (req, res) => {
    assertNotLocked('Creating a project'); // MYMU
    const requestBody = req.body as Record<string, unknown>;
    const projectPath = typeof requestBody.path === 'string' ? requestBody.path : '';
    const customName = typeof requestBody.customName === 'string' ? requestBody.customName : null;

    if (requestBody.workspaceType !== undefined) {
      throw new AppError('workspaceType is no longer supported. Use the single create-project flow.', {
        code: 'LEGACY_WORKSPACE_TYPE_UNSUPPORTED',
        statusCode: 400,
      });
    }

    if (requestBody.githubUrl || requestBody.githubTokenId || requestBody.newGithubToken) {
      throw new AppError('Repository cloning is not supported on create-project', {
        code: 'CLONE_NOT_SUPPORTED_ON_CREATE_PROJECT',
        statusCode: 400,
        details: 'Use /api/projects/clone-progress for cloning workflows',
      });
    }

    const projectCreationResult = await createProject({
      projectPath,
      customName,
    });

    res.json({
      success: true,
      project: projectCreationResult.project,
      message:
        projectCreationResult.outcome === 'reactivated_archived'
          ? 'Archived project path reused successfully'
          : 'Project created successfully',
    });
  }),
);

/**
 * One-time (or idempotent) migration: apply legacy `localStorage` starred projectIds to the DB, then clear client storage.
 */
router.post(
  '/migrate-legacy-stars',
  asyncHandler(async (req, res) => {
    const projectIds = Array.isArray((req.body as { projectIds?: unknown })?.projectIds)
      ? ((req.body as { projectIds: unknown[] }).projectIds as unknown[]).map((x) => String(x))
      : [];
    const { updated } = applyLegacyStarredProjectIds(projectIds);
    res.json({ success: true, updated });
  }),
);

router.get('/clone-progress', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (type: string, data: Record<string, unknown>) => {
    if (res.writableEnded) {
      return;
    }

    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  let cloneOperation: Awaited<ReturnType<typeof startCloneProject>> | null = null;
  const closeListener = () => {
    cloneOperation?.cancel();
  };
  req.on('close', closeListener);

  try {
    const queryParams = req.query as Record<string, unknown>;
    const workspacePath = readQueryStringValue(queryParams.path);
    const githubUrl = readQueryStringValue(queryParams.githubUrl);
    const githubTokenId = readOptionalNumericQueryValue(queryParams.githubTokenId);
    const newGithubToken = readQueryStringValue(queryParams.newGithubToken) || null;

    const authenticatedUser = (req as typeof req & { user?: AuthenticatedUser }).user;
    const userId = authenticatedUser?.id;
    if (userId === undefined || userId === null) {
      throw new AppError('Authenticated user is required', {
        code: 'AUTHENTICATION_REQUIRED',
        statusCode: 401,
      });
    }

    cloneOperation = await startCloneProject(
      {
        workspacePath,
        githubUrl,
        githubTokenId,
        newGithubToken,
        userId,
      },
      {
        onProgress: (message) => {
          sendEvent('progress', { message });
        },
        onComplete: ({ project, message }) => {
          sendEvent('complete', { project, message });
        },
      },
    );

    await cloneOperation.waitForCompletion;
  } catch (error) {
    sendEvent('error', { message: resolveRouteErrorMessage(error) });
  } finally {
    req.off('close', closeListener);
    if (!res.writableEnded) {
      res.end();
    }
  }
});

router.get(
  '/:projectId/taskmaster',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const taskMasterDetails = await getProjectTaskMaster(projectId);
    res.json(taskMasterDetails);
  }),
);

router.put('/:projectId/rename', (req, res) => {
  try {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const { displayName } = req.body as { displayName?: unknown };
    updateProjectDisplayName(projectId, displayName);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to rename project' });
  }
});

router.post(
  '/:projectId/toggle-star',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const { isStarred } = toggleProjectStar(projectId);
    res.json({ success: true, isStarred });
  }),
);

router.post(
  '/:projectId/restore',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    restoreArchivedProject(projectId);
    res.json(createApiSuccessResponse({ projectId, isArchived: false }));
  }),
);

/**
 * - `force` not set / false: archive project in DB only (`isArchived` = 1; hidden from active list).
 * - `force=true`: remove DB row, delete session rows for that path, remove all `*.jsonl` under the Claude project dir.
 */
router.delete(
  '/:projectId',
  asyncHandler(async (req, res) => {
    assertNotLocked('Removing a project'); // MYMU
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const force = req.query.force === 'true';
    await deleteOrArchiveProject(projectId, force);
    res.json({ success: true });
  }),
);

export default router;
