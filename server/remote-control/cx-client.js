// cx-client.js — live-attach engine for Codex agents (sibling of oc-client.js).
//
// Where oc-client attaches to `opencode serve` HTTP servers, this engine
// attaches to each agent's own `codex app-server --listen ws://127.0.0.1:PORT`
// (stock binary — nothing added to the tenant or to codex). The protocol is
// JSON-RPC 2.0 over a websocket, schema-documented by the binary itself
// (`codex app-server generate-json-schema`). One registered server = one
// agent; threads live on that server. The MyMu session id encodes the
// routing: `cxs_<agent>_<threadId>` (thread ids are UUIDs — no underscores —
// so the LAST underscore always splits agent from thread).
//
// Discovery is registration-only (same philosophy as the other engines): the
// spawn launcher starts the app-server and drops a JSON registration file
// into CX_REGISTRY_DIR (default ~/.cloudcli/codex-agents). A codex that was
// never registered — or started without app-server — is simply not attachable.
//
//   <name>.json  { "name": "...", "port": 4700, "host": "127.0.0.1",
//                  "cwd": "/home/tenant/work", "user": "tenant" }
//
// Robustness mirrors oc-client where the failure modes exist here too: ws
// reconnect with backoff, per-session replay buffer, multi-writer fan-out,
// debounced history refresh. Offline history is the MyMu-side item cache
// (~/.cache/ccui-cx-events): every attached thread's items are persisted on
// change, so a dead agent still shows its transcript.
//
// One deliberate divergence: approvals are server→client JSON-RPC REQUESTS
// (not fire-and-forget events like opencode's permission.asked), so a pending
// approval blocks the agent's turn until THIS process answers the rpc id.

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { WebSocket } from 'ws';
import { createNormalizedMessage } from '../shared/utils.js';

const CX_PREFIX = 'cxs_';
const REGISTRY_DIR = () =>
  process.env.CX_REGISTRY_DIR || path.join(os.homedir(), '.cloudcli', 'codex-agents');
const CACHE_DIR = () =>
  process.env.CX_EVENTS_CACHE_DIR || path.join(os.homedir(), '.cache', 'ccui-cx-events');

const CX_RPC_TIMEOUT_MS = 8000;
const CX_CONNECT_TIMEOUT_MS = 4000;
const CX_RECONNECT_BASE_MS = 1000;
const CX_RECONNECT_CAP_MS = 30 * 1000;
const CX_CACHE_FLUSH_MS = 2000;
const REPLAY_BUFFER_MAX = 500;
const WS_OPEN_RAW = 1;
const PROVIDER = 'codex';

// ── id scheme ────────────────────────────────────────────────────────────────

export function isCxSessionId(id) {
  return typeof id === 'string' && id.startsWith(CX_PREFIX);
}

/** `cxs_<agent>_<threadId>` → { agent, thread } (null if malformed). Thread ids
 *  are UUIDs (never contain `_`), so the last underscore is the separator even
 *  when the agent name itself contains underscores. */
export function parseCxId(id) {
  if (!isCxSessionId(id)) return null;
  const rest = id.slice(CX_PREFIX.length);
  const idx = rest.lastIndexOf('_');
  if (idx <= 0 || idx === rest.length - 1) return null;
  return { agent: rest.slice(0, idx), thread: rest.slice(idx + 1) };
}

export function makeCxId(agentName, threadId) {
  return `${CX_PREFIX}${agentName}_${threadId}`;
}

// ── registry ─────────────────────────────────────────────────────────────────

/** Read every registration file; malformed/foreign files are skipped. */
export function listCxRegistrations() {
  const dir = REGISTRY_DIR();
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const regs = [];
  for (const f of names) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const name = String(raw.name || path.basename(f, '.json')).trim();
      const port = Number.parseInt(raw.port, 10);
      if (!name || !Number.isFinite(port)) continue;
      regs.push({
        name,
        port,
        host: typeof raw.host === 'string' && raw.host ? raw.host : '127.0.0.1',
        cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
        user: typeof raw.user === 'string' ? raw.user : null,
        startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : null,
      });
    } catch { /* skip unreadable/foreign file */ }
  }
  return regs;
}

