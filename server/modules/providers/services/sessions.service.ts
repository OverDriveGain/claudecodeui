import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type {
  FetchHistoryOptions,
  FetchHistoryResult,
  LLMProvider,
  NormalizedMessage,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';
// Remote-control proxy — read-only history fetch for connected agent sessions.
import { getSessionEventsCached as getRemoteSessionEventsCached } from '@/remote-control/rc-client.js';
// Live OpenCode agents — history rows from the agent's own server / MyMu cache.
import { getOcSessionRows } from '@/remote-control/oc-client.js';
import { getCxSessionRows, normalizeCxItems } from '@/remote-control/cx-client.js';
import { isAgentCaptureAllowed } from '@/services/rc.service.js';
import { deriveContextUsage, usageContextTokens } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { currentAgentAllow, currentLinuxUser, isNameAllowedForUser, isPathOwnedByLinuxUser } from '@/services/user-context.js';

type CreateAppSessionResult = {
  sessionId: string;
  provider: LLMProvider;
  projectPath: string;
  sessionName: string;
};

type ArchivedSessionListItem = {
  sessionId: string;
  provider: LLMProvider;
  projectId: string | null;
  projectPath: string | null;
  projectDisplayName: string;
  sessionTitle: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivity: string | null;
  isProjectArchived: boolean;
};

type RecentSessionListItem = Pick<
  ArchivedSessionListItem,
  'sessionId' | 'provider' | 'projectId' | 'projectDisplayName' | 'sessionTitle' | 'lastActivity'
>;

type RecentSessionsPage = {
  conversations: RecentSessionListItem[];
  total: number;
  hasMore: boolean;
};

type SessionDetails = {
  /** Canonical app-facing session id (may differ from the looked-up id when a provider-native id was given). */
  sessionId: string;
  provider: LLMProvider;
  summary: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivity: string | null;
  isArchived: boolean;
  project: {
    projectId: string;
    path: string;
    fullPath: string;
    displayName: string;
    isStarred: boolean;
    isArchived: boolean;
  } | null;
};

const MAX_CLOUDCLI_SESSION_NAME_WORDS = 4;

function buildCloudCliSessionName(initialMessage: string): string {
  const words = initialMessage.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, MAX_CLOUDCLI_SESSION_NAME_WORDS).join(' ') || 'Untitled Session';
}

/**
 * Removes one file if it exists.
 */
async function removeFileIfExists(filePath: string): Promise<boolean> {
  try {
    await fsp.unlink(filePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Archive rows need a stable project label even when the owning project is not
 * part of the active sidebar payload. This lightweight resolver keeps the
 * archive API self-contained while still matching the project's stored display
 * name when one exists.
 */
/**
 * Real start of a still-open turn: the newest user PROMPT event with no `result`
 * (turn end) after it. Synthetic rows (caveats, image sizing notes), tool_result
 * carriers, and subagent sidechains are not prompts. Returns null when the last
 * turn completed — the client only consumes this while the agent is running, so
 * a stale open turn (interrupted, never produced a result) is harmless.
 */
export function deriveOpenTurn(events: unknown[]): { turnStartedAt: string; turnStartContextTokens?: number } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as Record<string, unknown> | null;
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'result') return null;
    if (e.type !== 'user' || e.isSynthetic === true || e.parent_tool_use_id) continue;
    const content = (e.message as Record<string, unknown> | undefined)?.content;
    if (Array.isArray(content) && content.some((p) => (p as Record<string, unknown>)?.type === 'tool_result')) {
      continue;
    }
    // Local-command RECORD rows (`<command-name>`, `<local-command-*>`) are appended
    // AFTER their turn's result — /clear leaves one as the newest user row, which
    // read as an open turn forever (stuck working loader / clear-time timer anchor).
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? String((content.find((p) => (p as Record<string, unknown>)?.type === 'text') as Record<string, unknown> | undefined)?.text ?? '')
        : '';
    if (/^\s*<(?:command-name|local-command-)/.test(text)) continue;
    const ts = e.created_at || e.timestamp;
    if (typeof ts !== 'string' || !ts) return null;
    // Baseline for the live "tokens this turn" counter: the context position of
    // the last assistant message BEFORE this prompt.
    for (let k = i - 1; k >= 0; k--) {
      const prev = events[k] as Record<string, unknown> | null;
      const tokens = usageContextTokens((prev?.message as Record<string, unknown> | undefined)?.usage);
      if (tokens !== null) return { turnStartedAt: ts, turnStartContextTokens: tokens };
    }
    return { turnStartedAt: ts };
  }
  return null;
}

