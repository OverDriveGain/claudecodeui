// oc-client.js — live-attach engine for OpenCode agents (sibling of rc-client.js).
//
// Where rc-client proxies Anthropic's cloud relay, this engine attaches to each
// agent's own `opencode serve` HTTP server (stock binary — nothing added to the
// tenant or to opencode). One registered server = one agent; sessions live on
// that server. The MyMu session id encodes the routing: `ocs_<agent>_<ses_…>`.
//
// Discovery is registration-only (same philosophy as launching claude with
// --remote-control): the spawn launcher starts `opencode serve --port N
// --hostname 127.0.0.1` and drops a JSON registration file into OC_REGISTRY_DIR
// (default ~/.cloudcli/opencode-agents). A server that was never registered —
// or an opencode started without `serve` — is simply not attachable.
//
//   <name>.json  { "name": "...", "port": 4600, "host": "127.0.0.1",
//                  "cwd": "/home/tenant/work", "user": "tenant" }
//
// Robustness mirrors rc-client where the failure modes exist here too: SSE
// reconnect with backoff, history top-up after a gap, per-session replay
// buffer, multi-writer fan-out. Offline history is the MyMu-side event cache
// (~/.cache/ccui-oc-events): every attached session's rows are persisted on
// change, so a dead agent still shows its transcript.

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import http from 'http';
import crypto from 'crypto';
import { createNormalizedMessage } from '../shared/utils.js';
import { mappedForeignUsers, cloudcliRegistryForUserSync } from '@/modules/mymu/index.js';

const OC_PREFIX = 'ocs_';
const REGISTRY_DIR = () =>
  process.env.OC_REGISTRY_DIR || path.join(os.homedir(), '.cloudcli', 'opencode-agents');
const CACHE_DIR = () =>
  process.env.OC_EVENTS_CACHE_DIR || path.join(os.homedir(), '.cache', 'ccui-oc-events');

const OC_HTTP_TIMEOUT_MS = 4000;
const OC_RECONNECT_BASE_MS = 1000;
const OC_RECONNECT_CAP_MS = 30 * 1000;
const OC_CACHE_FLUSH_MS = 2000;
const REPLAY_BUFFER_MAX = 500;
const WS_OPEN_RAW = 1;

// ── id scheme ────────────────────────────────────────────────────────────────

export function isOcSessionId(id) {
  return typeof id === 'string' && id.startsWith(OC_PREFIX);
}

/** `ocs_<agent>_<ses_…>` → { agent, ses } (null if malformed). */
export function parseOcId(id) {
  if (!isOcSessionId(id)) return null;
  const idx = id.indexOf('_ses_');
  if (idx < 0) return null;
  return { agent: id.slice(OC_PREFIX.length, idx), ses: id.slice(idx + 1) };
}

export function makeOcId(agentName, ses) {
  return `${OC_PREFIX}${agentName}_${ses}`;
}

// ── registry ─────────────────────────────────────────────────────────────────

/** Normalize one registration object into a roster-ready reg (null if invalid). */
function rawToOcReg(raw, fallbackName) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || fallbackName || '').trim();
  const port = Number.parseInt(raw.port, 10);
  if (!name || !Number.isFinite(port)) return null;
  return {
    name,
    port,
    host: typeof raw.host === 'string' && raw.host ? raw.host : '127.0.0.1',
    cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
    user: typeof raw.user === 'string' ? raw.user : null,
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : null,
  };
}

// listRegistrations() is called on every registration() lookup, and the
// cross-user scan below spawns one `sudo python3` per mapped foreign user — so
// the merged result is cached briefly to avoid a sudo storm. TTL is short enough
// that a newly spawned agent still surfaces promptly.
const REG_CACHE_MS = 3000;
let ocRegCache = { at: 0, regs: [] };

/**
 * Every opencode registration reachable from this instance: the service user's
 * own ~/.cloudcli/opencode-agents PLUS each mapped foreign user's (the
 * one-MyMu-per-host model — same cross-user fs seam local-sessions uses).
 * Malformed/foreign files are skipped; the service user wins a name collision.
 */
