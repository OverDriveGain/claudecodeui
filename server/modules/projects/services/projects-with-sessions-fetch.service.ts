import fs from 'node:fs/promises';
import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { listAgents, fleetProjectId } from '@/services/fleet.service.js';
import { listAgents as listRegisteredAgents, agentProjectId } from '@/services/agent-discovery.service.js';
import { sessionSynchronizerService } from '@/modules/providers/index.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';
import type { RealtimeClientConnection } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type SessionSummary = {
  id: string;
  summary: string;
  messageCount: number;
  lastActivity: string;
};

type SessionsByProvider = Record<'claude' | 'cursor' | 'codex' | 'gemini' | 'opencode', SessionSummary[]>;

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
  cursorSessions: SessionSummary[];
  codexSessions: SessionSummary[];
  geminiSessions: SessionSummary[];
  opencodeSessions: SessionSummary[];
  sessionMeta: {
    hasMore: boolean;
    total: number;
  };
  // Fleet-agent metadata (only set for virtual fleet projects).
  fleetAlive?: boolean;
  fleetHost?: string;
  // controllable: agent has a live control plane (can receive injected prompts).
  // false → transcript visible, but the composer must be disabled (read-only).
  fleetControllable?: boolean;
  // agent-discovery metadata (only set for virtual registered-agent projects).
  agentState?: 'ONLINE' | 'CONTROLLABLE' | 'DISCONNECTED';
  agentLabel?: string;
  agentId?: string;
  agentCwd?: string;
  agentLastSeen?: number;
  // channel-shim connected: agent is ONLINE and a reverse-connect channel is live,
  // so the composer can WRITE into the live session even without a control port.
  agentChannelConnected?: boolean;
  // writable: composer should be enabled (CONTROLLABLE, or ONLINE + channel-connected).
  agentWritable?: boolean;
  // the agent's live session id, so the sidebar leaf can open it directly.
  agentSessionId?: string;
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
};

type SessionPaginationOptions = {
  limit?: number;
  offset?: number;
};

type ProjectSessionsPageResult = {
  sessionsByProvider: SessionsByProvider;
  total: number;
  hasMore: boolean;
};

export type ProjectSessionsPageApiView = {
  projectId: string;
  sessions: SessionSummary[];
  cursorSessions: SessionSummary[];
  codexSessions: SessionSummary[];
  geminiSessions: SessionSummary[];
  opencodeSessions: SessionSummary[];
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
    summary: row.custom_name || '',
    messageCount: 0,
    lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
  };
}

function bucketSessionRowsByProvider(rows: SessionRepositoryRow[]): SessionsByProvider {
  const byProvider: SessionsByProvider = {
    claude: [],
    cursor: [],
    codex: [],
    gemini: [],
    opencode: [],
  };

  for (const row of rows) {
    const provider = row.provider as keyof SessionsByProvider;
    const bucket = byProvider[provider];
    if (!bucket) {
      continue;
    }

    bucket.push(mapSessionRowToSummary(row));
  }

  return byProvider;
}

function readProjectSessionsIncludingArchived(projectPath: string): ProjectSessionsPageResult {
  const rows = sessionsDb.getSessionsByProjectPathIncludingArchived(projectPath) as SessionRepositoryRow[];

  return {
    sessionsByProvider: bucketSessionRowsByProvider(rows),
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
    sessionsByProvider: bucketSessionRowsByProvider(rows),
    total,
    hasMore: pagination.offset + rows.length < total,
  };
}