function registration(agentName) {
  return listCxRegistrations().find((r) => r.name === agentName) || null;
}

export function isCxConfigured() {
  return listCxRegistrations().length > 0;
}

// ── connection manager (one ws per agent, shared by its sessions) ────────────
//
// A connection is opened lazily on first use (roster probe, attach, drive),
// initialized with the required JSON-RPC handshake, and kept for the process
// lifetime while any session is watched. Roster probes use a short-lived
// connect timeout so a dead agent doesn't stall the agents list.

// agentName -> { ws, alive, initialized, nextId, pending:Map(id->{resolve,reject,timer}),
//                sessions:Set<cxsId>, retries, reconnectTimer, connectPromise,
//                loadedThreads:Set<threadId>, turnByThread:Map(threadId->turnId) }
const cxConns = new Map();
const rosterErrors = new Map(); // agentName -> message (last probe failure)

function connState(agentName) {
  let s = cxConns.get(agentName);
  if (!s) {
    s = {
      ws: null, alive: false, initialized: false, nextId: 1,
      pending: new Map(), sessions: new Set(), retries: 0,
      reconnectTimer: null, connectPromise: null,
      loadedThreads: new Set(), turnByThread: new Map(),
    };
    cxConns.set(agentName, s);
  }
  return s;
}

