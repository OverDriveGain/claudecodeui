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

import { lookupBySession, listAgents, discoveryCall, discoveryTranscript } from './services/agent-discovery.service.js';
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

  // Tail transcript until the assistant turn ends or we time out.
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await sleep(700);
    const t = await discoveryTranscript(agentId);
    if (!t.ok) continue;
    if (t.sessionId && t.sessionId !== sid) { sid = t.sessionId; seen = 0; }
    if (t.records.length <= seen) continue;
    const fresh = t.records.slice(seen);
    seen = t.records.length;
    let done = false;
    for (const raw of fresh) {
      try {
        // Stamp with viewSid (the GUI session), not the transcript's internal
        // session id, so the reply renders in the active conversation live.
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
    if (done) break;
  }

  ws.send(createNormalizedMessage({ kind: 'complete', exitCode: 0, sessionId: viewSid, provider: 'claude' }));
}
