// fleet-files.js — serve a live fleet agent's filesystem through the SAME
// per-project file endpoints ccui uses for a normal project, by routing to the
// discovery service's read-only file endpoints. The GUI (FileTree, editor,
// image viewer) is unchanged — only the data source differs.
//
// Paths handed back to the GUI are RELATIVE to the agent's cwd (discovery's
// `path_rel`); the GUI treats `path` as opaque and echoes it to read/content,
// where we forward it to discovery as `?path=<rel>`.

import { discoveryCall, agentFromProjectId } from './services/fleet.service.js';

const TREE_MAX_DEPTH = 3;   // bound recursive HTTP fan-out into discovery
const TREE_MAX_DIRS = 300;  // hard cap on directories walked

const enc = encodeURIComponent;

async function listDir(name, rel) {
  const { status, json } = await discoveryCall('GET', `/agents/${enc(name)}/files`, {
    query: rel ? { path: rel } : {},
  });
  return { ok: status >= 200 && status < 300, status, json };
}

// Assemble discovery's one-level listings into ccui's recursive getFileTree shape.
async function buildTree(name, rel, depth, counter) {
  const { ok, json } = await listDir(name, rel);
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
      item.children = await buildTree(name, e.path_rel, depth + 1, counter);
    }
    items.push(item);
  }
  return items;
}

export async function fleetFileTree(projectId, res) {
  const name = agentFromProjectId(projectId);
  try {
    res.json(await buildTree(name, '', 0, { n: 0 }));
  } catch (e) {
    res.status(502).json({ error: `fleet files unreachable: ${e?.message || e}` });
  }
}

export async function fleetReadFile(projectId, filePath, res) {
  const name = agentFromProjectId(projectId);
  if (!filePath) return res.status(400).json({ error: 'Invalid file path' });
  try {
    const { status, json } = await discoveryCall('GET', `/agents/${enc(name)}/file`, { query: { path: filePath } });
    if (status < 200 || status >= 300) return res.status(status).json(json);
    if (json.encoding === 'base64') {
      // Editor renders text; flag binary so the GUI can fall back to the viewer.
      return res.json({ content: '', path: json.path, binary: true, mime: json.mime, size: json.size });
    }
    res.json({ content: json.content, path: json.path, truncated: json.truncated });
  } catch (e) {
    res.status(502).json({ error: `fleet file unreachable: ${e?.message || e}` });
  }
}

export async function fleetFileContent(projectId, filePath, res) {
  const name = agentFromProjectId(projectId);
  if (!filePath) return res.status(400).json({ error: 'Invalid file path' });
  try {
    const { status, json } = await discoveryCall('GET', `/agents/${enc(name)}/file`, { query: { path: filePath } });
    if (status < 200 || status >= 300) return res.status(status).json(json);
    const buf = json.encoding === 'base64'
      ? Buffer.from(json.content || '', 'base64')
      : Buffer.from(json.content || '', 'utf8');
    res.setHeader('Content-Type', json.mime || 'application/octet-stream');
    res.send(buf);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: `fleet content unreachable: ${e?.message || e}` });
  }
}

// Live agents are read-only over the fleet bridge today (discovery exposes no
// write). Mutating file ops return a clear 403 rather than silently 404ing.
export function fleetReadOnly(res) {
  res.status(403).json({ error: 'Live agent files are read-only via the fleet bridge.' });
}