function failAllPending(state, reason) {
  for (const [, p] of state.pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
  state.pending.clear();
}

/** Open + initialize the agent's ws connection (idempotent, single-flight). */
function ensureConn(agentName) {
  const state = connState(agentName);
  if (state.alive && state.initialized) return Promise.resolve(state);
  if (state.connectPromise) return state.connectPromise;
  const reg = registration(agentName);
  if (!reg) return Promise.reject(new Error(`codex agent "${agentName}" is not registered on this host`));

  state.connectPromise = new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${reg.host}:${reg.port}`, { handshakeTimeout: CX_CONNECT_TIMEOUT_MS });
    let settled = false;
    const fail = (err) => {
      if (!settled) { settled = true; state.connectPromise = null; reject(err); }
    };
    ws.on('error', (err) => {
      state.alive = false;
      failAllPending(state, `codex agent "${agentName}" connection error: ${err.message}`);
      fail(err);
      scheduleReconnect(agentName, state);
    });
    ws.on('close', () => {
      state.alive = false;
      state.initialized = false;
      state.loadedThreads.clear();
      failAllPending(state, `codex agent "${agentName}" connection closed`);
      fail(new Error('connection closed'));
      scheduleReconnect(agentName, state);
    });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      handleCxMessage(agentName, state, msg);
    });
    ws.on('open', () => {
      state.ws = ws;
      state.alive = true;
      state.retries = 0;
      rawRpc(state, 'initialize', {
        clientInfo: { name: 'claudecodeui', title: 'Claude Code UI', version: '1.0.0' },
      }).then(() => {
        state.initialized = true;
        state.connectPromise = null;
        settled = true;
        // A (re)connected stream may have missed events — refresh every watched
        // session's cache so offline history stays warm.
        for (const sid of state.sessions) markDirty(sid);
        resolve(state);
      }).catch(fail);
    });
  });
  return state.connectPromise;
}

function scheduleReconnect(agentName, state) {
  if (state.reconnectTimer) return;
  if (state.sessions.size === 0) return; // nobody watching — reopen lazily on next use
  const delay = Math.min(CX_RECONNECT_CAP_MS, CX_RECONNECT_BASE_MS * 2 ** Math.min(state.retries, 8));
  state.retries += 1;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    ensureConn(agentName).catch(() => { /* retried by the next close/error */ });
  }, delay);
}

/** Fire one JSON-RPC request on an OPEN connection. */
function rawRpc(state, method, params, { timeout = CX_RPC_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (!state.ws || state.ws.readyState !== WS_OPEN_RAW) {
      reject(new Error(`codex ${method}: connection not open`));
      return;
    }
    const id = state.nextId++;
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error(`codex ${method} timed out`));
    }, timeout);
    state.pending.set(id, { resolve, reject, timer });
    try {
      state.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }));
    } catch (err) {
      clearTimeout(timer);
      state.pending.delete(id);
      reject(err);
    }
  });
}

/** Connect (if needed) and fire one JSON-RPC request. */
async function cxRpc(agentName, method, params, opts) {
  const state = await ensureConn(agentName);
  return rawRpc(state, method, params, opts);
}

// ── roster ───────────────────────────────────────────────────────────────────

export function getCxAccountErrors() {
  return [...rosterErrors.entries()].map(([label, message]) => ({ label: `codex:${label}`, status: 0, message }));
}

/**
 * One roster row per registered agent, shaped like rc-client's listAgents rows
 * so rc.service can merge them untouched. The leaf session is the most recently
 * updated thread on that server; offline servers fall back to the newest cached
 * thread so history stays reachable.
 */
export async function listCxAgents() {
  const regs = listCxRegistrations();
  const rows = [];
  for (const reg of regs) {
    try {
      const res = await cxRpc(reg.name, 'thread/list', {});
      rosterErrors.delete(reg.name);
      const threads = Array.isArray(res?.data) ? res.data : [];
      threads.sort((a, b) => Number(b?.recencyAt ?? b?.updatedAt ?? 0) - Number(a?.recencyAt ?? a?.updatedAt ?? 0));
      const leaf = threads[0] || null;
      const status = leaf?.status?.type;
      rows.push({
        id: leaf ? makeCxId(reg.name, leaf.id) : makeCxId(reg.name, 'none'),
        title: reg.name,
        connected: Boolean(leaf),
        active: Boolean(leaf),
        running: Boolean(status && status !== 'idle' && status !== 'notLoaded'),
        repo: reg.cwd || leaf?.cwd || null,
        lastEventAt: leaf?.recencyAt ? new Date(Number(leaf.recencyAt) * 1000).toISOString() : reg.startedAt || undefined,
        createdAt: leaf?.createdAt ? new Date(Number(leaf.createdAt) * 1000).toISOString() : undefined,
        account: undefined,
        provider: PROVIDER,
      });
    } catch (err) {
      rosterErrors.set(reg.name, err?.message || String(err));
      const cachedThread = newestCachedThread(reg.name);
      rows.push({
        id: cachedThread ? makeCxId(reg.name, cachedThread) : makeCxId(reg.name, 'none'),
        title: reg.name,
        connected: false,
        active: false,
        running: false,
        repo: reg.cwd,
        lastEventAt: reg.startedAt || undefined,
        provider: PROVIDER,
      });
    }
  }
  return rows;
}

export async function getCxSessionCwd(sessionId) {
  const parsed = parseCxId(sessionId);
  if (!parsed) return null;
  const reg = registration(parsed.agent);
  if (!reg) return null;
  if (reg.cwd) return reg.cwd;
  try {
    const res = await cxRpc(parsed.agent, 'thread/read', { threadId: parsed.thread });
    return (res?.thread && typeof res.thread.cwd === 'string' && res.thread.cwd) || null;
  } catch { return null; }
}

// ── history items + MyMu-side cache ──────────────────────────────────────────
//
// Rows are raw ThreadItem objects (the app-server's camelCase v2 shape),
// flattened turn-by-turn from `thread/read {includeTurns:true}`. The cache
// file IS the offline history: written whenever the live server is read or a
// stream event dirties the session.

function cacheFile(agentName, threadId) {
  return path.join(CACHE_DIR(), `${agentName}__${threadId}.json`);
}

function newestCachedThread(agentName) {
  try {
    const files = fs.readdirSync(CACHE_DIR()).filter((f) => f.startsWith(`${agentName}__`) && f.endsWith('.json'));
    if (files.length === 0) return null;
    files.sort((a, b) => fs.statSync(path.join(CACHE_DIR(), b)).mtimeMs - fs.statSync(path.join(CACHE_DIR(), a)).mtimeMs);
    return files[0].slice(`${agentName}__`.length, -'.json'.length);
  } catch { return null; }
}

async function saveItems(agentName, threadId, items) {
  try {
    await fsp.mkdir(CACHE_DIR(), { recursive: true });
    const tmp = cacheFile(agentName, threadId) + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(items));
    await fsp.rename(tmp, cacheFile(agentName, threadId));
  } catch { /* cache is best-effort */ }
}

async function loadItems(agentName, threadId) {
  try { return JSON.parse(await fsp.readFile(cacheFile(agentName, threadId), 'utf8')); } catch { return []; }
}

/**
 * Full ThreadItem rows for a session — live from the agent's server when
 * reachable (refreshing the disk cache), else the last cached copy.
 */
export async function getCxSessionRows(sessionId) {
  const parsed = parseCxId(sessionId);
  if (!parsed || parsed.thread === 'none') return [];
  const reg = registration(parsed.agent);
  if (reg) {
    try {
      const res = await cxRpc(parsed.agent, 'thread/read', { threadId: parsed.thread, includeTurns: true });
      const turns = Array.isArray(res?.thread?.turns) ? res.thread.turns : [];
      const items = [];
      for (const turn of turns) {
        for (const item of Array.isArray(turn?.items) ? turn.items : []) {
          if (item && typeof item === 'object') items.push(item);
        }
      }
      if (items.length > 0 || turns.length > 0) {
        void saveItems(parsed.agent, parsed.thread, items);
        return items;
      }
    } catch { /* offline → cache below */ }
  }
  return loadItems(parsed.agent, parsed.thread);
}

// ── item translation ─────────────────────────────────────────────────────────
//
// One ThreadItem → GUI frames. Used for BOTH history rows and live
// item/started|completed notifications, so a live agent and its reloaded
// transcript are visually indistinguishable.

function itemText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** Translate one ThreadItem into zero or more normalized frames. */
export function translateCxItem(item, sessionId) {
  if (!item || typeof item !== 'object') return [];
  const id = item.id || crypto.randomUUID();
  const base = { id, sessionId, provider: PROVIDER };
  switch (item.type) {
    case 'userMessage': {
      const text = itemText(item.content);
      if (!text.trim()) return [];
      return [createNormalizedMessage({ ...base, kind: 'text', role: 'user', content: text })];
    }
    case 'agentMessage': {
      const text = typeof item.text === 'string' ? item.text : '';
      if (!text.trim()) return [];
      return [createNormalizedMessage({ ...base, kind: 'text', role: 'assistant', content: text })];
    }
    case 'reasoning': {
      const text = itemText(item.summary) || itemText(item.content);
      if (!text.trim()) return [];
      return [createNormalizedMessage({ ...base, kind: 'thinking', content: text })];
    }
    case 'plan': {
      const text = typeof item.text === 'string' ? item.text : '';
      if (!text.trim()) return [];
      return [createNormalizedMessage({ ...base, kind: 'thinking', content: text })];
    }
    case 'commandExecution':
      return [createNormalizedMessage({
        ...base,
        kind: 'tool_use',
        toolName: 'Bash',
        toolInput: { command: item.command },
        toolId: id,
        output: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : undefined,
        exitCode: item.exitCode ?? undefined,
        status: item.status,
      })];
    case 'fileChange':
      return [createNormalizedMessage({
        ...base,
        kind: 'tool_use',
        toolName: 'FileChanges',
        toolInput: item.changes,
        toolId: id,
        status: item.status,
      })];
    case 'mcpToolCall':
      return [createNormalizedMessage({
        ...base,
        kind: 'tool_use',
        toolName: item.tool || 'MCP',
        toolInput: item.arguments,
        toolId: id,
        server: item.server,
        result: item.result,
        error: item.error,
        status: item.status,
      })];
    case 'dynamicToolCall':
      return [createNormalizedMessage({
        ...base,
        kind: 'tool_use',
        toolName: item.tool || 'Tool',
        toolInput: item.arguments,
        toolId: id,
        status: item.status,
      })];
    case 'webSearch':
      return [createNormalizedMessage({
        ...base,
        kind: 'tool_use',
        toolName: 'WebSearch',
        toolInput: { query: item.query },
        toolId: id,
      })];
    default:
      return []; // imageView/sleep/review-mode markers etc. — no GUI shape
  }
}

/** Normalize cached/live ThreadItem rows into GUI messages (history path). */
export function normalizeCxItems(rows, sessionId) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    out.push(...translateCxItem(row, sessionId));
  }
  return out;
}

// ── live sessions: writers, replay ───────────────────────────────────────────

// sessionId(cxs_…) -> entry { writers:Set, replayBuffer:[], turnOpen, dirtyTimer }
const activeCxSessions = new Map();
// requestKey `cx:<agent>:<rpcId>` -> { agent, rpcId, sessionId } for approval answers
const pendingCxApprovals = new Map();

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
  let entry = activeCxSessions.get(sessionId);
  if (!entry && create) {
    entry = { writers: new Set(), replayBuffer: [], turnOpen: false, dirtyTimer: null };
    activeCxSessions.set(sessionId, entry);
  }
  return entry;
}

/** Debounced cache refresh after stream activity, so offline history is warm. */
function markDirty(sessionId) {
  const entry = activeCxSessions.get(sessionId);
  const parsed = parseCxId(sessionId);
  if (!entry || !parsed) return;
  if (entry.dirtyTimer) return;
  entry.dirtyTimer = setTimeout(() => {
    entry.dirtyTimer = null;
    void getCxSessionRows(sessionId); // fetch-and-save
  }, CX_CACHE_FLUSH_MS);
}

// ── incoming message routing ─────────────────────────────────────────────────

function handleCxMessage(agentName, state, msg) {
  // Response to one of our requests.
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = state.pending.get(msg.id);
    if (p) {
      state.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`codex rpc error: ${JSON.stringify(msg.error).slice(0, 300)}`));
      else p.resolve(msg.result);
    }
    return;
  }
  // Server→client REQUEST (approvals) — must be answered on this rpc id.
  if (msg.id !== undefined && typeof msg.method === 'string') {
    handleCxServerRequest(agentName, state, msg);
    return;
  }
  // Notification.
  if (typeof msg.method === 'string') {
    handleCxNotification(agentName, state, msg.method, msg.params || {});
  }
}

function respond(state, id, result) {
  try { state.ws.send(JSON.stringify({ jsonrpc: '2.0', id, result })); } catch { /* conn died */ }
}

/** Approval request from the agent → GUI permission prompt. */
function handleCxServerRequest(agentName, state, msg) {
  const params = msg.params || {};
  const threadId = params.threadId;
  const sessionId = threadId ? makeCxId(agentName, threadId) : null;
  const entry = sessionId ? activeCxSessions.get(sessionId) : null;

  const approvalKinds = {
    'item/commandExecution/requestApproval': { toolName: 'Bash', input: { command: params.command } },
    'item/fileChange/requestApproval': { toolName: 'FileChanges', input: { changes: params.changes, reason: params.reason } },
    'item/permissions/requestApproval': { toolName: 'Permissions', input: params },
    'execCommandApproval': { toolName: 'Bash', input: { command: params.command } },
    'applyPatchApproval': { toolName: 'FileChanges', input: { changes: params.changes } },
  };
  const kind = approvalKinds[msg.method];
  if (!kind) {
    // Unknown server request — refuse politely so the turn doesn't hang forever.
    respond(state, msg.id, { decision: 'decline' });
    return;
  }
  if (!entry || liveWriters(entry).length === 0) {
    // Nobody is watching this session — declining is safer than auto-accepting.
    respond(state, msg.id, { decision: 'decline' });
    if (entry) {
      emitFrame(entry, createNormalizedMessage({
        kind: 'error', sessionId, provider: PROVIDER,
        content: `Declined a ${kind.toolName} approval because no client was attached.`,
      }));
    }
    return;
  }
  const requestKey = `cx:${agentName}:${msg.id}`;
  pendingCxApprovals.set(requestKey, { agent: agentName, rpcId: msg.id, sessionId });
  emitFrame(entry, createNormalizedMessage({
    kind: 'permission_request',
    requestId: requestKey,
    toolName: kind.toolName,
    input: kind.input || {},
    sessionId,
    provider: PROVIDER,
  }));
}

/** Translate one app-server notification into GUI frames. */
function handleCxNotification(agentName, state, method, params) {
  const threadId = params.threadId;
  if (!threadId) return;
  const sessionId = makeCxId(agentName, threadId);
  const entry = activeCxSessions.get(sessionId);
  if (!entry) {
    // Track the running turn id even for unwatched threads — an interrupt
    // needs it and the roster reads running state lazily.
    if (method === 'turn/started' && params.turn?.id) state.turnByThread.set(threadId, params.turn.id);
    if (method === 'turn/completed') state.turnByThread.delete(threadId);
    return;
  }

  if (method === 'item/agentMessage/delta') {
    fanOut(entry, createNormalizedMessage({
      id: params.itemId, sessionId, provider: PROVIDER,
      kind: 'stream_delta', content: params.delta || '',
    }));
    entry.turnOpen = true;
    return;
  }

  if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
    fanOut(entry, createNormalizedMessage({
      id: params.itemId, sessionId, provider: PROVIDER,
      kind: 'thinking', content: params.delta || '',
    }));
    entry.turnOpen = true;
    return;
  }

  if (method === 'item/started' || method === 'item/completed') {
    // item/started for streamed kinds arrives with empty text; the deltas fill
    // the bubble and item/completed re-emits the final shape (the GUI dedups on
    // the frame id). Non-streamed kinds (commands, file changes) render here.
    markDirty(sessionId);
    const frames = translateCxItem(params.item, sessionId);
    for (const frame of frames) emitFrame(entry, frame);
    entry.turnOpen = true;
    return;
  }

  if (method === 'turn/started') {
    if (params.turn?.id) state.turnByThread.set(threadId, params.turn.id);
    fanOut(entry, { type: 'session-status', sessionId, isProcessing: true });
    entry.turnOpen = true;
    return;
  }

  if (method === 'turn/completed') {
    state.turnByThread.delete(threadId);
    entry.turnOpen = false;
    markDirty(sessionId);
    const err = params.turn?.error;
    if (err) {
      emitFrame(entry, createNormalizedMessage({
        kind: 'error', sessionId, provider: PROVIDER,
        content: typeof err === 'string' ? err : (err?.message || 'Codex turn failed'),
      }));
    }
    // Clear the buffer BEFORE emitting so `complete` lands in the fresh buffer
    // (same rationale as oc-client: a rebinding client must learn the turn ended).
    entry.replayBuffer = [];
    emitFrame(entry, createNormalizedMessage({ kind: 'complete', exitCode: err ? 1 : 0, sessionId, provider: PROVIDER }));
    return;
  }

  if (method === 'thread/status/changed') {
    const busy = Boolean(params.status?.type && params.status.type !== 'idle' && params.status.type !== 'notLoaded');
    fanOut(entry, { type: 'session-status', sessionId, isProcessing: busy });
    if (busy) entry.turnOpen = true;
    return;
  }

  if (method === 'thread/error' || method === 'error') {
    entry.turnOpen = false;
    emitFrame(entry, createNormalizedMessage({
      kind: 'error', sessionId, provider: PROVIDER,
      content: params.message || params.error?.message || 'Codex session error',
    }));
    emitFrame(entry, createNormalizedMessage({ kind: 'complete', exitCode: 1, sessionId, provider: PROVIDER }));
  }
}

// ── thread loading ───────────────────────────────────────────────────────────

/** Make sure the thread is loaded server-side (resume is a no-op for a running
 *  thread — app-server rejoins it). Tracked per connection: a reconnect clears
 *  the set, so the next drive resumes again. */
async function ensureThreadLoaded(agentName, threadId) {
  const state = await ensureConn(agentName);
  if (state.loadedThreads.has(threadId)) return state;
  await rawRpc(state, 'thread/resume', { threadId }, { timeout: 30000 });
  state.loadedThreads.add(threadId);
  return state;
}

// ── public engine surface (mirrors oc-client) ────────────────────────────────

/**
 * Attach the GUI writer to a session's live stream (idempotent per session,
 * additive per writer) and replay the current turn's buffered frames.
 */
export async function attachCxSession(sessionId, ws) {
  const parsed = parseCxId(sessionId);
  if (!parsed) throw new Error(`not a codex session id: ${sessionId}`);
  const entry = sessionEntry(sessionId, { create: true });
  if (ws) {
    // Dedup by UNDERLYING connection, not wrapper identity (same fix as
    // oc-client: each chat run wraps the browser socket in a fresh writer).
    for (const w of entry.writers) {
      if (w.ws && ws.ws && w.ws === ws.ws) entry.writers.delete(w);
    }
    entry.writers.add(ws);
  }
  const state = connState(parsed.agent);
  state.sessions.add(sessionId);
  // Load the thread so its notifications flow to this connection. Best-effort:
  // an offline agent still serves cached history.
  if (parsed.thread !== 'none') {
    await ensureThreadLoaded(parsed.agent, parsed.thread).catch(() => { /* offline */ });
  }
  // Replay the buffered frames of the open turn to just this writer.
  if (ws && entry.replayBuffer) {
    for (const frame of entry.replayBuffer) {
      try { ws.send(frame); } catch { break; }
    }
  }
}

// ── slash commands ───────────────────────────────────────────────────────────

function infoFrame(sessionId, text) {
  return createNormalizedMessage({ kind: 'text', role: 'assistant', content: text, sessionId, provider: PROVIDER });
}

function completeFrame(sessionId, exitCode = 0) {
  return createNormalizedMessage({ kind: 'complete', exitCode, sessionId, provider: PROVIDER });
}

async function handleCxSlashCommand({ ws, sessionId, parsed, name }) {
  const say = (text, exitCode = 0) => {
    if (!ws) return;
    ws.send(infoFrame(sessionId, text));
    ws.send(completeFrame(sessionId, exitCode));
  };

  if (name === 'new' || name === 'clear') {
    try {
      const reg = registration(parsed.agent);
      const res = await cxRpc(parsed.agent, 'thread/start', { cwd: reg?.cwd || undefined });
      const newId = res?.thread?.id ? makeCxId(parsed.agent, res.thread.id) : null;
      say(newId
        ? 'Started a fresh thread for this agent. Reopen the agent from the sidebar to continue in the new thread (this view stays on the old conversation).'
        : 'Thread created, but the server returned no id.');
    } catch (err) {
      say(`Couldn't start a new thread: ${err.message}`, 1);
    }
    return;
  }

  if (name === 'compact' || name === 'summarize') {
    try {
      await ensureThreadLoaded(parsed.agent, parsed.thread);
      // Long-running LLM work — don't hold the send; progress streams over the
      // ws and turn/completed emits the turn's `complete`.
      void cxRpc(parsed.agent, 'thread/compact/start', { threadId: parsed.thread }, { timeout: 10 * 60 * 1000 })
        .catch((err) => {
          const entry = activeCxSessions.get(sessionId);
          if (entry) {
            emitFrame(entry, createNormalizedMessage({ kind: 'error', content: `compact failed: ${err.message}`, sessionId, provider: PROVIDER }));
            emitFrame(entry, completeFrame(sessionId, 1));
          }
        });
      const entry = sessionEntry(sessionId, { create: true });
      entry.turnOpen = true;
      if (ws) ws.send(infoFrame(sessionId, 'Compacting the thread…'));
    } catch (err) {
      say(`Couldn't compact: ${err.message}`, 1);
    }
    return;
  }

  if (name === 'abort' || name === 'stop') {
    abortCxSession(sessionId);
    say('Abort sent.');
    return;
  }

  if (name === 'help' || name === 'commands') {
    say('Available commands:\n/new (alias /clear) — fresh thread · /compact — summarize context · /abort — interrupt');
    return;
  }

  say(`Unknown codex command /${name}. Built-ins: /new /clear /compact /abort /help.`, 1);
}

