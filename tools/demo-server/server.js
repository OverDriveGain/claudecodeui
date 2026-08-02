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
 *   POST /api/providers/sessions                          -> session pre-create (build 11+)
 *   GET  /api/projects/:id/files  /api/projects/:id/file  /api/projects/:id/files/content
 *   GET  /api/file-tree/projects/:id/…                    -> rewritten onto the above (build 11+)
 *   POST /api/assets/images  /api/assets/files            -> composer attachments
 *   GET  /api/assets/images/:name  /api/assets/files/:name-> serves them back
 *   GET  /api/version                                     -> shown in the accounts sheet
 *   GET  /api/agent-hosts                                 -> no pinning in the demo
 *   WS   /ws   chat.subscribe / chat.send / chat.abort    (build 11+ stock dialect)
 *              rc-subscribe / claude-command              (legacy — published 1.0, still live)
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
const BUILT_AT = nowISO();

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

// ---- attachment store -----------------------------------------------------
//
// The app uploads composer attachments before it sends, then references them by
// path (the stock claudecodeui flow). Without these routes the upload 404s and
// the whole send fails, so a reviewer attaching a photo hits a dead end. Bytes
// are held in memory only — the demo never writes to disk — and the newest
// uploads evict the oldest so a long session can't grow without bound.

const assets = new Map(); // filename -> { buffer, mimeType, name }
const MAX_ASSETS = 40;

function putAsset(filename, record) {
  assets.set(filename, record);
  while (assets.size > MAX_ASSETS) assets.delete(assets.keys().next().value);
}

/**
 * Minimal multipart/form-data reader — enough for the app's uploads, which send
 * one part per file. Returns [{ field, filename, contentType, body }].
 */
function parseMultipart(buffer, boundary) {
  const parts = [];
  const delimiter = Buffer.from(`--${boundary}`);
  const positions = [];
  let at = buffer.indexOf(delimiter);
  while (at !== -1) {
    positions.push(at);
    at = buffer.indexOf(delimiter, at + delimiter.length);
  }
  for (let i = 0; i < positions.length - 1; i++) {
    // Skip the delimiter and its trailing CRLF, then split headers from body.
    const start = positions[i] + delimiter.length + 2;
    const end = positions[i + 1];
    if (start >= end) continue;
    const chunk = buffer.subarray(start, end);
    const split = chunk.indexOf('\r\n\r\n');
    if (split === -1) continue;
    const headers = chunk.subarray(0, split).toString('utf8');
    const disposition = /name="([^"]*)"(?:;\s*filename="([^"]*)")?/i.exec(headers);
    const type = /content-type:\s*([^\r\n]+)/i.exec(headers);
    parts.push({
      field: disposition ? disposition[1] : '',
      filename: disposition && disposition[2] ? disposition[2] : null,
      contentType: type ? type[1].trim() : 'application/octet-stream',
      // Drop the trailing CRLF, which belongs to the next delimiter, not the file.
      body: chunk.subarray(split + 4, chunk.length - 2),
    });
  }
  return parts;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * Stores the uploaded parts and answers in the shape the app decodes:
 * `{ images: [...] }` for the images route, `{ attachments: [...] }` otherwise.
 */