export function listRegistrations() {
  const now = Date.now();
  if (now - ocRegCache.at < REG_CACHE_MS) return ocRegCache.regs;

  const byName = new Map();

  // Service user's own registry (honors OC_REGISTRY_DIR override).
  const dir = REGISTRY_DIR();
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { names = []; }
  for (const f of names) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const reg = rawToOcReg(raw, path.basename(f, '.json'));
      if (reg) byName.set(reg.name, reg);
    } catch { /* skip unreadable/foreign file */ }
  }

  // Mapped foreign linux users' ~/.cloudcli/opencode-agents (cross-user, sudo).
  try {
    for (const user of mappedForeignUsers()) {
      for (const raw of cloudcliRegistryForUserSync(user, 'opencode-agents')) {
        const reg = rawToOcReg(raw);
        if (reg && !byName.has(reg.name)) byName.set(reg.name, reg);
      }
    }
  } catch { /* cross-user scan is best-effort */ }

  ocRegCache = { at: now, regs: [...byName.values()] };
  return ocRegCache.regs;
}

function registration(agentName) {
  return listRegistrations().find((r) => r.name === agentName) || null;
}

export function isOcConfigured() {
  return listRegistrations().length > 0;
}

// ── plain HTTP client (localhost, keep it dependency-free) ───────────────────

