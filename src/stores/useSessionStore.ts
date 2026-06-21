/**
 * Session-keyed message store.
 *
 * Holds per-session state in a Map keyed by sessionId.
 * Session switch = change activeSessionId pointer. No clearing. Old data stays.
 * WebSocket handler = store.appendRealtime(msg.sessionId, msg). One line.
 * No localStorage for messages. Backend JSONL is the source of truth.
 *
 * Each session's messages live in ONE id-keyed log (slot.byId). Every source —
 * server backfill, live frames, optimistic echoes, the streaming placeholder —
 * UPSERTS into that map by id; rendering derives a sorted, deduped array
 * (see sessionLog.ts). This is what makes a late/duplicate/out-of-order write
 * harmless and keeps ordering by timestamp rather than arrival.
 */

import { useCallback, useMemo, useRef, useState } from 'react';

import { authenticatedFetch } from '../utils/api';
import type { LLMProvider } from '../types/app';
import {
  deriveLog,
  rewriteMessageSessionId,
  sameMessage,
  EMPTY,
  type NormalizedMessage,
  type MessageKind,
} from './sessionLog';

// Re-export so existing imports (`from '../stores/useSessionStore'`) keep working.
export type { NormalizedMessage, MessageKind };

// ─── Per-session slot ────────────────────────────────────────────────────────

export type SessionStatus = 'idle' | 'loading' | 'streaming' | 'error';

export interface SessionSlot {
  /** The single source of truth: every message keyed by id, insertion-ordered. */
  byId: Map<string, NormalizedMessage>;
  /** Cached render view (chronological + echo-deduped), recomputed lazily. */
  merged: NormalizedMessage[];
  /** @internal Bumped on every log mutation; merged is recomputed when it lags. */
  _logVersion: number;
  /** @internal Version `merged` was computed at. */
  _mergedAtVersion: number;
  status: SessionStatus;
  fetchedAt: number;
  total: number;
  hasMore: boolean;
  offset: number;
  tokenUsage: unknown;
  /** @internal Monotonic counter to discard out-of-order server fetch responses. */
  _fetchSeq: number;
}

function createEmptySlot(): SessionSlot {
  return {
    byId: new Map(),
    merged: EMPTY,
    _logVersion: 0,
    _mergedAtVersion: -1,
    status: 'idle',
    fetchedAt: 0,
    total: 0,
    hasMore: false,
    offset: 0,
    tokenUsage: null,
    _fetchSeq: 0,
  };
}

/** Recompute slot.merged from the log only when the log changed since last time. */
function commit(slot: SessionSlot): void {
  if (slot._mergedAtVersion === slot._logVersion) return;
  slot.merged = deriveLog(slot.byId);
  slot._mergedAtVersion = slot._logVersion;
}

/**
 * Upsert one message. Returns true if the log actually changed. An incoming
 * message identical to the one already stored is a NO-OP — the existing object
 * reference is kept, so an idle/background refetch of unchanged content triggers
 * no re-render (and doesn't tear down a text selection).
 */
function logSet(slot: SessionSlot, msg: NormalizedMessage): boolean {
  const cur = slot.byId.get(msg.id);
  if (cur && sameMessage(cur, msg)) return false;
  slot.byId.set(msg.id, msg);
  slot._logVersion++;
  return true;
}

/** Upsert many; returns true if anything changed (one version bump for the batch). */
function logSetMany(slot: SessionSlot, msgs: NormalizedMessage[]): boolean {
  let changed = false;
  for (const m of msgs) {
    const cur = slot.byId.get(m.id);
    if (cur && sameMessage(cur, m)) continue;
    slot.byId.set(m.id, m);
    changed = true;
  }
  if (changed) slot._logVersion++;
  return changed;
}

// ─── Stale threshold ─────────────────────────────────────────────────────────

