// control-channel.js — hybrid bridge: drive a LIVE `claude --remote-control`
// session (via plugin:control@kaxtus) from the claudecodeui UI, instead of the
// Agent SDK spawning/owning a session.
//
// Seam: chat-websocket dispatch routes a `claude-command` here when the target
// session is the one our control plugin reports (see isControlSession). We then:
//   1. POST the prompt to the plugin's /prompt  (-> injected into the live session)
//   2. tail that session's transcript JSONL and feed each new record through
//      claudecodeui's OWN claude normalizer, so responses render natively.
//
// Config (env): CCUI_CONTROL_URL (default http://127.0.0.1:8787), CCUI_CONTROL_TOKEN.
// The plugin's bind/port/token live in ~/.vault/control-plugin.env on the host.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { sessionsService } from './modules/providers/services/sessions.service.js';
import { createNormalizedMessage } from './shared/utils.js';

function cfg() {
  return {
    url: (process.env.CCUI_CONTROL_URL || 'http://127.0.0.1:8787').replace(/\/+$/, ''),
    token: process.env.CCUI_CONTROL_TOKEN || '',
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Find a session's transcript by globbing the session id across project dirs —
// avoids reproducing claude's cwd-sanitization.
function findTranscript(sessionId) {
  const base = path.join(os.homedir(), '.claude', 'projects');
  let dirs;
  try {
    dirs = fs.readdirSync(base);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const p = path.join(base, d, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// The control plugin's /health reports the LIVE session it is attached to:
// { session, cwd }. Cached briefly so we don't hammer it on every keystroke.
let healthCache = { at: 0, session: null, cwd: null };
async function liveHealth() {
  const { url, token } = cfg();
  if (!token) return { session: null, cwd: null };
  const now = Date.now();
  if (now - healthCache.at > 3000) {
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
      const j = r.ok ? await r.json() : {};
      healthCache = { at: now, session: j.session || null, cwd: j.cwd || null };
    } catch {
      healthCache = { at: now, session: null, cwd: null };
    }
  }
  return healthCache;
}

function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => path.resolve(p).replace(/\/+$/, '');
  return norm(a) === norm(b);
}

// A chat is "control-driven" when its working dir (the claudecodeui project) is
// the live agent's cwd, OR its sessionId is the live session. claudecodeui often
// starts a fresh SDK session id on send, so cwd is the reliable signal.
export async function isControlSession(sessionId, cwd) {
  const { token } = cfg();
  if (!token) return false;
  const h = await liveHealth();
  if (!h.session) return false;
  if (sessionId && h.session === sessionId) return true;
  if (cwd && samePath(cwd, h.cwd)) return true;
  return false;
}

export async function queryControlChannel(command, options = {}, ws) {
  const { url, token } = cfg();

  // Always target the LIVE session the plugin reports — claudecodeui may pass a
  // different/new session id, but the agent we inject into is the one on /health.
  const h = await liveHealth();
  const sessionId = h.session;
  if (!sessionId) {
    ws.send(createNormalizedMessage({ kind: 'error', content: 'control plugin reports no live session', sessionId: '', provider: 'claude' }));
    ws.send(createNormalizedMessage({ kind: 'complete', exitCode: 1, sessionId: '', provider: 'claude' }));
    return;
  }

  // Only stream records appended AFTER our injection.
  const transcript = findTranscript(sessionId);
  let offset = transcript ? fs.statSync(transcript).size : 0;
  let buf = '';

  // 1. inject the prompt into the live session
  try {
    const res = await fetch(`${url}/prompt`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        content: command,
        meta: { origin: 'claudecodeui', user: ws?.userId ? String(ws.userId) : 'ccui' },
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      ws.send(createNormalizedMessage({ kind: 'error', content: `control inject failed (${res.status}): ${t}`, sessionId, provider: 'claude' }));
      ws.send(createNormalizedMessage({ kind: 'complete', exitCode: 1, sessionId, provider: 'claude' }));
      return;
    }
  } catch (e) {
    ws.send(createNormalizedMessage({ kind: 'error', content: `control plugin unreachable: ${e?.message || e}`, sessionId, provider: 'claude' }));
    ws.send(createNormalizedMessage({ kind: 'complete', exitCode: 1, sessionId, provider: 'claude' }));
    return;
  }

  // 2. tail the transcript until the assistant turn ends (or we time out)
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await sleep(400);
    const p = transcript || findTranscript(sessionId);
    if (!p) continue;
    let sz;
    try {
      sz = fs.statSync(p).size;
    } catch {
      continue;
    }
    if (sz < offset) { offset = 0; buf = ''; } // rotated/truncated
    if (sz <= offset) continue;

    let chunk;
    try {
      const fd = fs.openSync(p, 'r');
      const b = Buffer.allocUnsafe(sz - offset);
      fs.readSync(fd, b, 0, sz - offset, offset);
      fs.closeSync(fd);
      chunk = b.toString('utf8');
    } catch {
      continue;
    }
    offset = sz;
    buf += chunk;

    let nl;
    let done = false;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.sessionId && sessionId && entry.sessionId !== sessionId) continue;
      // Reuse claudecodeui's own claude normalizer (same path its history reader
      // uses), so the UI renders these exactly like a native claude session.
      try {
        const normalized = sessionsService.normalizeMessage('claude', entry, sessionId);
        if (Array.isArray(normalized)) for (const m of normalized) ws.send(m);
      } catch {
        // shape mismatch on an exotic record — skip it, keep streaming
      }
      if (entry.type === 'assistant') {
        const sr = entry.message?.stop_reason;
        if (sr && sr !== 'tool_use') done = true; // turn finished
      }
    }
    if (done) break;
  }

  ws.send(createNormalizedMessage({ kind: 'complete', exitCode: 0, sessionId, provider: 'claude' }));
}
