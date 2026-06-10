#!/usr/bin/env node
// rc-send.mjs — agent-to-agent messaging over Anthropic's Remote Control relay (CCR v2).
//
// Any agent/script running under the operator's account can reach + write to another
// `claude --remote-control` agent with ZERO infra: no CCUI server, no daemon, no
// channel-shim. It piggybacks on the same Anthropic API the CCUI Agents tab uses
// (see server/remote-control/rc-client.js). Self-contained — only needs node + the
// operator's claude.ai OAuth on this machine.
//
// Usage:
//   node rc-send.mjs <name-substring> "<message>"            # fire-and-forget
//   node rc-send.mjs <name-substring> "<message>" --wait 30  # wait up to 30s, print reply
//
// The message lands in the target agent's REAL session — it sees it as a normal user
// prompt (same session a human drives in the GUI or the terminal).

import { readFileSync } from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';

const BASE = process.env.RC_BASE_URL || 'https://api.anthropic.com';
const BETA = 'ccr-byoc-2025-07-29';

function auth() {
  const token =
    process.env.RC_OAUTH_TOKEN ||
    JSON.parse(readFileSync(`${os.homedir()}/.claude/.credentials.json`, 'utf8')).claudeAiOauth?.accessToken;
  const org =
    process.env.RC_ORG_UUID ||
    JSON.parse(readFileSync(`${os.homedir()}/.claude.json`, 'utf8')).oauthAccount?.organizationUuid;
  if (!token) throw new Error('no claude.ai OAuth token (run `claude` /login on this account)');
  return { token, org };
}
function H({ token, org }, withOrg) {
  const h = { Authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'anthropic-beta': BETA };
  if (withOrg && org) h['x-organization-uuid'] = org;
  return h;
}

// List ALL connected agents — page through /v1/code/sessions via `cursor` (it returns
// ~20 most-recent-first per page), so an idle-but-connected agent isn't missed.
async function listConnected(a) {
  const all = [];
  let cursor = null;
  for (let i = 0; i < 8; i++) {
    const url = `${BASE}/v1/code/sessions?limit=200` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const r = await fetch(url, { headers: H(a) });
    if (!r.ok) throw new Error(`list sessions ${r.status}`);
    const j = await r.json();
    all.push(...(j.data || []));
    cursor = j.next_cursor;
    if (!cursor || !(j.data || []).length) break;
  }
  return all.filter((s) => s.connection_status === 'connected' && !s.environment_id);
}

async function findAgent(a, pattern) {
  const live = await listConnected(a);
  const hits = live.filter((s) => (s.title || '').toLowerCase().includes(pattern.toLowerCase()));
  if (hits.length === 0) throw new Error(`no connected agent matching "${pattern}". Live: ${live.map((s) => (s.title || '').split('\n')[0]).join(', ')}`);
  if (hits.length > 1) throw new Error(`ambiguous "${pattern}" → ${hits.map((s) => s.title.split('\n')[0]).join(', ')}`);
  return { id: hits[0].id, title: hits[0].title.split('\n')[0] };
}

async function send(a, sessionId, content) {
  const event = { uuid: crypto.randomUUID(), session_id: sessionId, type: 'user', parent_tool_use_id: null, message: { role: 'user', content } };
  const r = await fetch(`${BASE}/v1/sessions/${sessionId}/events`, { method: 'POST', headers: H(a, true), body: JSON.stringify({ events: [event] }) });
  if (!r.ok) throw new Error(`send ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

// Poll for the assistant reply that lands AFTER `sinceId` (the last event before we sent).
async function waitReply(a, sessionId, sinceId, sec) {
  const deadline = Date.now() + sec * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    // sinceId is null when the session had no events before we sent (fresh agent) —
    // omit after_id entirely then (a literal `after_id=null` is rejected by the API).
    const url = `${BASE}/v1/sessions/${sessionId}/events?limit=100` + (sinceId ? `&after_id=${sinceId}` : '');
    const r = await fetch(url, { headers: H(a, true) });
    if (!r.ok) continue;
    const evs = (await r.json()).data || [];
    const texts = evs.filter((e) => e.type === 'assistant')
      .flatMap((e) => Array.isArray(e.message?.content) ? e.message.content.filter((c) => c.type === 'text').map((c) => c.text) : [])
      .filter(Boolean);
    if (texts.length) return texts.join('\n');
  }
  return null;
}

// The TRUE newest event id (events paginate oldest-first; page to the end).
async function newestId(a, sessionId) {
  let after = null, last = null;
  for (let i = 0; i < 60; i++) {
    const url = `${BASE}/v1/sessions/${sessionId}/events?limit=100` + (after ? `&after_id=${after}` : '');
    const r = await fetch(url, { headers: H(a, true) });
    if (!r.ok) break;
    const j = await r.json();
    if (j.last_id) last = j.last_id;
    if (!j.has_more || !j.last_id) break;
    after = j.last_id;
  }
  return last;
}

const [pattern, message, ...rest] = process.argv.slice(2);
if (!pattern || !message) { console.error('usage: rc-send.mjs <name-substring> "<message>" [--wait <sec>]'); process.exit(2); }
const waitIdx = rest.indexOf('--wait');
const waitSec = waitIdx >= 0 ? Number(rest[waitIdx + 1] || 30) : 0;

const a = auth();
const agent = await findAgent(a, pattern);
// remember the newest event id before sending, so we only read the NEW reply
const lastId = waitSec > 0 ? await newestId(a, agent.id) : null;
await send(a, agent.id, message);
console.error(`→ sent to ${agent.title} (${agent.id})`);
if (waitSec > 0) {
  const reply = await waitReply(a, agent.id, lastId, waitSec);
  if (reply) console.log(reply);
  else { console.error(`(no reply within ${waitSec}s)`); process.exit(1); }
}
