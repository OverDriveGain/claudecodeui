import os from 'node:os';
import path from 'node:path';
import { promises as fsPromises } from 'node:fs';

import chokidar, { type FSWatcher } from 'chokidar';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';
import type { LLMProvider } from '@/shared/types.js';
import { generateDisplayName } from '@/modules/projects/index.js';
// MYMU: per-user scoping of realtime deltas (FORK.md S2)
import { isNameAllowedFor, isNameDeniedFor, isPathOwnedByLinuxUser } from '@/services/user-context.js';

type WatcherEventType = 'add' | 'change';

const PROVIDER_WATCH_PATHS: Array<{ provider: LLMProvider; rootPath: string }> = [
  {
    provider: 'claude',
    rootPath: path.join(os.homedir(), '.claude', 'projects'),
  },
  {
    provider: 'cursor',
    rootPath: path.join(os.homedir(), '.cursor', 'projects'),
  },
  {
    provider: 'codex',
    rootPath: path.join(os.homedir(), '.codex', 'sessions'),
  },
  {
    provider: 'opencode',
    rootPath: path.join(os.homedir(), '.local', 'share', 'opencode'),
  },
];

const WATCHER_IGNORED_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/subagents/**',
  '**/tool-results/**',
  '**/*.tmp',
  '**/*.swp',
  '**/.DS_Store',
];

const PROJECTS_UPDATE_DEBOUNCE_MS = 500;
const PROJECTS_UPDATE_MAX_WAIT_MS = 2_000;

/**
 * Use native filesystem events (inotify/FSEvents) by default so terminal-driven
 * session activity reflects in the UI within a fraction of a second instead of
 * the multi-second lag that polling imposes. Polling stays available behind an
 * env flag for network mounts (NFS/SMB) where native events are unreliable.
 */
const WATCHER_USE_POLLING = process.env.SESSIONS_WATCHER_POLLING === '1';
const WATCHER_POLL_INTERVAL_MS = Number(process.env.SESSIONS_WATCHER_INTERVAL_MS) || 6_000;

const watchers: FSWatcher[] = [];

type PendingWatcherUpdate = {
  providers: Set<LLMProvider>;
  changeTypes: Set<WatcherEventType>;
  /**
   * Provider-native session ids reported by the synchronizers. They are
   * translated back to app-facing session rows at flush time, because the
   * transcript file names on disk only ever contain provider ids.
   */
  updatedSessionIds: Set<string>;
};

let pendingWatcherUpdate: PendingWatcherUpdate | null = null;
let pendingWatcherUpdateStartedAt: number | null = null;
let pendingWatcherFlushTimer: ReturnType<typeof setTimeout> | null = null;
let watcherRefreshInFlight = false;
let watcherRescheduleAfterRefresh = false;

// ─── Terminal-session "running" detection ────────────────────────────────────
// The server does not own terminal-driven Claude processes, so it cannot read a
// live "busy" flag from them. Instead we infer activity from the transcript the
// CLI writes to disk: when the last conversational event is an open turn (an
// assistant turn that will call tools, or a user/tool_result the assistant must
// answer) the session is running; when it is a completed assistant turn it is
// idle. The completing write itself flips the state, so no polling is needed.
// An idle-timeout is the safety net for interrupted sessions that never write a
// closing event.

type RawTranscriptEvent = Record<string, any>;

const RUNNING_IDLE_TIMEOUT_MS = Number(process.env.SESSIONS_RUNNING_TIMEOUT_MS) || 90_000;
const TAIL_READ_BYTES = 64 * 1024;

const runningSessionIds = new Set<string>();
const runningIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Reads the tail of a transcript and returns the last `user`/`assistant` event,
 * skipping control rows (mode, file-history-snapshot, ai-title, ...).
 */
