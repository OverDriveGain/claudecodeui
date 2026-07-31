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
import { mkdir, readFile, writeFile, rename, readdir, stat, unlink } from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

import WebSocket from 'ws';

import { createNormalizedMessage } from '@/shared/utils.js';

const BASE = process.env.RC_BASE_URL || 'https://api.anthropic.com';
const WS_BASE = BASE.replace(/^http/, 'ws');
const ANTHROPIC_VERSION = '2023-06-01';
// Anthropic's beta tag for the remote-control session/event API.
const BETA_CCR = 'ccr-byoc-2025-07-29';

// sendMessage resilience: total passes over the account list, and the backoff
// base between passes (pass n waits n * base ms). Worst case adds ~2.2s before
// the user sees a delivery error — cheap insurance against transient relay 401s.
const RC_SEND_MAX_PASSES = Math.max(1, Number.parseInt(process.env.RC_SEND_MAX_PASSES || '', 10) || 3);
const RC_SEND_RETRY_BASE_MS = Math.max(100, Number.parseInt(process.env.RC_SEND_RETRY_BASE_MS || '', 10) || 750);

// sessionId -> { upstream: WebSocket, ws: clientWriter, replayBuffer, normalize,
//                retries, closedByUs, pingTimer, reconnectTimer, alive }
const activeRemoteSessions = new Map();
// Max frames retained per session for reconnect replay (~one turn's worth). The
// buffer is cleared at each turn end, so this only caps a single very long turn.
const RC_REPLAY_BUFFER_MAX = 400;
// Upstream keepalive + reconnect tuning. claude.ai/code's own client pings every
// 30s and retries transient closes; without both, a long-lived quiet subscription
// dies silently (idle timeout / NAT drop) and the GUI stops receiving until a
// manual refresh — the exact "message only appears after refresh" failure.
const RC_PING_INTERVAL_MS = 30 * 1000;
const RC_RECONNECT_BASE_MS = 1000;
const RC_RECONNECT_CAP_MS = 30 * 1000;
const RC_RECONNECT_MAX_RETRIES = 8;
// Cap the frames emitted from the missed-events top-up after a reconnect.
const RC_TOPUP_EMIT_MAX = 200;
// Stall watchdog. The upstream subscription can go silently stale: the socket keeps
// answering transport pings (so the heartbeat sees it alive) while the relay stops
// forwarding session events — observed in production as "messages stop mid-turn and
// the loader never clears, until a manual refresh" with ZERO close/error events all
// day. The heartbeat cannot catch this, so while a turn looks active but the socket
// has been quiet, cross-check the relay's EVENTS API over HTTP: emit what the socket
// missed (the client upserts by id, so duplicates collapse), finalize the turn when a
// flushed `result` shows up, and recycle the demonstrably-stale socket.
const RC_STALL_CHECK_MS = Math.max(2000, Number.parseInt(process.env.RC_STALL_CHECK_MS || '', 10) || 10 * 1000);
const RC_STALL_QUIET_MS = Math.max(5000, Number.parseInt(process.env.RC_STALL_QUIET_MS || '', 10) || 20 * 1000);
// The turnOpen-gated check above has a blind spot: turnOpen only opens from events
// the socket itself delivers or from OUR OWN send. A socket that went silently stale
// while the agent was idle forwards nothing when the next turn is started OUTSIDE
// the GUI (agent's terminal, another driver) — so the watchdog never engaged and the
// view froze until a manual refresh. While subscribers are watching, also probe on a
// slower cadence when NO turn is open; the same cursor top-up is the discriminator
// (idle agent → nothing new → no-op; stale socket → missed events → emit + recycle).
const RC_IDLE_SYNC_MS = Math.max(10 * 1000, Number.parseInt(process.env.RC_IDLE_SYNC_MS || '', 10) || 60 * 1000);
// Cap of remembered live-delivered event uuids per session (staleness discriminator:
// a topped-up event we already streamed is NOT evidence the socket missed anything).
const RC_SEEN_UUIDS_MAX = 2000;
// Raw ws OPEN state (ws library constant) — used to prune dead subscriber writers.
const WS_OPEN_RAW = 1;

/**
 * All live subscriber writers for a session entry. The GUI can watch one agent from
 * SEVERAL connections at once (phone + desktop, two tabs, the native app) — each
 * subscribes with its own writer. The old model kept only the LATEST writer, so
 * every re-subscribe STOLE the stream from the other viewers: the losing view froze
 * mid-turn with a stuck loader until its own refresh stole the stream back (the
 * exact "messages stop + loading forever until refresh" bug). Fan out to every
 * writer instead; dead ones (closed sockets) are pruned on each use.
 */
function liveWriters(entry) {
  if (!entry) return [];
  if (!entry.writers) entry.writers = new Set();
  if (entry.ws) entry.writers.add(entry.ws);
  for (const w of entry.writers) {
    const raw = w && w.ws;
    if (raw && typeof raw.readyState === 'number' && raw.readyState !== WS_OPEN_RAW) {
      entry.writers.delete(w);
    }
  }
  return [...entry.writers];
}

/** Send one frame to every live subscriber of the entry (writer races swallowed). */
function fanOut(entry, frame) {
  for (const w of liveWriters(entry)) {
    try { w.send(frame); } catch { /* writer race — pruned on the next emit */ }
  }
}

// requestId -> { sessionId } so a permission answer routes to the right upstream WS.
const pendingRemotePermissions = new Map();
// rawRequestId -> timestamp of when we answered it. After answering, the agent takes
// a moment to record the tool_result; until then the question still looks "open" in
// history, so a re-subscribe would re-surface it (flicker / "asking again"). This
// short-lived record suppresses re-emitting a question the user already answered.
const answeredRemotePermissions = new Map();
const ANSWERED_PERMISSION_TTL_MS = 10 * 60 * 1000;

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

// ── Multi-account credential registry ──────────────────────────────────────────
// A deployment can drive agents from MORE THAN ONE claude.ai login at once. Set
// RC_ACCOUNTS to a JSON array; every relay call is routed to the credential that owns
// the session in question. Backward compatible: with RC_ACCOUNTS unset (or
// empty/invalid) the registry collapses to a single "default" account sourced exactly
// as before — RC_OAUTH_TOKEN/RC_ORG_UUID env, else the ~/.claude dotfiles.
//
// Each entry supplies BOTH a token and an org uuid, as literals OR as dotfile paths:
//   label|name                              display/routing label (optional)
//   token|accessToken                       literal OAuth token
//   orgUuid|org_uuid|organizationUuid        literal org uuid
//   credentialsPath|credentials_path         path to a .credentials.json
//                                            (.claudeAiOauth.accessToken)
//   claudeJsonPath|claude_json_path          path to a .claude.json
//                                            (.oauthAccount.organizationUuid)
// Paths WIN on freshness: they are read per-call, so an account's `claude` CLI
// rewriting its dotfile after an OAuth refresh is picked up automatically — literal
// tokens are a snapshot that expires. Fields can be mixed (literal org + path token).
// An entry is kept only if it can yield both a token and an org uuid from some source.

function expandHome(p) {
  return typeof p === 'string' && p.startsWith('~')
    ? path.join(os.homedir(), p.slice(1))
    : p;
}
function readJsonFile(p) {
  return JSON.parse(readFileSync(expandHome(p), 'utf8'));
}