function ocRequest(reg, method, pathname, body, { timeout = OC_HTTP_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: reg.host, port: reg.port, method, path: pathname,
        headers: {
          accept: 'application/json',
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            reject(new Error(`opencode ${method} ${pathname} → ${res.statusCode}: ${text.slice(0, 300)}`));
            return;
          }
          if (!text) { resolve(null); return; }
          try { resolve(JSON.parse(text)); } catch { resolve(text); }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`opencode ${method} ${pathname} timed out`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── roster ───────────────────────────────────────────────────────────────────

const rosterErrors = new Map(); // agentName -> message (last probe failure)

export function getOcAccountErrors() {
  return [...rosterErrors.entries()].map(([label, message]) => ({ label: `opencode:${label}`, status: 0, message }));
}

/**
 * One roster row per registered agent (server), shaped like rc-client's
 * listAgents rows so rc.service can merge them untouched. The leaf session is
 * the most recently updated ROOT session on that server; offline servers fall
 * back to the newest cached session so history stays reachable.
 */
export async function listOcAgents() {
  const regs = listRegistrations();
  const rows = [];
  for (const reg of regs) {
    try {
      const [sessions, statuses] = await Promise.all([
        ocRequest(reg, 'GET', '/session'),
        ocRequest(reg, 'GET', '/session/status').catch(() => ({})),
      ]);
      rosterErrors.delete(reg.name);
      const roots = (Array.isArray(sessions) ? sessions : []).filter((s) => s && s.id && !s.parentID);
      roots.sort((a, b) => Number(b?.time?.updated ?? 0) - Number(a?.time?.updated ?? 0));
      const leaf = roots[0] || null;
      const running = Boolean(
        leaf && statuses && typeof statuses === 'object'
        && statuses[leaf.id] && statuses[leaf.id].type && statuses[leaf.id].type !== 'idle',
      );
      rows.push({
        id: leaf ? makeOcId(reg.name, leaf.id) : makeOcId(reg.name, 'ses_none'),
        title: reg.name,
        connected: Boolean(leaf),
        active: Boolean(leaf),
        running,
        repo: reg.cwd || (leaf ? leaf.directory : null) || null,
        lastEventAt: leaf?.time?.updated ? new Date(Number(leaf.time.updated)).toISOString() : reg.startedAt || undefined,
        createdAt: leaf?.time?.created ? new Date(Number(leaf.time.created)).toISOString() : undefined,
        account: undefined,
        provider: 'opencode',
      });
    } catch (err) {
      rosterErrors.set(reg.name, err?.message || String(err));
      const cachedSes = newestCachedSession(reg.name);
      rows.push({
        id: cachedSes ? makeOcId(reg.name, cachedSes) : makeOcId(reg.name, 'ses_none'),
        title: reg.name,
        connected: false,
        active: false,
        running: false,
        repo: reg.cwd,
        lastEventAt: reg.startedAt || undefined,
        provider: 'opencode',
      });
    }
  }
  return rows;
}

export async function getOcSessionCwd(sessionId) {
  const parsed = parseOcId(sessionId);
  if (!parsed) return null;
  const reg = registration(parsed.agent);
  if (!reg) return null;
  if (reg.cwd) return reg.cwd;
  try {
    const s = await ocRequest(reg, 'GET', `/session/${encodeURIComponent(parsed.ses)}`);
    return (s && typeof s.directory === 'string' && s.directory) || null;
  } catch { return null; }
}

// ── history rows + MyMu-side cache ──────────────────────────────────────────
//
// Rows are the raw API shape [{info, parts}] from GET /session/:id/message.
// The cache file IS the offline history: written whenever the live server is
// read or a stream event dirties the session.

function cacheFile(agentName, ses) {
  return path.join(CACHE_DIR(), `${agentName}__${ses}.json`);
}

function newestCachedSession(agentName) {
  try {
    const files = fs.readdirSync(CACHE_DIR()).filter((f) => f.startsWith(`${agentName}__ses_`));
    if (files.length === 0) return null;
    files.sort((a, b) => fs.statSync(path.join(CACHE_DIR(), b)).mtimeMs - fs.statSync(path.join(CACHE_DIR(), a)).mtimeMs);
    return files[0].slice(`${agentName}__`.length, -'.json'.length);
  } catch { return null; }
}

async function saveRows(agentName, ses, rows) {
  try {
    await fsp.mkdir(CACHE_DIR(), { recursive: true });
    const tmp = cacheFile(agentName, ses) + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(rows));
    await fsp.rename(tmp, cacheFile(agentName, ses));
  } catch { /* cache is best-effort */ }
}

async function loadRows(agentName, ses) {
  try { return JSON.parse(await fsp.readFile(cacheFile(agentName, ses), 'utf8')); } catch { return []; }
}

/**
 * Full message rows for a session — live from the agent's server when
 * reachable (refreshing the disk cache), else the last cached copy.
 */
export async function getOcSessionRows(sessionId) {
  const parsed = parseOcId(sessionId);
  if (!parsed) return [];
  const reg = registration(parsed.agent);
  if (reg) {
    try {
      const rows = await ocRequest(reg, 'GET', `/session/${encodeURIComponent(parsed.ses)}/message`);
      if (Array.isArray(rows)) {
        void saveRows(parsed.agent, parsed.ses, rows);
        return rows;
      }
    } catch { /* offline → cache below */ }
  }
  return loadRows(parsed.agent, parsed.ses);
}

// ── live sessions: writers, replay, SSE upstream ─────────────────────────────

// sessionId(ocs_…) -> entry { writers:Set, replayBuffer:[], normalize, turnOpen,
//                             partTypes:Map(partID->{type,role}), dirtyTimer }
const activeOcSessions = new Map();
// agentName -> { req, alive, retries, sessions:Set<ocsId> }
const ocUpstreams = new Map();
// requestId(raw permID) -> { sessionId } for permission answers
const pendingOcPermissions = new Map();
const answeredOcPermissions = new Map();
const ANSWERED_TTL_MS = 10 * 60 * 1000;

function liveWriters(entry) {
  if (!entry) return [];
  if (!entry.writers) entry.writers = new Set();
  for (const w of entry.writers) {
    const raw = w && w.ws;
    if (raw && typeof raw.readyState === 'number' && raw.readyState !== WS_OPEN_RAW) entry.writers.delete(w);
  }
  return [...entry.writers];
}

function fanOut(entry, frame) {
  for (const w of liveWriters(entry)) {
    try { w.send(frame); } catch { /* pruned next emit */ }
  }
}

function pushReplayFrame(entry, frame) {
  if (!entry.replayBuffer) entry.replayBuffer = [];
  entry.replayBuffer.push(frame);
  if (entry.replayBuffer.length > REPLAY_BUFFER_MAX) entry.replayBuffer.shift();
}

function emitFrame(entry, frame) {
  pushReplayFrame(entry, frame);
  fanOut(entry, frame);
}

function sessionEntry(sessionId, { create = false } = {}) {
  let entry = activeOcSessions.get(sessionId);
  if (!entry && create) {
    entry = { writers: new Set(), replayBuffer: [], normalize: null, turnOpen: false, partTypes: new Map(), dirtyTimer: null };
    activeOcSessions.set(sessionId, entry);
  }
  return entry;
}

/** Debounced cache refresh after stream activity, so offline history is warm. */
function markDirty(sessionId) {
  const entry = activeOcSessions.get(sessionId);
  const parsed = parseOcId(sessionId);
  if (!entry || !parsed) return;
  if (entry.dirtyTimer) return;
  entry.dirtyTimer = setTimeout(() => {
    entry.dirtyTimer = null;
    void getOcSessionRows(sessionId); // fetch-and-save
  }, OC_CACHE_FLUSH_MS);
}

// ── SSE upstream (one per agent server, shared by its sessions) ──────────────

function ensureUpstream(agentName) {
  const existing = ocUpstreams.get(agentName);
  if (existing && existing.alive) return;
  const reg = registration(agentName);
  if (!reg) return;
  const state = existing || { req: null, alive: false, retries: 0, sessions: new Set() };
  ocUpstreams.set(agentName, state);

  const req = http.request(
    { host: reg.host, port: reg.port, method: 'GET', path: '/event', headers: { accept: 'text/event-stream' } },
    (res) => {
      if (res.statusCode !== 200) { res.resume(); scheduleReconnect(agentName, state); return; }
      state.alive = true;
      state.retries = 0;
      // A (re)connected stream may have missed events — refresh every watched
      // session's cache and top up watchers from history rows.
      for (const sid of state.sessions) markDirty(sid);
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
          if (!data) continue;
          try { handleOcEvent(agentName, JSON.parse(data)); } catch { /* non-JSON keepalive */ }
        }
      });
      res.on('end', () => { state.alive = false; scheduleReconnect(agentName, state); });
      res.on('error', () => { state.alive = false; scheduleReconnect(agentName, state); });
    },
  );
  req.on('error', () => { state.alive = false; scheduleReconnect(agentName, state); });
  state.req = req;
  req.end();
}

