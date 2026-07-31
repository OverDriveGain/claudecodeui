// MYMU: this upstream file carries MyMu modifications — F1 live agents (remote leaves + per-user filter).
// Diff against upstream main to see the exact hunks (see FORK.md).
import fs from 'node:fs/promises';
import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { sessionSynchronizerService } from '@/modules/providers/index.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';
import type { RealtimeClientConnection } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';
import { remoteProjectId, listRemoteAgents } from '@/services/rc.service.js';
import { currentAgentAllow, currentLinuxUser, isNameAllowedFor, isPathOwnedByLinuxUser } from '@/services/user-context.js';

type SessionSummary = {
  id: string;
  provider: string;
  summary: string;
  messageCount: number;
  lastActivity: string;
  createdAt: string | null;
};

type SessionRepositoryRow = {
  provider: string;
  session_id: string;
  custom_name?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
};

export type ProjectListItem = {
  projectId: string;
  path: string;
  displayName: string;
  fullPath: string;
  isStarred: boolean;
  sessions: SessionSummary[];
  sessionMeta: {
    hasMore: boolean;
    total: number;
  };
  // Remote-control agent metadata (only set for virtual remote:<id> projects):
  // marks the leaf as a live agent, carries the session id to drive, and the honest
  // online/offline state.
  isRemoteAgent?: boolean;
  remoteSessionId?: string;
  remoteConnected?: boolean;
  remoteRunning?: boolean;
  // Owning claude.ai account label — set only when >1 account is configured, so the
  // sidebar can badge which login an agent belongs to.
  remoteAccount?: string;
};

export type ArchivedProjectListItem = ProjectListItem & {
  isArchived: true;
};

type ProgressUpdate = {
  phase: 'loading' | 'complete';
  current: number;
  total: number;
  currentProject?: string;
};

type GetProjectsWithSessionsOptions = {
  skipSynchronization?: boolean;
  sessionsLimit?: number;
  sessionsOffset?: number;
  // Suppress the loading_progress broadcast (which carries project paths to ALL
  // clients). Set when computing the list for a background/per-client broadcast
  // that no client is waiting on, so it neither spams nor leaks paths.
  skipProgress?: boolean;
};

type SessionPaginationOptions = {
  limit?: number;
  offset?: number;
};

type ProjectSessionsPageResult = {
  sessions: SessionSummary[];
  total: number;
  hasMore: boolean;
};

export type ProjectSessionsPageApiView = {
  projectId: string;
  sessions: SessionSummary[];
  sessionMeta: {
    hasMore: boolean;
    total: number;
  };
};

const DEFAULT_PROJECT_SESSIONS_PAGE_SIZE = 20;
const MAX_PROJECT_SESSIONS_PAGE_SIZE = 200;

/**
 * Generate better display name from path.
 */
export async function generateDisplayName(projectName: string, actualProjectDir: string | null = null): Promise<string> {
  // Use actual project directory if provided, otherwise decode from project name.
  const projectPath = actualProjectDir || projectName.replace(/-/g, '/');

  // Try to read package.json from the project path.
  try {
    const packageJsonPath = path.join(projectPath, 'package.json');
    const packageData = await fs.readFile(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageData) as { name?: string };

    // Return the name from package.json if it exists.
    if (packageJson.name) {
      return packageJson.name;
    }
  } catch {
    // Fall back to path-based naming if package.json doesn't exist or can't be read.
  }

  // If it starts with /, it's an absolute path.
  if (projectPath.startsWith('/')) {
    const parts = projectPath.split('/').filter(Boolean);
    // Return only the last folder name.
    return parts[parts.length - 1] || projectPath;
  }

  return projectPath;
}

function normalizeSessionPagination(options: SessionPaginationOptions = {}): { limit: number; offset: number } {
  const rawLimit = Number.isFinite(options.limit) ? Math.floor(Number(options.limit)) : DEFAULT_PROJECT_SESSIONS_PAGE_SIZE;
  const rawOffset = Number.isFinite(options.offset) ? Math.floor(Number(options.offset)) : 0;

  return {
    limit: Math.min(Math.max(1, rawLimit), MAX_PROJECT_SESSIONS_PAGE_SIZE),
    offset: Math.max(0, rawOffset),
  };
}