// Parse RC_ACCOUNTS into unresolved SPECS (label + literal creds and/or dotfile paths).
function parseAccountSpecs() {
  const raw = process.env.RC_ACCOUNTS;
  if (!raw || !raw.trim()) return null;
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch {
    console.error('[rc] RC_ACCOUNTS is not valid JSON — ignoring, using single-account fallback');
    return null;
  }
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const seen = new Set();
  const specs = [];
  arr.forEach((a, i) => {
    if (!a || typeof a !== 'object') return;
    const label = String(a.label || a.name || `account${i + 1}`).trim() || `account${i + 1}`;
    if (seen.has(label)) return;
    const spec = {
      label,
      token: a.token || a.accessToken || null,
      orgUuid: a.orgUuid || a.org_uuid || a.organizationUuid || null,
      credentialsPath: a.credentialsPath || a.credentials_path || null,
      claudeJsonPath: a.claudeJsonPath || a.claude_json_path || null,
    };
    // Need a source for BOTH fields (literal or path), else the entry is unusable.
    if ((!spec.token && !spec.credentialsPath) || (!spec.orgUuid && !spec.claudeJsonPath)) return;
    seen.add(label);
    specs.push(spec);
  });
  return specs.length ? specs : null;
}

// Last successfully-resolved {token, orgUuid} per label — a transient dotfile read
// failure (mid-rewrite, mount blip) falls back to this instead of dropping the account.
const lastGoodAccount = new Map();
// Labels that couldn't be resolved at all (never good) — surfaced via getAccountErrors.
const accountResolveErrors = new Map();

// Resolve one spec to {label, token, orgUuid}, reading any paths FRESH (per-call →
// picks up a refreshed/rewritten dotfile). Falls back to last-known-good on a read
// failure; returns null (and records an error) only if it never resolved.
function resolveSpec(spec) {
  let token = spec.token;
  let orgUuid = spec.orgUuid;
  let readErr = null;
  if (!token && spec.credentialsPath) {
    try { token = readJsonFile(spec.credentialsPath)?.claudeAiOauth?.accessToken || null; }
    catch (e) { readErr = e; }
  }
  if (!orgUuid && spec.claudeJsonPath) {
    try { orgUuid = readJsonFile(spec.claudeJsonPath)?.oauthAccount?.organizationUuid || null; }
    catch (e) { readErr = e; }
  }
  if (token && orgUuid) {
    const acct = { label: spec.label, token: String(token), orgUuid: String(orgUuid) };
    lastGoodAccount.set(spec.label, acct);
    accountResolveErrors.delete(spec.label);
    return acct;
  }
  const prev = lastGoodAccount.get(spec.label);
  if (prev) return prev; // transient — reuse last-known-good, no error
  accountResolveErrors.set(spec.label, {
    status: 0,
    message: `could not read credentials (${readErr?.message || 'missing token or org uuid'})`,
  });
  return null;
}

// How many accounts are CONFIGURED (specs), regardless of whether each resolves right
// now — so the multi-account UI/error surfacing stays on even if one account is
// temporarily unreadable (its failure is reported rather than silently collapsing to
// single-account).
function configuredAccountCount() {
  const specs = parseAccountSpecs();
  return specs ? specs.length : 1;
}

// The active credential set. RC_ACCOUNTS wins (specs resolved per-call); otherwise a
// single "default" account. If every configured account fails to resolve AND none has
// a last-known-good value, fall through to the default so a boot-time path glitch
// doesn't leave the proxy fully dark.
export function getAccounts() {
  const specs = parseAccountSpecs();
  if (specs) {
    const resolved = specs.map(resolveSpec).filter(Boolean);
    if (resolved.length) return resolved;
  }
  const { token, orgUuid } = getRemoteAuth();
  return [{ label: 'default', token, orgUuid }];
}

export function hasMultipleAccounts() {
  return configuredAccountCount() > 1;
}

function accountByLabel(label) {
  return getAccounts().find((a) => a.label === label) || null;
}

// sessionId (BOTH cse_/session_ forms) -> owning account label. Populated whenever a
// roster is fetched (listAgents) and whenever a relay call proves which credential a
// session answers to. This is the authoritative routing table.
const sessionAccountMap = new Map();
function rememberAccountForSession(sessionId, label) {
  if (!sessionId || !label) return;
  sessionAccountMap.set(toCseId(sessionId), label);
  sessionAccountMap.set(toSessionId(sessionId), label);
}
function knownAccountForSession(sessionId) {
  const label =
    sessionAccountMap.get(sessionId) ||
    sessionAccountMap.get(toCseId(sessionId)) ||
    sessionAccountMap.get(toSessionId(sessionId));
  return label ? accountByLabel(label) : null;
}

// Resolve which credential owns a session. Fast path for a single-account
// deployment (the only account). Otherwise consult the routing table; on a COLD miss
// (an id requested before any roster fetch populated the map) refresh the roster once
// — a fanout that repopulates the map — then re-check. Returns null only when the id
// is unknown to every account, in which case read callers try each credential in turn
// rather than 403 the request.
async function resolveAccountForSession(sessionId) {
  const accounts = getAccounts();
  if (accounts.length <= 1) return accounts[0] || null;
  const known = knownAccountForSession(sessionId);
  if (known) return known;
  try { await listAgents(); } catch { /* degrade — try-all order below */ }
  return knownAccountForSession(sessionId);
}

// Credential try-order for a read: the resolved owner first, then the rest (so a
// cold/unknown session still resolves by probing each account). Single-account
// deployments get exactly one entry — unchanged behaviour.
async function accountTryOrder(sessionId) {
  const accounts = getAccounts();
  if (accounts.length <= 1) return accounts;
  const primary = await resolveAccountForSession(sessionId);
  if (!primary) return accounts;
  return [primary, ...accounts.filter((a) => a.label !== primary.label)];
}

// Per-account roster-fetch errors from the last listAgents fanout, so the UI can
// surface "account X failed" without breaking the rest of the list.
let lastListErrors = new Map();
// Combine credential-resolve failures (unreadable dotfile path, never good) with
// roster-fetch failures (expired token → 401). A roster error wins if a label has both.
export function getAccountErrors() {
  const out = new Map();
  for (const [label, e] of accountResolveErrors) out.set(label, e);
  for (const [label, e] of lastListErrors) out.set(label, e);
  return [...out.entries()].map(([label, e]) => ({ label, ...e }));
}

