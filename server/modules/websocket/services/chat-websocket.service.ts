import type { WebSocket } from 'ws';

import { materializeAttachmentOptions } from '@/modules/assets/index.js';
import { sessionsDb } from '@/modules/database/index.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import { WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';
import type {
  AnyRecord,
  AuthenticatedWebSocketRequest,
  LLMProvider,
  RealtimeClientConnection,
} from '@/shared/types.js';
import { createNormalizedMessage, parseIncomingJsonObject } from '@/shared/utils.js';
import { runWithUserContext, parseAgentAllow, effectiveAgentAllowRaw, effectiveLinuxUser } from '@/services/user-context.js';

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
  // Remote-control proxy: a claude-command tagged with options.remoteControl is
  // driven over the proxy; abort/permission route by the rc: prefix / active session.
  isRemoteCommand: (options: unknown) => boolean;
  queryRemoteChannel: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  // Read-only live subscription to a connected agent (opened when the GUI views it).
  subscribeRemoteChannel: (sessionId: string, writer: WebSocketWriter) => Promise<unknown>;
  isRemoteSession: (sessionId: string) => boolean;
  abortRemoteSession: (sessionId: string) => boolean;
  resolveRemotePermission: (requestId: string, decision: unknown) => boolean;
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

  // Per-connection agent visibility: every message this socket sends is dispatched
  // inside the user's context, so the rc.service capture checks enforce per-user
  // scoping on subscribe/drive (same as HTTP requests via the auth middleware).
  const wsUser = request?.user as import('@/services/user-context.js').VisibilityUser | undefined;
  const agentAllowRaw = effectiveAgentAllowRaw(wsUser);
  const wsLinuxUser = effectiveLinuxUser(wsUser);
  // Stamp the parsed allow-list + linux user on the socket so per-user
  // broadcasters (e.g. the sessions watcher's projects_updated) can scope their
  // push to this client, instead of pushing the unrestricted list to every socket.
  (ws as unknown as RealtimeClientConnection).agentAllow = parseAgentAllow(agentAllowRaw);
  (ws as unknown as RealtimeClientConnection).linuxUser = wsLinuxUser;

  ws.on('message', (rawMessage) => runWithUserContext(agentAllowRaw, async () => {
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

      // ---- Stock-upstream dialect (chat.*) ----
      // The post-fork upstream client protocol. MyMu accepts BOTH vocabularies
      // so one client can speak one protocol against MyMu and stock servers
      // alike; these aliases translate onto the existing handlers below.

      // Relay-agent sessions carry the Anthropic `cse_` id prefix; the dynamic
      // check alone only knows sessions that are ALREADY attached, which a
      // quiet agent isn't yet.
      const isRelaySession = (id: string): boolean =>
        id.startsWith('cse_') || dependencies.isRemoteSession(id);

      if (messageType === 'chat.subscribe') {
        const sessions = Array.isArray((data as AnyRecord).sessions)
          ? ((data as AnyRecord).sessions as AnyRecord[])
          : [];
        for (const entry of sessions) {
          const sessionId = typeof entry?.sessionId === 'string' ? entry.sessionId : '';
          if (!sessionId) continue;
          if (isRelaySession(sessionId)) {
            await dependencies.subscribeRemoteChannel(sessionId, writer);
            // isProcessing deliberately omitted for relay sessions: the
            // agent-status poll is authoritative there, and a wrong `false`
            // in this ack would fight the client's loader.
            writer.send({ kind: 'chat_subscribed', sessionId });
          } else {
            const isProcessing = dependencies.isClaudeSDKSessionActive(sessionId);
            if (isProcessing) {
              dependencies.reconnectSessionWriter(sessionId, ws);
            }
            writer.send({
              kind: 'chat_subscribed',
              sessionId,
              isProcessing,
              pendingPermissions: isProcessing
                ? dependencies.getPendingApprovalsForSession(sessionId)
                : [],
            });
          }
        }
        return;
      }

      if (messageType === 'chat.send') {
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        const content = typeof (data as AnyRecord).content === 'string'
          ? String((data as AnyRecord).content)
          : '';
        const clientOptions = { ...((data.options ?? {}) as AnyRecord) };
        if (!sessionId) {
          writer.send({
            kind: 'protocol_error',
            code: 'SESSION_ID_REQUIRED',
            message: 'chat.send requires a sessionId.',
          });
          return;
        }
        // Store-referenced attachments ({path} records from POST /api/assets/*)
        // become the inline shape the provider pipeline consumes; inline
        // data-URLs pass through, references outside the store are dropped.
        await materializeAttachmentOptions(clientOptions);
        if (isRelaySession(sessionId)) {
          await dependencies.queryRemoteChannel(
            content,
            { ...clientOptions, sessionId, resume: true, remoteControl: sessionId },
            writer
          );
          return;
        }
        const row = sessionsDb.getSessionById(sessionId);
        if (!row) {
          writer.send({
            kind: 'protocol_error',
            code: 'SESSION_NOT_FOUND',
            message: `Session "${sessionId}" was not found. Create it via POST /api/providers/sessions first.`,
            sessionId,
          });
          return;
        }
        const projectPath = row.project_path ?? undefined;
        const options: AnyRecord = {
          ...clientOptions,
          projectPath,
          cwd: clientOptions.cwd ?? projectPath,
        };
        if (row.jsonl_path) {
          // Existing transcript: resume the provider-native session.
          options.sessionId = sessionId;
          options.resume = true;
        } else {
          // Pre-created placeholder (no transcript yet): first message spawns
          // fresh; `session_created` announces the real id and the client
          // rebinds. The placeholder served its purpose — the sessions watcher
          // registers the real session when its transcript lands on disk.
          sessionsDb.deleteSessionById(sessionId);
        }
        await dependencies.queryClaudeSDK(content, options, writer);
        return;
      }

      if (messageType === 'chat.abort') {
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        const success = isRelaySession(sessionId)
          ? dependencies.abortRemoteSession(sessionId)
          : await dependencies.abortClaudeSDKSession(sessionId);
        writer.send(
          createNormalizedMessage({
            kind: 'complete',
            exitCode: success ? 0 : 1,
            aborted: true,
            success,
            sessionId,
            provider: DEFAULT_PROVIDER,
          })
        );
        return;
      }

      // Read-only live subscription: the GUI opened a remote-control agent and wants
      // its stream mirrored live (terminal messages, thinking progress, output) the
      // way claude.ai/code does — without sending anything.
      if (messageType === 'rc-subscribe') {
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        if (sessionId) {
          await dependencies.subscribeRemoteChannel(sessionId, writer);
        }
        return;
      }

      if (messageType === 'claude-command') {
        // Remote-control agent: a claude-command tagged with options.remoteControl
        // is driven over the proxy (attach + send to the live agent), not the local
        // SDK. The capture policy is enforced inside queryRemoteChannel.
        if (dependencies.isRemoteCommand(data.options)) {
          await dependencies.queryRemoteChannel(data.command ?? '', data.options, writer);
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
        } else if (dependencies.isRemoteSession(sessionId)) {
          success = dependencies.abortRemoteSession(sessionId);
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

      if (messageType === 'claude-permission-response' || messageType === 'chat.permission-response') {
        if (typeof data.requestId === 'string' && data.requestId.length > 0) {
          const decision = {
            allow: Boolean(data.allow),
            updatedInput: data.updatedInput,
            message: typeof data.message === 'string' ? data.message : undefined,
          };
          // Remote-control prompts carry an `rc:` requestId; route them to the proxy.
          // Returns false when it isn't a remote prompt, so the local path still runs.
          if (!dependencies.resolveRemotePermission(data.requestId, decision)) {
            dependencies.resolveToolApproval(data.requestId, {
              ...decision,
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
  }, wsLinuxUser));

  ws.on('close', () => {
    console.log('[INFO] Chat client disconnected');
    connectedClients.delete(ws);
  });
}