function resolveProjectDisplayName(
  projectPath: string | null,
  customProjectName: string | null | undefined,
): string {
  const trimmedCustomName = typeof customProjectName === 'string' ? customProjectName.trim() : '';
  if (trimmedCustomName.length > 0) {
    return trimmedCustomName;
  }

  if (!projectPath) {
    return 'Unknown Project';
  }

  return path.basename(projectPath) || projectPath;
}

/**
 * Application service for provider-backed session message operations.
 *
 * Callers pass a provider id and this service resolves the concrete provider
 * class, keeping normalization/history call sites decoupled from implementation
 * file layout.
 */
export const sessionsService = {
  /**
   * Lists provider ids that can load session history and normalize live messages.
   */
  listProviderIds(): LLMProvider[] {
    return providerRegistry.listProviders().map((provider) => provider.id);
  },

  /**
   * Returns app-facing ids for provider runs that are currently processing.
   *
   * This is intentionally status-only: callers that only need sidebar activity
   * indicators should not attach to chat streams or request replayed messages.
   */
  listRunningSessions(): Array<{
    sessionId: string;
    provider: LLMProvider;
    startedAt: number;
    lastSeq: number;
  }> {
    return chatRunRegistry.listRunningRuns();
  },

  /**
   * Returns the active conversation feed in true global activity order.
   */
  listRecentSessions(limit: number, offset: number): RecentSessionsPage {
    const page = sessionsDb.getRecentSessionsPage(limit, offset);
    const projectCache = new Map<string, ReturnType<typeof projectsDb.getProjectPath>>();
    const conversations = page.sessions.map((session) => {
      const projectPath = session.project_path?.trim() ? session.project_path : null;
      let project = null;

      if (projectPath) {
        if (!projectCache.has(projectPath)) {
          projectCache.set(projectPath, projectsDb.getProjectPath(projectPath));
        }
        project = projectCache.get(projectPath) ?? null;
      }

      return {
        sessionId: session.session_id,
        provider: session.provider as LLMProvider,
        projectId: project?.project_id ?? null,
        projectDisplayName: resolveProjectDisplayName(projectPath, project?.custom_project_name),
        sessionTitle: session.custom_name?.trim() || session.session_id,
        lastActivity: session.updated_at ?? session.created_at ?? null,
      };
    });

    return {
      conversations,
      total: page.total,
      hasMore: offset + conversations.length < page.total,
    };
  },

  /**
   * Resolves the provider-native session id a runtime needs for resume.
   *
   * Callers hand provider runtimes the stable app session id; the provider
   * CLIs/SDKs only understand their own native id, which lives on the session
   * row. Ids without a row are assumed to be provider-native already (direct
   * API callers that reference sessions the watcher has not indexed yet).
   */
  resolveProviderSessionId(sessionId: string | null | undefined): string | null {
    if (!sessionId) {
      return null;
    }

    const session = sessionsDb.getSessionById(sessionId);
    return session ? session.provider_session_id : sessionId;
  },

  /**
   * Normalizes one provider-native event into frontend session message events.
   */
  normalizeMessage(
    providerName: string,
    raw: unknown,
    sessionId: string | null,
  ): NormalizedMessage[] {
    return providerRegistry.resolveProvider(providerName).sessions.normalizeMessage(raw, sessionId);
  },

  /**
   * Allocates a stable app-facing session id before any provider run happens.
   *
   * This is the entry point of the session gateway: the frontend calls this
   * (via `POST /api/providers/sessions`) when the user starts a brand-new
   * chat, navigates to the returned id immediately, and the id never changes
   * for the lifetime of the conversation. The provider-native id is mapped to
   * this row later, when the provider runtime announces it mid-run. Its title
   * comes directly from the first visible CloudCLI message and is limited to
   * four whole words before any provider-owned storage exists.
   */
  createAppSession(
    provider: LLMProvider,
    projectPath: string,
    initialMessage: string,
  ): CreateAppSessionResult {
    const normalizedProjectPath = projectPath.trim();
    if (!normalizedProjectPath) {
      throw new AppError('projectPath is required.', {
        code: 'PROJECT_PATH_REQUIRED',
        statusCode: 400,
      });
    }

    const sessionId = randomUUID();
    const sessionName = buildCloudCliSessionName(initialMessage);
    sessionsDb.createAppSession(sessionId, provider, normalizedProjectPath, sessionName);

    return {
      sessionId,
      provider,
      projectPath: normalizedProjectPath,
      sessionName,
    };
  },

  /**
   * Resolves the provider-native id only for an explicit user copy action.
   * Normal session payloads continue to expose only the stable app id.
   */
  getProviderSessionId(sessionId: string): string {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    if (!session.provider_session_id) {
      throw new AppError('This session ID is not available yet.', {
        code: 'PROVIDER_SESSION_ID_NOT_AVAILABLE',
        statusCode: 409,
      });
    }

    return session.provider_session_id;
  },

  /**
   * Fetches persisted history by app session id.
   *
   * Provider and provider-specific lookup hints are resolved from the indexed
   * session metadata in the database. The provider adapter receives the
   * provider-native session id (the one written into transcripts on disk),
   * and every returned message is remapped back to the app session id so
   * provider ids never reach the frontend.
   */
  async fetchHistory(
    sessionId: string,
    options: Pick<FetchHistoryOptions, 'limit' | 'offset'> = {},
  ): Promise<FetchHistoryResult> {
    // Remote-control connected agent session (cse_… / session_…): not a local DB
    // session. The relay only pages oldest-first (no reverse), so the backend caches
    // the whole transcript once and then serves it like a local file — honoring
    // limit/offset so opening an agent loads just the recent tail (fast) instead of
    // re-pulling the entire relay history on every open. "Load all" (limit === null)
    // returns everything from the warm cache.
    // Live OpenCode agent session (ocs_…): rows come from the agent's own
    // `opencode serve` server when reachable, else the MyMu-side event cache —
    // normalized through the SAME code path as local OpenCode sqlite history.
    if (sessionId.startsWith('ocs_')) {
      if (!(await isAgentCaptureAllowed(sessionId))) {
        return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
      }
      const limit = options.limit ?? null;
      const offset = Math.max(0, options.offset ?? 0);
      const rows = await getOcSessionRows(sessionId);
      const provider = providerRegistry.resolveProvider('opencode').sessions as unknown as {
        normalizeApiMessages(rows: unknown[], sessionId: string): NormalizedMessage[];
      };
      const normalized = provider.normalizeApiMessages(rows, sessionId);
      const totalNormalized = normalized.length;
      let total = 0;
      for (const msg of normalized) {
        if (msg.kind !== 'tool_result') total += 1;
      }
      if (limit === null) {
        return { messages: normalized, total, hasMore: false, offset: 0, limit: null };
      }
      const start = Math.max(0, totalNormalized - offset - limit);
      const end = Math.max(0, totalNormalized - offset);
      return { messages: normalized.slice(start, end), total, hasMore: start > 0, offset, limit };
    }

    // Live Codex agent session (cxs_…): ThreadItem rows from the agent's own
    // `codex app-server` when reachable, else the MyMu-side item cache —
    // translated through the same item mapper the live stream uses.
    if (sessionId.startsWith('cxs_')) {
      if (!(await isAgentCaptureAllowed(sessionId))) {
        return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
      }
      const limit = options.limit ?? null;
      const offset = Math.max(0, options.offset ?? 0);
      const rows = await getCxSessionRows(sessionId);
      const normalized = normalizeCxItems(rows, sessionId) as NormalizedMessage[];
      const totalNormalized = normalized.length;
      let total = 0;
      for (const msg of normalized) {
        if (msg.kind !== 'tool_result') total += 1;
      }
      if (limit === null) {
        return { messages: normalized, total, hasMore: false, offset: 0, limit: null };
      }
      const start = Math.max(0, totalNormalized - offset - limit);
      const end = Math.max(0, totalNormalized - offset);
      return { messages: normalized.slice(start, end), total, hasMore: start > 0, offset, limit };
    }

    if (sessionId.startsWith('cse_') || sessionId.startsWith('session_')) {
      // Capture policy: don't serve history for an agent this deployment can't surface.
      if (!(await isAgentCaptureAllowed(sessionId))) {
        return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
      }

      const limit = options.limit ?? null;
      const offset = Math.max(0, options.offset ?? 0);

      const events = await getRemoteSessionEventsCached(sessionId);
      const normalized: NormalizedMessage[] = [];
      for (const raw of events) {
        // Skip subagent-internal events (Task sidechain): the relay stores a
        // subagent's own prompt/thinking/tools/result inline, each tagged with the
        // parent Task's tool_use_id. Locally these are folded under the Task tool,
        // never shown as top-level messages — mirror that so history doesn't render
        // the subagent's prompt as a user message or its thoughts as unsolicited output.
        if (raw && typeof raw === 'object' && (raw as { parent_tool_use_id?: unknown }).parent_tool_use_id) {
          continue;
        }
        normalized.push(...this.normalizeMessage('claude', raw, sessionId));
      }

      // Display total counts conversation messages (drop tool_result rows), while
      // windowing uses the full normalized length so offsets stay aligned — same
      // semantics as the local provider's fetchHistory.
      const totalNormalized = normalized.length;
      let total = 0;
      for (const msg of normalized) {
        if (msg.kind !== 'tool_result') total += 1;
      }

      const context = deriveContextUsage(events) ?? undefined;
      const openTurn = deriveOpenTurn(events) ?? undefined;
      const turnStartedAt = openTurn?.turnStartedAt;
      const turnStartContextTokens = openTurn?.turnStartContextTokens;
      if (limit === null) {
        return {
          messages: normalized, total, hasMore: false, offset: 0, limit: null,
          context, turnStartedAt, turnStartContextTokens,
        };
      }

      const start = Math.max(0, totalNormalized - offset - limit);
      const end = Math.max(0, totalNormalized - offset);
      return {
        messages: normalized.slice(start, end), total, hasMore: start > 0, offset, limit,
        context, turnStartedAt, turnStartContextTokens,
      };
    }

    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    // MYMU: Agent-restricted users (agent_allow set) may read history for local
    // projects that match their agent name OR live under their mapped linux
    // user's home — the same scope the conversations list shows. Deny others
    // rather than leak that the session exists.
    if (
      currentAgentAllow()?.length &&
      !isNameAllowedForUser(path.basename(session.project_path ?? '')) &&
      !isPathOwnedByLinuxUser(session.project_path ?? '', currentLinuxUser())
    ) {
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    // App-created sessions that never produced a provider transcript yet
    // (e.g. first message still streaming) simply have no history.
    if (!session.provider_session_id) {
      return {
        messages: [],
        total: 0,
        hasMore: false,
        offset: options.offset ?? 0,
        limit: options.limit ?? null,
      };
    }

    const provider = session.provider as LLMProvider;
    const result = await providerRegistry.resolveProvider(provider).sessions.fetchHistory(sessionId, {
      limit: options.limit ?? null,
      offset: options.offset ?? 0,
      projectPath: session.project_path ?? '',
      providerSessionId: session.provider_session_id,
    });

    return {
      ...result,
      messages: result.messages.map((message) => ({
        ...message,
        sessionId,
      })),
    };
  },

  /**
   * Resolves one session (by app id, falling back to the provider-native id)
   * to its metadata plus the owning project.
   *
   * This backs deep links like `/session/:sessionId`: the frontend's paginated
   * project payloads only carry each project's first session page, so a
   * session opened directly by URL may not be present client-side at all —
   * this lookup is the authoritative way to learn which project owns it.
   */
  getSessionDetailsById(sessionId: string): SessionDetails {
    const session =
      sessionsDb.getSessionById(sessionId) ?? sessionsDb.getSessionByProviderSessionId(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const projectPath = session.project_path?.trim() ? session.project_path : null;
    const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;

    return {
      sessionId: session.session_id,
      provider: session.provider as LLMProvider,
      summary: session.custom_name?.trim() || '',
      createdAt: session.created_at ?? null,
      updatedAt: session.updated_at ?? null,
      lastActivity: session.updated_at ?? session.created_at ?? null,
      isArchived: Boolean(session.isArchived),
      project: project && projectPath
        ? {
            projectId: project.project_id,
            path: projectPath,
            fullPath: projectPath,
            displayName: resolveProjectDisplayName(projectPath, project.custom_project_name),
            isStarred: Boolean(project.isStarred),
            isArchived: Boolean(project.isArchived),
          }
        : null,
    };
  },

  /**
   * Returns archived sessions with enough project metadata for the sidebar to
   * group, filter, open, and restore them without a per-row follow-up query.
   */
  listArchivedSessions(): ArchivedSessionListItem[] {
    const archivedSessions = sessionsDb.getArchivedSessions();
    const projectCache = new Map<string, ReturnType<typeof projectsDb.getProjectPath>>();

    return archivedSessions.map((session) => {
      const projectPath = session.project_path?.trim() ? session.project_path : null;
      let project = null;

      if (projectPath) {
        if (!projectCache.has(projectPath)) {
          projectCache.set(projectPath, projectsDb.getProjectPath(projectPath));
        }
        project = projectCache.get(projectPath) ?? null;
      }

      return {
        sessionId: session.session_id,
        provider: session.provider as LLMProvider,
        projectId: project?.project_id ?? null,
        projectPath,
        projectDisplayName: resolveProjectDisplayName(projectPath, project?.custom_project_name),
        sessionTitle: session.custom_name?.trim() || session.session_id,
        createdAt: session.created_at ?? null,
        updatedAt: session.updated_at ?? null,
        lastActivity: session.updated_at ?? session.created_at ?? null,
        isProjectArchived: Boolean(project?.isArchived),
      };
    });
  },

  /**
   * Archives or permanently deletes one persisted session row by id.
   *
   * Soft-delete mirrors the project behavior by toggling `isArchived` so the
   * row disappears from active lists but remains restorable. Force-delete
   * optionally removes the transcript file before deleting the database row.
   */
  async deleteOrArchiveSessionById(
    sessionId: string,
    options: {
      force?: boolean;
      deletedFromDisk?: boolean;
    } = {},
  ): Promise<{ sessionId: string; action: 'archived' | 'deleted'; deletedFromDisk: boolean }> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    if (!options.force) {
      sessionsDb.updateSessionIsArchived(sessionId, true);
      return {
        sessionId,
        action: 'archived',
        deletedFromDisk: false,
      };
    }

    let removedFromDisk = false;
    if (options.deletedFromDisk && session.jsonl_path) {
      removedFromDisk = await removeFileIfExists(session.jsonl_path);
    }

    const deleted = sessionsDb.deleteSessionById(sessionId);
    if (!deleted) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    return {
      sessionId,
      action: 'deleted',
      deletedFromDisk: removedFromDisk,
    };
  },

  /**
   * Restores one archived session back into the active sidebar lists.
   */
  restoreSessionById(sessionId: string): { sessionId: string; isArchived: false } {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    sessionsDb.updateSessionIsArchived(sessionId, false);
    return { sessionId, isArchived: false };
  },

  /**
   * Renames one session by id without requiring the caller to pass provider.
   */
  renameSessionById(sessionId: string, summary: string): { sessionId: string; summary: string } {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    sessionsDb.updateSessionCustomName(sessionId, summary);
    return { sessionId, summary };
  },
};