/** Build request headers for the Anthropic API, authed as `account` (or the default). */
function headers(account, { beta, org, client } = {}) {
  const { token, orgUuid } = account || getRemoteAuth();
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

/** True when at least one account has a usable OAuth token + org uuid (else off). */
export function isRemoteControlConfigured() {
  return getAccounts().some((a) => a.token && a.orgUuid);
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
// A working agent emits events (thinking tokens, tool use, output) constantly, so a
// "running" worker_status that hasn't produced an event in this long is a stale flag
// left by an interrupted turn, not real work. Safety net for the sidebar dot.
const RUNNING_MAX_IDLE_MS = 90 * 1000;

// An "open" turn whose upstream has been silent this long is a dead worker
// (crashed/killed mid-turn — no result ever comes), not a silent tool call.
// Without this bound a stale turnOpen entry reported running forever and pinned
// clients' loaders overnight.
const TURNOPEN_TRUST_MAX_MS =
  Math.max(2 * 60_000, parseInt(process.env.RC_TURNOPEN_TRUST_MAX_MS || '', 10) || 30 * 60_000);

function isWorkerRunning(s) {
  if (s.worker_status !== 'running') return false;
  if (s.connection_status !== 'connected') return false;
  if (s.status === 'archived') return false;
  // A subscribed upstream's live turn state beats the idle heuristic — in BOTH
  // directions. turnOpen=true survives a long silent tool call (a 2-minute build
  // emits nothing) that trips the 90s cutoff; turnOpen=false means we SAW the
  // turn end (result/command ack), while the relay's worker_status flag stays a
  // stale 'running' long after (verified: still 'running' minutes after a
  // /clear) — trusting the flag then re-armed pollers' loaders till next turn.
  const entry = activeRemoteSessions.get(s.id);
  if (entry) {
    if (!entry.turnOpen) return false;
    if (Date.now() - (entry.lastUpstreamAt || 0) < TURNOPEN_TRUST_MAX_MS) return true;
    // fall through: open-turn entry gone silent too long — dead worker
  }
  const last = Date.parse(s.last_event_at || s.created_at || '');
  return Number.isFinite(last) && Date.now() - last < RUNNING_MAX_IDLE_MS;
}

// Shape one raw relay session row into the app's agent record.
function mapAgentRow(s) {
  return {
    id: s.id,
    title: (s.title || '').split('\n')[0].trim(),
    connected: s.connection_status === 'connected',
    // status==='active' means the relay session is live; 'archived' sessions report
    // connection_status='connected' too but reject sends with 409 "not active". So a
    // session is only DRIVABLE when connected AND active — see the dedup in rc.service.
    active: s.status === 'active',
    // Per-session live work state, as claude.ai/code reads it: worker_status is
    // "running" while the agent is mid-turn, else "idle" (or
    // "WORKER_STATUS_UNSPECIFIED" when disconnected/unknown). Drives the sidebar
    // running dot. BUT the relay leaves a STALE "running" flag on sessions that were
    // interrupted/disconnected mid-turn and never produced a `result` (e.g.
    // bti-environment sat at worker_status=running with no event for 130s+). A real
    // working agent emits events constantly, so trust the flag only for a live
    // session (connected, not archived) whose last event is recent — an idle-timeout
    // safety net, same idea as the local-session watcher.
    running: isWorkerRunning(s),
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
  };
}

// Page ONE account's whole session list. Never throws — returns { rows, error } so a
// fanout can degrade gracefully (one expired token doesn't blank the whole roster).
async function listAgentsForAccount(account, { pageSize, maxPages }) {
  const rows = [];
  let cursor = null;
  for (let i = 0; i < maxPages; i++) {
    const url = `${BASE}/v1/code/sessions?limit=${pageSize}`
      + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    let r;
    try {
      r = await fetch(url, { headers: headers(account) });
    } catch (err) {
      return { rows, error: { status: 0, message: err?.message || 'network error' } };
    }
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      // Partial page-through already yielded rows — keep them, note the error.
      return { rows, error: { status: r.status, message: body.slice(0, 200) } };
    }
    const j = await r.json();
    const batch = j.data || [];
    rows.push(...batch);
    cursor = j.next_cursor;
    if (!cursor || batch.length === 0) break;
  }
  return { rows, error: null };
}

// /v1/code/sessions is paginated (default 20, most-recent-first) with a
// `cursor`/`next_cursor` scheme; page through so the WHOLE fleet returns. With
// multiple accounts, fan out across all of them concurrently, tag each session with
// its owning account label, and populate the sessionId->account routing table so the
// drive/history/subscribe paths know which credential to use.
export async function listAgents({ pageSize = 200, maxPages = 8 } = {}) {
  const accounts = getAccounts();
  const settled = await Promise.all(
    accounts.map((acc) => listAgentsForAccount(acc, { pageSize, maxPages })),
  );
  const errors = new Map();
  const out = [];
  settled.forEach((res, i) => {
    const acc = accounts[i];
    if (res.error) errors.set(acc.label, res.error);
    for (const s of res.rows) {
      rememberAccountForSession(s.id, acc.label);
      out.push({ ...mapAgentRow(s), account: acc.label });
    }
  });
  lastListErrors = errors;
  // Every account failed AND produced nothing → throw so the caller (rc.service)
  // serves its last-good cache, exactly as the single-account path did before.
  if (out.length === 0 && errors.size === accounts.length && accounts.length > 0) {
    const first = [...errors.values()][0];
    throw new Error(`listAgents: all ${accounts.length} account(s) failed (e.g. ${first.status}: ${first.message})`);
  }
  return out;
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
  // Try the owning account first; on a cold/unknown session, probe each credential in
  // turn (a foreign session 404s under the wrong token) rather than failing outright.
  const order = await accountTryOrder(sessionId);
  for (const account of order) {
    const all = [];
    let cursor = after;
    let lastId = after;
    let anyOk = false;
    for (let i = 0; i < maxPages; i++) {
      const url = `${BASE}/v1/sessions/${sessionId}/events?limit=${limit}`
        + (cursor ? `&after_id=${encodeURIComponent(cursor)}` : '');
      const r = await fetch(url, { headers: headers(account, { beta: BETA_CCR, org: true }) });
      if (!r.ok) break;
      anyOk = true;
      const j = await r.json();
      const batch = Array.isArray(j.data) ? j.data : [];
      all.push(...batch);
      if (j.last_id) lastId = j.last_id;
      if (!j.has_more || !batch.length || !j.last_id) break;
      cursor = j.last_id;
    }
    if (anyOk) {
      rememberAccountForSession(sessionId, account.label);
      return { events: all, lastId };
    }
    // This account rejected the session (wrong owner / expired) — try the next.
  }
  return { events: [], lastId: after };
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

// ── Disk persistence for the event cache ───────────────────────────────────────
// The in-memory cache above is wiped on every restart, so a big session (10k+
// events) pays the full ~10s relay page-through again on the first open after a
// restart. We persist the raw event log to disk and, on a cold process, load it and
// top up only the events created since the saved cursor. This is safe with ZERO
// invalidation logic because the relay event log is APPEND-ONLY: the cached prefix
// always matches the relay's prefix, so the on-disk copy can only ever be extended,
// never become wrong. Any failure (missing/corrupt file, write error, bad cursor)
// silently falls back to the exact pre-existing behaviour — a full page-through — so
// the worst case is "no speed-up", never incorrect history. Raw events (not
// normalized) are stored, so a normalizer change can't leave stale rendered data.
const EVENTS_CACHE_DIR =
  process.env.RC_EVENTS_CACHE_DIR || path.join(os.homedir(), '.cache', 'ccui-rc-events');
const EVENTS_DISK_MAX = 80;            // cap files on disk (LRU by mtime)
const EVENTS_DISK_SAVE_THROTTLE_MS = 15000; // don't rewrite a multi-MB file on every top-up

// sessionIds are relay ids (cse_…/session_…) — alnum + underscore, safe as filenames.
function eventsCacheFile(sessionId) {
  return path.join(EVENTS_CACHE_DIR, `${sessionId}.json`);
}

function eventKey(e) {
  return e?.event_id || e?.uuid || null;
}

// Concurrent top-ups used to double-append the same relay suffix (two callers
// read the same lastId before either advanced it), and a lagging disk cursor
// re-fetches already-cached events on warm start. Both leaked duplicate rows
// all the way to the clients (a sent message rendering twice). Events are
// deduped by id here and on every append, and top-ups are serialized per entry.
function dedupeEventList(events) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    const k = eventKey(e);
    if (k) {
      if (seen.has(k)) continue;
      seen.add(k);
    }
    out.push(e);
  }
  return out;
}

function eventIdSet(events) {
  const ids = new Set();
  for (const e of events) {
    const k = eventKey(e);
    if (k) ids.add(k);
  }
  return ids;
}

