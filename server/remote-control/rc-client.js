/**
 * Remote-Control client — a PROXY to Anthropic's CCR v2 relay (their "bridge").
 *
 * This module lets claudecodeui act as a *driver* of `claude --remote-control`
 * agents, exactly the role the claude.ai/code website plays. It does NOT host any
 * relay of its own: it just talks to Anthropic's cloud over the operator's own
 * OAuth, lists the live agents, and (later) streams/sends to them. Pure middleman.
 *
 * "remote-control" is named after the CLI flag the agent is launched with, so the
 * naming says what it is — not "bridge" (that is Anthropic's word for THEIR relay).
 *
 * READ side (auth + asking the server for things):
 *   - getRemoteAuth / isRemoteControlConfigured  — operator OAuth + org uuid
 *   - listAgents()                               — the `--remote-control` fleet (online+offline)
 *   - getSessionEvents()                         — a session's full history
 *
 * DRIVE side (talking to a running agent):
 *   - attachSession()       — open the subscribe WS, relay+normalize the stream
 *   - sendMessage()         — POST a user message to the agent's session
 *   - driveRemoteSession()  — attach + announce + send (one chat turn)
 *   - resolveRemotePermission() / abortRemoteSession() — control frames up the WS
 *   - detachSession() / isActiveRemoteSession()
 *
 * Anthropic endpoints used here (all against api.anthropic.com):
 *   GET  /v1/code/sessions                 the connected interactive agent sessions
 *   GET  /v1/sessions/{id}/events          a session's event history (paginated)
 *   POST /v1/sessions/{id}/events          send a user message to a session
 *   WS   /v1/sessions/ws/{id}/subscribe    stream the session + send control frames
 */

import { readFileSync } from 'fs';
import os from 'os';
import crypto from 'crypto';

import WebSocket from 'ws';

import { createNormalizedMessage } from '@/shared/utils.js';

const BASE = process.env.RC_BASE_URL || 'https://api.anthropic.com';
const WS_BASE = BASE.replace(/^http/, 'ws');
const ANTHROPIC_VERSION = '2023-06-01';
// Anthropic's beta tag for the remote-control session/event API.
const BETA_CCR = 'ccr-byoc-2025-07-29';

// sessionId -> { upstream: WebSocket, ws: clientWriter }
const activeRemoteSessions = new Map();
// requestId -> { sessionId } so a permission answer routes to the right upstream WS.
const pendingRemotePermissions = new Map();

/**
 * Read the operator's claude.ai OAuth token + org uuid. These are the SAME
 * credentials the claude.ai/code website uses to prove it may drive your agents.
 * Env overrides win so a deployment can inject them without the dotfiles.
 *   RC_OAUTH_TOKEN  overrides ~/.claude/.credentials.json → claudeAiOauth.accessToken
 *   RC_ORG_UUID     overrides ~/.claude.json            → oauthAccount.organizationUuid
 */
export function getRemoteAuth() {
  const token =
    process.env.RC_OAUTH_TOKEN ||
    (() => {
      try {
        return JSON.parse(readFileSync(`${os.homedir()}/.claude/.credentials.json`, 'utf8'))
          .claudeAiOauth?.accessToken;
      } catch {
        return undefined;
      }
    })();
  const orgUuid =
    process.env.RC_ORG_UUID ||
    (() => {
      try {
        return JSON.parse(readFileSync(`${os.homedir()}/.claude.json`, 'utf8'))
          .oauthAccount?.organizationUuid;
      } catch {
        return undefined;
      }
    })();
  return { token, orgUuid };
}

/** Build request headers for the Anthropic API. */
function headers({ beta, org } = {}) {
  const { token, orgUuid } = getRemoteAuth();
  const h = {
    Authorization: `Bearer ${token}`,
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
  };
  if (beta) h['anthropic-beta'] = beta;
  if (org) h['x-organization-uuid'] = orgUuid;
  return h;
}

/** True when a usable OAuth token + org uuid are present (else the proxy is off). */
export function isRemoteControlConfigured() {
  const { token, orgUuid } = getRemoteAuth();
  return Boolean(token && orgUuid);
}