async function readLastMeaningfulEvent(filePath: string): Promise<RawTranscriptEvent | null> {
  let handle: Awaited<ReturnType<typeof fsPromises.open>> | null = null;
  try {
    handle = await fsPromises.open(filePath, 'r');
    const { size } = await handle.stat();
    if (size === 0) {
      return null;
    }
    const readBytes = Math.min(size, TAIL_READ_BYTES);
    const buffer = Buffer.alloc(readBytes);
    await handle.read(buffer, 0, readBytes, size - readBytes);
    const lines = buffer.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) {
        continue;
      }
      let evt: RawTranscriptEvent;
      try {
        evt = JSON.parse(line);
      } catch {
        // Partial first line of the tail window, or a row split across the read
        // boundary — ignore and keep scanning toward older complete lines.
        continue;
      }
      if (evt.type === 'user' || evt.type === 'assistant') {
        return evt;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
}

/**
 * Decides whether the latest transcript event represents an open (in-progress)
 * turn. Assistant turns that stopped to call tools, or are still streaming, are
 * open; a user prompt / tool_result is open (the assistant must respond next);
 * an assistant turn that ended normally is closed.
 */
function eventIndicatesOpenTurn(evt: RawTranscriptEvent): boolean {
  if (evt.type === 'assistant') {
    const stop = evt.message?.stop_reason;
    return stop === 'tool_use' || stop === null || stop === undefined;
  }
  if (evt.type === 'user') {
    return evt.isMeta !== true;
  }
  return false;
}

function broadcastSessionActivity(): void {
  const message = JSON.stringify({
    type: 'session_activity',
    runningSessionIds: Array.from(runningSessionIds),
    timestamp: new Date().toISOString(),
  });
  connectedClients.forEach(client => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(message);
    }
  });
}

function clearRunningIdleTimer(sessionId: string): void {
  const existing = runningIdleTimers.get(sessionId);
  if (existing) {
    clearTimeout(existing);
    runningIdleTimers.delete(sessionId);
  }
}

/**
 * Re-evaluates a Claude session's running state from its transcript tail and
 * broadcasts only when the running set actually changes.
 */
async function evaluateSessionActivity(filePath: string, sessionId: string | null): Promise<void> {
  if (!sessionId) {
    return;
  }

  const lastEvent = await readLastMeaningfulEvent(filePath);
  const running = lastEvent ? eventIndicatesOpenTurn(lastEvent) : false;
  const wasRunning = runningSessionIds.has(sessionId);

  clearRunningIdleTimer(sessionId);

  if (running) {
    runningSessionIds.add(sessionId);
    const idleTimer = setTimeout(() => {
      runningIdleTimers.delete(sessionId);
      if (runningSessionIds.delete(sessionId)) {
        broadcastSessionActivity();
      }
    }, RUNNING_IDLE_TIMEOUT_MS);
    if (typeof idleTimer.unref === 'function') {
      idleTimer.unref();
    }
    runningIdleTimers.set(sessionId, idleTimer);
    if (!wasRunning) {
      broadcastSessionActivity();
    }
  } else if (runningSessionIds.delete(sessionId)) {
    broadcastSessionActivity();
  }
}

/**
 * Filters watcher events to provider-specific session artifact file types.
 */
function isWatcherTargetFile(provider: LLMProvider, filePath: string): boolean {
  if (provider === 'opencode') {
    return path.basename(filePath) === 'opencode.db';
  }

  return filePath.endsWith('.jsonl');
}

function clearPendingWatcherFlushTimer(): void {
  if (pendingWatcherFlushTimer) {
    clearTimeout(pendingWatcherFlushTimer);
    pendingWatcherFlushTimer = null;
  }
}

function schedulePendingWatcherFlush(): void {
  if (!pendingWatcherUpdate) {
    return;
  }

  const now = Date.now();
  if (pendingWatcherUpdateStartedAt === null) {
    pendingWatcherUpdateStartedAt = now;
  }

  const elapsed = now - pendingWatcherUpdateStartedAt;
  const remainingMaxWait = Math.max(0, PROJECTS_UPDATE_MAX_WAIT_MS - elapsed);
  const delay = Math.min(PROJECTS_UPDATE_DEBOUNCE_MS, remainingMaxWait);

  clearPendingWatcherFlushTimer();
  pendingWatcherFlushTimer = setTimeout(() => {
    void flushPendingWatcherUpdate();
  }, delay);
}