async function loadDiskEvents(sessionId) {
  try {
    const j = JSON.parse(await readFile(eventsCacheFile(sessionId), 'utf8'));
    if (j && Array.isArray(j.events) && j.events.length) {
      return { events: dedupeEventList(j.events), lastId: typeof j.lastId === 'string' ? j.lastId : null };
    }
  } catch { /* missing/corrupt → caller pages from the relay */ }
  return null;
}

let diskEvictInFlight = false;
async function evictDiskEvents() {
  if (diskEvictInFlight) return;
  diskEvictInFlight = true;
  try {
    const all = await readdir(EVENTS_CACHE_DIR);
    // Sweep orphaned temp files left by a write that was killed before the rename.
    for (const f of all.filter((f) => f.endsWith('.tmp'))) {
      try {
        if (Date.now() - (await stat(path.join(EVENTS_CACHE_DIR, f))).mtimeMs > 60000) {
          await unlink(path.join(EVENTS_CACHE_DIR, f)).catch(() => {});
        }
      } catch { /* ignore */ }
    }
    const files = all.filter((f) => f.endsWith('.json'));
    if (files.length <= EVENTS_DISK_MAX) return;
    const withMtime = await Promise.all(
      files.map(async (f) => {
        try { return { f, m: (await stat(path.join(EVENTS_CACHE_DIR, f))).mtimeMs }; }
        catch { return { f, m: 0 }; }
      }),
    );
    withMtime.sort((a, b) => a.m - b.m); // oldest first
    for (const { f } of withMtime.slice(0, files.length - EVENTS_DISK_MAX)) {
      await unlink(path.join(EVENTS_CACHE_DIR, f)).catch(() => {});
    }
  } catch { /* best-effort */ }
  finally { diskEvictInFlight = false; }
}

async function saveDiskEvents(sessionId, events, lastId) {
  try {
    await mkdir(EVENTS_CACHE_DIR, { recursive: true });
    const file = eventsCacheFile(sessionId);
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify({ lastId: lastId || null, events, savedAt: Date.now() }));
    await rename(tmp, file); // atomic — a crash mid-write can't corrupt the live file
    void evictDiskEvents();
  } catch { /* disk full / read-only / etc — in-memory cache still works */ }
}

/**
 * Cached event history for a session. First call (cold process) loads the on-disk
 * copy when present and tops it up from the relay, else pages the whole history;
 * later calls serve from memory and (when `topUp`) fetch only events created after
 * the last cursor — append-only transcripts make all of this safe. Returns the full
 * oldest-first raw event array; the caller windows/normalizes it.
 */
// Serialized, id-deduped top-up: one relay fetch in flight per entry, and only
// events whose id is unseen get appended. Concurrent callers await the same
// promise instead of racing the cursor.
function topUpEntry(sessionId, entry, { saveNow = false } = {}) {
  if (entry.topUpPromise) return entry.topUpPromise;
  entry.topUpPromise = (async () => {
    try {
      const { events: fresh, lastId } = await getSessionEvents(sessionId, { after: entry.lastId });
      const newOnes = fresh.filter((e) => {
        const k = eventKey(e);
        return !k || !entry.ids.has(k);
      });
      if (newOnes.length) {
        for (const e of newOnes) {
          const k = eventKey(e);
          if (k) entry.ids.add(k);
        }
        entry.events = entry.events.concat(newOnes);
        if (lastId) entry.lastId = lastId;
        // Throttle disk writes: an actively-watched big session tops up often, and
        // the file is multi-MB. A lagging on-disk cursor just means a few
        // re-fetched events next cold start — deduped on load, harmless.
        if (saveNow || Date.now() - (entry.lastDiskSaveAt || 0) > EVENTS_DISK_SAVE_THROTTLE_MS) {
          entry.lastDiskSaveAt = Date.now();
          await saveDiskEvents(sessionId, entry.events, entry.lastId);
        }
      } else if (lastId) {
        entry.lastId = lastId;
      }
      entry.fetchedAt = Date.now();
    } catch { /* keep what we have; the next call retries */ }
    finally { entry.topUpPromise = null; }
  })();
  return entry.topUpPromise;
}

export async function getSessionEventsCached(sessionId, { topUp = true } = {}) {
  let entry = sessionEventsCache.get(sessionId);
  if (!entry) {
    const disk = await loadDiskEvents(sessionId);
    if (disk) {
      // Warm-start from disk, then sync only the suffix the relay added since.
      entry = { events: disk.events, ids: eventIdSet(disk.events), lastId: disk.lastId, fetchedAt: Date.now(), lastDiskSaveAt: Date.now(), topUpPromise: null };
      // Register BEFORE the async top-up so concurrent callers share this entry
      // (and its in-flight top-up) instead of racing a second cold load.
      sessionEventsCache.set(sessionId, entry);
      evictSessionEventsCache();
      if (topUp) await topUpEntry(sessionId, entry, { saveNow: true });
      return entry.events;
    }
    // No disk copy → original behaviour: page the whole history, then persist it.
    const { events, lastId } = await getSessionEvents(sessionId, {});
    entry = { events: dedupeEventList(events), lastId, fetchedAt: Date.now(), lastDiskSaveAt: Date.now(), topUpPromise: null };
    entry.ids = eventIdSet(entry.events);
    sessionEventsCache.set(sessionId, entry);
    evictSessionEventsCache();
    await saveDiskEvents(sessionId, entry.events, entry.lastId);
  } else if (topUp) {
    await topUpEntry(sessionId, entry);
  }
  return entry.events;
}

/** Drop a session's cached events (e.g. on detach or forced reload). */
export function invalidateSessionEventsCache(sessionId) {
  if (sessionId) sessionEventsCache.delete(sessionId);
  else sessionEventsCache.clear();
}

// sessionId -> cwd. The agent's working directory is reported by the relay in the
// session detail (session_context.cwd) and is stable for the life of the session,
// so resolve it once and cache. This is how the GUI points its file browser at the
// agent's real directory — claude.ai/code itself doesn't expose the files, but it
// does tell us where the agent is working.
const sessionCwdCache = new Map();