function scheduleReconnect(agentName, state) {
  if (state.reconnectTimer) return;
  if (state.sessions.size === 0) return; // nobody watching — reopen lazily on next attach
  const delay = Math.min(OC_RECONNECT_CAP_MS, OC_RECONNECT_BASE_MS * 2 ** Math.min(state.retries, 8));
  state.retries += 1;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    ensureUpstream(agentName);
  }, delay);
}

// ── event translation ────────────────────────────────────────────────────────

const PROVIDER = 'opencode';

function frameIdFor(messageID, partID) {
  return `${messageID}_${partID}`;
}

/** Translate one SSE event from an agent's server into GUI frames. */
function handleOcEvent(agentName, ev) {
  const type = ev?.type;
  const props = ev?.properties || {};
  const ses = props.sessionID || props.part?.sessionID || props.info?.sessionID;
  if (!type || !ses) return;
  const sessionId = makeOcId(agentName, ses);
  const entry = activeOcSessions.get(sessionId);
  if (!entry) return; // nobody subscribed to this session

  if (type === 'message.part.delta') {
    const known = entry.partTypes.get(props.partID) || {};
    if (props.field !== 'text') return;
    const kind = known.type === 'reasoning' ? 'thinking' : 'stream_delta';
    // User echo parts never stream deltas; assistant text/thinking do.
    fanOut(entry, createNormalizedMessage({
      id: frameIdFor(props.messageID, props.partID),
      sessionId, provider: PROVIDER, kind, content: props.delta || '',
    }));
    entry.turnOpen = true;
    return;
  }

  if (type === 'message.part.updated') {
    const part = props.part || {};
    entry.partTypes.set(part.id, { type: part.type, role: entry.roleByMessage?.get(part.messageID) });
    markDirty(sessionId);
    const frames = entry.normalize ? entry.normalize({ info: entry.lastInfoByMessage?.get(part.messageID), part }, sessionId) : [];
    for (const frame of frames) emitFrame(entry, frame);
    entry.turnOpen = true;
    return;
  }

  if (type === 'message.updated') {
    const info = props.info || {};
    if (!entry.roleByMessage) entry.roleByMessage = new Map();
    if (!entry.lastInfoByMessage) entry.lastInfoByMessage = new Map();
    entry.roleByMessage.set(info.id, info.role);
    entry.lastInfoByMessage.set(info.id, info);
    markDirty(sessionId);
    if (info.role === 'assistant' && info.error) {
      emitFrame(entry, createNormalizedMessage({
        kind: 'error', sessionId, provider: PROVIDER,
        content: typeof info.error === 'string' ? info.error : (info.error?.data?.message || info.error?.name || 'OpenCode error'),
      }));
    }
    return;
  }

  if (type === 'session.status') {
    const busy = Boolean(props.status && props.status.type && props.status.type !== 'idle');
    fanOut(entry, { type: 'session-status', sessionId, isProcessing: busy });
    if (busy) entry.turnOpen = true;
    return;
  }

  if (type === 'session.idle') {
    entry.turnOpen = false;
    markDirty(sessionId);
    // Clear the buffer BEFORE emitting so `complete` lands in the fresh buffer
    // (same rationale as rc-client: a rebinding client must learn the turn ended).
    entry.replayBuffer = [];
    emitFrame(entry, createNormalizedMessage({ kind: 'complete', exitCode: 0, sessionId, provider: PROVIDER }));
    return;
  }

  if (type === 'session.error') {
    const err = props.error;
    entry.turnOpen = false;
    emitFrame(entry, createNormalizedMessage({
      kind: 'error', sessionId, provider: PROVIDER,
      content: (err && (err.data?.message || err.name)) || 'OpenCode session error',
    }));
    emitFrame(entry, createNormalizedMessage({ kind: 'complete', exitCode: 1, sessionId, provider: PROVIDER }));
    return;
  }

  if (type === 'permission.asked') {
    // v1 and v2 events share the essentials: an id, a session, tool metadata.
    const rawId = props.id || crypto.randomUUID();
    pendingOcPermissions.set(rawId, { sessionId });
    emitFrame(entry, createNormalizedMessage({
      kind: 'permission_request',
      requestId: `oc:${rawId}`,
      toolName: props.tool?.name || props.permission || props.type || 'tool',
      input: props.metadata || {},
      sessionId, provider: PROVIDER,
    }));
    return;
  }

  if (type === 'permission.replied') {
    const rawId = props.requestID || props.id;
    if (rawId && pendingOcPermissions.has(rawId)) {
      pendingOcPermissions.delete(rawId);
      answeredOcPermissions.set(rawId, Date.now());
      fanOut(entry, createNormalizedMessage({ kind: 'permission_cancelled', requestId: `oc:${rawId}`, sessionId, provider: PROVIDER }));
    }
  }
}

