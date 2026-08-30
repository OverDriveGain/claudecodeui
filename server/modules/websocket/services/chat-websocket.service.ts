import path from 'node:path';

import type { WebSocket } from 'ws';

import { sessionsDb, userDb } from '@/modules/database/index.js';
import { providerModelsService } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import {
  getGlobalImageAssetsDir,
  isImageAttachmentDescriptor,
  normalizeAttachmentDescriptors,
  type ChatAttachmentDescriptor,
} from '@/shared/image-attachments.js';
import type {
  AnyRecord,
  AuthenticatedWebSocketRequest,
  LLMProvider,
  ProviderPermissionDecision,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import { parseIncomingJsonObject } from '@/shared/utils.js';
// MYMU: per-user agent visibility on the chat socket (FORK.md S2)
import { runWithUserContext, parseAgentAllow, effectiveAgentAllowRaw, effectiveLinuxUser, effectiveModelDeny, isModelBlocked } from '@/modules/mymu/index.js';
// MYMU: live relay agents (FORK.md S1) — relay sessions (Anthropic `cse_` ids)
// are driven over the remote-control proxy, injected by the server root (the
// rc-channel adapter is a root file outside the module graph, like claude-sdk).
import { WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';

type RelayDependencies = {
  queryRemoteChannel: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  subscribeRemoteChannel: (sessionId: string, writer: WebSocketWriter) => Promise<unknown>;
  isRemoteSession: (sessionId: string) => boolean;
  abortRemoteSession: (sessionId: string) => boolean;
  resolveRemotePermission: (requestId: string, decision: unknown) => boolean;
};
let relay: RelayDependencies | null = null;
/** MYMU: called once from the server root to wire the remote-control proxy. */
export function setRelayDependencies(deps: RelayDependencies): void {
  relay = deps;
}

const isRelaySession = (id: string): boolean =>
  id.startsWith('cse_') || id.startsWith('ocs_') || id.startsWith('cxs_') || (relay ? relay.isRemoteSession(id) : false);

/**
 * MYMU hook: fires once each time a user opens a LIVE AGENT conversation
 * (`chat.subscribe` for a relay/OpenCode session). Intentionally empty — a
 * systematic extension point for per-open side effects (e.g. bring an offline
 * agent online, telemetry, presence). Must never throw and must stay cheap;
 * the subscribe path is latency-sensitive.
 */
export function onLiveAgentConversationOpened(_sessionId: string): void {
  // no-op (stub)
}

/**
 * Trust boundary for client-supplied image attachments: chat.send options come
 * straight from the browser, and the provider runtimes read the referenced
 * files off disk (Claude base64-encodes them into the prompt). Only images
 * that live directly inside the global upload store (`~/.cloudcli/assets`,
 * where POST /api/assets/images puts them) are allowed through — anything
 * else (absolute paths elsewhere, traversal, subdirectories) is dropped.
 *
 * Exported for tests; `assetsRootOverride` exists only for them.
 */
export function filterAttachmentsToUploadStore(
  attachments: unknown,
  assetsRootOverride?: string,
): ChatAttachmentDescriptor[] {
  const assetsRoot = path.resolve(assetsRootOverride ?? getGlobalImageAssetsDir());

  return normalizeAttachmentDescriptors(attachments).filter((descriptor) => {
    // Relative paths are anchored in the store; absolute ones must already be in it.
    const resolved = path.resolve(assetsRoot, descriptor.path);
    const relative = path.relative(assetsRoot, resolved);
    const isDirectChild =
      relative.length > 0 &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      !relative.includes(path.sep) &&
      !relative.includes('/');

    if (!isDirectChild) {
      console.warn(`[Chat] Dropping attachment outside the upload store: ${descriptor.path}`);
    }
    return isDirectChild;
  });
}

/** Backward-compatible image filter consumed by existing websocket tests. */
export function filterImagesToUploadStore(
  images: unknown,
  assetsRootOverride?: string,
): ChatAttachmentDescriptor[] {
  return filterAttachmentsToUploadStore(images, assetsRootOverride);
}

/** Application boundary for dispatching provider runs and approvals. */
type ProviderRuntimeGateway = {
  hasRuntime(provider: string): boolean;
  run(
    provider: LLMProvider,
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
  ): Promise<unknown>;
  abort(provider: LLMProvider, sessionId: string): Promise<boolean>;
  resolveToolApproval(requestId: string, payload: ProviderPermissionDecision): void;
  getPendingApprovalsForSession(sessionId: string): unknown[];
};

type ChatWebSocketDependencies = {
  /** Central dispatcher for every provider SDK/CLI runtime. */
  runtime: ProviderRuntimeGateway;
};

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

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WS_OPEN_STATE) {
    ws.send(JSON.stringify(payload));
  }
}