function queuePendingWatcherUpdate(
  eventType: WatcherEventType,
  provider: LLMProvider,
  updatedSessionId: string | null
): void {
  if (!pendingWatcherUpdate) {
    pendingWatcherUpdate = {
      providers: new Set<LLMProvider>(),
      changeTypes: new Set<WatcherEventType>(),
      updatedSessionIds: new Set<string>(),
    };
  }

  pendingWatcherUpdate.providers.add(provider);
  pendingWatcherUpdate.changeTypes.add(eventType);
  if (updatedSessionId) {
    pendingWatcherUpdate.updatedSessionIds.add(updatedSessionId);
  }

  schedulePendingWatcherFlush();
}

/**
 * Builds one `session_upserted` delta event for a provider-native session id.
 *
 * The event carries everything a sidebar needs to upsert the session in place
 * (session summary plus owning-project metadata), so clients never need a full
 * project-list refetch when a transcript file changes on disk. Returns `null`
 * when the id cannot be resolved to an indexed session row.
 */
async function buildSessionUpsertedEvent(updatedProviderSessionId: string): Promise<string | null> {
  const row = sessionsDb.getSessionByProviderSessionId(updatedProviderSessionId)
    ?? sessionsDb.getSessionById(updatedProviderSessionId);
  if (!row || row.isArchived) {
    return null;
  }

  const projectPath = row.project_path;
  const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;
  const displayName = project?.custom_project_name?.trim()
    ? project.custom_project_name
    : await generateDisplayName(path.basename(projectPath ?? '') || (projectPath ?? ''), projectPath);

  return JSON.stringify({
    kind: 'session_upserted',
    sessionId: row.session_id,
    provider: row.provider,
    session: {
      id: row.session_id,
      summary: row.custom_name || '',
      messageCount: 0,
      lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    },
    project: project
      ? {
        projectId: project.project_id,
        path: project.project_path,
        fullPath: project.project_path,
        displayName,
        isStarred: Boolean(project.isStarred),
      }
      : null,
    timestamp: new Date().toISOString(),
  });
}

