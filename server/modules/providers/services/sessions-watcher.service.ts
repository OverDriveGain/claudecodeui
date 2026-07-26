import os from 'node:os';
import path from 'node:path';
import { promises as fsPromises } from 'node:fs';

import chokidar, { type FSWatcher } from 'chokidar';

import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';
import type { LLMProvider } from '@/shared/types.js';
import { getProjectsWithSessions, filterProjectsForUser } from '@/modules/projects/index.js';

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
  // {
  //   provider: 'gemini',
  //   rootPath: path.join(os.homedir(), '.gemini', 'sessions'),
  // },
  // Keep `sessions/` watcher disabled: Gemini also mirrors artifacts there,
  // which causes duplicate synchronization events.
  {
    provider: 'gemini',
    rootPath: path.join(os.homedir(), '.gemini', 'tmp'),
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

  if (provider === 'gemini') {
    return filePath.endsWith('.json') || filePath.endsWith('.jsonl');
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
    // Computed with no request context = the unrestricted superset. Each client is
    // then sent ITS OWN per-user slice below — never the full list — so a restricted
    // account can't see other agents flicker in via this realtime push (it would
    // otherwise show every agent until the next user-scoped HTTP refresh).
    const updatedProjects = await getProjectsWithSessions({ skipSynchronization: true, skipProgress: true });
    const changeTypes = Array.from(queuedUpdate.changeTypes);
    const watchProviders = Array.from(queuedUpdate.providers);
    const updatedSessionIds = Array.from(queuedUpdate.updatedSessionIds);

    // Backward-compatible fields stay populated with the first queued values.
    const baseMessage = {
      type: 'projects_updated',
      timestamp: new Date().toISOString(),
      changeType: changeTypes[0] ?? 'change',
      updatedSessionId: updatedSessionIds[0] ?? undefined,
      watchProvider: watchProviders[0] ?? undefined,
      changeTypes,
      updatedSessionIds,
      watchProviders,
      batched: true,
    };

    connectedClients.forEach(client => {
      if (client.readyState !== WS_OPEN_STATE) return;
      const projectsForClient = filterProjectsForUser(updatedProjects, client.agentAllow ?? null, client.linuxUser ?? null);
      client.send(JSON.stringify({ ...baseMessage, projects: projectsForClient }));
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Session watcher refresh failed while broadcasting projects_updated', { error: message });
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
