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
function headers({ beta, org, client } = {}) {
  const { token, orgUuid } = getRemoteAuth();
  const h = {
    Authorization: `Bearer ${token}`,
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
  };
  if (beta) h['anthropic-beta'] = beta;
  if (org) h['x-organization-uuid'] = orgUuid;
  // Present as the claude.ai/code web client — required for the code-sessions
  // queue path to behave the same way (native queue instead of interrupt).
  if (client) {
    h['anthropic-client-platform'] = 'web_claude_ai';
    h['anthropic-client-feature'] = 'ccr';
  }
  return h;
}

/** cse_/session_ ids share a suffix; build the form each API surface expects. */
function toCseId(sessionId) {
  return sessionId.startsWith('session_') ? `cse_${sessionId.slice('session_'.length)}` : sessionId;
}
function toSessionId(sessionId) {
  return sessionId.startsWith('cse_') ? `session_${sessionId.slice('cse_'.length)}` : sessionId;
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
    // Stable agent identity across restarts: the git repo the session works on.
    // The title is derived per-session from its launch/first-prompt and drifts
    // (e.g. "environment" vs "/environment"), so grouping must key on this.
    repo: (Array.isArray(s.config?.outcomes)
      ? s.config.outcomes.find((o) => o?.git_info?.repo)?.git_info?.repo
      : null) || null,
    // Recency — the same signal the claude.ai "Recents" view orders by.
    lastEventAt: s.last_event_at || s.created_at || '',
    createdAt: s.created_at,
  }));
}

/**
 * Page a session's event history (raw SDK transcript records, oldest-first). Same
 * record shape as a local JSONL transcript ({type, message, uuid, …}) so the caller
 * can normalize them with the standard normalizeMessage path.
 *
 * The events API only pages forward (oldest→newest) via `after_id` — there is NO
 * reverse / descending option (verified against the relay). We page at limit=1000
 * (the relay accepts it; claude.ai uses 500) so even a multi-thousand-event agent
 * is fetched in a handful of round-trips instead of dozens. `maxPages` is a runaway
 * guard, not a real ceiling.
 *
 * `after` resumes from a cursor (the previous `last_id`) for incremental top-up.
 * Returns `{ events, lastId }` where `lastId` is the cursor to resume from next.
 */
export async function getSessionEvents(sessionId, { after = null, limit = 1000, maxPages = 1000 } = {}) {
  const all = [];
  let cursor = after;
  let lastId = after;
  for (let i = 0; i < maxPages; i++) {
    const url = `${BASE}/v1/sessions/${sessionId}/events?limit=${limit}`
      + (cursor ? `&after_id=${encodeURIComponent(cursor)}` : '');
    const r = await fetch(url, { headers: headers({ beta: BETA_CCR, org: true }) });
    if (!r.ok) break;
    const j = await r.json();
    const batch = Array.isArray(j.data) ? j.data : [];
    all.push(...batch);
    if (j.last_id) lastId = j.last_id;
    if (!j.has_more || !batch.length || !j.last_id) break;
    cursor = j.last_id;
  }
  return { events: all, lastId };
}

// sessionId -> { events: rawEvent[], lastId: cursor, fetchedAt: ms }. Turns the
// relay's forward-only, whole-history paging into a warm local transcript we can
// window (tail-first) and top-up cheaply — so opening an agent behaves like
// opening a local file, not a 5-second relay backfill on every open.
const sessionEventsCache = new Map();
const SESSION_EVENTS_CACHE_MAX = 40;

function evictSessionEventsCache() {
  while (sessionEventsCache.size > SESSION_EVENTS_CACHE_MAX) {
    let oldestKey = null;
    let oldest = Infinity;
    for (const [k, v] of sessionEventsCache) {
      if (v.fetchedAt < oldest) { oldest = v.fetchedAt; oldestKey = k; }
    }
    if (oldestKey === null) break;
    sessionEventsCache.delete(oldestKey);
  }
}

/**
 * Cached event history for a session. First call pays the full page-through;
 * later calls serve from cache and (when `topUp`) fetch only events created after
 * the last cursor — append-only transcripts make this safe. Returns the full
 * oldest-first raw event array; the caller windows/normalizes it.
 */
export async function getSessionEventsCached(sessionId, { topUp = true } = {}) {
  let entry = sessionEventsCache.get(sessionId);
  if (!entry) {
    const { events, lastId } = await getSessionEvents(sessionId, {});
    entry = { events, lastId, fetchedAt: Date.now() };
    sessionEventsCache.set(sessionId, entry);
    evictSessionEventsCache();
  } else if (topUp) {
    const { events: fresh, lastId } = await getSessionEvents(sessionId, { after: entry.lastId });
    if (fresh.length) {
      entry.events = entry.events.concat(fresh);
      if (lastId) entry.lastId = lastId;
    }
    entry.fetchedAt = Date.now();
  }
  return entry.events;
}

/** Drop a session's cached events (e.g. on detach or forced reload). */
export function invalidateSessionEventsCache(sessionId) {
  if (sessionId) sessionEventsCache.delete(sessionId);
  else sessionEventsCache.clear();
}

// ───────────────────────────── DRIVE SIDE ──────────────────────────────────

/**
 * POST a user message (string or content blocks) to a remote session. The agent's
 * reply streams back over the attach WS (opened by attachSession), not this call.
 */