function mapSessionRowToSummary(row: SessionRepositoryRow): SessionSummary {
  return {
    id: row.session_id,
    provider: row.provider,
    summary: row.custom_name || '',
    messageCount: 0,
    lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    createdAt: row.created_at ?? null,
  };
}

function readProjectSessionsIncludingArchived(projectPath: string): ProjectSessionsPageResult {
  const rows = sessionsDb.getSessionsByProjectPathIncludingArchived(projectPath) as SessionRepositoryRow[];

  return {
    sessions: rows.map(mapSessionRowToSummary),
    total: rows.length,
    hasMore: false,
  };
}

/**
 * Reads one paginated project session slice from the DB and groups rows by provider.
 */
function readProjectSessionsPageByPath(
  projectPath: string,
  options: SessionPaginationOptions = {},
): ProjectSessionsPageResult {
  const pagination = normalizeSessionPagination(options);
  const rows = sessionsDb.getSessionsByProjectPathPage(
    projectPath,
    pagination.limit,
    pagination.offset,
  ) as SessionRepositoryRow[];
  const total = sessionsDb.countSessionsByProjectPath(projectPath);

  return {
    sessions: rows.map(mapSessionRowToSummary),
    total,
    hasMore: pagination.offset + rows.length < total,
  };
}

// Broadcast progress to all connected WebSocket clients.
// Uses the unified `kind` envelope like every other websocket frame.
function broadcastProgress(progress: ProgressUpdate) {
  const message = JSON.stringify({
    kind: 'loading_progress',
    ...progress,
  });

  connectedClients.forEach((client: RealtimeClientConnection) => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(message);
    }
  });
}

/**
 * Filter a project list to what a user with `agentAllow` may see. null/empty =
 * unrestricted (returns the list unchanged). Otherwise keeps a project when its
 * agent name matches an allow pattern: the display name for any leaf (a remote
 * agent's title or a local project's name) plus the path basename for local
 * projects (covers custom-named / path-decoded names). One rule, used both by the
 * HTTP fetch (request context) and the watcher's per-client broadcast, so a
 * realtime push can never show a restricted user more than a refresh would.
 */
export function filterProjectsForUser<T extends ProjectListItem>(
  projects: T[],
  agentAllow: string[] | null | undefined,
  linuxUser: string | null | undefined = null,
): T[] {
  if (!agentAllow || agentAllow.length === 0) return projects;
  return projects.filter(
    (p) =>
      isNameAllowedFor(p.displayName, agentAllow) ||
      (!p.isRemoteAgent && isNameAllowedFor(path.basename(p.path), agentAllow)) ||
      // One-instance-per-host PATH rule: local projects inside the mapped linux
      // user's home are theirs regardless of naming ("they have projects they
      // see in their linux user") — no per-user pattern maintenance for locals.
      (!p.isRemoteAgent && isPathOwnedByLinuxUser(p.fullPath || p.path, linuxUser)),
  );
}

/**
 * Reads all projects from DB and returns provider-bucketed session summaries.
 */
