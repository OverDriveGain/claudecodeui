// agent-discovery-files.js — serve a registered agent's filesystem through
// ccui's per-project file endpoints by routing to the daemon's cwd-jailed
// file endpoints. Agents are addressed by stable UUID.

import { Readable } from 'node:stream';
import { discoveryCall, agentIdFromProjectId, discoveryRawResponse } from './services/agent-discovery.service.js';

const TREE_MAX_DEPTH = 3;
const TREE_MAX_DIRS = 300;

const enc = encodeURIComponent;

async function listDir(agentId, rel) {
  const { status, json } = await discoveryCall('GET', `/agents/${enc(agentId)}/files`, {
    query: rel ? { path: rel } : {},
  });
  return { ok: status >= 200 && status < 300, status, json };
}

async function buildTree(agentId, rel, depth, counter) {
  const { ok, json } = await listDir(agentId, rel);
  if (!ok) return [];
  const entries = Array.isArray(json.entries) ? json.entries : [];
  const items = [];
  for (const e of entries) {
    const isDir = e.type === 'dir';
    const item = {
      name: e.name,
      path: e.path_rel,
      type: isDir ? 'directory' : 'file',
      size: e.size || 0,
      modified: e.mtime ? new Date(e.mtime * 1000).toISOString() : null,
      permissions: '000',
      permissionsRwx: '---------',
    };
    if (isDir && depth < TREE_MAX_DEPTH && counter.n < TREE_MAX_DIRS) {
      counter.n += 1;
      item.children = await buildTree(agentId, e.path_rel, depth + 1, counter);
    }
    items.push(item);
  }
  return items;
}

export async function agentFileTree(projectId, res) {
  const agentId = agentIdFromProjectId(projectId);
  try {
    res.json(await buildTree(agentId, '', 0, { n: 0 }));
  } catch (e) {
    res.status(502).json({ error: `agent files unreachable: ${e?.message || e}` });
  }
}

export async function agentReadFile(projectId, filePath, res) {
  const agentId = agentIdFromProjectId(projectId);
  if (!filePath) return res.status(400).json({ error: 'Invalid file path' });
  try {
    const { status, json } = await discoveryCall('GET', `/agents/${enc(agentId)}/file`, { query: { path: filePath } });
    if (status < 200 || status >= 300) return res.status(status).json(json);
    if (json.encoding === 'base64') {
      return res.json({ content: '', path: json.path, binary: true, mime: json.mime, size: json.size });
    }
    res.json({ content: json.content, path: json.path, truncated: json.truncated });
  } catch (e) {
    res.status(502).json({ error: `agent file unreachable: ${e?.message || e}` });
  }
}

export async function agentFileContent(projectId, filePath, res) {
  const agentId = agentIdFromProjectId(projectId);
  if (!filePath) return res.status(400).json({ error: 'Invalid file path' });
  try {
    const { status, json } = await discoveryCall('GET', `/agents/${enc(agentId)}/file`, { query: { path: filePath } });
    if (status < 200 || status >= 300) return res.status(status).json(json);
    const buf = json.encoding === 'base64'
      ? Buffer.from(json.content || '', 'base64')
      : Buffer.from(json.content || '', 'utf8');
    res.setHeader('Content-Type', json.mime || 'application/octet-stream');
    res.send(buf);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: `agent content unreachable: ${e?.message || e}` });
  }
}

// Stream an agent's file bytes with HTTP Range passthrough — used for media
// (video/audio) and any binary. Forwards the browser's Range header to the
// daemon's /raw endpoint and pipes the (206/200) response straight through,
// so the file streams and seeks instead of buffering a truncated base64 blob.
export async function agentFileContentRaw(projectId, filePath, req, res) {
  const agentId = agentIdFromProjectId(projectId);
  if (!filePath) return res.status(400).json({ error: 'Invalid file path' });
  try {
    const upstream = await discoveryRawResponse(agentId, filePath, req.headers.range);
    res.status(upstream.status);
    for (const h of ['content-type', 'content-range', 'accept-ranges', 'content-length']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!upstream.body) {
      res.end();
      return;
    }
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: `agent content unreachable: ${e?.message || e}` });
  }
}

// Registered agents are read-only over the discovery bridge (daemon exposes no write).
export function agentReadOnly(res) {
  res.status(403).json({ error: 'Registered agent files are read-only via the discovery bridge.' });
}