// ── public engine surface (mirrors rc-client) ────────────────────────────────

/**
 * Attach the GUI writer to a session's live stream (idempotent per session,
 * additive per writer) and replay the current turn's buffered frames.
 */
export async function attachOcSession(sessionId, ws, normalize) {
  const parsed = parseOcId(sessionId);
  if (!parsed) throw new Error(`not an opencode session id: ${sessionId}`);
  const entry = sessionEntry(sessionId, { create: true });
  if (normalize) entry.normalize = normalize;
  if (ws) {
    // Dedup by UNDERLYING connection, not wrapper identity: every chat run
    // wraps the same browser socket in a fresh writer object, so identity
    // dedup accumulates one writer per message sent and each SSE delta fans
    // out N times to the same socket (the "AppApprecireciateate" bug).
    for (const w of entry.writers) {
      if (w.ws && ws.ws && w.ws === ws.ws) entry.writers.delete(w);
    }
    entry.writers.add(ws);
  }
  const state = ocUpstreams.get(parsed.agent);
  if (state) state.sessions.add(sessionId); else ocUpstreams.set(parsed.agent, { req: null, alive: false, retries: 0, sessions: new Set([sessionId]) });
  ensureUpstream(parsed.agent);
  // Replay the buffered frames of the open turn to just this writer.
  if (ws && entry.replayBuffer) {
    for (const frame of entry.replayBuffer) {
      try { ws.send(frame); } catch { break; }
    }
  }
}

/**
 * Re-surface a permission asked before the GUI attached (the SSE stream does
 * not replay). Pulls the server's open-permission list.
 */