export async function getSessionCwd(sessionId) {
  if (!sessionId) return null;
  if (sessionCwdCache.has(sessionId)) return sessionCwdCache.get(sessionId);
  const order = await accountTryOrder(sessionId);
  for (const account of order) {
    try {
      const url = `${BASE}/v1/sessions/${toSessionId(sessionId)}`;
      const r = await fetch(url, { headers: headers(account, { beta: BETA_CCR, org: true }) });
      if (!r.ok) continue; // wrong account / expired — try the next
      rememberAccountForSession(sessionId, account.label);
      const j = await r.json();
      const cwd =
        (j && j.session_context && typeof j.session_context.cwd === 'string' && j.session_context.cwd) ||
        (j && j.response_shape && j.response_shape.session_context && j.response_shape.session_context.cwd) ||
        null;
      if (cwd) sessionCwdCache.set(sessionId, cwd);
      return cwd || null;
    } catch {
      // try the next account
    }
  }
  return null;
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
  const order = await accountTryOrder(sessionId);
  let last = { ok: false, status: 0, notActive: false };
  // The relay intermittently 401s tokens it accepts seconds later, and a starved
  // host can throw transient network errors — so retry the whole account list a
  // few times with backoff before surfacing an error to the user. A 409 "not
  // active" is definitive and returns immediately; everything else is worth
  // another pass.
  for (let pass = 0; pass < RC_SEND_MAX_PASSES; pass++) {
    if (pass > 0) await new Promise((res) => setTimeout(res, RC_SEND_RETRY_BASE_MS * pass));
    for (const account of order) {
      let r;
      try {
        r = await fetch(url, {
          method: 'POST',
          headers: headers(account, { beta: BETA_CCR, org: true, client: true }),
          body: JSON.stringify({ events: [event] }),
        });
      } catch (err) {
        console.error('[rc] sendMessage fetch threw', { sessionId, url, account: account.label, pass, error: err?.message });
        last = { ok: false, status: 0, notActive: false };
        continue;
      }
      if (r.ok) {
        rememberAccountForSession(sessionId, account.label);
        return { ok: true, status: r.status, notActive: false };
      }
      let body = '';
      try { body = (await r.text()).slice(0, 300); } catch { /* ignore */ }
      // 409 "not active" comes from the OWNING account (the session exists but is
      // archived) — a definitive answer; don't shop it to other accounts or retry.
      const notActive = r.status === 409 && /not active/i.test(body);
      if (notActive) {
        rememberAccountForSession(sessionId, account.label);
        return { ok: false, status: r.status, notActive: true };
      }
      console.error('[rc] sendMessage failed', { sessionId, url, account: account.label, pass, status: r.status, body });
      last = { ok: false, status: r.status, notActive: false };
    }
  }
  return last;
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
    // ADD this writer to the subscriber set (don't replace): other open views of the
    // same agent keep receiving the stream. liveWriters() prunes closed ones.
    if (!existing.writers) existing.writers = new Set();
    existing.writers.add(ws);
    if (typeof ws.setSessionId === 'function') ws.setSessionId(sessionId);
    // Reconnect recovery. The browser↔server WS drops on a tab/window switch (and
    // mobile backgrounding); while it's down, every frame the upstream relay sends
    // is written to the now-dead writer and lost. The relay does NOT replay on
    // re-subscribe (verified: a fresh subscribe yields zero frames) and its events
    // API lags mid-turn, so the user's just-sent message and the agent's in-flight
    // output silently vanish until the turn flushes (completion) or a manual refresh
    // re-pages history. We therefore keep a small per-session buffer of the frames
    // we emitted and flush it to the freshly-bound writer here — the only lossless
    // recovery. The client dedups by id, so already-seen frames collapse and only
    // the missed ones surface.
    if (Array.isArray(existing.replayBuffer)) {
      for (const frame of existing.replayBuffer) {
        try { ws.send(frame); } catch { /* writer race — next reconnect retries */ }
      }
    }
    // A returning viewer may be looking at a gap the replay buffer doesn't cover
    // (buffer cleared at turn end, or the socket went stale while nobody watched).
    // Run one events-API sync now: emits anything the socket demonstrably missed and
    // recycles the socket if it did (single-flight; a healthy quiet stream is one
    // cursor GET returning nothing). This also makes the client's periodic
    // re-subscribe an active liveness probe instead of a pure no-op.
    // Quiet-gated: a rebind also happens on SEND (driveRemoteSession re-attaches),
    // where the just-POSTed user event can hit the events API before the socket
    // streams it back — an unconditional probe counts that as "missed" and recycles
    // a healthy socket right at turn start. A recently-speaking upstream is
    // demonstrably alive, and the replay-buffer flush above already covers it.
    if (Date.now() - (existing.lastUpstreamAt || 0) >= RC_STALL_QUIET_MS) {
      void syncStalledUpstream(sessionId, existing);
    }
    return existing;
  }
  // replayBuffer holds the meaningful frames of (roughly) the current turn so a
  // reconnecting client can recover what it missed while its WS was down — see the
  // rebind branch above. Capped so an idle long-lived session can't grow unbounded.
  // `normalize` is retained so the upstream can be silently reopened (reconnect)
  // with the same wiring after a transient relay-side close.
  const entry = {
    upstream: null,
    ws,
    replayBuffer: [],
    normalize,
    retries: 0,
    closedByUs: false,
    pingTimer: null,
    reconnectTimer: null,
    alive: true,
    // Stall-watchdog state: is a turn in flight, when the upstream last spoke, the
    // uuids it delivered (to tell truly-missed events from cache-lag duplicates).
    turnOpen: false,
    lastUpstreamAt: 0,
    stallTimer: null,
    stallSyncInFlight: false,
    lastStallSyncAt: 0,
    seenEventUuids: new Set(),
    // Every live subscriber (multiple GUI views of the same agent) — see liveWriters.
    writers: new Set([ws]),
  };
  activeRemoteSessions.set(sessionId, entry);

  if (typeof ws.setSessionId === 'function') ws.setSessionId(sessionId);

  await openRemoteUpstream(sessionId, entry);
  // Fresh attach ≠ complete view: only the RECONNECT path topped up missed events,
  // so a subscription rebuilt from scratch (previous entry exhausted its retries
  // during a relay/DNS outage and was dropped) silently lost the whole gap, and a
  // mid-turn open missed whatever flushed between the history fetch and this attach.
  // Bridge it in the background (off the send path — the pre-count itself can be a
  // full page-through on a cold cache): emit events the relay has that we never
  // streamed. The client upserts by id, so overlap with history/live collapses.
  void (async () => {
    try {
      const preAttachCount = (await getSessionEventsCached(sessionId, { topUp: false })).length;
      await emitMissedEventsAfterReconnect(sessionId, entry, preAttachCount);
    } catch { /* watchdog / next subscribe covers it */ }
  })();
  return entry;
}

/**
 * After a reconnect, bridge the gap: events that flushed to the relay's events API
 * while the upstream was down are pulled (cursor top-up) and emitted through the
 * normal normalizer. The client's id-keyed event log upserts idempotently, so
 * frames it already saw collapse and only the missed ones surface. Mid-turn frames
 * that never flushed are unrecoverable by design (the relay replays nothing); the
 * replay buffer + next turn's stream cover the visible continuity.
 */
async function emitMissedEventsAfterReconnect(sessionId, entry, preDropCount) {
  try {
    const all = await getSessionEventsCached(sessionId);
    const missed = all.slice(Math.max(0, preDropCount));
    if (missed.length === 0) return;
    emitRawEvents(sessionId, entry, missed);
  } catch { /* the next manual refresh / history fetch covers it */ }
}

/**
 * Local-command RECORD events (/clear and friends) are appended AFTER the turn's
 * `result`: a synthetic caveat row, a `<command-name>` user row, and an assistant
 * "(no content)" ack. They document the command — they are not work. Counting one
 * as mid-turn evidence re-opened turnOpen right after the result closed it, and
 * since nothing follows a /clear, the session read as "running" forever (stuck
 * working loader on every client until the next real turn).
 */
function isCommandRecordEvent(m) {
  const content = m?.message?.content;
  if (m?.type === 'user') {
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content) ? (content.find((p) => p?.type === 'text')?.text || '') : '';
    return /^\s*<(?:command-name|local-command-)/.test(text);
  }
  if (m?.type === 'assistant') {
    return Array.isArray(content) && content.length === 1
      && content[0]?.type === 'text' && content[0].text === '(no content)';
  }
  return false;
}

/**
 * Retain a frame for reconnect replay. Invariant: a buffered `complete` is only
 * meaningful as the LAST frame (it tells a viewer that rebinds after turn end to
 * clear its loader). The moment any newer frame is buffered the turn has moved on,
 * and replaying that stale `complete` on a rebind — every 45s client keepalive, and
 * the attach inside a send — cleared the working loader mid-turn on phones. So a
 * non-complete push evicts any buffered `complete` first.
 */