/**
 * Ask Anthropic for ALL of the operator's agent sessions — every session the bridge
 * knows about (1:1 with the claude.ai "Recents" list). Includes connected agents
 * (driveable now), idle/disconnected ones (history-viewable, drive on reconnect),
 * and environment/cloud sessions. `connected` carries the honest online/offline
 * state the Recents view doesn't surface; `isEnvironment` flags cloud/env sessions.
 *
 * Nothing is hard-filtered here — which agents a deployment actually surfaces is
 * decided solely by the capture policy (RC_AGENT_ALLOW/DENY) in rc.service, whose
 * default (unset, or `*`) is show-all.
 */
export async function listAgents({ pageSize = 200, maxPages = 8 } = {}) {
  // /v1/code/sessions is paginated (default 20, ordered most-recent-first) with a
  // `cursor`/`next_cursor` scheme. Reading only page 1 hid every agent that wasn't
  // recently active (e.g. an idle but connected agent), which is why one had to be
  // "talked to" to surface. Page through so the WHOLE fleet is returned.
  const rows = [];
  let cursor = null;
  for (let i = 0; i < maxPages; i++) {
    const url = `${BASE}/v1/code/sessions?limit=${pageSize}`
      + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const r = await fetch(url, { headers: headers() });
    if (!r.ok) {
      if (i === 0) throw new Error(`listAgents ${r.status}: ${(await r.text()).slice(0, 200)}`);
      break; // partial fetch — return what we have rather than failing the list
    }
    const j = await r.json();
    const batch = j.data || [];
    rows.push(...batch);
    cursor = j.next_cursor;
    if (!cursor || batch.length === 0) break;
  }
  return rows.map((s) => ({
    id: s.id,
    title: (s.title || '').split('\n')[0].trim(),
    connected: s.connection_status === 'connected',
    isEnvironment: Boolean(s.environment_id),
    // Recency — the same signal the claude.ai "Recents" view orders by.
    lastEventAt: s.last_event_at || s.created_at || '',
    createdAt: s.created_at,
  }));
}

/**
 * Fetch a session's full event history (raw SDK transcript records). Same record
 * shape as a local JSONL transcript ({type, message, uuid, …}) so the caller can
 * normalize them with the standard normalizeMessage path. Returns [] on error.
 *
 * The events API returns a page at a time (oldest-first) with has_more + last_id;
 * we page forward via after_id so the GUI gets the WHOLE conversation, not page 1.
 */
export async function getSessionEvents(sessionId, { maxPages = 60 } = {}) {
  const all = [];
  let after = null;
  for (let i = 0; i < maxPages; i++) {
    const url = `${BASE}/v1/sessions/${sessionId}/events?limit=100`
      + (after ? `&after_id=${encodeURIComponent(after)}` : '');
    const r = await fetch(url, { headers: headers({ beta: BETA_CCR, org: true }) });
    if (!r.ok) break;
    const j = await r.json();
    const batch = Array.isArray(j.data) ? j.data : [];
    all.push(...batch);
    if (!j.has_more || !batch.length || !j.last_id) break;
    after = j.last_id;
  }
  return all;
}

// ───────────────────────────── DRIVE SIDE ──────────────────────────────────

/**
 * POST a user message (string or content blocks) to a remote session. The agent's
 * reply streams back over the attach WS (opened by attachSession), not this call.
 */
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
 * Subscribe to a remote session and relay its stream into the client writer `ws`
 * (the same writer the local SDK path writes to, so the GUI renders with no new
 * code). `normalize(rawFrame, sessionId) -> normalizedMessage[]` is injected by the
 * caller so this engine stays provider-agnostic and free of cross-module coupling.
 * Idempotent per sessionId. Resolves once the upstream WS is open; the streaming
 * continues in the background.
 */