async function flushPendingWatcherUpdate(): Promise<void> {
  clearPendingWatcherFlushTimer();

  if (!pendingWatcherUpdate) {
    return;
  }

  if (watcherRefreshInFlight) {
    watcherRescheduleAfterRefresh = true;
    return;
  }

  const queuedUpdate = pendingWatcherUpdate;
  pendingWatcherUpdate = null;
  pendingWatcherUpdateStartedAt = null;
  watcherRefreshInFlight = true;

  try {
    // Per-session deltas instead of full project snapshots: an upsert of one
    // session can never clobber unrelated client state, so the frontend needs
    // no "suppress updates while a run is active" protection logic.
    // MYMU: each delta is sent only to clients whose scope covers the session's
    // project (agent-name pattern OR mapped-linux-user path ownership), so a
    // restricted account never sees foreign sessions flicker in via realtime.
    const events: Array<{ event: string; projectPath: string | null }> = [];
    for (const updatedSessionId of queuedUpdate.updatedSessionIds) {
      const event = await buildSessionUpsertedEvent(updatedSessionId);
      if (event) {
        const row = sessionsDb.getSessionById(updatedSessionId);
        events.push({ event, projectPath: row?.project_path ?? null });
      }
    }

    if (events.length > 0) {
      connectedClients.forEach(client => {
        if (client.readyState !== WS_OPEN_STATE) return;
        const allow = (client as { agentAllow?: string[] | null }).agentAllow ?? null;
        const linuxUser = (client as { linuxUser?: string | null }).linuxUser ?? null;
        const deny = (client as { agentDeny?: string[] | null }).agentDeny ?? null;
        for (const { event, projectPath } of events) {
          const name = projectPath ? path.basename(projectPath) : '';
          // Deny first and unconditionally — a realtime push must never surface
          // what a refresh hides, including for an otherwise-unrestricted client.
          if (isNameDeniedFor(name, deny)) continue;
          if (allow && allow.length > 0) {
            const inScope = isNameAllowedFor(name, allow)
              || isPathOwnedByLinuxUser(projectPath ?? '', linuxUser);
            if (!inScope) continue;
          }
          client.send(event);
        }
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Session watcher refresh failed while broadcasting session_upserted', { error: message });
  } finally {
    watcherRefreshInFlight = false;

    if (pendingWatcherUpdate || watcherRescheduleAfterRefresh) {
      watcherRescheduleAfterRefresh = false;
      schedulePendingWatcherFlush();
    }
  }
}

/**
 * Handles file watcher updates and triggers provider file-level synchronization.
 */
async function onUpdate(
  eventType: WatcherEventType,
  filePath: string,
  provider: LLMProvider
): Promise<void> {
  if (!isWatcherTargetFile(provider, filePath)) {
    return;
  }

  try {
    const result = await sessionSynchronizerService.synchronizeProviderFile(provider, filePath);
    if (!result.indexed) {
      return;
    }

    console.log(`Session synchronization triggered by ${eventType} event for provider "${provider}"`, {
      filePath,
      sessionId: result.sessionId,
    });
    queuePendingWatcherUpdate(eventType, provider, result.sessionId);

    // Infer terminal-session running state from the transcript tail (Claude only).
    if (provider === 'claude') {
      void evaluateSessionActivity(filePath, result.sessionId ?? null);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Session watcher sync failed for provider "${provider}"`, {
      eventType,
      filePath,
      error: message,
    });
  }
}

/**
 * Starts provider filesystem watchers and performs initial DB synchronization.
 */
export async function initializeSessionsWatcher(): Promise<void> {
  console.log('Setting up session watchers', {
    mode: WATCHER_USE_POLLING ? `polling@${WATCHER_POLL_INTERVAL_MS}ms` : 'native',
  });

  const initialSync = await sessionSynchronizerService.synchronizeSessions();
  console.log('Initial session synchronization complete', {
    processedByProvider: initialSync.processedByProvider,
    failures: initialSync.failures,
  });

  for (const { provider, rootPath } of PROVIDER_WATCH_PATHS) {
    try {
      await fsPromises.mkdir(rootPath, { recursive: true });

      const watcher = chokidar.watch(rootPath, {
        ignored: WATCHER_IGNORED_PATTERNS,
        persistent: true,
        ignoreInitial: true,
        followSymlinks: false,
        depth: 6,
        usePolling: WATCHER_USE_POLLING,
        interval: WATCHER_POLL_INTERVAL_MS,
        binaryInterval: WATCHER_POLL_INTERVAL_MS,
      });

      watcher
        .on('add', (filePath: string) => {
          void onUpdate('add', filePath, provider);
        })
        .on('change', (filePath: string) => {
          void onUpdate('change', filePath, provider);
        })
        .on('error', (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Session watcher error for provider "${provider}"`, { error: message });
        });

      watchers.push(watcher);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to initialize session watcher for provider "${provider}"`, {
        rootPath,
        error: message,
      });
    }
  }
}

/**
 * Stops all active provider session watchers.
 */
export async function closeSessionsWatcher(): Promise<void> {
  clearPendingWatcherFlushTimer();

  await Promise.all(
    watchers.map(async (watcher) => {
      try {
        await watcher.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Failed to close session watcher', { error: message });
      }
    })
  );
  watchers.length = 0;
  pendingWatcherUpdate = null;
  pendingWatcherUpdateStartedAt = null;
  watcherRefreshInFlight = false;
  watcherRescheduleAfterRefresh = false;

  for (const timer of runningIdleTimers.values()) {
    clearTimeout(timer);
  }
  runningIdleTimers.clear();
  runningSessionIds.clear();
}