const STALE_THRESHOLD_MS = 30_000;

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useSessionStore() {
  const storeRef = useRef(new Map<string, SessionSlot>());
  const sessionAliasesRef = useRef(new Map<string, string>());
  const activeSessionIdRef = useRef<string | null>(null);
  // Bump to force re-render — only when the active session's data changes
  const [, setTick] = useState(0);
  const notify = useCallback((sessionId: string) => {
    const aliases = sessionAliasesRef.current;
    let resolvedSessionId = sessionId;
    const visited = new Set<string>();

    while (aliases.has(resolvedSessionId) && !visited.has(resolvedSessionId)) {
      visited.add(resolvedSessionId);
      resolvedSessionId = aliases.get(resolvedSessionId)!;
    }

    if (resolvedSessionId === activeSessionIdRef.current) {
      setTick(n => n + 1);
    }
  }, []);

  const resolveSessionId = useCallback((sessionId: string | null | undefined): string | null => {
    if (!sessionId) {
      return null;
    }

    const aliases = sessionAliasesRef.current;
    let resolvedSessionId = sessionId;
    const visited = new Set<string>();

    while (aliases.has(resolvedSessionId) && !visited.has(resolvedSessionId)) {
      visited.add(resolvedSessionId);
      resolvedSessionId = aliases.get(resolvedSessionId)!;
    }

    return resolvedSessionId;
  }, []);

  const setActiveSession = useCallback((sessionId: string | null) => {
    activeSessionIdRef.current = resolveSessionId(sessionId);
  }, [resolveSessionId]);

  const getSlot = useCallback((sessionId: string): SessionSlot => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const store = storeRef.current;
    if (!store.has(resolvedSessionId)) {
      store.set(resolvedSessionId, createEmptySlot());
    }
    return store.get(resolvedSessionId)!;
  }, [resolveSessionId]);

  const has = useCallback((sessionId: string) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    return storeRef.current.has(resolvedSessionId);
  }, [resolveSessionId]);

  /**
   * Fetch messages from the provider sessions endpoint and upsert them into the
   * log. Provider and project metadata are resolved server-side from `sessionId`.
   */
  const fetchFromServer = useCallback(async (
    sessionId: string,
    opts: {
      provider?: LLMProvider;
      projectId?: string;
      projectPath?: string;
      limit?: number | null;
      offset?: number;
    } = {},
  ) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    // Stamp this fetch; if a newer fetch is started before we resolve, discard our
    // (now-stale) response so it can't apply stale pagination metadata.
    const fetchSeq = (slot._fetchSeq += 1);
    // Only flash "loading" (and re-render) on a COLD load. A background re-fetch of
    // an already-populated session must not churn the view — that's what dropped
    // text selections while idle.
    const coldLoad = slot.byId.size === 0;
    if (coldLoad) {
      slot.status = 'loading';
      notify(resolvedSessionId);
    }

    try {
      const params = new URLSearchParams();
      if (opts.limit !== null && opts.limit !== undefined) {
        params.append('limit', String(opts.limit));
        params.append('offset', String(opts.offset ?? 0));
      }

      const qs = params.toString();
      const url = `/api/providers/sessions/${encodeURIComponent(resolvedSessionId)}/messages${qs ? `?${qs}` : ''}`;
      const response = await authenticatedFetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      if (slot._fetchSeq !== fetchSeq) return slot; // superseded by a newer fetch
      const messages: NormalizedMessage[] = data.messages || [];

      // Idempotent upsert (never replace the list): unchanged messages keep their
      // existing object reference, so a no-op refetch causes no re-render.
      const changed = logSetMany(slot, messages);
      slot.total = data.total ?? messages.length;
      slot.hasMore = Boolean(data.hasMore);
      slot.offset = (opts.offset ?? 0) + messages.length;
      slot.fetchedAt = Date.now();
      slot.status = 'idle';
      if (data.tokenUsage) {
        slot.tokenUsage = data.tokenUsage;
      }
      // Re-render only when the messages or the cold-load status actually changed.
      if (changed || coldLoad) {
        commit(slot);
        notify(resolvedSessionId);
      }
      return slot;
    } catch (error) {
      console.error(`[SessionStore] fetch failed for ${resolvedSessionId}:`, error);
      slot.status = 'error';
      notify(resolvedSessionId);
      return slot;
    }
  }, [getSlot, notify, resolveSessionId]);

  /**
   * Load older (paginated) messages and upsert them into the log.
   */
  const fetchMore = useCallback(async (
    sessionId: string,
    opts: {
      provider?: LLMProvider;
      projectId?: string;
      projectPath?: string;
      limit?: number;
    } = {},
  ) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    if (!slot.hasMore) return slot;

    const params = new URLSearchParams();
    const limit = opts.limit ?? 20;
    params.append('limit', String(limit));
    params.append('offset', String(slot.offset));

    const qs = params.toString();
    const url = `/api/providers/sessions/${encodeURIComponent(resolvedSessionId)}/messages${qs ? `?${qs}` : ''}`;

    try {
      const response = await authenticatedFetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const olderMessages: NormalizedMessage[] = data.messages || [];

      // Older messages carry earlier timestamps; deriveLog re-sorts, so a plain
      // upsert places them correctly without prepend bookkeeping.
      const changed = logSetMany(slot, olderMessages);
      slot.hasMore = Boolean(data.hasMore);
      slot.offset = slot.offset + olderMessages.length;
      if (changed) {
        commit(slot);
        notify(resolvedSessionId);
      }
      return slot;
    } catch (error) {
      console.error(`[SessionStore] fetchMore failed for ${resolvedSessionId}:`, error);
      return slot;
    }
  }, [getSlot, notify, resolveSessionId]);

  /**
   * Append (upsert) a realtime (WebSocket) message into the correct session's log.
   * Works regardless of which session is actively viewed.
   */
  const appendRealtime = useCallback((sessionId: string, msg: NormalizedMessage) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    const normalizedMessage =
      msg.sessionId === resolvedSessionId ? msg : { ...msg, sessionId: resolvedSessionId };
    if (!logSet(slot, normalizedMessage)) return; // identical re-delivery — no churn
    commit(slot);
    notify(resolvedSessionId);
  }, [getSlot, notify, resolveSessionId]);

  /**
   * Append multiple realtime messages at once (batch).
   */
  const appendRealtimeBatch = useCallback((sessionId: string, msgs: NormalizedMessage[]) => {
    if (msgs.length === 0) return;
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    const normalized = msgs.map((msg) =>
      msg.sessionId === resolvedSessionId ? msg : { ...msg, sessionId: resolvedSessionId },
    );
    if (!logSetMany(slot, normalized)) return; // nothing new — no churn
    commit(slot);
    notify(resolvedSessionId);
  }, [getSlot, notify, resolveSessionId]);

  /**
   * Re-fetch server history (full transcript) and upsert it into the log. Because
   * this upserts rather than replacing a list, a stale/out-of-order response can
   * only refresh existing ids — it can never drop the live tail (the old "reply
   * vanishes then reappears" race), so no reconcile/filter step is needed.
   */
  const refreshFromServer = useCallback(async (
    sessionId: string,
    _opts: {
      provider?: LLMProvider;
      projectId?: string;
      projectPath?: string;
    } = {},
  ) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    const fetchSeq = (slot._fetchSeq += 1);
    try {
      const url = `/api/providers/sessions/${encodeURIComponent(resolvedSessionId)}/messages`;
      const response = await authenticatedFetch(url);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (slot._fetchSeq !== fetchSeq) return; // superseded by a newer fetch/refresh

      const messages: NormalizedMessage[] = data.messages || [];
      const changed = logSetMany(slot, messages);
      slot.total = data.total ?? slot.byId.size;
      slot.hasMore = Boolean(data.hasMore);
      slot.fetchedAt = Date.now();
      // No-op refetch (idle catch-up with nothing new) → no re-render, so a text
      // selection survives. Only notify when the log actually changed.
      if (changed) {
        commit(slot);
        notify(resolvedSessionId);
      }
    } catch (error) {
      console.error(`[SessionStore] refresh failed for ${resolvedSessionId}:`, error);
    }
  }, [getSlot, notify, resolveSessionId]);

  /**
   * Update session status.
   */
  const setStatus = useCallback((sessionId: string, status: SessionStatus) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    slot.status = status;
    notify(resolvedSessionId);
  }, [getSlot, notify, resolveSessionId]);

  /**
   * Check if a session's data is stale (>30s old).
   */
  const isStale = useCallback((sessionId: string) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = storeRef.current.get(resolvedSessionId);
    if (!slot) return true;
    return Date.now() - slot.fetchedAt > STALE_THRESHOLD_MS;
  }, [resolveSessionId]);

  /**
   * Update or create the streaming placeholder (accumulated text so far). One
   * well-known id per session, upserted in place so it streams without stacking.
   */
  const updateStreaming = useCallback((sessionId: string, accumulatedText: string, msgProvider: LLMProvider) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    const streamId = `__streaming_${resolvedSessionId}`;
    logSet(slot, {
      id: streamId,
      sessionId: resolvedSessionId,
      timestamp: new Date().toISOString(),
      provider: msgProvider,
      kind: 'stream_delta',
      content: accumulatedText,
    });
    commit(slot);
    notify(resolvedSessionId);
  }, [getSlot, notify, resolveSessionId]);

  /**
   * Finalize streaming: promote the streaming placeholder to a real assistant text
   * message (new unique id) so it persists; the server's own copy, if it arrives
   * with yet another id, is collapsed by the adjacent-echo dedup at render.
   */
  const finalizeStreaming = useCallback((sessionId: string) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = storeRef.current.get(resolvedSessionId);
    if (!slot) return;
    const streamId = `__streaming_${resolvedSessionId}`;
    const stream = slot.byId.get(streamId);
    if (!stream) return;
    slot.byId.delete(streamId);
    const finalId = `text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    slot.byId.set(finalId, { ...stream, id: finalId, kind: 'text', role: 'assistant' });
    slot._logVersion++;
    commit(slot);
    notify(resolvedSessionId);
  }, [notify, resolveSessionId]);

  /**
   * Drop ephemeral (optimistic / streaming-placeholder) entries from the log,
   * leaving server- and realtime-confirmed messages. (Currently unused; kept for
   * API stability.)
   */
  const clearRealtime = useCallback((sessionId: string) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = storeRef.current.get(resolvedSessionId);
    if (!slot) return;
    let changed = false;
    for (const id of [...slot.byId.keys()]) {
      if (id.startsWith('local_') || id.startsWith('__streaming_')) {
        slot.byId.delete(id);
        changed = true;
      }
    }
    if (!changed) return;
    slot._logVersion++;
    commit(slot);
    notify(resolvedSessionId);
  }, [notify, resolveSessionId]);

  /**
   * Get merged messages for a session (for rendering).
   */
  const getMessages = useCallback((sessionId: string): NormalizedMessage[] => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = storeRef.current.get(resolvedSessionId);
    if (!slot) return EMPTY;
    commit(slot); // ensure merged reflects the latest log
    return slot.merged;
  }, [resolveSessionId]);

  /**
   * Get session slot (for status, pagination info, etc.).
   */
  const getSessionSlot = useCallback((sessionId: string): SessionSlot | undefined => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    return storeRef.current.get(resolvedSessionId);
  }, [resolveSessionId]);

  const replaceSessionId = useCallback((fromSessionId: string, toSessionId: string) => {
    const resolvedFromSessionId = resolveSessionId(fromSessionId) ?? fromSessionId;
    const resolvedToSessionId = resolveSessionId(toSessionId) ?? toSessionId;

    if (resolvedFromSessionId === resolvedToSessionId) {
      sessionAliasesRef.current.set(fromSessionId, resolvedToSessionId);
      return;
    }

    const store = storeRef.current;
    const sourceSlot = store.get(resolvedFromSessionId);
    const targetSlot = store.get(resolvedToSessionId) ?? createEmptySlot();

    if (sourceSlot) {
      // Merge the source log into the target by id (rewriting sessionId + the
      // streaming placeholder's id). Upsert preserves the target's own entries.
      for (const msg of sourceSlot.byId.values()) {
        const rewritten = rewriteMessageSessionId(msg, resolvedFromSessionId, resolvedToSessionId);
        targetSlot.byId.set(rewritten.id, rewritten);
      }
      targetSlot._logVersion++;
      targetSlot.status =
        sourceSlot.status === 'error'
          ? 'error'
          : sourceSlot.status === 'streaming' || targetSlot.status === 'streaming'
            ? 'streaming'
            : sourceSlot.status === 'loading' || targetSlot.status === 'loading'
              ? 'loading'
              : targetSlot.status;
      targetSlot.fetchedAt = Math.max(targetSlot.fetchedAt, sourceSlot.fetchedAt, Date.now());
      targetSlot.total = Math.max(targetSlot.total, sourceSlot.total, targetSlot.byId.size);
      targetSlot.hasMore = targetSlot.hasMore || sourceSlot.hasMore;
      targetSlot.offset = Math.max(targetSlot.offset, sourceSlot.offset);
      targetSlot.tokenUsage = targetSlot.tokenUsage ?? sourceSlot.tokenUsage;
      targetSlot._fetchSeq = Math.max(targetSlot._fetchSeq, sourceSlot._fetchSeq);
      commit(targetSlot);

      store.set(resolvedToSessionId, targetSlot);
      store.delete(resolvedFromSessionId);
    }

    sessionAliasesRef.current.set(resolvedFromSessionId, resolvedToSessionId);
    sessionAliasesRef.current.set(fromSessionId, resolvedToSessionId);

    for (const [aliasSessionId, targetSessionId] of sessionAliasesRef.current.entries()) {
      if (targetSessionId === resolvedFromSessionId) {
        sessionAliasesRef.current.set(aliasSessionId, resolvedToSessionId);
      }
    }

    if (activeSessionIdRef.current === resolvedFromSessionId) {
      activeSessionIdRef.current = resolvedToSessionId;
    }

    notify(resolvedToSessionId);
  }, [notify, resolveSessionId]);

  return useMemo(() => ({
    getSlot,
    has,
    fetchFromServer,
    fetchMore,
    appendRealtime,
    appendRealtimeBatch,
    refreshFromServer,
    setActiveSession,
    setStatus,
    isStale,
    updateStreaming,
    finalizeStreaming,
    clearRealtime,
    getMessages,
    getSessionSlot,
    replaceSessionId,
  }), [
    getSlot, has, fetchFromServer, fetchMore,
    appendRealtime, appendRealtimeBatch, refreshFromServer,
    setActiveSession, setStatus, isStale, updateStreaming, finalizeStreaming,
    clearRealtime, getMessages, getSessionSlot, replaceSessionId,
  ]);
}

export type SessionStore = ReturnType<typeof useSessionStore>;