export async function getProjectsWithSessions(
  options: GetProjectsWithSessionsOptions = {}
): Promise<ProjectListItem[]> {
  if (!options.skipSynchronization) {
    await sessionSynchronizerService.synchronizeSessions();
  }

  const projectRows = projectsDb.getProjectPaths() as Array<{
    project_id: string;
    project_path: string;
    custom_project_name?: string | null;
    isStarred?: number;
  }>;
  const totalProjects = projectRows.length;
  const projects: ProjectListItem[] = [];
  let processedProjects = 0;

  for (const row of projectRows) {
    processedProjects += 1;

    const projectId = row.project_id;
    const projectPath = row.project_path;

    if (!options.skipProgress) {
      broadcastProgress({
        phase: 'loading',
        current: processedProjects,
        total: totalProjects,
        currentProject: projectPath,
      });
    }

    const displayName =
      row.custom_project_name && row.custom_project_name.trim().length > 0
        ? row.custom_project_name
        : await generateDisplayName(path.basename(projectPath) || projectPath, projectPath);

    const sessionsPage = readProjectSessionsPageByPath(projectPath, {
      limit: options.sessionsLimit,
      offset: options.sessionsOffset,
    });

    projects.push({
      projectId,
      path: projectPath,
      displayName,
      fullPath: projectPath,
      isStarred: Boolean(row.isStarred),
      sessions: sessionsPage.sessions,
      sessionMeta: {
        hasMore: sessionsPage.hasMore,
        total: sessionsPage.total,
      },
    });
  }

  // Remote-control agents: surface the operator's CONNECTED live agents as virtual
  // projects (projectId `remote:<sessionId>`). Each leaf drives the agent by
  // attaching to its existing session. Additive + non-fatal — empty when the proxy
  // is unconfigured/down or the capture policy hides everything.
  try {
    const agents = await listRemoteAgents();
    for (const agent of agents) {
      projects.push({
        projectId: remoteProjectId(agent.id),
        path: `remote://${agent.id}`,
        displayName: agent.title,
        fullPath: `remote://${agent.id}`,
        isStarred: false,
        // The agent's live relay session surfaces as a NORMAL session row, so
        // the stock UI lists and opens the conversation with zero special
        // casing — history and chat.send resolve the cse_ id via the relay.
        sessions: [{
          id: agent.id,
          provider: 'claude',
          summary: agent.title,
          messageCount: 0,
          lastActivity: agent.lastEventAt ?? new Date().toISOString(),
          createdAt: null,
        }],
        sessionMeta: { hasMore: false, total: 1 },
        isRemoteAgent: true,
        remoteSessionId: agent.id,
        remoteConnected: agent.connected,
        remoteRunning: agent.running,
        remoteAccount: agent.account,
      });
    }
  } catch {
    // proxy unreachable — omit remote projects this round
  }

  if (!options.skipProgress) {
    broadcastProgress({
      phase: 'complete',
      current: totalProjects,
      total: totalProjects,
    });
  }

  // A user restricted by agent_allow sees the SAME list as the host, just filtered
  // to their agent (see filterProjectsForUser).
  return filterProjectsForUser(projects, currentAgentAllow(), currentLinuxUser());
}

/**
 * Reads archived projects from DB and includes every session row for each
 * project path, because an archived workspace should surface all preserved
 * conversation history in the archive view regardless of each session's flag.
 */
export async function getArchivedProjectsWithSessions(
  options: Pick<GetProjectsWithSessionsOptions, 'skipSynchronization'> = {},
): Promise<ArchivedProjectListItem[]> {
  if (!options.skipSynchronization) {
    await sessionSynchronizerService.synchronizeSessions();
  }

  const projectRows = projectsDb.getArchivedProjectPaths() as Array<{
    project_id: string;
    project_path: string;
    custom_project_name?: string | null;
    isStarred?: number;
  }>;

  const archivedProjects: ArchivedProjectListItem[] = [];

  for (const row of projectRows) {
    const displayName =
      row.custom_project_name && row.custom_project_name.trim().length > 0
        ? row.custom_project_name
        : await generateDisplayName(path.basename(row.project_path) || row.project_path, row.project_path);

    const sessionsPage = readProjectSessionsIncludingArchived(row.project_path);

    archivedProjects.push({
      projectId: row.project_id,
      path: row.project_path,
      displayName,
      fullPath: row.project_path,
      isStarred: Boolean(row.isStarred),
      isArchived: true,
      sessions: sessionsPage.sessions,
      sessionMeta: {
        hasMore: sessionsPage.hasMore,
        total: sessionsPage.total,
      },
    });
  }

  return archivedProjects;
}

/**
 * Loads one paginated session slice for a specific project id.
 */
export async function getProjectSessionsPage(
  projectId: string,
  options: SessionPaginationOptions = {},
): Promise<ProjectSessionsPageApiView> {
  const projectRow = projectsDb.getProjectById(projectId);
  if (!projectRow) {
    throw new AppError(`Project "${projectId}" was not found.`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  const sessionsPage = readProjectSessionsPageByPath(projectRow.project_path, options);
  return {
    projectId: projectRow.project_id,
    sessions: sessionsPage.sessions,
    sessionMeta: {
      hasMore: sessionsPage.hasMore,
      total: sessionsPage.total,
    },
  };
}