/**
 * Reports a protocol-level failure to the requesting client.
 *
 * Protocol errors deliberately use their own `kind` (instead of the provider
 * `error` message kind) so the frontend can distinguish "your request was
 * invalid" from "the model run produced an error" without inspecting text.
 */
function sendProtocolError(
  ws: WebSocket,
  code: string,
  error: string,
  sessionId?: string
): void {
  sendJson(ws, {
    kind: 'protocol_error',
    code,
    error,
    sessionId: sessionId ?? null,
    timestamp: new Date().toISOString(),
  });
}

function readRequiredSessionId(data: AnyRecord): string | null {
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
  return sessionId.length > 0 ? sessionId : null;
}

/**
 * Handles `chat.send`: resolves the session row (provider, project path, and
 * provider-native id all come from the database — never from the client),
 * registers the run, and dispatches to the provider runtime.
 */
async function handleChatSend(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.send requires a sessionId.');
    return;
  }

  // MYMU: relay sessions bypass the local run registry — the agent's own
  // machine owns the run; the proxy streams its frames back to this socket.
  if (isRelaySession(sessionId)) {
    const command = typeof data.content === 'string' ? data.content : '';
    const clientOptions = (data.options ?? {}) as AnyRecord;
    // MYMU F8: live-agent sends honor the per-user model block-list too — the
    // channel adapters now APPLY an explicit composer pick on the agent, so a
    // blocked model must be refused here exactly like a local session. Only an
    // explicit pick is checked ('default'/unset leaves the agent's own model).
    const relayModelRaw = typeof clientOptions.model === 'string' ? clientOptions.model.trim() : '';
    if (relayModelRaw && relayModelRaw !== 'default') {
      const relayDeny = effectiveModelDeny(userId == null ? null : userDb.getUserById(Number(userId)));
      if (relayDeny.length > 0 && isModelBlocked(relayModelRaw, relayDeny)) {
        sendProtocolError(
          ws,
          'MODEL_NOT_ALLOWED',
          `Model "${relayModelRaw}" is not available on your account.`,
          sessionId,
        );
        return;
      }
    }
    // MYMU: live agents take the SAME attachment pipeline as project sessions —
    // the client uploads through POST /api/assets/files and the descriptors are
    // re-verified against the upload store here. Before this, relay options went
    // through raw and only legacy inline data-URLs could land, so files uploaded
    // to a live agent were silently dropped. Legacy inline images stay untouched
    // in `images` (App Store 1.0.x, demo server) and still land downstream.
    const relayAttachments = filterAttachmentsToUploadStore([
      ...normalizeAttachmentDescriptors(clientOptions.images),
      ...normalizeAttachmentDescriptors(clientOptions.files),
      ...normalizeAttachmentDescriptors(clientOptions.attachments),
    ]).filter(
      (descriptor, index, all) => all.findIndex((candidate) => candidate.path === descriptor.path) === index,
    );
    await relay?.queryRemoteChannel(
      command,
      {
        ...clientOptions,
        attachments: relayAttachments,
        sessionId,
        resume: true,
        remoteControl: sessionId,
      },
      new WebSocketWriter(ws, userId)
    );
    return;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    sendProtocolError(
      ws,
      'SESSION_NOT_FOUND',
      `Session "${sessionId}" was not found. Create it via POST /api/providers/sessions first.`,
      sessionId
    );
    return;
  }

  const provider = session.provider as LLMProvider;
  if (!dependencies.runtime.hasRuntime(provider)) {
    sendProtocolError(ws, 'UNSUPPORTED_PROVIDER', `Provider "${provider}" is not available.`, sessionId);
    return;
  }

  // MYMU: per-user model block-list. A blocked model is refused before the run
  // starts — this catches a hand-crafted request AND a session previously
  // recorded with a now-blocked model, so the restriction is never picker-only.
  // Owners are exempt (effectiveModelDeny returns []). Relay sessions run the
  // same check on an explicit pick in their branch above.
  const modelDeny = effectiveModelDeny(userId == null ? null : userDb.getUserById(Number(userId)));
  if (modelDeny.length > 0) {
    const requestedRaw = (data.options as AnyRecord | undefined)?.model;
    const requestedModel = typeof requestedRaw === 'string' && requestedRaw.trim()
      ? requestedRaw.trim()
      : (session.model ?? '');
    if (isModelBlocked(requestedModel, modelDeny)) {
      sendProtocolError(
        ws,
        'MODEL_NOT_ALLOWED',
        `Model "${requestedModel}" is not available on your account.`,
        sessionId,
      );
      return;
    }
  }

  const run = chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider,
    providerSessionId: session.provider_session_id,
    connection: ws,
    userId,
  });

  if (!run) {
    sendProtocolError(
      ws,
      'RUN_IN_PROGRESS',
      `Session "${sessionId}" already has a run in progress.`,
      sessionId
    );
    return;
  }

  const clientOptions = (data.options ?? {}) as AnyRecord;
  const command = typeof data.content === 'string' ? data.content : '';

  // Record what this turn runs with so reopening the session later restores the
  // same model and reasoning effort, and so the resume path has a
  // session-scoped model answer to use.
  if (typeof clientOptions.model === 'string' && clientOptions.model.trim()) {
    providerModelsService.setSessionModel(provider, sessionId, clientOptions.model);
  }
  if (typeof clientOptions.effort === 'string' && clientOptions.effort.trim()) {
    providerModelsService.setSessionEffort(provider, sessionId, clientOptions.effort);
  }

  const attachmentCandidates = [
    ...normalizeAttachmentDescriptors(clientOptions.images),
    ...normalizeAttachmentDescriptors(clientOptions.files),
    ...normalizeAttachmentDescriptors(clientOptions.attachments),
  ];
  const verifiedAttachments = filterAttachmentsToUploadStore(attachmentCandidates);
  const uniqueAttachments = verifiedAttachments.filter(
    (descriptor, index, all) => all.findIndex((candidate) => candidate.path === descriptor.path) === index,
  );

  // The provider runtimes receive the stable app session id. When their
  // CLI/SDK needs the provider-native id for resume, they resolve it from the
  // session row themselves (sessionsService.resolveProviderSessionId).
  // Brand-new sessions have no provider id yet, so the runtime starts fresh
  // and announces one, which the gateway writer captures and maps back to the
  // app session id.
  const runtimeOptions: AnyRecord = {
    ...clientOptions,
    // Attachments are re-validated server-side: only direct children of the
    // global upload store may reach provider runtimes or their file tools.
    attachments: uniqueAttachments,
    images: uniqueAttachments.filter(isImageAttachmentDescriptor),
    files: uniqueAttachments.filter((descriptor) => !isImageAttachmentDescriptor(descriptor)),
    sessionId,
    cwd: clientOptions.cwd ?? session.project_path ?? undefined,
    projectPath: session.project_path ?? clientOptions.projectPath,
  };

  try {
    await dependencies.runtime.run(provider, command, runtimeOptions, run.writer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Chat] Provider runtime "${provider}" failed`, { sessionId, error: message });
  } finally {
    // Safety net: a runtime that crashed (or resolved) without emitting its
    // terminal `complete` would otherwise leave the session stuck in
    // "processing" forever on every connected client. Scoped to THIS run —
    // a queued message can start the session's next run before this promise
    // settles, and the session-keyed completeRun would kill that new run.
    chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });
  }
}

/**
 * Handles `chat.abort`: cancels the run for one app session and emits the
 * terminal `complete` on its behalf (runtimes skip their own complete for
 * aborted runs, and the registry drops any duplicate).
 */
async function handleChatAbort(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.abort requires a sessionId.');
    return;
  }

  // MYMU: relay sessions abort over the proxy
  if (isRelaySession(sessionId)) {
    const success = relay ? relay.abortRemoteSession(sessionId) : false;
    (new WebSocketWriter(ws, null)).send({
      kind: 'complete', sessionId, exitCode: success ? 0 : 1, success, aborted: true,
    });
    return;
  }

  const run = chatRunRegistry.getRun(sessionId);
  if (!run || run.status !== 'running') {
    sendProtocolError(ws, 'NO_ACTIVE_RUN', `Session "${sessionId}" has no active run.`, sessionId);
    return;
  }

  const success = await dependencies.runtime.abort(run.provider, sessionId);

  chatRunRegistry.completeRun(sessionId, {
    exitCode: success ? 0 : 1,
    aborted: true,
  });
}

/**
 * Handles `chat.subscribe`: for each requested session, reports whether a run
 * is processing, re-attaches the live stream to this socket, replays missed
 * events (seq > lastSeq), and includes pending permission requests.
 *
 * This single message replaces the old `check-session-status`,
 * `get-pending-permissions`, and Claude-only writer reconnect flows.
 */
function handleChatSubscribe(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): void {
  const targets = Array.isArray(data.sessions) ? data.sessions : [];

  for (const target of targets) {
    if (!target || typeof target !== 'object') {
      continue;
    }

    const sessionId = typeof (target as AnyRecord).sessionId === 'string'
      ? ((target as AnyRecord).sessionId as string).trim()
      : '';
    if (!sessionId) {
      continue;
    }

    // MYMU: relay sessions attach via the remote-control proxy. isProcessing
    // deliberately omitted — the agent-status poll is authoritative there and
    // a wrong `false` in this ack would fight the client's loader.
    if (isRelaySession(sessionId)) {
      onLiveAgentConversationOpened(sessionId);
      void relay?.subscribeRemoteChannel(sessionId, new WebSocketWriter(ws, null));
      (new WebSocketWriter(ws, null)).send({ kind: 'chat_subscribed', sessionId });
      continue;
    }

    const lastSeqRaw = (target as AnyRecord).lastSeq;
    const lastSeq = typeof lastSeqRaw === 'number' && Number.isFinite(lastSeqRaw)
      ? Math.max(0, Math.floor(lastSeqRaw))
      : 0;

    const run = chatRunRegistry.getRun(sessionId);
    const isProcessing = chatRunRegistry.isProcessing(sessionId);

    // Future live events for this run should land on the socket that asked —
    // this is what makes mid-stream page refreshes work for all providers.
    if (isProcessing) {
      chatRunRegistry.attachConnection(sessionId, ws);
    }

    // Pending approvals are tracked under the app session id inside the
    // Claude runtime, so they can be looked up directly.
    const pendingPermissions = dependencies.runtime.getPendingApprovalsForSession(sessionId);

    sendJson(ws, {
      kind: 'chat_subscribed',
      sessionId,
      isProcessing,
      lastSeq: run?.lastSeq ?? 0,
      pendingPermissions,
      timestamp: new Date().toISOString(),
    });

    // Replay only for RUNNING runs, strictly after the ack. Completed runs
    // are fully persisted to the provider transcript and served over REST —
    // replaying them (e.g. after a page reload where the client's lastSeq is
    // 0) would duplicate messages the history fetch already returned.
    if (isProcessing) {
      for (const event of chatRunRegistry.replayEvents(sessionId, lastSeq)) {
        sendJson(ws, event);
      }
    }
  }
}

/**
 * Handles `chat.permission-response`: forwards a tool-approval decision to the
 * pending approval resolver (Claude is the only provider with interactive
 * approvals today, but the message is intentionally provider-neutral).
 */
function handlePermissionResponse(data: AnyRecord, dependencies: ChatWebSocketDependencies): void {
  if (typeof data.requestId !== 'string' || data.requestId.length === 0) {
    return;
  }

  // MYMU: relay prompts carry an `rc:` requestId — resolve over the proxy;
  // returns false when it isn't a remote prompt, so the local path still runs.
  const decision = {
    allow: Boolean(data.allow),
    updatedInput: data.updatedInput,
    message: typeof data.message === 'string' ? data.message : undefined,
  };
  if (relay && relay.resolveRemotePermission(data.requestId, decision)) {
    return;
  }

  dependencies.runtime.resolveToolApproval(data.requestId, {
    ...decision,
    rememberEntry: data.rememberEntry,
  });
}

/**
 * Handles authenticated chat websocket messages used by the main chat panel.
 *
 * Inbound protocol (client to server):
 * - `chat.send`                { sessionId, content, options? }
 * - `chat.abort`               { sessionId }
 * - `chat.subscribe`           { sessions: [{ sessionId, lastSeq? }] }
 * - `chat.permission-response` { requestId, allow, updatedInput?, message?, rememberEntry? }
 *
 * Outbound protocol (server to client): every frame is `kind`-based — either
 * a provider `NormalizedMessage` (with `seq`) or a gateway event
 * (`chat_subscribed`, `session_upserted`, `loading_progress`,
 * `protocol_error`).
 */
export function handleChatConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: ChatWebSocketDependencies
): void {
  console.log('[INFO] Chat WebSocket connected');
  connectedClients.add(ws);

  const userId = readRequestUserId(request);

  // MYMU: every message this socket sends dispatches inside the user's
  // visibility context; the allow-list + linux user are stamped on the socket
  // so per-user broadcasters can scope their pushes to this client.
  const wsUser = request?.user as Record<string, unknown> | undefined;
  const agentAllowRaw = effectiveAgentAllowRaw(wsUser as never);
  const wsLinuxUser = effectiveLinuxUser(wsUser as never);
  (ws as unknown as Record<string, unknown>).agentAllow = parseAgentAllow(agentAllowRaw);
  (ws as unknown as Record<string, unknown>).linuxUser = wsLinuxUser;

  ws.on('message', (rawMessage) => runWithUserContext(agentAllowRaw, async () => {
    try {
      const parsed = parseIncomingJsonObject(rawMessage);
      if (!parsed) {
        throw new Error('Invalid websocket payload');
      }

      const data = parsed as AnyRecord;
      const messageType = typeof data.type === 'string' ? data.type : '';

      switch (messageType) {
        case 'chat.send':
          await handleChatSend(ws, userId, data, dependencies);
          return;
        case 'chat.abort':
          await handleChatAbort(ws, data, dependencies);
          return;
        case 'chat.subscribe':
          handleChatSubscribe(ws, data, dependencies);
          return;
        case 'chat.permission-response':
          handlePermissionResponse(data, dependencies);
          return;
        default:
          sendProtocolError(ws, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type "${messageType}".`);
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Chat WebSocket error:', message);
      sendProtocolError(ws, 'INTERNAL_ERROR', message);
    }
  }, wsLinuxUser)); // MYMU: closes runWithUserContext

  ws.on('close', () => {
    console.log('[INFO] Chat client disconnected');
    connectedClients.delete(ws);
  });
}
