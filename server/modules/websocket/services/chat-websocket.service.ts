import type { WebSocket } from 'ws';

import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import { WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';
import type {
  AnyRecord,
  AuthenticatedWebSocketRequest,
  LLMProvider,
} from '@/shared/types.js';
import { createNormalizedMessage, parseIncomingJsonObject } from '@/shared/utils.js';

type ChatIncomingMessage = AnyRecord & {
  type?: string;
  command?: string;
  options?: AnyRecord;
  provider?: string;
  sessionId?: string;
  requestId?: string;
  allow?: unknown;
  updatedInput?: unknown;
  message?: unknown;
  rememberEntry?: unknown;
};

const DEFAULT_PROVIDER: LLMProvider = 'claude';

type ChatWebSocketDependencies = {
  queryClaudeSDK: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  // Hybrid control-channel bridge (see server/control-channel.js).
  queryControlChannel: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  isControlSession: (sessionId: string, cwd: string) => Promise<boolean>;
  // Live fleet-agent bridge (see server/fleet-channel.js).
  queryFleetChannel: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  isFleetSession: (sessionId: string) => Promise<boolean>;
  // Registered agent bridge (agent-discovery, see server/agent-discovery-channel.js).
  queryAgentChannel: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  isAgentSession: (sessionId: string) => Promise<boolean>;
  // Answer a registered agent's interactive `ask` (routes the GUI selection to
  // the daemon). requestId is namespaced `chask:<agentId>:<request_id>`.
  answerAgentChannel: (requestId: string, decision: unknown, writer?: WebSocketWriter) => Promise<void>;
  spawnCursor: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  queryCodex: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  spawnGemini: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  spawnOpenCode: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  abortClaudeSDKSession: (sessionId: string) => Promise<boolean>;
  abortCursorSession: (sessionId: string) => boolean;
  abortCodexSession: (sessionId: string) => boolean;
  abortGeminiSession: (sessionId: string) => boolean;
  abortOpenCodeSession: (sessionId: string) => boolean;
  resolveToolApproval: (
    requestId: string,
    payload: {
      allow: boolean;
      updatedInput?: unknown;
      message?: string;
      rememberEntry?: unknown;
    }
  ) => void;
  isClaudeSDKSessionActive: (sessionId: string) => boolean;
  isCursorSessionActive: (sessionId: string) => boolean;
  isCodexSessionActive: (sessionId: string) => boolean;
  isGeminiSessionActive: (sessionId: string) => boolean;
  isOpenCodeSessionActive: (sessionId: string) => boolean;
  reconnectSessionWriter: (sessionId: string, ws: WebSocket) => boolean;
  getPendingApprovalsForSession: (sessionId: string) => unknown[];
  getActiveClaudeSDKSessions: () => unknown;
  getActiveCursorSessions: () => unknown;
  getActiveCodexSessions: () => unknown;
  getActiveGeminiSessions: () => unknown;
  getActiveOpenCodeSessions: () => unknown;
};

/**
 * Normalizes potentially invalid provider names coming from websocket payloads.
 */
function readProvider(value: unknown): LLMProvider {
  if (value === 'claude' || value === 'cursor' || value === 'codex' || value === 'gemini' || value === 'opencode') {
    return value;
  }

  return DEFAULT_PROVIDER;
}

/**
 * Extracts the authenticated request user id in the formats currently produced
 * by platform and OSS auth code paths.
 */
function readRequestUserId(
  request: AuthenticatedWebSocketRequest | undefined
): string | number | null {
  const user = request?.user;
  if (!user) {
    return null;
  }

  if (typeof user.id === 'string' || typeof user.id === 'number') {
    return user.id;
  }

  if (typeof user.userId === 'string' || typeof user.userId === 'number') {
    return user.userId;
  }

  return null;
}

/**
 * Handles authenticated chat websocket messages used by the main chat panel.
 */
export function handleChatConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: ChatWebSocketDependencies
): void {
  console.log('[INFO] Chat WebSocket connected');
  connectedClients.add(ws);

  const writer = new WebSocketWriter(ws, readRequestUserId(request));

  ws.on('message', async (rawMessage) => {
    try {
      const parsed = parseIncomingJsonObject(rawMessage);
      if (!parsed) {
        throw new Error('Invalid websocket payload');
      }

      const data = parsed as ChatIncomingMessage;
      const messageType = data.type;
      if (!messageType) {
        throw new Error('Message type is required');
      }

      // Keep-alive heartbeat from the client — reply so it knows the socket is
      // live (and so reverse proxies don't idle-close a quiet connection).
      if (messageType === 'ping') {
        try {
          ws.send(JSON.stringify({ type: 'pong' }));
        } catch {
          /* socket already closing */
        }
        return;
      }

      if (messageType === 'claude-command') {
        // Hybrid: if this session is driven by plugin:control@kaxtus (a live
        // --remote-control session), inject the prompt into it instead of
        // spawning a new Agent SDK session. See server/control-channel.js.
        const controlSid = typeof data.options?.sessionId === 'string' ? data.options.sessionId : '';
        const controlCwd = typeof data.options?.cwd === 'string' ? data.options.cwd : '';
        // Registered agent (agent-discovery) — inject + tail transcript by agent ID.
        const agentMatch = controlSid ? await dependencies.isAgentSession(controlSid) : false;
        if (agentMatch) {
          await dependencies.queryAgentChannel(data.command ?? '', data.options, writer);
          return;
        }
        // Live fleet agent (a virtual project) — inject into the remote agent
        // and tail its transcript over HTTP. See server/fleet-channel.js.
        const fleetMatch = controlSid ? await dependencies.isFleetSession(controlSid) : false;
        if (fleetMatch) {
          await dependencies.queryFleetChannel(data.command ?? '', data.options, writer);
          return;
        }
        if (
          (controlSid || controlCwd) &&
          (await dependencies.isControlSession(controlSid, controlCwd))
        ) {
          await dependencies.queryControlChannel(data.command ?? '', data.options, writer);
          return;
        }
        await dependencies.queryClaudeSDK(data.command ?? '', data.options, writer);
        return;
      }

      if (messageType === 'cursor-command') {
        await dependencies.spawnCursor(data.command ?? '', data.options, writer);
        return;
      }

      if (messageType === 'codex-command') {
        await dependencies.queryCodex(data.command ?? '', data.options, writer);
        return;
      }

      if (messageType === 'gemini-command') {
        await dependencies.spawnGemini(data.command ?? '', data.options, writer);
        return;
      }

      if (messageType === 'opencode-command') {
        await dependencies.spawnOpenCode(data.command ?? '', data.options, writer);
        return;
      }

      if (messageType === 'cursor-resume') {
        await dependencies.spawnCursor(
          '',
          {
            sessionId: data.sessionId,
            resume: true,
            cwd: data.options?.cwd,
          },
          writer
        );
        return;
      }

      if (messageType === 'abort-session') {
        const provider = readProvider(data.provider);
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        let success = false;

        if (provider === 'cursor') {
          success = dependencies.abortCursorSession(sessionId);
        } else if (provider === 'codex') {
          success = dependencies.abortCodexSession(sessionId);
        } else if (provider === 'gemini') {
          success = dependencies.abortGeminiSession(sessionId);
        } else if (provider === 'opencode') {
          success = dependencies.abortOpenCodeSession(sessionId);
        } else {
          success = await dependencies.abortClaudeSDKSession(sessionId);
        }

        writer.send(
          createNormalizedMessage({
            kind: 'complete',
            exitCode: success ? 0 : 1,
            aborted: true,
            success,
            sessionId,
            provider,
          })
        );
        return;
      }

      if (messageType === 'claude-permission-response') {
        if (typeof data.requestId === 'string' && data.requestId.length > 0) {
          // A `chask:` requestId is a registered agent's interactive ask — route
          // the answer to the daemon instead of the local SDK approval registry.
          if (data.requestId.startsWith('chask:')) {
            await dependencies.answerAgentChannel(data.requestId, {
              allow: Boolean(data.allow),
              updatedInput: data.updatedInput,
            }, writer);
          } else {
            dependencies.resolveToolApproval(data.requestId, {
              allow: Boolean(data.allow),
              updatedInput: data.updatedInput,
              message: typeof data.message === 'string' ? data.message : undefined,
              rememberEntry: data.rememberEntry,
            });
          }
        }
        return;
      }

      if (messageType === 'cursor-abort') {
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        const success = dependencies.abortCursorSession(sessionId);
        writer.send(
          createNormalizedMessage({
            kind: 'complete',
            exitCode: success ? 0 : 1,
            aborted: true,
            success,
            sessionId,
            provider: 'cursor',
          })
        );
        return;
      }

      if (messageType === 'check-session-status') {
        const provider = readProvider(data.provider);
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        let isActive = false;

        if (provider === 'cursor') {
          isActive = dependencies.isCursorSessionActive(sessionId);
        } else if (provider === 'codex') {
          isActive = dependencies.isCodexSessionActive(sessionId);
        } else if (provider === 'gemini') {
          isActive = dependencies.isGeminiSessionActive(sessionId);
        } else if (provider === 'opencode') {
          isActive = dependencies.isOpenCodeSessionActive(sessionId);
        } else {
          isActive = dependencies.isClaudeSDKSessionActive(sessionId);
          if (isActive) {
            dependencies.reconnectSessionWriter(sessionId, ws);
          }
        }

        writer.send({
          type: 'session-status',
          sessionId,
          provider,
          isProcessing: isActive,
        });
        return;
      }

      if (messageType === 'get-pending-permissions') {
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        if (sessionId && dependencies.isClaudeSDKSessionActive(sessionId)) {
          const pending = dependencies.getPendingApprovalsForSession(sessionId);
          writer.send({
            type: 'pending-permissions-response',
            sessionId,
            data: pending,
          });
        }
        return;
      }

      if (messageType === 'get-active-sessions') {
        writer.send({
          type: 'active-sessions',
          sessions: {
            claude: dependencies.getActiveClaudeSDKSessions(),
            cursor: dependencies.getActiveCursorSessions(),
            codex: dependencies.getActiveCodexSessions(),
            gemini: dependencies.getActiveGeminiSessions(),
            opencode: dependencies.getActiveOpenCodeSessions(),
          },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Chat WebSocket error:', message);
      writer.send({
        type: 'error',
        error: message,
      });
    }
  });

  ws.on('close', () => {
    console.log('[INFO] Chat client disconnected');
    connectedClients.delete(ws);
  });
}