/** Send one user turn to the agent's thread. */
export async function driveCxSession({ ws, sessionId, command }) {
  const parsed = parseCxId(sessionId);
  if (!parsed) throw new Error(`not a codex session id: ${sessionId}`);
  const reg = registration(parsed.agent);
  const fail = (reason) => {
    if (!ws) return;
    ws.send(createNormalizedMessage({ kind: 'error', content: reason, sessionId, provider: PROVIDER }));
    ws.send(createNormalizedMessage({ kind: 'complete', exitCode: 1, sessionId, provider: PROVIDER }));
  };
  if (!reg) { fail(`Agent "${parsed.agent}" is not registered on this host.`); return; }
  // Bind the stream FIRST so the turn's frames land on this writer.
  await attachCxSession(sessionId, ws);
  if (ws) ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: sessionId, sessionId, provider: PROVIDER }));
  // Slash command? (/new, /clear, /compact, /abort, /help)
  const slash = /^\/([A-Za-z0-9:_-]+)[ \t]*([\s\S]*)$/.exec((command || '').trim());
  if (slash) {
    await handleCxSlashCommand({ ws, sessionId, parsed, name: slash[1].toLowerCase() });
    return;
  }
  try {
    if (parsed.thread === 'none') {
      // Registered agent with no thread yet: start one and drive it. The GUI
      // stays on the placeholder id for this turn; the roster leaf rotates to
      // the real thread on its next refresh.
      const res = await cxRpc(parsed.agent, 'thread/start', { cwd: reg.cwd || undefined });
      const newThread = res?.thread?.id;
      if (!newThread) { fail('The agent could not start a thread.'); return; }
      const realId = makeCxId(parsed.agent, newThread);
      const state = connState(parsed.agent);
      state.loadedThreads.add(newThread);
      state.sessions.add(realId);
      // Mirror the placeholder entry onto the real session id so the incoming
      // notifications (keyed by the real thread) reach this writer.
      const placeholder = sessionEntry(sessionId, { create: true });
      activeCxSessions.set(realId, placeholder);
      if (ws) ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: realId, sessionId, provider: PROVIDER }));
      await cxRpc(parsed.agent, 'turn/start', {
        threadId: newThread,
        input: [{ type: 'text', text: command || '' }],
      }, { timeout: 30000 });
      placeholder.turnOpen = true;
      return;
    }
    await ensureThreadLoaded(parsed.agent, parsed.thread);
    await cxRpc(parsed.agent, 'turn/start', {
      threadId: parsed.thread,
      input: [{ type: 'text', text: command || '' }],
    }, { timeout: 30000 });
    const entry = sessionEntry(sessionId, { create: true });
    entry.turnOpen = true;
  } catch (err) {
    fail(`Message not delivered to codex agent "${parsed.agent}": ${err.message}`);
  }
}