// Broadcast progress to all connected WebSocket clients
function broadcastProgress(progress: ProgressUpdate) {
  const message = JSON.stringify({
    type: 'loading_progress',
    ...progress,
  });

  connectedClients.forEach((client: RealtimeClientConnection) => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(message);
    }
  });
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

  // A registered agent's working folder gets discovered as a regular DB project
  // too (it accrues .claude session history). Surfacing it in the Projects panel
  // means the SAME live session shows twice — once here and once as the Agents
  // entry — and opening it from the Projects path drives the session OUTSIDE the
  // channel route, which "eats" the live output. Collect live-agent cwds up front
  // and skip the duplicate regular project; the Agents entry is the canonical way
  // in. (Cached call — cheap; on daemon-down we just don't filter.)
  const liveAgentCwds = new Set<string>();
  const normCwd = (p: string) => (p || '').replace(/\/+$/, '');
  try {
    for (const a of await listRegisteredAgents()) {
      if (a.cwd) liveAgentCwds.add(normCwd(a.cwd));
    }
  } catch {
    // daemon unreachable — show projects unfiltered this round
  }

  for (const row of projectRows) {
    processedProjects += 1;

    const projectId = row.project_id;
    const projectPath = row.project_path;

    // Skip the duplicate of a live agent's working folder (see note above).
    if (liveAgentCwds.has(normCwd(projectPath))) {
      continue;
    }

    broadcastProgress({
      phase: 'loading',
      current: processedProjects,
      total: totalProjects,
      currentProject: projectPath,
    });

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
      sessions: sessionsPage.sessionsByProvider.claude,
      cursorSessions: sessionsPage.sessionsByProvider.cursor,
      codexSessions: sessionsPage.sessionsByProvider.codex,
      geminiSessions: sessionsPage.sessionsByProvider.gemini,
      opencodeSessions: sessionsPage.sessionsByProvider.opencode,
      sessionMeta: {
        hasMore: sessionsPage.hasMore,
        total: sessionsPage.total,
      },
    });
  }

  // Virtual fleet projects: ALL agents in this user's domain (alive + offline)
  // appear as projects with their last session navigable.
  // Offline agents show a read-only last-session history; live ones are talkable.
  // No DB row — recognised later (history/send) via the session->agent registry
  // in fleet.service.js. Non-fatal if discovery is unreachable.
  try {
    const agents = await listAgents();
    for (const a of agents) {
      const isAlive = Boolean(a.alive);
      const sessionLabel = isAlive ? `${a.agent} (live)` : `${a.agent} (last session)`;
      const sessions: SessionSummary[] = a.session_id
        ? [{
            id: a.session_id,
            summary: sessionLabel,
            messageCount: 0,
            lastActivity: a.last_activity
              ? new Date(a.last_activity * 1000).toISOString()
              : new Date().toISOString(),
          }]
        : [];
      projects.push({
        projectId: fleetProjectId(a.agent),
        path: `fleet://${a.host}/${a.agent}`,
        displayName: `🤖 ${a.agent}`,
        fullPath: `fleet://${a.host}/${a.agent}`,
        isStarred: false,
        sessions,
        cursorSessions: [],
        codexSessions: [],
        geminiSessions: [],
        opencodeSessions: [],
        sessionMeta: { hasMore: false, total: sessions.length },
        // Pass alive + control-plane state so the frontend can show the right badge.
        fleetAlive: isAlive,
        fleetHost: a.host,
        // controllable is only meaningful when alive. Unregistered/legacy agents
        // that don't carry the field default to controllable when alive (old behaviour).
        // Writable if the control plane is usable OR a channel-shim is connected —
        // mirrors the virtual-agent path so channel-only fleets (e.g. Wael's, which
        // launch --remote-control with no control plugin → controllable:false) are
        // not read-only-gated. fleetControllable feeds ONLY the read-only gates.
        fleetControllable: isAlive ? ((a.controllable ?? true) || Boolean(a.channel_connected)) : false,
      });
    }
  } catch {
    // discovery down — just omit fleet projects this round
  }

  // agent-discovery virtual projects: all registered agents (ONLINE, CONTROLLABLE,
  // DISCONNECTED) appear as projects. Register-only — if nothing is registered,
  // this block adds nothing. Non-fatal if the daemon is unreachable.
  try {
    const registeredAgents = await listRegisteredAgents();
    for (const a of registeredAgents) {
      const isControllable = a.state === 'CONTROLLABLE';
      const isConnected = a.state !== 'DISCONNECTED';
      const stateLabel = isControllable ? 'connected' : isConnected ? 'read-only' : 'disconnected';
      const sessions: SessionSummary[] = a.session_id
        ? [{
            id: a.session_id,
            summary: `${a.label} (${stateLabel})`,
            messageCount: 0,
            lastActivity: a.last_activity
              ? new Date(a.last_activity * 1000).toISOString()
              : new Date().toISOString(),
          }]
        : [];
      projects.push({
        projectId: agentProjectId(a.id),
        path: a.cwd,
        displayName: a.label,
        fullPath: a.cwd,
        isStarred: false,
        sessions,
        cursorSessions: [],
        codexSessions: [],
        geminiSessions: [],
        opencodeSessions: [],
        sessionMeta: { hasMore: false, total: sessions.length },
        agentState: a.state,
        agentLabel: a.label,
        agentId: a.id,
        agentCwd: a.cwd,
        agentLastSeen: a.last_seen,
        agentChannelConnected: Boolean(a.channel_connected),
        agentWritable:
          a.state === 'CONTROLLABLE' ||
          (a.state === 'ONLINE' && Boolean(a.channel_connected)),
        // Explicit session id for the agent leaf to navigate to directly — the
        // sidebar loads `sessions` lazily on expand, and the agent leaf never
        // expands, so it cannot rely on sessions[] being populated.
        agentSessionId: a.session_id || undefined,
      });
    }
  } catch {
    // daemon unreachable — omit registered agent projects this round
  }

  broadcastProgress({
    phase: 'complete',
    current: totalProjects,
    total: totalProjects,
  });

  return projects;
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
      sessions: sessionsPage.sessionsByProvider.claude,
      cursorSessions: sessionsPage.sessionsByProvider.cursor,
      codexSessions: sessionsPage.sessionsByProvider.codex,
      geminiSessions: sessionsPage.sessionsByProvider.gemini,
      opencodeSessions: sessionsPage.sessionsByProvider.opencode,
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
    sessions: sessionsPage.sessionsByProvider.claude,
    cursorSessions: sessionsPage.sessionsByProvider.cursor,
    codexSessions: sessionsPage.sessionsByProvider.codex,
    geminiSessions: sessionsPage.sessionsByProvider.gemini,
    opencodeSessions: sessionsPage.sessionsByProvider.opencode,
    sessionMeta: {
      hasMore: sessionsPage.hasMore,
      total: sessionsPage.total,
    },
  };
}
