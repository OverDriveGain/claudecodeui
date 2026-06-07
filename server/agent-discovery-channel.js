// agent-discovery-channel.js — send bridge for registered agents.
//
// When a claude-command targets a registered-agent session, this module injects
// the prompt into the live agent via the daemon's /agents/<id>/prompt endpoint,
// then tails its transcript and feeds each new record through ccui's own
// normalizer so the reply renders natively in the chat UI.
//
// Agents are addressed by stable UUID (not name). The force=true bypass and the
// in-memory telegram block-cache present in fleet-channel.js are removed — those
// were Manar-fleet-specific workarounds.

import { lookupBySession, listAgents, discoveryCall, discoveryTranscript, discoveryPendingAsk, discoveryAnswer, getAgentById } from './services/agent-discovery.service.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { createNormalizedMessage } from './shared/utils.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;

export async function isAgentSession(sessionId) {
  if (!sessionId) return false;
  if (lookupBySession(sessionId)) return true;
  await listAgents({ force: true });
  return Boolean(lookupBySession(sessionId));
}

export async function queryAgentChannel(command, options = {}, ws) {
  const sessionId = typeof options?.sessionId === 'string' ? options.sessionId : '';
  // The session the GUI navigated to and is rendering. ALL outbound messages
  // must be stamped with this id — the frontend's session store only re-renders
  // messages whose sessionId matches the active view. The agent's internal
  // transcript session id (`sid` below) is used solely for tailing/indexing;
  // if we leaked it onto outbound messages they'd be stored under a foreign
  // session slot and stay invisible until a refresh re-fetched the transcript.
  const agent = lookupBySession(sessionId);
  if (!agent) {
    ws.send(createNormalizedMessage({ kind: 'error', content: 'agent for this session is no longer registered', sessionId, provider: 'claude' }));
    ws.send(createNormalizedMessage({ kind: 'complete', exitCode: 1, sessionId, provider: 'claude' }));
    return;
  }

  // Writable if it has a live control plane (CONTROLLABLE) OR a connected
  // reverse-connect channel shim. Only DISCONNECTED is truly blocked.
  if (!(agent.controllable || agent.channel_connected || agent.state === 'CONTROLLABLE')) {
    const reason = agent.state === 'DISCONNECTED'
      ? 'agent is disconnected — relaunch it and re-register to resume'
      : 'agent has no control plane — transcript is read-only';
    ws.send(createNormalizedMessage({ kind: 'error', content: reason, sessionId, provider: 'claude' }));
    ws.send(createNormalizedMessage({ kind: 'complete', exitCode: 1, sessionId, provider: 'claude' }));
    return;
  }

  const agentId = agent.id;
  // Stable id for everything we emit to the client.
  const viewSid = sessionId;

  // Baseline record count before injecting, so we tail only the new records.
  const baseline = await discoveryTranscript(agentId);
  let seen = baseline.records.length;
  let sid = baseline.sessionId || sessionId;
  const transcriptAvailable = baseline.ok;

  // Forward image attachments if present.
  const images = Array.isArray(options?.images)
    ? options.images
        .filter((im) => im && typeof im.data === 'string')
        .map((im) => ({ name: im.name, mimeType: im.mimeType, data: im.data }))
    : [];

  try {
    const body = { prompt: command, meta: { origin: 'claudecodeui' } };
    if (images.length) body.images = images;
    const { status, json } = await discoveryCall('POST', `/agents/${enc(agentId)}/prompt`, {
      body,
      timeoutMs: 125000,
    });
    if (status < 200 || status >= 300) {
      const reason = json?.error || json?.detail || `inject failed (HTTP ${status})`;
      ws.send(createNormalizedMessage({ kind: 'error', content: reason, sessionId: viewSid, provider: 'claude' }));
      ws.send(createNormalizedMessage({ kind: 'complete', exitCode: 1, sessionId: viewSid, provider: 'claude' }));
      return;
    }
  } catch (e) {
    ws.send(createNormalizedMessage({ kind: 'error', content: `agent unreachable: ${e?.message || e}`, sessionId: viewSid, provider: 'claude' }));
    ws.send(createNormalizedMessage({ kind: 'complete', exitCode: 1, sessionId: viewSid, provider: 'claude' }));
    return;
  }

  if (!transcriptAvailable) {
    ws.send(createNormalizedMessage({
      kind: 'status',
      content: `Prompt delivered to ${agent.label}. Live reply streaming needs the transcript endpoint (not available).`,
      sessionId: viewSid,
      provider: 'claude',
    }));
    ws.send(createNormalizedMessage({ kind: 'complete', exitCode: 0, sessionId: viewSid, provider: 'claude' }));
    return;
  }

  // Stream the agent's reply, surfacing an interactive ask if it parks on one.
  await tailAndSurface(agentId, viewSid, seen, sid, ws);
}