export async function sendMessage(sessionId, content) {
  // Mirror claude.ai/code exactly: POST to the CODE-sessions namespace with a
  // `payload`-wrapped event. This routes the message through the agent's native
  // queue (it orders messages sent mid-turn) instead of interrupting the current
  // turn — which is what the plain /v1/sessions/<id>/events path did. URL uses the
  // cse_ id; the body's session_id uses the session_ form.
  const event = {
    payload: {
      type: 'user',
      uuid: crypto.randomUUID(),
      session_id: toSessionId(sessionId),
      parent_tool_use_id: null,
      message: { role: 'user', content },
    },
  };
  const url = `${BASE}/v1/code/sessions/${toCseId(sessionId)}/events`;
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: headers({ beta: BETA_CCR, org: true, client: true }),
      body: JSON.stringify({ events: [event] }),
    });
  } catch (err) {
    console.error('[rc] sendMessage fetch threw', { sessionId, url, error: err?.message });
    return false;
  }
  if (!r.ok) {
    let body = '';
    try { body = (await r.text()).slice(0, 300); } catch { /* ignore */ }
    console.error('[rc] sendMessage failed', { sessionId, url, status: r.status, body });
  }
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
  // Rebind to the LATEST GUI writer. The browser↔server WS reconnects on mobile
  // network blips, tab reloads, and SW updates — handing us a fresh writer while
  // the upstream relay subscription is still alive. Without rebinding, frames keep
  // streaming to the dead original writer and the chat silently stops updating
  // ("works at first, then nothing"). The handlers below read `entry.ws`, so this
  // single assignment redirects the live stream to the new connection.
  const existing = activeRemoteSessions.get(sessionId);
  if (existing) {
    existing.ws = ws;
    if (typeof ws.setSessionId === 'function') ws.setSessionId(sessionId);
    return existing;
  }
  const { token, orgUuid } = getRemoteAuth();
  const url = `${WS_BASE}/v1/sessions/ws/${sessionId}/subscribe?organization_uuid=${orgUuid}`;
  const upstream = new WebSocket(url, {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-version': ANTHROPIC_VERSION },
  });
  // `turnActive` gates the result->complete translation: the bridge replays the
  // previous turn's `result` when we subscribe, which would otherwise fire a
  // premature `complete` and clear the GUI's "working" state. We only treat a
  // `result` as end-of-turn once driveRemoteSession has actually sent this turn.
  const entry = { upstream, ws, turnActive: false };
  activeRemoteSessions.set(sessionId, entry);

  if (typeof ws.setSessionId === 'function') ws.setSessionId(sessionId);

  upstream.on('message', (data) => {
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    // Always write to the CURRENT writer (rebound on reconnect), never the one
    // captured when this upstream first opened.
    const out = activeRemoteSessions.get(sessionId)?.ws || ws;

    // Permission prompt — the agent wants to use a tool; relay to the GUI's
    // existing permission UI. `rc:` prefixes the id so the answer routes back here.
    if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') {
      const rawId = m.request_id || crypto.randomUUID();
      pendingRemotePermissions.set(rawId, { sessionId });
      out.send(createNormalizedMessage({
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
      out.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId: m.request_id, sessionId, provider: 'claude' }));
      return;
    }
    if (m.type === 'control_response') return; // ack frame — nothing to render

    // Everything else is a Claude Agent SDK message — normalize via the injected
    // provider normalizer (kept out of this engine so it stays provider-agnostic).
    if (normalize) {
      try {
        const normalized = normalize(m, sessionId) || [];
        for (const frame of normalized) out.send(frame);
      } catch (err) {
        out.send(createNormalizedMessage({ kind: 'error', content: `rc normalize: ${err.message}`, sessionId, provider: 'claude' }));
      }
    }
    // End-of-TURN: a `result` SDK message means the agent finished this turn. The
    // WS stays open across turns, so translate it into a per-turn `complete` so the
    // GUI finalizes streaming and clears the "working" state (the session lives on).
    // Ignore a `result` we didn't initiate (the bridge replays the last turn's
    // result on subscribe) so it can't prematurely clear the "working" indicator.
    if (m.type === 'result') {
      const e = activeRemoteSessions.get(sessionId);
      if (e && !e.turnActive) return;
      if (e) e.turnActive = false;
      out.send(createNormalizedMessage({ kind: 'complete', exitCode: 0, sessionId, provider: 'claude' }));
    }
  });

  upstream.on('close', (code) => {
    const out = activeRemoteSessions.get(sessionId)?.ws || ws;
    activeRemoteSessions.delete(sessionId);
    // 4003 = unauthorized (permanent). Anything else: the worker/session ended.
    out.send(createNormalizedMessage({ kind: 'complete', exitCode: code === 4003 ? 1 : 0, sessionId, provider: 'claude' }));
  });
  upstream.on('error', (err) => {
    const out = activeRemoteSessions.get(sessionId)?.ws || ws;
    out.send(createNormalizedMessage({ kind: 'error', content: `rc ws: ${err.message}`, sessionId, provider: 'claude' }));
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
    // Arm the end-of-turn detector now (after attach/replay, before send) so the
    // NEXT `result` is treated as this turn's completion — not a stale replayed one.
    const e = activeRemoteSessions.get(sessionId);
    if (e) e.turnActive = true;
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
