// fleet-channel.js — send bridge for live fleet agents (the cross-host twin of
// control-channel.js). When a `claude-command` targets a fleet-agent session,
// we inject the prompt into the live agent via the discovery /prompt endpoint,
// then tail its transcript over HTTP and feed each new record through ccui's own
// claude normalizer so the reply renders natively in the chat UI.
//
// Recognises fleet sessions via the registry in services/fleet.service.js.

import { lookupBySession, listAgents, discoveryCall, discoveryTranscript } from './services/fleet.service.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { createNormalizedMessage } from './shared/utils.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;

// Per-agent inject-block cache. When discovery refuses an injection (e.g. 409
// telegram-guarded / wake-on-demand), we remember the reason briefly and
// short-circuit further sends with the same message — instead of hammering the
// discovery /prompt endpoint with guaranteed-to-fail re-injects on every retry
// or reconnect.
const BLOCK_TTL_MS = 60000;
const blocked = new Map(); // agentName -> { reason, until }

function blockReason(name) {
  const b = blocked.get(name);
  if (b && Date.now() < b.until) return b.reason;
  if (b) blocked.delete(name);
  return null;
}

export async function isFleetSession(sessionId) {
  if (!sessionId) return false;
  if (lookupBySession(sessionId)) return true;
  await listAgents(); // refresh registry, then re-check
  return Boolean(lookupBySession(sessionId));
}

export async function queryFleetChannel(command, options = {}, ws) {
  const sessionId = typeof options?.sessionId === 'string' ? options.sessionId : '';
  const agent = lookupBySession(sessionId);
  if (!agent) {
    ws.send(createNormalizedMessage({ kind: 'error', content: 'fleet agent for this session is no longer live', sessionId, provider: 'claude' }));
    ws.send(createNormalizedMessage({ kind: 'complete', exitCode: 1, sessionId, provider: 'claude' }));
    return;
  }
  const name = agent.agent;

  // If this agent recently refused injection, don't hit box again — replay the
  // cached reason. Prevents the retry/reconnect hammering seen with
  // telegram-guarded agents.
  const cachedReason = blockReason(name);
  if (cachedReason) {
    console.log(`[fleet] ${name} inject suppressed (cached block): ${cachedReason}`);
    ws.send(createNormalizedMessage({ kind: 'error', content: cachedReason, sessionId, provider: 'claude' }));
    ws.send(createNormalizedMessage({ kind: 'complete', exitCode: 1, sessionId, provider: 'claude' }));
    return;
  }

  // Baseline BEFORE injecting. The transcript endpoint ignores `since` and
  // returns the whole NDJSON transcript each call, so we tail by record COUNT:
  // remember how many records exist now, emit only records beyond that.
  const baseline = await discoveryTranscript(name);
  let seen = baseline.records.length;
  let sid = baseline.sessionId || sessionId;
  // Stamp ALL outbound messages with the GUI's session id, not the agent's
  // internal transcript session id — the frontend only re-renders messages
  // matching the active view, so a foreign sid leaves the reply invisible
  // until a refresh. `sid` stays internal (transcript tailing/indexing only).
  const viewSid = sessionId;
  const transcriptAvailable = baseline.ok;

  // 1. inject the prompt into the live agent.
  // force=true: for channel-bound (telegram) agents this bypasses the guard and
  // runs `claude --print --resume` — a real synchronous reply that lands in the
  // transcript we tail. It's a resume process, not the live in-memory one (can
  // drift from a busy live channel), but it delivers a genuine reply today.
  // (Proper live channel = plugin:control on box, a pending developer task.)
  // --print --resume is synchronous and can take up to ~120s, so the inject must
  // not time out early.
  // Forward any attachments (ccui's upload endpoint already hands us base64
  // data-URIs); discovery materialises them on the agent's host and feeds them
  // to claude as image content blocks. Shape: {name, mimeType, data}.
  const images = Array.isArray(options?.images)
    ? options.images
        .filter((im) => im && typeof im.data === 'string')
        .map((im) => ({ name: im.name, mimeType: im.mimeType, data: im.data }))
    : [];

  try {
    const body = { content: command, meta: { origin: 'claudecodeui' } };
    if (images.length) body.images = images;
    const { status, json } = await discoveryCall('POST', `/agents/${enc(name)}/prompt`, {
      query: { force: 'true' },
      body,
      timeoutMs: 125000,
    });
    console.log(`[fleet] inject ${name} (force${images.length ? `, ${images.length} img` : ''}) -> HTTP ${status}`);
    if (status < 200 || status >= 300) {
      const reason = json?.error || json?.detail || `inject failed (HTTP ${status})`;
      // Remember the refusal so repeated sends don't re-hammer discovery.
      if (status === 409) blocked.set(name, { reason, until: Date.now() + BLOCK_TTL_MS });
      ws.send(createNormalizedMessage({ kind: 'error', content: reason, sessionId: viewSid, provider: 'claude' }));
      ws.send(createNormalizedMessage({ kind: 'complete', exitCode: 1, sessionId: viewSid, provider: 'claude' }));
      return;
    }
  } catch (e) {
    ws.send(createNormalizedMessage({ kind: 'error', content: `agent unreachable: ${e?.message || e}`, sessionId: viewSid, provider: 'claude' }));
    ws.send(createNormalizedMessage({ kind: 'complete', exitCode: 1, sessionId: viewSid, provider: 'claude' }));
    return;
  }

  // Without the transcript endpoint we can't stream the reply — say so plainly
  // instead of hanging until the deadline. The prompt WAS delivered.
  if (!transcriptAvailable) {
    ws.send(createNormalizedMessage({
      kind: 'status',
      content: `Prompt delivered to ${name}. Live reply streaming needs the discovery transcript endpoint (not available yet).`,
      sessionId: viewSid,
      provider: 'claude',
    }));
    ws.send(createNormalizedMessage({ kind: 'complete', exitCode: 0, sessionId: viewSid, provider: 'claude' }));
    return;
  }

  // 2. tail the transcript until the assistant turn ends (or we time out)
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await sleep(700);
    const t = await discoveryTranscript(name);
    if (!t.ok) continue;
    if (t.sessionId && t.sessionId !== sid) { sid = t.sessionId; seen = 0; } // respawn
    if (t.records.length <= seen) continue;
    const fresh = t.records.slice(seen);
    seen = t.records.length;
    let done = false;
    for (const raw of fresh) {
      try {
        const norm = sessionsService.normalizeMessage('claude', raw, viewSid);
        if (Array.isArray(norm)) for (const m of norm) ws.send(m);
      } catch {
        // exotic record — skip, keep streaming
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