// Tail an agent's transcript, streaming each new record to the GUI (stamped with
// the GUI's viewSid so it renders live), until EITHER:
//   - the assistant turn ends  -> send `complete` (composer resets), or
//   - the agent parks on an interactive `ask` -> emit a `permission_request` and
//     STOP WITHOUT a `complete`. A trailing `complete` would make the frontend
//     clear pendingPermissionRequests, wiping the picker before the user sees it
//     (the turn isn't over — it resumes when they answer via answerAgentChannel).
async function tailAndSurface(agentId, viewSid, startSeen, startSid, ws) {
  let seen = startSeen;
  let sid = startSid;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await sleep(700);
    const t = await discoveryTranscript(agentId);
    if (!t.ok) continue;
    if (t.sessionId && t.sessionId !== sid) { sid = t.sessionId; seen = 0; }
    let done = false;
    if (t.records.length > seen) {
      const fresh = t.records.slice(seen);
      seen = t.records.length;
      for (const raw of fresh) {
        try {
          const norm = sessionsService.normalizeMessage('claude', raw, viewSid);
          if (Array.isArray(norm)) for (const m of norm) ws.send(m);
        } catch {
          // exotic record — skip
        }
        if (raw?.type === 'assistant') {
          const sr = raw.message?.stop_reason;
          if (sr && sr !== 'tool_use') done = true;
        }
      }
    }
    if (done) break;

    // Parked on an interactive ask -> surface as a permission_request (rendered by
    // the existing AskUserQuestion panel) and return WITHOUT completing.
    const ask = await discoveryPendingAsk(agentId);
    if (ask) {
      ws.send(createNormalizedMessage({
        kind: 'permission_request',
        requestId: `chask:${agentId}:${ask.request_id}`,
        toolName: 'AskUserQuestion',
        input: { questions: ask.questions },
        sessionId: viewSid,
        provider: 'claude',
      }));
      return;
    }
  }
  // Turn ended (or timed out) — safe to complete now.
  ws.send(createNormalizedMessage({ kind: 'complete', exitCode: 0, sessionId: viewSid, provider: 'claude' }));
}

// Route an operator's answer to a channel-ask back to the daemon (which pushes it
// down the agent's SSE to unblock the `ask` tool), then resume streaming the
// agent's continuation so the GUI shows what happens next. requestId is the
// namespaced id `chask:<agentId>:<request_id>`; decision is the GUI permission
// decision ({ allow, updatedInput: { answers } }). `ws` lets us stream the resume.
export async function answerAgentChannel(requestId, decision = {}, ws = null) {
  if (typeof requestId !== 'string' || !requestId.startsWith('chask:')) return;
  // chask:<agentId>:<request_id> — both parts are UUIDs (no embedded colons).
  const parts = requestId.split(':');
  if (parts.length !== 3) return;
  const agentId = parts[1];
  const reqId = parts[2];
  // A denied/skipped decision still resolves the ask, just with no selection.
  const updatedInput = decision && typeof decision === 'object' ? decision.updatedInput : null;
  const answers =
    updatedInput && typeof updatedInput === 'object' && updatedInput.answers && typeof updatedInput.answers === 'object'
      ? updatedInput.answers
      : {};

  // Resolve the GUI session id (to stamp the resumed stream) + transcript baseline.
  let agent = getAgentById(agentId);
  if (!agent) { await listAgents({ force: true }); agent = getAgentById(agentId); }
  const viewSid = agent?.session_id || '';

  let seen = 0;
  let sid = viewSid;
  if (ws) {
    const base = await discoveryTranscript(agentId);
    if (base.ok) { seen = base.records.length; sid = base.sessionId || viewSid; }
  }

  try {
    await discoveryAnswer(agentId, reqId, answers);
  } catch {
    // best-effort; the plugin times out the ask if no answer arrives
    return;
  }

  // Stream the continuation (and any follow-up ask), ending with `complete`.
  if (ws && viewSid) {
    await tailAndSurface(agentId, viewSid, seen, sid, ws);
  }
}

// True if a requestId belongs to the channel-ask flow (vs the local SDK runner).
export function isAgentAskRequestId(requestId) {
  return typeof requestId === 'string' && requestId.startsWith('chask:');
}