export async function emitOutstandingOcPermission(sessionId, ws) {
  const parsed = parseOcId(sessionId);
  if (!parsed || !ws) return;
  const reg = registration(parsed.agent);
  if (!reg) return;
  let pending = [];
  try { pending = await ocRequest(reg, 'GET', '/permission'); } catch { return; }
  for (const p of Array.isArray(pending) ? pending : []) {
    if (!p || p.sessionID !== parsed.ses || !p.id) continue;
    if (answeredOcPermissions.has(p.id)) continue;
    pendingOcPermissions.set(p.id, { sessionId });
    ws.send(createNormalizedMessage({
      kind: 'permission_request',
      requestId: `oc:${p.id}`,
      toolName: p.tool?.name || p.permission || 'tool',
      input: p.metadata || {},
      sessionId, provider: PROVIDER,
    }));
  }
}

// ── slash commands ───────────────────────────────────────────────────────────
//
// Typed `/name args` in the GUI. Session-management builtins are handled here
// (opencode has no in-place /clear — a "new" session is a real new session on
// the server; the agent's roster leaf rotates to it). Everything else is
// resolved against the server's registered command list (GET /command) and
// executed via POST /session/:id/command — its output streams over SSE like a
// normal turn.

function infoFrame(sessionId, text) {
  return createNormalizedMessage({ kind: 'text', role: 'assistant', content: text, sessionId, provider: PROVIDER });
}

function completeFrame(sessionId, exitCode = 0) {
  return createNormalizedMessage({ kind: 'complete', exitCode, sessionId, provider: PROVIDER });
}

async function handleOcSlashCommand({ ws, sessionId, parsed, reg, name, args }) {
  const say = (text, exitCode = 0) => {
    if (!ws) return;
    ws.send(infoFrame(sessionId, text));
    ws.send(completeFrame(sessionId, exitCode));
  };

  if (name === 'new' || name === 'clear') {
    try {
      const created = await ocRequest(reg, 'POST', '/session', { title: reg.name });
      const newId = created && created.id ? makeOcId(reg.name, created.id) : null;
      say(newId
        ? 'Started a fresh session for this agent. Reopen the agent from the sidebar to continue in the new session (this view stays on the old conversation).'
        : 'Session created, but the server returned no id.');
    } catch (err) {
      say(`Couldn't start a new session: ${err.message}`, 1);
    }
    return;
  }

  if (name === 'compact' || name === 'summarize') {
    try {
      // Long-running LLM work — don't hold the send; progress streams over SSE
      // and session.idle emits the turn's `complete`.
      void ocRequest(reg, 'POST', `/session/${encodeURIComponent(parsed.ses)}/summarize`, {}, { timeout: 10 * 60 * 1000 })
        .catch((err) => {
          const entry = activeOcSessions.get(sessionId);
          if (entry) emitFrame(entry, createNormalizedMessage({ kind: 'error', content: `compact failed: ${err.message}`, sessionId, provider: PROVIDER }));
          if (entry) emitFrame(entry, completeFrame(sessionId, 1));
        });
      const entry = sessionEntry(sessionId, { create: true });
      entry.turnOpen = true;
      if (ws) ws.send(infoFrame(sessionId, 'Compacting the session…'));
    } catch (err) {
      say(`Couldn't compact: ${err.message}`, 1);
    }
    return;
  }

  if (name === 'abort' || name === 'stop') {
    abortOcSession(sessionId);
    say('Abort sent.');
    return;
  }

  // Registered commands (project/global opencode commands, MCP prompts, skills).
  let commands = [];
  try { commands = await ocRequest(reg, 'GET', '/command'); } catch { commands = []; }
  const list = Array.isArray(commands) ? commands : [];

  if (name === 'help' || name === 'commands') {
    const builtin = '/new (alias /clear) — fresh session · /compact — summarize context · /abort — interrupt';
    const registered = list.map((c) => `/${c.name}${c.description ? ` — ${c.description}` : ''}`).join('\n');
    say(`Available commands:\n${builtin}${registered ? `\n${registered}` : ''}`);
    return;
  }

  const match = list.find((c) => c && c.name === name);
  if (!match) {
    const known = list.map((c) => `/${c.name}`).join(' ');
    say(`Unknown opencode command /${name}. Built-ins: /new /clear /compact /abort /help.${known ? ` Registered: ${known}` : ''}`, 1);
    return;
  }

  // Real command run = a full LLM turn; fire it and let SSE stream the output
  // (session.idle ends the turn). Failures surface on the live stream.
  void ocRequest(reg, 'POST', `/session/${encodeURIComponent(parsed.ses)}/command`,
    { command: name, ...(args ? { arguments: args } : {}) },
    { timeout: 10 * 60 * 1000 })
    .catch((err) => {
      const entry = activeOcSessions.get(sessionId);
      if (entry) {
        emitFrame(entry, createNormalizedMessage({ kind: 'error', content: `/${name} failed: ${err.message}`, sessionId, provider: PROVIDER }));
        emitFrame(entry, completeFrame(sessionId, 1));
      }
    });
  const entry = sessionEntry(sessionId, { create: true });
  entry.turnOpen = true;
}