async function handleAssetUpload(req, res, field) {
  const contentType = req.headers['content-type'] || '';
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!boundary) return sendJSON(res, 400, { error: 'expected multipart/form-data' });

  const parts = parseMultipart(await readBody(req), (boundary[1] || boundary[2]).trim());
  const records = parts
    .filter((part) => part.filename)
    .map((part) => {
      const safe = String(part.filename).replace(/[^\w.\-]+/g, '_').slice(0, 80) || 'file';
      const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}-${safe}`;
      putAsset(filename, { buffer: part.body, mimeType: part.contentType, name: part.filename });
      return {
        name: part.filename,
        // Mirrors the real store's absolute path; the demo only ever echoes it back.
        path: `/home/demo/.cloudcli/assets/${filename}`,
        size: part.body.length,
        mimeType: part.contentType,
      };
    });

  if (records.length === 0) return sendJSON(res, 400, { error: 'no files provided' });
  return sendJSON(res, 200, field === 'images' ? { images: records } : { attachments: records });
}

function serveAsset(res, filename) {
  const asset = assets.get(filename);
  if (!asset) return sendJSON(res, 404, { error: 'asset not found' });
  res.writeHead(200, {
    'Content-Type': asset.mimeType,
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(asset.buffer);
}

// ---- REST -----------------------------------------------------------------

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  let p = u.pathname;
  // Build 11+ reads the file tree at the stock path /api/file-tree/projects/:id/…;
  // rewrite it onto the existing /api/projects file handlers (same as the real fork).
  if (p.startsWith('/api/file-tree/projects/')) p = '/api/projects/' + p.slice('/api/file-tree/projects/'.length);

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
  if (p === '/api/version') return sendJSON(res, 200, { version: 'demo', builtAt: BUILT_AT });
  // No agent/host pinning in the demo — one canned agent, one origin.
  if (p === '/api/agent-hosts') return sendJSON(res, 200, { assignments: {} });
  if (req.method === 'POST' && (p === '/api/assets/images' || p === '/api/assets/files')) {
    handleAssetUpload(req, res, p.endsWith('/images') ? 'images' : 'files');
    return;
  }
  {
    const am = p.match(/^\/api\/assets\/(?:images|files)\/([^/]+)$/);
    if (am) return serveAsset(res, decodeURIComponent(am[1]));
  }
  if (p === '/api/projects') return sendJSON(res, 200, { projects: projects() });
  if (p === '/api/projects/archived') return sendJSON(res, 200, { projects: [] });
  if (p === '/api/projects/agent-status')
    return sendJSON(res, 200, { agents: [{ id: 'remote:demo-agent', running: false, connected: true }] });
  {
    const mm = p.match(/^\/api\/providers\/sessions\/([^/]+)\/messages$/);
    if (mm) return sendJSON(res, 200, history(decodeURIComponent(mm[1])));
  }
  // Build 11+ pre-creates a session over REST before the first chat.send.
  if (req.method === 'POST' && p === '/api/providers/sessions')
    return sendJSON(res, 201, { sessionId: LOCAL_SESSION, provider: 'claude', projectPath: '/home/demo/hello-world' });
  if (/^\/api\/projects\/[^/]+\/files\/content$/.test(p)) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end('# hello-world\n\nA tiny demo project.\n');
    return;
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

  // Echo the user's line, then stream a short canned assistant reply. Persist the
  // turn (liveTurns) so the app's end-of-turn history refetch keeps it instead of
  // wiping the reply back to the base transcript.
  const streamReply = (sid, userText, attachments) => {
    // Name what was attached — otherwise an upload looks ignored, and the
    // reviewer can't tell the attachment path worked.
    const names = (Array.isArray(attachments) ? attachments : [])
      .map((a) => (a && (a.name || a.path)) || '')
      .filter(Boolean)
      .map((n) => String(n).split('/').pop());
    const received = names.length
      ? `I received ${names.length === 1 ? 'your file' : `${names.length} files`} (${names.join(', ')}). `
      : '';
    const reply = received +
                  "This is the MyMu demo backend — everything here is sample " +
                  "data. Point the app at your own Claude Code UI server to drive real agents.";
    (liveTurns[sid] || (liveTurns[sid] = [])).push(
      { id: 'u' + (++seq), kind: 'text', role: 'user', content: (userText || '').toString() },
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
  };

  ws.on('message', (data) => {
    let msg = {};
    try { msg = JSON.parse(data.toString()); } catch { return; }

    // --- current stock dialect (build 11+): chat.* ---
    if (msg.type === 'chat.subscribe') { send({ type: 'session-status', isProcessing: false }); return; }
    if (msg.type === 'chat.send') {
      const opts = msg.options || {};
      streamReply(msg.sessionId || LOCAL_SESSION, msg.content,
                  [].concat(opts.attachments || [], opts.images || [], opts.files || []));
      return;
    }
    if (msg.type === 'chat.abort') { send({ kind: 'complete' }); return; }

    // --- legacy dialect (published 1.0 app, still live): rc-subscribe / claude-command ---
    if (msg.type === 'rc-subscribe') { send({ type: 'session-status', isProcessing: false }); return; }
    if (msg.type === 'claude-command') {
      const opts = msg.options || {};
      const sid = opts.sessionId || opts.remoteControl || LOCAL_SESSION;
      streamReply(sid, msg.command, [].concat(opts.attachments || [], opts.images || [], opts.files || []));
      return;
    }
    if (msg.type === 'abort-session') { send({ kind: 'complete' }); return; }
  });
});

server.listen(PORT, () => console.log(`MyMu demo server on :${PORT}`));