function pushReplayFrame(entry, frame) {
  if (!Array.isArray(entry.replayBuffer)) entry.replayBuffer = [];
  if (frame?.kind !== 'complete' && entry.replayBuffer.some((f) => f?.kind === 'complete')) {
    entry.replayBuffer = entry.replayBuffer.filter((f) => f?.kind !== 'complete');
  }
  entry.replayBuffer.push(frame);
  if (entry.replayBuffer.length > RC_REPLAY_BUFFER_MAX) entry.replayBuffer.shift();
}

/**
 * Emit a slice of RAW relay events to the current writer through the normalizer —
 * the shared tail of both gap-recovery paths (post-reconnect top-up and the stall
 * watchdog). The normalizer produces NOTHING for a raw `result` event (the live
 * socket path translates it separately), so a turn that ENDED inside the recovered
 * gap must be finalized here too: without the explicit `complete`, the GUI's loader
 * spun forever even though every message had been delivered.
 */
function emitRawEvents(sessionId, entry, rawEvents) {
  const target = activeRemoteSessions.get(sessionId) || entry;
  let emitted = 0;
  for (const raw of rawEvents) {
    if (emitted >= RC_TOPUP_EMIT_MAX) break;
    // Same subagent-sidechain filter as the live + history paths.
    if (raw && typeof raw === 'object' && raw.parent_tool_use_id) continue;
    let frames = [];
    try { frames = entry.normalize ? entry.normalize(raw, sessionId) : []; } catch { continue; }
    for (const frame of frames) {
      pushReplayFrame(target, frame);
      fanOut(target, frame);
      emitted += 1;
    }
  }
  if (rawEvents.some((e) => e?.type === 'result')) {
    target.turnOpen = false;
    target.replayBuffer = [];
    const frame = createNormalizedMessage({ kind: 'complete', exitCode: 0, sessionId, provider: 'claude' });
    target.replayBuffer.push(frame);
    fanOut(target, frame);
  }
}

/**
 * Stall recovery: a turn is open but the upstream socket has been silent past the
 * quiet threshold. Pull the events API (HTTP — independent of the socket, and with
 * the account-fallback auth path), emit anything the socket demonstrably missed,
 * finalize the turn if its `result` flushed, and recycle the stale socket so live
 * streaming resumes. Cheap when healthy: one cursor-based GET returning nothing.
 */
async function syncStalledUpstream(sessionId, entry) {
  if (entry.stallSyncInFlight) return;
  entry.stallSyncInFlight = true;
  entry.lastStallSyncAt = Date.now();
  try {
    const before = (await getSessionEventsCached(sessionId, { topUp: false })).length;
    const all = await getSessionEventsCached(sessionId);
    // Only events appended by THIS top-up are candidates, and only those the live
    // socket did NOT deliver count as missed — the cache always lags the live stream
    // (live frames never touch it), so without the seen-uuid filter a healthy but
    // quiet socket (agent inside a long tool call) would be recycled mid-turn.
    const missed = all
      .slice(Math.max(0, before))
      .filter((e) => !(e && e.uuid && entry.seenEventUuids.has(e.uuid)));
    if (missed.length === 0) return;
    // Missed events with no `result` yet = a turn is in flight that the socket never
    // told us about (started outside the GUI on a stale socket). Open it so the
    // watchdog switches to the fast mid-turn cadence until its result arrives.
    // (emitRawEvents flips it back off when the batch does contain a result.)
    // A batch of only local-command records is a turn that already ENDED — its
    // result streamed live and only the trailing records landed in the cache.
    if (!missed.some((e) => e?.type === 'result')
        && missed.some((e) => !isCommandRecordEvent(e))) entry.turnOpen = true;
    console.log('[rc] stalled upstream: recovering missed events via events API', {
      sessionId,
      missed: missed.length,
      quietMs: Date.now() - (entry.lastUpstreamAt || 0),
    });
    emitRawEvents(sessionId, entry, missed);
    // The socket failed to stream events the relay had — it's stale. Terminate to
    // fire 'close' → the transparent reconnect path resubscribes with fresh auth.
    try { entry.upstream?.terminate(); } catch { /* already dead */ }
  } catch { /* relay unreachable — the next watchdog tick retries */ }
  finally { entry.stallSyncInFlight = false; }
}

/** Schedule a reconnect attempt for a transiently-closed upstream (single-flight). */
function scheduleRemoteReconnect(sessionId, entry) {
  if (entry.reconnectTimer || entry.closedByUs) return;
  if (entry.retries >= RC_RECONNECT_MAX_RETRIES) {
    // Give up: drop the subscription and tell the GUI the stream ended so the
    // loader clears. Reopening the conversation (or the client's periodic
    // re-subscribe) starts a fresh attach.
    activeRemoteSessions.delete(sessionId);
    fanOut(entry, createNormalizedMessage({ kind: 'complete', exitCode: 0, sessionId, provider: 'claude' }));
    return;
  }
  const delay = Math.min(RC_RECONNECT_CAP_MS, RC_RECONNECT_BASE_MS * 2 ** entry.retries);
  entry.retries += 1;
  entry.reconnectTimer = setTimeout(async () => {
    entry.reconnectTimer = null;
    if (entry.closedByUs || activeRemoteSessions.get(sessionId) !== entry) return;
    // Snapshot the flushed-event count BEFORE reconnecting (disk only, no relay
    // call) so we know which events to top-up-emit once the stream is back.
    let preDropCount = 0;
    try { preDropCount = (await getSessionEventsCached(sessionId, { topUp: false })).length; } catch { /* 0 → capped emit */ }
    try {
      await openRemoteUpstream(sessionId, entry);
      entry.retries = 0;
      console.log('[rc] upstream reconnected', { sessionId });
      await emitMissedEventsAfterReconnect(sessionId, entry, preDropCount);
      // A question/permission asked during the gap would otherwise be invisible.
      const out = activeRemoteSessions.get(sessionId)?.ws || entry.ws;
      try { await emitOutstandingPermission(sessionId, out); } catch { /* non-fatal */ }
    } catch {
      scheduleRemoteReconnect(sessionId, entry);
    }
  }, delay);
}

/**
 * Open (or reopen) the upstream relay subscription for `entry` and wire all
 * handlers. Resolves when the socket is open; rejects on a failed dial. Shared by
 * the initial attach and the transparent reconnect path.
 */
