// rc-channel.js — dispatcher adapter for remote-control agent sessions.
//
// Adapts the chat dispatcher's (command, options, writer) call shape onto the
// remote-control engine (server/remote-control/rc-client.js). Additive — it sits
// beside the local SDK path and is only reached when a command targets a remote
// agent (options.remoteControl = the connected agent's session id).

import {
  driveRemoteSession,
  attachSession,
  abortRemoteSession,
  resolveRemotePermission,
  isActiveRemoteSession,
  emitOutstandingPermission,
} from './remote-control/rc-client.js';
import { isAgentCaptureAllowed } from './services/rc.service.js';
import { landAttachments, fileReferralText } from './services/incoming-files.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { createNormalizedMessage } from './shared/utils.js';

// The engine is provider-agnostic; this adapter supplies the claude normalizer so a
// streamed bridge frame renders through the exact same path the local SDK uses.
const normalizeClaude = (rawFrame, sessionId) => {
  const messages = sessionsService.normalizeMessage('claude', rawFrame, sessionId);
  // MYMU: mirror the local runtime's token_budget status frames for relay
  // sessions, so the stock TokenUsageSummary + usage modal light up for
  // agents exactly like local conversations.
  const tokenBudget = extractRelayTokenBudget(rawFrame);
  if (tokenBudget) {
    messages.push(createNormalizedMessage({
      kind: 'status',
      text: 'token_budget',
      tokenBudget,
      sessionId,
      provider: 'claude',
    }));
  }
  return messages;
};

/** Token budget from a raw relay frame's usage payload (same shape the local
 *  claude runtime's extractTokenBudget produces). */
function extractRelayTokenBudget(rawFrame) {
  const usage = rawFrame?.message?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const cacheCreationTokens = n(usage.cache_creation_input_tokens);
  const cacheReadTokens = n(usage.cache_read_input_tokens);
  const inputTokens = n(usage.input_tokens) + cacheCreationTokens + cacheReadTokens;
  const outputTokens = n(usage.output_tokens);
  if (inputTokens + outputTokens === 0) return null;
  const contextWindow = Number.parseInt(process.env.CONTEXT_WINDOW, 10) || 160000;
  return {
    used: inputTokens + outputTokens,
    total: contextWindow,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheTokens: cacheCreationTokens + cacheReadTokens,
    breakdown: { input: inputTokens, output: outputTokens },
  };
}

/** A chat command targets a remote agent iff it carries options.remoteControl. */
export function isRemoteCommand(options) {
  return Boolean(options && typeof options.remoteControl === 'string' && options.remoteControl.length > 0);
}

/** True once a remote session is attached (used by the abort path). */
export function isRemoteSession(sessionId) {
  return isActiveRemoteSession(sessionId);
}

/**
 * Run one remote-control chat turn. `options.remoteControl` is the connected agent's
 * session id; we attach + send to it. `writer` is the WebSocketWriter, which is
 * exactly the engine's `ws` contract.
 */
export async function queryRemoteChannel(command, options, writer) {
  const opts = options || {};
  const sessionId = opts.remoteControl;
  // Enforce the server-side capture policy: refuse to drive an agent this deployment
  // isn't allowed to surface (can't be bypassed with a crafted frame). The refusal
  // must be LOUD: this used to return void, so a mis-routed send (e.g. a peer-host
  // agent whose message landed on the primary that denies it) vanished while the
  // client showed a working loader forever.
  if (!sessionId || !(await isAgentCaptureAllowed(sessionId))) {
    console.warn('[rc-channel] refused out-of-scope drive', { sessionId: sessionId || null });
    if (sessionId && writer) {
      writer.send(createNormalizedMessage({
        kind: 'error',
        content: 'Message not delivered: this server is not allowed to drive this agent. '
          + 'The agent likely runs on another host — check its host pin and that you are logged into that host.',
        sessionId,
        provider: 'claude',
      }));
      writer.send(createNormalizedMessage({ kind: 'complete', exitCode: 1, sessionId, provider: 'claude' }));
    }
    return;
  }
  // Attachments land as REAL FILES on the agent's host (same-host write, or
  // shipped to the owning peer via /api/federation/upload) and the message just
  // refers the agent to the saved paths — any file type works and the agent
  // reads it from disk like everything else. Only when no host can take the
  // bytes (no peer owns the session, e.g. an agent on a CCUI-less machine) do
  // we fall back to the old content-block embedding so nothing regresses.
  let outCommand = command;
  let outImages = opts.images;
  const landed = await landAttachments(sessionId, opts.images);
  if (landed && landed.length > 0) {
    outCommand = [command || '', fileReferralText(landed)].filter(Boolean).join('\n\n');
    outImages = undefined;
  }
  return driveRemoteSession({ ws: writer, sessionId, command: outCommand, images: outImages, normalize: normalizeClaude });
}

/**
 * Subscribe (read-only) to a connected agent's session so the GUI mirrors it LIVE
 * — exactly like claude.ai/code, which holds an open subscription per open session
 * and receives every event (user messages typed in the terminal, thinking-token
 * progress, assistant output, result) as it happens. Called when the web UI OPENS
 * an agent, before/without sending anything. Attaches the upstream relay socket and
 * binds it to this writer; the engine is idempotent per session and rebinds the
 * writer on reconnect. No-op (silently) if the capture policy hides the agent.
 */
export async function subscribeRemoteChannel(sessionId, writer) {
  if (!sessionId || !(await isAgentCaptureAllowed(sessionId))) return;
  try {
    await attachSession(sessionId, writer, normalizeClaude);
    // If the agent is waiting on a question/permission asked before we attached,
    // surface it as an answerable request — the relay won't replay it, so without
    // this the GUI is stuck showing the read-only transcript copy.
    await emitOutstandingPermission(sessionId, writer);
  } catch {
    // relay unreachable / transient — the GUI still has history; live mirror resumes
    // on the next open or send.
  }
}

// Stop + permission answer route straight to the engine (it already strips the
// `rc:` requestId prefix and returns false for non-remote prompts, so other
// permission paths still run).
export { abortRemoteSession, resolveRemotePermission };