/** Answer an approval prompt. Returns false when the id isn't a cx prompt. */
export function resolveCxPermission(requestId, decision) {
  if (typeof requestId !== 'string' || !requestId.startsWith('cx:')) return false;
  const pending = pendingCxApprovals.get(requestId);
  if (!pending) return true; // ours but expired — swallow, don't fall through
  pendingCxApprovals.delete(requestId);
  const state = cxConns.get(pending.agent);
  if (!state || !state.ws || state.ws.readyState !== WS_OPEN_RAW) return true;
  const cxDecision = decision?.allow
    ? (decision?.rememberEntry ? 'acceptForSession' : 'accept')
    : 'decline';
  respond(state, pending.rpcId, { decision: cxDecision });
  const entry = activeCxSessions.get(pending.sessionId);
  if (entry) {
    fanOut(entry, createNormalizedMessage({
      kind: 'permission_cancelled', requestId, sessionId: pending.sessionId, provider: PROVIDER,
    }));
  }
  return true;
}

/** Interrupt the running turn. Returns true if the abort was dispatched. */
export function abortCxSession(sessionId) {
  const parsed = parseCxId(sessionId);
  if (!parsed) return false;
  const state = cxConns.get(parsed.agent);
  const turnId = state?.turnByThread.get(parsed.thread);
  if (!state || !turnId) return false;
  void rawRpc(state, 'turn/interrupt', { threadId: parsed.thread, turnId })
    .catch((err) => console.warn('[cx] abort failed', { sessionId, error: err.message }));
  return true;
}

export function isActiveCxSession(sessionId) {
  return activeCxSessions.has(sessionId);
}