async function openRemoteUpstream(sessionId, entry) {
  // Subscribe as the account that owns this session (falls back to the sole/first
  // account for a single-account deployment or a still-unresolved cold id).
  const account = (await resolveAccountForSession(sessionId)) || getAccounts()[0] || {};
  const { token, orgUuid } = account;
  entry.accountLabel = account.label;
  const url = `${WS_BASE}/v1/sessions/ws/${sessionId}/subscribe?organization_uuid=${orgUuid}`;
  const upstream = new WebSocket(url, {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-version': ANTHROPIC_VERSION },
  });
  entry.upstream = upstream;

  // Keepalive + dead-socket detection (standard ws heartbeat): a silently-dead
  // TCP connection emits nothing — without pinging, the stream just stops and the
  // GUI never learns. If a pong doesn't come back within one interval, terminate;
  // that fires 'close' and the reconnect path below restores the stream.
  entry.alive = true;
  upstream.on('pong', () => { entry.alive = true; });
  entry.pingTimer = setInterval(() => {
    if (upstream.readyState !== WebSocket.OPEN) return;
    if (!entry.alive) {
      try { upstream.terminate(); } catch { /* already dead */ }
      return;
    }
    entry.alive = false;
    try { upstream.ping(); } catch { /* close handler takes over */ }
  }, RC_PING_INTERVAL_MS);

  // Stall watchdog (see syncStalledUpstream). Runs for the ENTRY, not the socket:
  // deliberately NOT cleared in the transient-close handler, so while the reconnect
  // loop is still dialing, events keep reaching the GUI over HTTP. Self-cancels once
  // the entry is detached/superseded; idle sessions (turnOpen=false) cost nothing.
  if (entry.stallTimer) clearInterval(entry.stallTimer);
  entry.stallTimer = setInterval(() => {
    if (entry.closedByUs || activeRemoteSessions.get(sessionId) !== entry) {
      clearInterval(entry.stallTimer);
      entry.stallTimer = null;
      return;
    }
    const now = Date.now();
    if (entry.turnOpen) {
      // Mid-turn: a working agent emits constantly, so a quiet socket past the
      // threshold is suspect — cross-check the events API (original behaviour).
      if (now - (entry.lastUpstreamAt || 0) < RC_STALL_QUIET_MS) return;
    } else {
      // Idle: quiet is normal, so quiet-time proves nothing — instead probe the
      // events API on a slow cadence to catch a turn started OUTSIDE the GUI on a
      // silently-stale socket (the turnOpen-gated check never fires for those).
      // Only while someone is actually watching; a viewer-less entry can wait for
      // the rebind sync in attachSession. Healthy+idle cost: one cursor GET
      // returning nothing per interval. Recent socket delivery defers the probe.
      if (liveWriters(entry).length === 0) return;
      const lastSignal = Math.max(entry.lastUpstreamAt || 0, entry.lastStallSyncAt || 0);
      if (now - lastSignal < RC_IDLE_SYNC_MS) return;
    }
    void syncStalledUpstream(sessionId, entry);
  }, RC_STALL_CHECK_MS);

  upstream.on('message', (data) => {
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    // Feed the stall watchdog: the socket is demonstrably delivering. Remember the
    // event uuid so a later events-API top-up can tell "the socket missed this" from
    // "the cache is just behind the live stream". `result` closes the turn; an ack
    // frame opens nothing; everything else means the agent is mid-turn.
    entry.lastUpstreamAt = Date.now();
    if (m.uuid) {
      entry.seenEventUuids.add(m.uuid);
      if (entry.seenEventUuids.size > RC_SEEN_UUIDS_MAX) {
        entry.seenEventUuids.delete(entry.seenEventUuids.values().next().value);
      }
    }
    if (m.type === 'result') entry.turnOpen = false;
    else if (m.type !== 'control_response' && !isCommandRecordEvent(m)) entry.turnOpen = true;
    // Always write to the CURRENT subscriber set (rebound/extended on reconnect),
    // never just the writer captured when this upstream first opened.
    const e0 = activeRemoteSessions.get(sessionId) || entry;
    // emit = send to EVERY live subscriber AND retain in the per-session replay
    // buffer so a reconnecting client recovers it. Transient per-token thinking
    // frames are sent but NOT buffered (the client re-derives the indicator).
    const emit = (frame) => {
      pushReplayFrame(e0, frame);
      fanOut(e0, frame);
    };

    // Live "thinking" progress. claude.ai/code shows a working indicator driven by
    // these frames (a running token estimate) while the model thinks. Translate it
    // into the GUI's per-session processing signal so the loader reflects the turn
    // live — gated to the viewed session on the client, and cleared by `result`
    // below. These frames are live-only; history never sees them.
    if (m.type === 'system' && m.subtype === 'thinking_tokens') {
      fanOut(e0, { type: 'session-status', sessionId, isProcessing: true });
      return;
    }

    // Permission prompt — the agent wants to use a tool; relay to the GUI's
    // existing permission UI. `rc:` prefixes the id so the answer routes back here.
    if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') {
      const rawId = m.request_id || crypto.randomUUID();
      pendingRemotePermissions.set(rawId, { sessionId });
      emit(createNormalizedMessage({
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
      emit(createNormalizedMessage({ kind: 'permission_cancelled', requestId: m.request_id, sessionId, provider: 'claude' }));
      return;
    }
    if (m.type === 'control_response') return; // ack frame — nothing to render

    // Subagent-internal event: the relay streams a Task subagent's OWN messages
    // (its prompt, thinking, tool calls, result) inline, each tagged with the
    // parent Task's tool_use_id. Locally these live in a separate agent-*.jsonl
    // and are folded under the Task tool — never shown as top-level conversation.
    // Emitting them here made the subagent's prompt look like a user message and
    // its thoughts appear unsolicited. Drop them; the parent Task tool_use + its
    // result (both un-parented) still render the container.
    if (m.parent_tool_use_id) return;

    // Everything else is a Claude Agent SDK message — normalize via the injected
    // provider normalizer (kept out of this engine so it stays provider-agnostic).
    if (entry.normalize) {
      try {
        const normalized = entry.normalize(m, sessionId) || [];
        for (const frame of normalized) emit(frame);
      } catch (err) {
        emit(createNormalizedMessage({ kind: 'error', content: `rc normalize: ${err.message}`, sessionId, provider: 'claude' }));
      }
    }
    // End-of-TURN: a `result` SDK message means the agent finished this turn. The
    // WS stays open across turns, so translate it into a per-turn `complete` so the
    // GUI finalizes streaming and clears the "working" state (the session lives on).
    // We ALWAYS fire complete on a result: every `result` we receive is live (the
    // relay replays NOTHING on subscribe — verified), so there is no stale replayed
    // result to suppress. The old `turnActive` guard dropped legitimate end-of-turn
    // results whenever it happened to be false, which left the loader stuck "working"
    // after the agent had stopped. Keeping it off is what keeps the loader in sync.
    if (m.type === 'result') {
      const e = activeRemoteSessions.get(sessionId);
      // Clear the buffer BEFORE emitting so the `complete` frame itself lands in the
      // fresh buffer: a client whose WS was down at turn end still learns the turn is
      // over when it rebinds (its missed content comes from the history refetch).
      // Clearing after the emit threw the turn-end signal away with the old turn's
      // frames — a rebound client then sat on a stuck "working" loader forever.
      if (e) e.replayBuffer = [];
      emit(createNormalizedMessage({ kind: 'complete', exitCode: 0, sessionId, provider: 'claude' }));
    }

    // A driven local command (/clear, /model, …) never produces a `result`: the
    // CLI acks with record events only. The sender's client armed its loader on
    // send and only `complete` clears it — without this, the loader spins until
    // the NEXT turn ends. The ack arrives as a small burst of records, so
    // debounce and only fire if no real turn opened meanwhile.
    if (isCommandRecordEvent(m) && !entry.turnOpen) {
      if (entry.commandAckTimer) clearTimeout(entry.commandAckTimer);
      entry.commandAckTimer = setTimeout(() => {
        entry.commandAckTimer = null;
        const e = activeRemoteSessions.get(sessionId);
        if (!e || e !== entry || e.turnOpen) return;
        emit(createNormalizedMessage({ kind: 'complete', exitCode: 0, sessionId, provider: 'claude' }));
      }, 1200);
    }
  });

  upstream.on('close', (code) => {
    if (entry.pingTimer) { clearInterval(entry.pingTimer); entry.pingTimer = null; }
    // Deliberate detach (or a superseded entry) — no signal, no reconnect.
    if (entry.closedByUs || activeRemoteSessions.get(sessionId) !== entry) return;
    if (code === 4003) {
      // Unauthorized: permanent. Tell the GUI the stream ended and drop the entry.
      activeRemoteSessions.delete(sessionId);
      fanOut(entry, createNormalizedMessage({ kind: 'complete', exitCode: 1, sessionId, provider: 'claude' }));
      return;
    }
    // Transient close (idle timeout, relay blip, dead TCP detected by the
    // heartbeat): keep the entry (writer + replay buffer stay bound) and reopen in
    // the background. No `complete` is sent — a mid-turn close would otherwise
    // wrongly clear the working indicator that the reconnected stream continues.
    console.log('[rc] upstream closed, scheduling reconnect', { sessionId, code });
    scheduleRemoteReconnect(sessionId, entry);
  });
  upstream.on('error', (err) => {
    // Logged, not surfaced: with auto-reconnect a transient socket error is an
    // implementation detail — an error bubble in the chat would be noise.
    console.error('[rc] upstream ws error', { sessionId, error: err.message });
  });

  await new Promise((resolve, reject) => {
    upstream.once('open', resolve);
    upstream.once('error', reject);
  });
}

/**
 * Surface a tool-permission / AskUserQuestion the agent is STILL waiting on RIGHT
 * NOW, when the GUI subscribes after it was asked. The relay replays nothing on
 * subscribe (verified) and the live `control_request` fired before we attached, so
 * without this the GUI shows only the read-only transcript copy with no way to
 * answer. We reconstruct the live request from history and emit the same
 * `permission_request` the live path would, registering its request_id — the relay
 * accepts that id for the control_response (verified: answering by it unblocked a
 * stuck agent). Idempotent: the client dedups pending requests by requestId.
 *
 * CRITICAL liveness guard: only the agent's CURRENT block counts. A `can_use_tool`
 * tool_use can be left unanswered in history forever — the user answered it in the
 * agent's own terminal, or the turn was interrupted — yet the agent has long moved
 * on (it's idle, thousands of events later). Re-surfacing such a dangling question
 * re-asks a DEAD question on every open, and the answer can never resolve it (the
 * relay no longer honors that id) → an infinite re-ask loop. So we take ONLY the
 * most-recent control_request and require it to be both unanswered AND the tail of
 * the transcript — no `result` (turn end) after it. Anything with a later result is
 * a finished turn, not a live block.
 */
export async function emitOutstandingPermission(sessionId, ws) {
  let events;
  try { events = await getSessionEventsCached(sessionId); } catch { return false; }
  if (!Array.isArray(events) || events.length === 0) return false;

  // Find the most-recent can_use_tool control_request (its position matters) and
  // the set of tool_use_ids that already have a tool_result.
  let last = null;
  let lastIdx = -1;
  const answered = new Set();
  events.forEach((e, i) => {
    if (e?.type === 'control_request' && e.request?.subtype === 'can_use_tool' && e.request?.tool_use_id) {
      last = {
        requestId: e.request_id,
        toolName: e.request.tool_name,
        input: e.request.input,
        toolUseId: e.request.tool_use_id,
      };
      lastIdx = i;
    }
    const content = e?.message?.content;
    if (Array.isArray(content)) {
      for (const b of content) if (b?.type === 'tool_result' && b.tool_use_id) answered.add(b.tool_use_id);
    }
  });
  if (!last || !last.requestId) return false;

  // Already answered by this GUI? The tool_result may not be recorded yet, but we
  // know it's resolved — don't re-surface it (prevents the answer-window flicker /
  // "asking again"). Opportunistically prune the TTL map.
  const answeredAt = answeredRemotePermissions.get(last.requestId);
  if (answeredAt) {
    if (Date.now() - answeredAt < ANSWERED_PERMISSION_TTL_MS) return false;
    answeredRemotePermissions.delete(last.requestId);
  }

  // Liveness: unanswered AND nothing terminal after it. A `result` (or the question
  // already having a tool_result) means the turn finished — the question is stale.
  if (answered.has(last.toolUseId)) return false;
  for (let i = lastIdx + 1; i < events.length; i++) {
    if (events[i]?.type === 'result') return false;
  }
  const open = last;

  pendingRemotePermissions.set(open.requestId, { sessionId });
  const frame = createNormalizedMessage({
    kind: 'permission_request',
    requestId: `rc:${open.requestId}`,
    toolName: open.toolName,
    input: open.input,
    sessionId,
    provider: 'claude',
  });
  const entry = activeRemoteSessions.get(sessionId);
  if (entry) {
    pushReplayFrame(entry, frame);
  }
  try { ws.send(frame); } catch { /* writer race — next subscribe retries */ }
  return true;
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
  // The buffered turn-end `complete` of the PREVIOUS turn must not replay into a
  // view that is about to start a new one — it landed ~200ms after the tap and
  // cleared the just-armed loader. Purge before attach flushes the replay buffer.
  const pre = activeRemoteSessions.get(sessionId);
  if (pre && Array.isArray(pre.replayBuffer)) {
    pre.replayBuffer = pre.replayBuffer.filter((f) => f?.kind !== 'complete');
  }
  await attachSession(sessionId, ws, normalize);
  const content = toUserContent(command, images);
  const hasContent = typeof content === 'string' ? content !== '' : content.length > 0;
  if (hasContent) {
    const sent = await sendMessage(sessionId, content);
    if (sent.ok) {
      // Open the turn for the stall watchdog: if the subscribe socket is dead from
      // the start, NOTHING ever streams — the watchdog is then the only path that
      // gets the reply (and the turn-end) to the GUI without a manual refresh.
      const e = activeRemoteSessions.get(sessionId);
      if (e) {
        e.turnOpen = true;
        e.lastUpstreamAt = Math.max(e.lastUpstreamAt || 0, Date.now());
      }
    }
    if (!sent.ok) {
      const reason = sent.notActive
        ? 'This agent is offline — its session is archived or disconnected and can’t receive messages. Start/reconnect the agent, then try again.'
        : 'Couldn’t deliver the message to the agent (the relay rejected it). Please try again.';
      ws.send(createNormalizedMessage({ kind: 'error', content: reason, sessionId, provider: 'claude' }));
    }
  }
  return { sessionId };
}

/** Answer a permission prompt: send a control_response up the WS. requestId may carry the `rc:` prefix. */
export function resolveRemotePermission(requestId, decision) {
  const rawId = requestId.startsWith('rc:') ? requestId.slice('rc:'.length) : requestId;
  const pending = pendingRemotePermissions.get(rawId);
  if (!pending) return false;
  pendingRemotePermissions.delete(rawId);
  // Remember we answered this so a re-subscribe during the result-write window can't
  // re-surface it, and drop the buffered permission_request so a reconnect replay
  // doesn't re-show the now-answered question.
  answeredRemotePermissions.set(rawId, Date.now());
  const entry = activeRemoteSessions.get(pending.sessionId);
  if (!entry || entry.upstream.readyState !== WebSocket.OPEN) return false;
  if (Array.isArray(entry.replayBuffer)) {
    entry.replayBuffer = entry.replayBuffer.filter((f) => f?.requestId !== `rc:${rawId}`);
  }
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
  if (!entry || entry.upstream?.readyState !== WebSocket.OPEN) return false;
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
  // Deliberate close: suppress the reconnect path and stop the timers.
  entry.closedByUs = true;
  if (entry.reconnectTimer) { clearTimeout(entry.reconnectTimer); entry.reconnectTimer = null; }
  if (entry.pingTimer) { clearInterval(entry.pingTimer); entry.pingTimer = null; }
  if (entry.stallTimer) { clearInterval(entry.stallTimer); entry.stallTimer = null; }
  try { entry.upstream?.close(); } catch { /* noop */ }
  activeRemoteSessions.delete(sessionId);
  return true;
}

export function isActiveRemoteSession(sessionId) {
  return activeRemoteSessions.has(sessionId);
}
