/**
 * Bridge Client (CCR v2 consumer)
 *
 * Lets claudecodeui act as a *driver* of Claude Code "Remote Control" agents —
 * the same role claude.ai/code plays. An agent launched with `claude remote-control`
 * registers an Environment with Anthropic's bridge; this module lists those
 * environments, creates/binds sessions to them, subscribes to the session's
 * event WebSocket, and relays the streamed Claude Agent SDK messages into the
 * EXACT same `normalizeMessage -> ws.send` path the local SDK path uses
 * (claude-sdk.js). The chat UI therefore renders bridge sessions — text,
 * thinking, tool activity/progress, permission prompts, stop — with no new
 * rendering code.
 *
 * Driver-side auth is the user's own claude.ai OAuth token (no USER_TYPE=ant
 * override needed here — that is only required when *launching* the worker).
 *
 * Endpoints (all against api.anthropic.com):
 *   GET  /v1/environments                         beta: environments-2025-11-01
 *   GET  /v1/sessions
 *   POST /v1/sessions                             beta: ccr-byoc-2025-07-29   (bind to environment_id)
 *   POST /v1/sessions/{id}/events                 beta: ccr-byoc-2025-07-29   (send a user message)
 *   WS   /v1/sessions/ws/{id}/subscribe?organization_uuid=...                 (stream + control frames)
 */

import { readFileSync } from 'fs';
import os from 'os';
import crypto from 'crypto';
import WebSocket from 'ws';
import { sessionsService } from '../modules/providers/services/sessions.service.js';
import { createNormalizedMessage } from '../shared/utils.js';

const BASE = process.env.BRIDGE_BASE_URL || 'https://api.anthropic.com';
const WS_BASE = BASE.replace(/^http/, 'ws');
const ANTHROPIC_VERSION = '2023-06-01';
const BETA_ENVIRONMENTS = 'environments-2025-11-01';
const BETA_CCR = 'ccr-byoc-2025-07-29';

// sessionId -> { upstream: WebSocket, ws: clientWriter, environmentId }
const activeBridgeSessions = new Map();
// requestId -> { sessionId } so a permission answer can be routed to the right upstream
const pendingBridgePermissions = new Map();

/** Read the user's claude.ai OAuth token + org uuid (env override wins). */
export function getBridgeAuth() {
  const token =
    process.env.BRIDGE_OAUTH_TOKEN ||
    (() => {
      try {
        return JSON.parse(readFileSync(`${os.homedir()}/.claude/.credentials.json`, 'utf8'))
          .claudeAiOauth?.accessToken;
      } catch { return undefined; }
    })();
  const orgUuid =
    process.env.BRIDGE_ORG_UUID ||
    (() => {
      try {
        return JSON.parse(readFileSync(`${os.homedir()}/.claude.json`, 'utf8'))
          .oauthAccount?.organizationUuid;
      } catch { return undefined; }
    })();
  return { token, orgUuid };
}