export async function attachSession(sessionId, ws, normalize) {
  if (activeRemoteSessions.has(sessionId)) return activeRemoteSessions.get(sessionId);
  const { token, orgUuid } = getRemoteAuth();
  const url = `${WS_BASE}/v1/sessions/ws/${sessionId}/subscribe?organization_uuid=${orgUuid}`;
  const upstream = new WebSocket(url, {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-version': ANTHROPIC_VERSION },
  });
  const entry = { upstream, ws };
  activeRemoteSessions.set(sessionId, entry);

  if (typeof ws.setSessionId === 'function') ws.setSessionId(sessionId);

  upstream.on('message', (data) => {
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }

    // Permission prompt — the agent wants to use a tool; relay to the GUI's
    // existing permission UI. `rc:` prefixes the id so the answer routes back here.
    if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') {
      const rawId = m.request_id || crypto.randomUUID();
      pendingRemotePermissions.set(rawId, { sessionId });
      ws.send(createNormalizedMessage({
        kind: 'permission_request',
        requestId: `rc:${rawId}`,
        toolName: m.request.tool_name,
        input: m.request.input,
        sessionId,
        provider: 'claude',
      }));
      return;
    }
    // The agent withdrew a prompt (e.g. it timed out) — dismiss it in the GUI.
    if (m.type === 'control_cancel_request') {
      pendingRemotePermissions.delete(m.request_id);
      ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId: m.request_id, sessionId, provider: 'claude' }));
      return;
    }
    if (m.type === 'control_response') return; // ack frame — nothing to render

    // Everything else is a Claude Agent SDK message — normalize via the injected
    // provider normalizer (kept out of this engine so it stays provider-agnostic).
    if (normalize) {
      try {
        const normalized = normalize(m, sessionId) || [];
        for (const out of normalized) ws.send(out);
      } catch (err) {
        ws.send(createNormalizedMessage({ kind: 'error', content: `rc normalize: ${err.message}`, sessionId, provider: 'claude' }));
      }
    }
    // End-of-TURN: a `result` SDK message means the agent finished this turn. The
    // WS stays open across turns, so translate it into a per-turn `complete` so the
    // GUI finalizes streaming and clears the "working" state (the session lives on).
    if (m.type === 'result') {
      ws.send(createNormalizedMessage({ kind: 'complete', exitCode: 0, sessionId, provider: 'claude' }));
    }
  });

  upstream.on('close', (code) => {
    activeRemoteSessions.delete(sessionId);
    // 4003 = unauthorized (permanent). Anything else: the worker/session ended.
    ws.send(createNormalizedMessage({ kind: 'complete', exitCode: code === 4003 ? 1 : 0, sessionId, provider: 'claude' }));
  });
  upstream.on('error', (err) => {
    ws.send(createNormalizedMessage({ kind: 'error', content: `rc ws: ${err.message}`, sessionId, provider: 'claude' }));
  });

  await new Promise((resolve, reject) => {
    upstream.once('open', resolve);
    upstream.once('error', reject);
  });
  return entry;
}

// A file is "text-like" (embed its decoded content as a text block) by mime or extension.
const TEXT_MIMES = new Set([
  'application/json', 'application/xml', 'application/javascript', 'application/typescript',
  'application/x-yaml', 'application/x-sh', 'application/x-httpd-php', 'application/sql',
]);
const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg',
  'conf', 'env', 'log', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java',
  'c', 'cpp', 'cc', 'h', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'sql', 'html', 'htm', 'css',
  'scss', 'less', 'vue', 'svelte', 'svg', 'dockerfile', 'gitignore', 'lua', 'r', 'kt', 'swift',
]);
function isTextLike(mime, name) {
  if (mime && mime.startsWith('text/')) return true;
  if (TEXT_MIMES.has(mime)) return true;
  const ext = (name.split('.').pop() || '').toLowerCase();
  return TEXT_EXTS.has(ext);
}

