#!/usr/bin/env node
/**
 * MyMu demo server — a FAKE claudecodeui-compatible backend.
 *
 * Purpose: give the App Store reviewer (and anyone curious) a safe place to log
 * in with ANY username/password and see a populated, working MyMu — WITHOUT
 * touching the real code.kaxtus.com fleet. Everything here is canned; no real
 * agents, no shell, no Anthropic. Intended to sit behind demo.proagenten.com.
 *
 * Implements only the subset of the API the iOS app calls:
 *   POST /api/auth/login                                  -> any creds accepted
 *   GET  /api/auth/status
 *   GET  /api/projects  /api/projects/archived
 *   GET  /api/projects/agent-status
 *   GET  /api/providers/sessions/:id/messages
 *   GET  /api/projects/:id/files  /api/projects/:id/file
 *   WS   /ws   (rc-subscribe, claude-command -> streamed canned reply)
 *
 * Zero secrets. One dependency: ws.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const nowISO = () => new Date().toISOString();

// MyMu privacy policy (served here so its URL is on the proagenten front).
let PRIVACY_HTML = '<h1>MyMu Privacy Policy</h1>';
try { PRIVACY_HTML = fs.readFileSync(path.join(__dirname, 'privacy.html'), 'utf8'); } catch {}

// ---- fixtures -------------------------------------------------------------

const REMOTE_SESSION = 'demo-remote-1';
const LOCAL_SESSION = 'demo-local-1';

// Turns the reviewer sends during their session, per sessionId. The iOS app
// refetches history right after a reply completes (end-of-turn reconcile); if
// that refetch didn't include the just-sent turn the reply would flash and then
// vanish. Persisting turns here makes the demo behave like a real server.
const liveTurns = Object.create(null);
let seq = 0;

function projects() {
  return [
    {
      projectId: 'remote:demo-agent',
      displayName: 'demo-agent',
      fullPath: null, path: null, isStarred: true, sessions: [],
      isRemoteAgent: true,
      remoteSessionId: REMOTE_SESSION,
      remoteConnected: true,
      remoteRunning: false,
    },
    {
      projectId: 'demo-hello-world',
      displayName: 'hello-world',
      fullPath: '/home/demo/hello-world',
      path: '/home/demo/hello-world',
      isStarred: false,
      isRemoteAgent: false,
      sessions: [{
        id: LOCAL_SESSION, title: 'Add a README', summary: null, name: null,
        lastActivity: nowISO(), updated_at: nowISO(), created_at: nowISO(),
        createdAt: nowISO(), messageCount: 6,
      }],
    },
  ];
}

function history(sessionId) {
  const base = [
    { id: 'm1', kind: 'text', role: 'user', content: 'Add a README with a quick-start section.' },
    { id: 'm2', kind: 'text', role: 'assistant',
      content: "Sure — I'll create `README.md` with an overview and a quick-start." },
    { id: 'm3', kind: 'tool_use', role: 'assistant', toolName: 'Write',
      toolInput: { file_path: 'README.md', content: '# hello-world\n\nA tiny demo project.' } },
    { id: 'm4', kind: 'tool_result', role: 'assistant', content: 'File created: README.md' },
    { id: 'm5', kind: 'text', role: 'assistant',
      content: 'Done. `README.md` now has an overview and a quick-start section. Anything else?' },
  ];
  const extra = (sessionId && liveTurns[sessionId]) || [];
  const msgs = base.concat(extra);
  return {
    messages: msgs, total: msgs.length, hasMore: false, offset: 0, limit: 200,
    context: { usedTokens: 18450, windowTokens: 200000 },
    turnStartedAt: null, turnStartContextTokens: null,
  };
}

function fileTree() {
  return [
    { name: 'README.md', path: 'README.md', type: 'file', size: 214, children: null, truncated: null },
    { name: 'src', path: 'src', type: 'directory', size: null, truncated: false, children: [
      { name: 'index.js', path: 'src/index.js', type: 'file', size: 96, children: null, truncated: null },
    ]},
  ];
}

// ---- REST -----------------------------------------------------------------

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;

  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  if (req.method === 'POST' && p === '/api/auth/login') {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      let username = 'demo';
      try { username = JSON.parse(raw || '{}').username || 'demo'; } catch {}
      sendJSON(res, 200, { success: true, token: 'demo-token', user: { id: 1, username } });
    });
    return;
  }
  if (p === '/api/auth/status') return sendJSON(res, 200, { user: { id: 1, username: 'demo' } });
  if (p === '/api/projects') return sendJSON(res, 200, { projects: projects() });
  if (p === '/api/projects/archived') return sendJSON(res, 200, { projects: [] });
  if (p === '/api/projects/agent-status')
    return sendJSON(res, 200, { agents: [{ id: 'remote:demo-agent', running: false, connected: true }] });
  {
    const mm = p.match(/^\/api\/providers\/sessions\/([^/]+)\/messages$/);
    if (mm) return sendJSON(res, 200, history(decodeURIComponent(mm[1])));
  }
  if (/^\/api\/projects\/[^/]+\/files$/.test(p)) return sendJSON(res, 200, fileTree());
  if (/^\/api\/projects\/[^/]+\/file$/.test(p))
    return sendJSON(res, 200, { content: '# hello-world\n\nA tiny demo project.\n' });

  if (p === '/privacy' || p === '/privacy.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PRIVACY_HTML);
    return;
  }
  if (p === '/' || p === '/healthz') { res.writeHead(200).end('MyMu demo server — ok'); return; }
  sendJSON(res, 404, { error: 'not found' });
});

// ---- WebSocket (/ws) ------------------------------------------------------

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const send = (o) => { try { ws.send(JSON.stringify(o)); } catch {} };

  ws.on('message', (data) => {
    let msg = {};
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'rc-subscribe') {
      send({ type: 'session-status', isProcessing: false });
      return;
    }
    if (msg.type === 'claude-command') {
      // Echo the user's line, then stream a short canned assistant reply.
      const reply = "This is the MyMu demo backend — everything here is sample " +
                    "data. Point the app at your own Claude Code UI server to drive real agents.";
      // Persist the turn so the app's end-of-turn history refetch keeps it (see
      // liveTurns) instead of wiping the reply back to the base transcript.
      const sid = (msg.options && (msg.options.sessionId || msg.options.remoteControl)) || LOCAL_SESSION;
      const userText = (msg.command || '').toString();
      (liveTurns[sid] || (liveTurns[sid] = [])).push(
        { id: 'u' + (++seq), kind: 'text', role: 'user', content: userText },
        { id: 'a' + (++seq), kind: 'text', role: 'assistant', content: reply },
      );
      send({ kind: 'status', text: 'Thinking…' });
      const words = reply.split(' ');
      let i = 0;
      const tick = setInterval(() => {
        if (i >= words.length) {
          clearInterval(tick);
          send({ kind: 'complete', contextTokens: 18600 });
          return;
        }
        send({ kind: 'stream_delta', content: (i === 0 ? '' : ' ') + words[i], contextTokens: 18500 + i });
        i++;
      }, 60);
      return;
    }
    if (msg.type === 'abort-session') { send({ kind: 'complete' }); return; }
  });
});

server.listen(PORT, () => console.log(`MyMu demo server on :${PORT}`));