function headers({ beta, org } = {}) {
  const { token, orgUuid } = getBridgeAuth();
  const h = { Authorization: `Bearer ${token}`, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' };
  if (beta) h['anthropic-beta'] = beta;
  if (org) h['x-organization-uuid'] = orgUuid;
  return h;
}

/** True when a usable OAuth token + org are present. */
export function isBridgeConfigured() {
  const { token, orgUuid } = getBridgeAuth();
  return Boolean(token && orgUuid);
}

/** List the user's bridge environments (the connected machines/agents). */
export async function listEnvironments() {
  const r = await fetch(`${BASE}/v1/environments`, { headers: headers({ beta: BETA_ENVIRONMENTS }) });
  if (!r.ok) throw new Error(`listEnvironments ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return (j.data || j.environments || []).map((e) => ({
    id: e.id,
    name: e.name,
    state: e.state,
    machineName: e.config?.machine_name,
    directory: e.config?.directory,
    branch: e.config?.branch,
    workerType: e.metadata?.worker_type,
    createdAt: e.created_at,
  }));
}

/** List remote sessions (optionally filtered to one environment). */
export async function listSessions(environmentId) {
  const r = await fetch(`${BASE}/v1/sessions`, { headers: headers() });
  if (!r.ok) throw new Error(`listSessions ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  let rows = (j.data || []).filter((s) => s.environment_kind === 'bridge');
  if (environmentId) rows = rows.filter((s) => s.environment_id === environmentId);
  return rows.map((s) => ({
    id: s.id,
    environmentId: s.environment_id,
    connectionStatus: s.connection_status,
    title: s.title || '',
    summary: s.post_turn_summary?.description || s.external_metadata?.post_turn_summary?.status_detail || '',
    createdAt: s.created_at,
    lastEventAt: s.last_event_at,
  }));
}

/** Create a session bound to a specific environment. Returns the session id. */
export async function createSession(environmentId, title = 'claudecodeui session') {
  const r = await fetch(`${BASE}/v1/sessions`, {
    method: 'POST',
    headers: headers({ beta: BETA_CCR, org: true }),
    body: JSON.stringify({
      title,
      events: [],
      session_context: { sources: [], outcomes: [] },
      environment_id: environmentId,
      source: 'remote-control',
    }),
  });
  if (!r.ok) throw new Error(`createSession ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const id = j.id || j.session?.id;
  if (!id) throw new Error('createSession: no id in response');
  return id;
}

/** POST a user message (string or content blocks) to a remote session. */
export async function sendMessage(sessionId, content) {
  const event = {
    uuid: crypto.randomUUID(),
    session_id: sessionId,
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content },
  };
  const r = await fetch(`${BASE}/v1/sessions/${sessionId}/events`, {
    method: 'POST',
    headers: headers({ beta: BETA_CCR, org: true }),
    body: JSON.stringify({ events: [event] }),
  });
  return r.ok;
}

/**
 * Subscribe to a remote session and relay its stream into the client writer
 * (`ws`, the same object claude-sdk.js writes to). Idempotent per sessionId.
 * Returns once the upstream WS is open (streaming continues in the background).
 */
export async function attachSession(sessionId, ws, environmentId) {
  if (activeBridgeSessions.has(sessionId)) return activeBridgeSessions.get(sessionId);
  const { token, orgUuid } = getBridgeAuth();
  const url = `${WS_BASE}/v1/sessions/ws/${sessionId}/subscribe?organization_uuid=${orgUuid}`;
  const upstream = new WebSocket(url, {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-version': ANTHROPIC_VERSION },
  });
  const entry = { upstream, ws, environmentId };
  activeBridgeSessions.set(sessionId, entry);

  if (ws.setSessionId && typeof ws.setSessionId === 'function') ws.setSessionId(sessionId);

  upstream.on('message', (data) => {
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }

    // Permission prompt — surfaced as a control_request{can_use_tool}.
    if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') {
      const requestId = m.request_id || crypto.randomUUID();
      pendingBridgePermissions.set(requestId, { sessionId });
      ws.send(createNormalizedMessage({
        kind: 'permission_request',
        requestId,
        toolName: m.request.tool_name,
        input: m.request.input,
        sessionId,
        provider: 'claude',
      }));
      return;
    }
    if (m.type === 'control_cancel_request') {
      pendingBridgePermissions.delete(m.request_id);
      ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId: m.request_id, sessionId, provider: 'claude' }));
      return;
    }
    if (m.type === 'control_response') return; // ack — nothing to render

    // Everything else is a Claude Agent SDK message — normalize like the local path.
    try {
      const normalized = sessionsService.normalizeMessage('claude', m, sessionId);
      for (const out of normalized) ws.send(out);
    } catch (err) {
      ws.send(createNormalizedMessage({ kind: 'error', content: `bridge normalize: ${err.message}`, sessionId, provider: 'claude' }));
    }
  });

  upstream.on('close', (code) => {
    activeBridgeSessions.delete(sessionId);
    // 4003 = unauthorized (permanent). Anything else: the worker/session ended.
    ws.send(createNormalizedMessage({ kind: 'complete', exitCode: code === 4003 ? 1 : 0, sessionId, provider: 'claude' }));
  });
  upstream.on('error', (err) => {
    ws.send(createNormalizedMessage({ kind: 'error', content: `bridge ws: ${err.message}`, sessionId, provider: 'claude' }));
  });

  await new Promise((resolve, reject) => {
    upstream.once('open', resolve);
    upstream.once('error', reject);
  });
  return entry;
}

/**
 * Start (or resume) a bridge chat turn: ensure subscribed, then send the message.
 * `options`: { sessionId?, environmentId, command, createTitle? }.
 * Returns { sessionId }.
 */
export async function queryBridgeSession({ ws, sessionId, environmentId, command, createTitle }) {
  let sid = sessionId;
  const isNew = !sid;
  if (isNew) {
    sid = await createSession(environmentId, createTitle || (typeof command === 'string' ? command.slice(0, 60) : 'session'));
    if (ws.setSessionId) ws.setSessionId(sid);
    ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: sid, sessionId: sid, provider: 'claude' }));
  }
  await attachSession(sid, ws, environmentId);
  if (command !== undefined && command !== null && command !== '') {
    const ok = await sendMessage(sid, command);
    if (!ok) ws.send(createNormalizedMessage({ kind: 'error', content: 'bridge: failed to send message', sessionId: sid, provider: 'claude' }));
  }
  return { sessionId: sid };
}

/** Answer a permission prompt: send a control_response upstream. */
export function resolveBridgePermission(requestId, decision) {
  const pending = pendingBridgePermissions.get(requestId);
  if (!pending) return false;
  pendingBridgePermissions.delete(requestId);
  const entry = activeBridgeSessions.get(pending.sessionId);
  if (!entry || entry.upstream.readyState !== WebSocket.OPEN) return false;
  const allow = decision?.allow ?? false;
  const response = {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: allow
        ? { behavior: 'allow', updatedInput: decision.updatedInput ?? {} }
        : { behavior: 'deny', message: decision.message ?? 'Denied' },
    },
  };
  entry.upstream.send(JSON.stringify(response));
  return true;
}

/** Stop the current turn: send an interrupt control_request upstream. */
export function abortBridgeSession(sessionId) {
  const entry = activeBridgeSessions.get(sessionId);
  if (!entry || entry.upstream.readyState !== WebSocket.OPEN) return false;
  entry.upstream.send(JSON.stringify({
    type: 'control_request',
    request_id: crypto.randomUUID(),
    request: { subtype: 'interrupt' },
  }));
  return true;
}

/** Detach (close the upstream subscription) without stopping the remote agent. */
export function detachSession(sessionId) {
  const entry = activeBridgeSessions.get(sessionId);
  if (!entry) return false;
  try { entry.upstream.close(); } catch { /* noop */ }
  activeBridgeSessions.delete(sessionId);
  return true;
}

export function isActiveBridgeSession(sessionId) {
  return activeBridgeSessions.has(sessionId);
}