/**
 * Build the user-message content for the /events API. With no attachments this is the
 * plain prompt string; with attachments it becomes an array of content blocks. Each
 * attachment (upload-images shape: { name, mimeType, data: 'data:<mime>;base64,<b64>' })
 * is encoded by type so files attached in the composer reach the live agent:
 *   image/*          -> image block (base64)
 *   application/pdf  -> document block (base64)
 *   text/code        -> text block with the decoded file content
 *   anything else    -> a short note (binary/arbitrary upload not supported yet — that
 *                       needs claude.ai's session-gated /api/<org>/upload + file_attachments,
 *                       which the OAuth bridge can't reach. Deferred.)
 */
function toUserContent(text, attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  const prompt = typeof text === 'string' ? text : '';
  const blocks = [];
  for (const att of list) {
    const m = /^data:([^;]+);base64,(.+)$/.exec(att?.data || '');
    if (!m) continue;
    const mime = m[1];
    const b64 = m[2];
    const name = att?.name || 'file';
    if (mime.startsWith('image/')) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mime, data: b64 } });
    } else if (mime === 'application/pdf') {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 }, title: name });
    } else if (isTextLike(mime, name)) {
      let decoded = '';
      try { decoded = Buffer.from(b64, 'base64').toString('utf8'); } catch { decoded = ''; }
      blocks.push({ type: 'text', text: `Attached file: ${name}\n\n\`\`\`\n${decoded}\n\`\`\`` });
    } else {
      blocks.push({ type: 'text', text: `[Attached file "${name}" (${mime || 'unknown type'}) — binary/arbitrary files aren't supported yet.]` });
    }
  }
  if (blocks.length === 0) return prompt;
  return [...(prompt ? [{ type: 'text', text: prompt }] : []), ...blocks];
}

/**
 * Drive one chat turn against a CONNECTED agent session (cse_/session_): ensure
 * subscribed, bind the GUI's view to the session id, then send the message. We
 * attach to the agent's EXISTING session — never create one — so the message lands
 * in the agent's real session + terminal. `images` (optional, upload-images shape)
 * are folded into the message as content blocks. `normalize` is forwarded to
 * attachSession. Returns { sessionId }.
 */
export async function driveRemoteSession({ ws, sessionId, command, images, normalize }) {
  if (typeof ws.setSessionId === 'function') ws.setSessionId(sessionId);
  // Announce the session id so the GUI binds its view to it (it opened the agent
  // leaf with no session id yet).
  ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: sessionId, sessionId, provider: 'claude' }));
  await attachSession(sessionId, ws, normalize);
  const content = toUserContent(command, images);
  const hasContent = typeof content === 'string' ? content !== '' : content.length > 0;
  if (hasContent) {
    const ok = await sendMessage(sessionId, content);
    if (!ok) ws.send(createNormalizedMessage({ kind: 'error', content: 'rc: failed to send message', sessionId, provider: 'claude' }));
  }
  return { sessionId };
}

/** Answer a permission prompt: send a control_response up the WS. requestId may carry the `rc:` prefix. */
export function resolveRemotePermission(requestId, decision) {
  const rawId = requestId.startsWith('rc:') ? requestId.slice('rc:'.length) : requestId;
  const pending = pendingRemotePermissions.get(rawId);
  if (!pending) return false;
  pendingRemotePermissions.delete(rawId);
  const entry = activeRemoteSessions.get(pending.sessionId);
  if (!entry || entry.upstream.readyState !== WebSocket.OPEN) return false;
  const allow = decision?.allow ?? false;
  entry.upstream.send(JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: rawId,
      response: allow
        ? { behavior: 'allow', updatedInput: decision.updatedInput ?? {} }
        : { behavior: 'deny', message: decision.message ?? 'Denied' },
    },
  }));
  return true;
}

/** Stop the current turn: send an interrupt control_request up the WS. */
export function abortRemoteSession(sessionId) {
  const entry = activeRemoteSessions.get(sessionId);
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
  const entry = activeRemoteSessions.get(sessionId);
  if (!entry) return false;
  try { entry.upstream.close(); } catch { /* noop */ }
  activeRemoteSessions.delete(sessionId);
  return true;
}

export function isActiveRemoteSession(sessionId) {
  return activeRemoteSessions.has(sessionId);
}
