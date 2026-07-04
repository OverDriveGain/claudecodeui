import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import { usePaletteOps } from '../../../contexts/PaletteOpsContext';
import { showCompletionTitleIndicator } from '../../../utils/pageTitleNotification';
import { playChatCompletionSound } from '../../../utils/notificationSound';
import type { PendingPermissionRequest, SessionNavigationOptions } from '../types/types';
import type { ProjectSession, LLMProvider } from '../../../types/app';
import type { SessionStore, NormalizedMessage } from '../../../stores/useSessionStore';

type PendingViewSession = {
  startedAt: number;
};

type LatestChatMessage = {
  type?: string;
  kind?: string;
  data?: any;
  message?: any;
  delta?: string;
  sessionId?: string;
  session_id?: string;
  requestId?: string;
  toolName?: string;
  input?: unknown;
  context?: unknown;
  error?: string;
  tool?: any;
  toolId?: string;
  result?: any;
  exitCode?: number;
  isProcessing?: boolean;
  actualSessionId?: string;
  event?: string;
  status?: any;
  isNewSession?: boolean;
  resultText?: string;
  isError?: boolean;
  success?: boolean;
  reason?: string;
  provider?: string;
  content?: string;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  tokenBudget?: unknown;
  newSessionId?: string;
  aborted?: boolean;
  [key: string]: any;
};

