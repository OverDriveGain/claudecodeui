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
} from './remote-control/rc-client.js';
import { isAgentCaptureAllowed } from './services/rc.service.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';

// The engine is provider-agnostic; this adapter supplies the claude normalizer so a
// streamed bridge frame renders through the exact same path the local SDK uses.
const normalizeClaude = (rawFrame, sessionId) => sessionsService.normalizeMessage('claude', rawFrame, sessionId);

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
  // isn't allowed to surface (can't be bypassed with a crafted frame).
  if (!sessionId || !(await isAgentCaptureAllowed(sessionId))) return;
  // Forward composer attachments (options.images, upload-images shape) so files
  // attached to a live agent are folded into the message as content blocks.
  return driveRemoteSession({ ws: writer, sessionId, command, images: opts.images, normalize: normalizeClaude });
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
  } catch {
    // relay unreachable / transient — the GUI still has history; live mirror resumes
    // on the next open or send.
  }
}

// Stop + permission answer route straight to the engine (it already strips the
// `rc:` requestId prefix and returns false for non-remote prompts, so other
// permission paths still run).
export { abortRemoteSession, resolveRemotePermission };