/** Send one user turn to the agent's own queue (fire-and-forget on the server). */
export async function driveOcSession({ ws, sessionId, command, normalize }) {
  const parsed = parseOcId(sessionId);
  if (!parsed) throw new Error(`not an opencode session id: ${sessionId}`);
  const reg = registration(parsed.agent);
  const fail = (reason) => {
    if (!ws) return;
    ws.send(createNormalizedMessage({ kind: 'error', content: reason, sessionId, provider: PROVIDER }));
    ws.send(createNormalizedMessage({ kind: 'complete', exitCode: 1, sessionId, provider: PROVIDER }));
  };
  if (!reg) { fail(`Agent "${parsed.agent}" is not registered on this host.`); return; }
  // Bind the stream FIRST so the turn's frames land on this writer.
  await attachOcSession(sessionId, ws, normalize);
  if (ws) ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: sessionId, sessionId, provider: PROVIDER }));
  // Slash command? (/new, /clear, /compact, /abort, /help, or a registered command)
  const slash = /^\/([A-Za-z0-9:_-]+)[ \t]*([\s\S]*)$/.exec((command || '').trim());
  if (slash) {
    await handleOcSlashCommand({
      ws, sessionId, parsed, reg,
      name: slash[1].toLowerCase(),
      args: slash[2].trim(),
    });
    return;
  }
  try {
    await ocRequest(reg, 'POST', `/session/${encodeURIComponent(parsed.ses)}/prompt_async`, {
      parts: [{ type: 'text', text: command || '' }],
    });
    const entry = sessionEntry(sessionId, { create: true });
    entry.turnOpen = true;
  } catch (err) {
    fail(`Message not delivered to opencode agent "${parsed.agent}": ${err.message}`);
  }
}

/** Answer a permission prompt. Returns false when the id isn't an oc prompt. */
export function resolveOcPermission(requestId, decision) {
  if (typeof requestId !== 'string' || !requestId.startsWith('oc:')) return false;
  const rawId = requestId.slice(3);
  const pending = pendingOcPermissions.get(rawId);
  if (!pending) return true; // ours but expired — swallow, don't fall through
  pendingOcPermissions.delete(rawId);
  answeredOcPermissions.set(rawId, Date.now());
  for (const [id, at] of answeredOcPermissions) {
    if (Date.now() - at > ANSWERED_TTL_MS) answeredOcPermissions.delete(id);
  }
  const parsed = parseOcId(pending.sessionId);
  const reg = parsed && registration(parsed.agent);
  if (!reg) return true;
  const response = decision?.allow ? (decision?.rememberEntry ? 'always' : 'once') : 'reject';
  void ocRequest(reg, 'POST', `/session/${encodeURIComponent(parsed.ses)}/permissions/${encodeURIComponent(rawId)}`, { response })
    .catch((err) => console.warn('[oc] permission reply failed', { requestId, error: err.message }));
  return true;
}

/** Interrupt the running turn. Returns true if the abort was dispatched. */
export function abortOcSession(sessionId) {
  const parsed = parseOcId(sessionId);
  const reg = parsed && registration(parsed.agent);
  if (!reg) return false;
  void ocRequest(reg, 'POST', `/session/${encodeURIComponent(parsed.ses)}/abort`, {})
    .catch((err) => console.warn('[oc] abort failed', { sessionId, error: err.message }));
  return true;
}

export function isActiveOcSession(sessionId) {
  return activeOcSessions.has(sessionId);
}