interface UseChatRealtimeHandlersArgs {
  latestMessage: LatestChatMessage | null;
  provider: LLMProvider;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  setCurrentSessionId: (sessionId: string | null) => void;
  setIsLoading: (loading: boolean) => void;
  setCanAbortSession: (canAbort: boolean) => void;
  setClaudeStatus: (status: { text: string; tokens: number; can_interrupt: boolean } | null) => void;
  setTokenBudget: (budget: Record<string, unknown> | null) => void;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  pendingViewSessionRef: MutableRefObject<PendingViewSession | null>;
  streamTimerRef: MutableRefObject<number | null>;
  accumulatedStreamRef: MutableRefObject<string>;
  onSessionInactive?: (sessionId?: string | null) => void;
  onSessionActive?: (sessionId?: string | null) => void;
  onSessionProcessing?: (sessionId?: string | null) => void;
  onSessionNotProcessing?: (sessionId?: string | null) => void;
  onNavigateToSession?: (sessionId: string, options?: SessionNavigationOptions) => void;
  onWebSocketReconnect?: () => void;
  sessionStore: SessionStore;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

export function useChatRealtimeHandlers({
  latestMessage,
  provider,
  selectedSession,
  currentSessionId,
  setCurrentSessionId,
  setIsLoading,
  setCanAbortSession,
  setClaudeStatus,
  setTokenBudget,
  setPendingPermissionRequests,
  pendingViewSessionRef,
  streamTimerRef,
  accumulatedStreamRef,
  onSessionInactive,
  onSessionActive,
  onSessionProcessing,
  onSessionNotProcessing,
  onNavigateToSession,
  onWebSocketReconnect,
  sessionStore,
}: UseChatRealtimeHandlersArgs) {
  const paletteOps = usePaletteOps();
  const lastProcessedMessageRef = useRef<LatestChatMessage | null>(null);

  useEffect(() => {
    if (!latestMessage) return;
    if (lastProcessedMessageRef.current === latestMessage) return;
    lastProcessedMessageRef.current = latestMessage;

    const activeViewSessionId =
      selectedSession?.id || currentSessionId || null;

    /* ---------------------------------------------------------------- */
    /*  Legacy messages (no `kind` field) — handle and return           */
    /* ---------------------------------------------------------------- */

    const msg = latestMessage as any;

    if (!msg.kind) {
      const messageType = String(msg.type || '');

      switch (messageType) {
        case 'websocket-reconnected':
          onWebSocketReconnect?.();
          return;

        case 'pending-permissions-response': {
          const permSessionId = msg.sessionId;
          const isCurrentPermSession =
            permSessionId === currentSessionId || (selectedSession && permSessionId === selectedSession.id);
          if (permSessionId && !isCurrentPermSession) return;
          setPendingPermissionRequests(msg.data || []);
          return;
        }

        case 'session-status': {
          const statusSessionId = msg.sessionId;
          if (!statusSessionId) return;

          const isCurrentSession =
            statusSessionId === currentSessionId || (selectedSession && statusSessionId === selectedSession.id);

          const status = msg.status;
          if (status) {
            // Only the viewed session's status drives this view's spinner — a
            // background session's status must not (that was the cross-conversation
            // "confusion" while another agent was working).
            if (!isCurrentSession) return;
            const statusInfo = {
              text: status.text || 'Working...',
              tokens: status.tokens || 0,
              can_interrupt: status.can_interrupt !== undefined ? status.can_interrupt : true,
            };
            setClaudeStatus(statusInfo);
            setIsLoading(true);
            setCanAbortSession(statusInfo.can_interrupt);
            return;
          }


          if (msg.isProcessing) {
            onSessionActive?.(statusSessionId);
            onSessionProcessing?.(statusSessionId);
            if (isCurrentSession) { setIsLoading(true); setCanAbortSession(true); }
            return;
          }

          onSessionInactive?.(statusSessionId);
          onSessionNotProcessing?.(statusSessionId);
          if (isCurrentSession) {
            setIsLoading(false);
            setCanAbortSession(false);
            setClaudeStatus(null);
          }
          return;
        }

        default:
          // Unknown legacy message type — ignore
          return;
      }
    }

    /* ---------------------------------------------------------------- */
    /*  NormalizedMessage handling (has `kind` field)                    */
    /* ---------------------------------------------------------------- */

    const sid = msg.sessionId || activeViewSessionId;

    // The open ChatInterface's singleton control state (loading spinner, status line,
    // abort button, permission prompts, session-id adoption, navigation) must be driven
    // ONLY by frames that belong to the session currently in view. A different session
    // — e.g. another agent working in the background — streams its frames through this
    // same handler; those must update only their own store slot (done above via
    // appendRealtime, which is keyed by `sid`) and must NEVER flip this view's spinner
    // or re-point it at their session. That cross-session bleed is what made messages
    // "go to another conversation" while one was busy. A frame with no sessionId (e.g.
    // the very first frames of a not-yet-created local session, and `session_created`
    // itself) is always owned by the open composer, so it counts as the active view.
    const drivesActiveView = !msg.sessionId || sid === activeViewSessionId;

    // --- Streaming: buffer for performance ---
    if (msg.kind === 'stream_delta') {
      const text = msg.content || '';
      if (!text) return;
      // Background session: keep its live text in its own store slot and leave the
      // active view's coalescing buffer untouched (mixing two sessions' deltas into
      // one buffer corrupted both).
      if (!drivesActiveView) {
        if (sid) sessionStore.appendRealtime(sid, msg as NormalizedMessage);
        return;
      }
      accumulatedStreamRef.current += text;
      if (!streamTimerRef.current) {
        streamTimerRef.current = window.setTimeout(() => {
          streamTimerRef.current = null;
          if (sid) {
            sessionStore.updateStreaming(sid, accumulatedStreamRef.current, provider);
          }
        }, 100);
      }
      return;
    }

    if (msg.kind === 'stream_end') {
      if (!drivesActiveView) {
        if (sid) sessionStore.finalizeStreaming(sid);
        return;
      }
      if (streamTimerRef.current) {
        clearTimeout(streamTimerRef.current);
        streamTimerRef.current = null;
      }
      if (sid) {
        if (accumulatedStreamRef.current) {
          sessionStore.updateStreaming(sid, accumulatedStreamRef.current, provider);
        }
        sessionStore.finalizeStreaming(sid);
      }
      accumulatedStreamRef.current = '';
      return;
    }

    // --- All other messages: route to store ---
    const shouldPersist =
      msg.kind !== 'session_created'
      && msg.kind !== 'complete'
      && msg.kind !== 'status'
      && msg.kind !== 'permission_request'
      && msg.kind !== 'permission_cancelled';

    if (sid && shouldPersist) {
      sessionStore.appendRealtime(sid, msg as NormalizedMessage);
    }

    // --- UI side effects for specific kinds ---
    switch (msg.kind) {
      case 'session_created': {
        const newSessionId = msg.newSessionId;
        if (!newSessionId) break;

        // We no longer synthesize client-side placeholder IDs. Until the provider
        // announces `session_created`, the active id is expected to be null.
        if (!currentSessionId) {
          console.log('Session created with ID:', newSessionId);
          console.log('Existing session ID:', currentSessionId);
          setCurrentSessionId(newSessionId);
          setPendingPermissionRequests((prev) =>
            prev.map((r) => (r.sessionId ? r : { ...r, sessionId: newSessionId })),
          );
        }
        pendingViewSessionRef.current = null;
        onSessionActive?.(newSessionId);
        onSessionProcessing?.(newSessionId);
        setIsLoading(true);
        setCanAbortSession(true);
        setClaudeStatus({
          text: 'Processing',
          tokens: 0,
          can_interrupt: true,
        });
        onNavigateToSession?.(newSessionId);
        break;
      }

      case 'complete': {
        if (drivesActiveView) {
          // Flush the active view's remaining streaming state and reset its spinner.
          if (streamTimerRef.current) {
            clearTimeout(streamTimerRef.current);
            streamTimerRef.current = null;
          }
          if (sid && accumulatedStreamRef.current) {
            sessionStore.updateStreaming(sid, accumulatedStreamRef.current, provider);
            sessionStore.finalizeStreaming(sid);
          }
          accumulatedStreamRef.current = '';

          setIsLoading(false);
          setCanAbortSession(false);
          setClaudeStatus(null);
        } else if (sid) {
          // Background session finished — finalize only its own store slot; never
          // touch this view's buffer/spinner.
          sessionStore.finalizeStreaming(sid);
        }
        // Do NOT clear pending permission / AskUserQuestion requests on a normal
        // `complete`. An agent cannot finish a turn while a tool_use is still
        // unanswered, so a `complete` arriving with an open question is spurious —
        // e.g. a backgrounded agent's relay socket idles/drops and emits a synthetic
        // `complete`. Clearing it there is exactly what made a question "vanish /
        // become skipped" after switching conversations. Open requests are cleared
        // the correct way: on answer (resolvePermission removes them) or when the
        // agent withdraws the prompt (`permission_cancelled`). Only an explicit
        // user abort cancels still-pending work.
        if (msg.aborted) {
          setPendingPermissionRequests((prev) =>
            prev.filter((r: PendingPermissionRequest) => r.sessionId && r.sessionId !== sid),
          );
        }
        onSessionInactive?.(sid);
        onSessionNotProcessing?.(sid);
        if (drivesActiveView) {
          pendingViewSessionRef.current = null;
        }

        // Handle aborted case
        if (msg.aborted) {
          // Abort was requested — the complete event confirms it
          // No special UI action needed beyond clearing loading state above
          // The backend already sent any abort-related messages
          break;
        }

        showCompletionTitleIndicator();
        void playChatCompletionSound();

        const actualSessionId =
          typeof msg.actualSessionId === 'string' && msg.actualSessionId.trim().length > 0
            ? msg.actualSessionId
            : null;
        const isVisibleSession =
          Boolean(
            sid
            && sid === activeViewSessionId,
          );

        if (actualSessionId && sid && actualSessionId !== sid) {
          sessionStore.replaceSessionId(sid, actualSessionId);

          if (isVisibleSession) {
            setCurrentSessionId(actualSessionId);
          }

          if (isVisibleSession) {
            onNavigateToSession?.(actualSessionId, { replace: true });
            setTimeout(() => { void paletteOps.refreshProjects(); }, 500);
          }
          break;
        }

        break;
      }

      case 'error': {
        if (drivesActiveView) {
          setIsLoading(false);
          setCanAbortSession(false);
          setClaudeStatus(null);
          pendingViewSessionRef.current = null;
        }
        onSessionInactive?.(sid);
        onSessionNotProcessing?.(sid);
        break;
      }

      case 'permission_request': {
        if (!msg.requestId) break;
        setPendingPermissionRequests((prev) => {
          if (prev.some((r: PendingPermissionRequest) => r.requestId === msg.requestId)) return prev;
          return [...prev, {
            requestId: msg.requestId,
            toolName: msg.toolName || 'UnknownTool',
            input: msg.input,
            context: msg.context,
            sessionId: sid || null,
            receivedAt: new Date(),
          }];
        });
        // Only the viewed session's prompt drives this view's spinner/status; a
        // background agent's request is still recorded above (keyed by its sid, and
        // filtered out of this view) and surfaces when its conversation is opened.
        if (drivesActiveView) {
          setIsLoading(true);
          setCanAbortSession(true);
          setClaudeStatus({ text: 'Waiting for permission', tokens: 0, can_interrupt: true });
        }
        break;
      }

      case 'permission_cancelled': {
        if (msg.requestId) {
          setPendingPermissionRequests((prev) => prev.filter((r: PendingPermissionRequest) => r.requestId !== msg.requestId));
        }
        break;
      }

      case 'status': {
        // A background session's progress/token status must not drive this view's
        // spinner or status line — that was the visible "confusion" while another
        // conversation was working.
        if (!drivesActiveView) break;
        if (msg.text === 'token_budget' && msg.tokenBudget) {
          setTokenBudget(msg.tokenBudget as Record<string, unknown>);
        } else if (msg.text) {
          setClaudeStatus({
            text: msg.text,
            tokens: msg.tokens || 0,
            can_interrupt: msg.canInterrupt !== undefined ? msg.canInterrupt : true,
          });
          setIsLoading(true);
          setCanAbortSession(msg.canInterrupt !== false);
        }
        break;
      }

      // text, tool_use, tool_result, thinking, interactive_prompt, task_notification
      // → already routed to store above, no UI side effects needed
      default:
        break;
    }
  }, [
    latestMessage,
    provider,
    selectedSession,
    currentSessionId,
    setCurrentSessionId,
    setIsLoading,
    setCanAbortSession,
    setClaudeStatus,
    setTokenBudget,
    setPendingPermissionRequests,
    pendingViewSessionRef,
    streamTimerRef,
    accumulatedStreamRef,
    onSessionInactive,
    onSessionActive,
    onSessionProcessing,
    onSessionNotProcessing,
    onNavigateToSession,
    onWebSocketReconnect,
    sessionStore,
    paletteOps,
  ]);
}
