// MYMU: cross-host file federation + remote/local project file routes +
// delivered-file endpoints, extracted verbatim from the pre-port server root
// (FORK.md S5). Registered BEFORE the module project routes so these fork
// implementations (remote:cse_ awareness + sudo-aware cross-user reads) win.
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import os from 'os';
import mime from 'mime-types';

import { projectsDb } from '../modules/database/index.js';
import { federationToken, inboundFederationEnabled, federationPeers, peerFetch } from '../services/federation.js';
import { resolveLocalSession } from '../services/local-sessions.js';
import { getRemoteAgentCwd, isRemoteProjectId, sessionIdFromProjectId, isAgentCaptureAllowed } from '../services/rc.service.js';
import { getSessionEventsCached } from '../remote-control/rc-client.js';
import { ownerForPath, readFileAsUser, existsAsUser, treeAsUser, overwriteFileAsUser } from '../services/user-fs.js';

// Helper: permissions to rwx format
function permToRwx(perm) {
    const r = perm & 4 ? 'r' : '-';
    const w = perm & 2 ? 'w' : '-';
    const x = perm & 1 ? 'x' : '-';
    return r + w + x;
}

// Bounded filesystem concurrency for tree walks (mirrors the old server root).
const DEFAULT_FS_CONCURRENCY = 64;
const parsedFsConcurrency = Number.parseInt(process.env.FS_CONCURRENCY || '', 10);
const FS_CONCURRENCY = Number.isFinite(parsedFsConcurrency) && parsedFsConcurrency > 0
    ? parsedFsConcurrency
    : DEFAULT_FS_CONCURRENCY;
let activeFsOperations = 0;
const pendingFsOperations = [];

async function acquire() {
    if (activeFsOperations < FS_CONCURRENCY) {
        activeFsOperations += 1;
        return;
    }
    await new Promise((resolve) => {
        pendingFsOperations.push(resolve);
    });
}

function release() {
    const next = pendingFsOperations.shift();
    if (next) {
        next();
        return;
    }
    activeFsOperations = Math.max(0, activeFsOperations - 1);
}

const IGNORED_DIRS = new Set([
    'node_modules', 'dist', 'build', '.next', '.nuxt', '.cache', '.parcel-cache',
    '.git', '.svn', '.hg',
    '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', 'venv', '.venv',
    'target', 'vendor',
    '.gradle', '.idea', 'coverage', '.nyc_output'
]);

async function resolveProjectRootById(projectId) {
    if (isRemoteProjectId(projectId)) {
        return await getRemoteAgentCwd(sessionIdFromProjectId(projectId));
    }
    const projectPath = await projectsDb.getProjectPathById(projectId);
    // Agent-restricted users (agent_allow set) may browse only the local project
    // that matches their agent name OR that lives in their mapped linux user's
    // home (path-ownership rule) — the same scope the projects list shows.
    if (
        projectPath &&
        currentAgentAllow()?.length &&
        !isNameAllowedForUser(path.basename(projectPath)) &&
        !isPathOwnedByLinuxUser(projectPath, currentLinuxUser())
    ) {
        return null;
    }
    return projectPath;
}

function validatePathInProject(projectRoot, targetPath) {
    const resolved = path.isAbsolute(targetPath)
        ? path.resolve(targetPath)
        : path.resolve(projectRoot, targetPath);
    const normalizedRoot = path.resolve(projectRoot) + path.sep;
    if (!resolved.startsWith(normalizedRoot)) {
        return { valid: false, error: 'Path must be under project root' };
    }
    return { valid: true, resolved };
}

async function getFileTree(dirPath, maxDepth = 3, currentDepth = 0, showHidden = true, dirDev = null) {
    // Device id of the directory being listed — used to detect mount boundaries.
    // Network mounts (rclone/NFS/SMB) inside a project make the eager walk crawl
    // or hang (each readdir is a network round-trip, EIO storms on server errors),
    // so the walk never descends across a filesystem boundary: the mount shows as
    // a truncated directory and its contents load on demand when opened.
    if (dirDev === null) {
        try { dirDev = (await fsPromises.lstat(dirPath)).dev; } catch { dirDev = null; }
    }
    // Using fsPromises from import
    let entries;
    try {
        await acquire();
        try {
            entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
        } finally {
            release();
        }
    } catch (error) {
        // Only log non-permission errors to avoid spam
        if (error.code !== 'EACCES' && error.code !== 'EPERM') {
            console.error('Error reading directory:', error);
        }
        return [];
    }

    const filteredEntries = entries.filter((entry) => !(entry.isDirectory() && IGNORED_DIRS.has(entry.name)));

    // Process every entry in parallel. On high-latency filesystems (NFS/SMB)
    // serial stat() was the real bottleneck — issuing them concurrently lets
    // the kernel pipeline the round-trips and the recursive calls overlap too.
    const items = await Promise.all(filteredEntries.map(async (entry) => {
        const itemPath = path.join(dirPath, entry.name);
        const item = {
            name: entry.name,
            path: itemPath,
            type: entry.isDirectory() ? 'directory' : 'file'
        };
        let entryDev = null;

        // Get file stats for additional metadata
        try {
            await acquire();
            try {
              const stats = await fsPromises.lstat(itemPath);
              entryDev = stats.dev;
              item.size = stats.size;
              item.modified = stats.mtime.toISOString();

              // Mark symlinks so UI can distinguish them
              if (stats.isSymbolicLink()) {
                item.isSymlink = true;
              }

              // Convert permissions to rwx format
              const mode = stats.mode;
              const ownerPerm = (mode >> 6) & 7;
              const groupPerm = (mode >> 3) & 7;
              const otherPerm = mode & 7;
              item.permissions =
                ((mode >> 6) & 7).toString() +
                ((mode >> 3) & 7).toString() +
                (mode & 7).toString();
              item.permissionsRwx =
                permToRwx(ownerPerm) +
                permToRwx(groupPerm) +
                permToRwx(otherPerm);
            } finally {
                release();
            }
        } catch (statError) {
            // If stat fails, provide default values
            item.size = 0;
            item.modified = null;
            item.permissions = '000';
            item.permissionsRwx = '---------';
        }

        if (entry.isDirectory()) {
            const crossesMount = dirDev !== null && entryDev !== null && entryDev !== dirDev;
            if (crossesMount) {
                // Different filesystem (rclone/NFS/SMB/bind mount) — never walk it
                // eagerly; the client fetches its contents on demand via ?path=.
                item.truncated = true;
                item.mount = true;
            } else if (currentDepth < maxDepth) {
                // Recurse. Let readdir's own EACCES bubble up through the catch in
                // the recursive call rather than doing a separate access() probe
                // (which doubled the round-trip count on SMB without adding info).
                // The recursive call starts with a bounded readdir; holding a permit
                // for the whole subtree can deadlock when sibling directories are
                // waiting on their own children.
                item.children = await getFileTree(itemPath, maxDepth, currentDepth + 1, showHidden, entryDev);
            } else {
                // Depth cutoff — the directory exists but its contents weren't
                // walked; the client loads them on demand (lazy expansion).
                item.truncated = true;
            }
        }

        return item;
    }));

    return items.sort((a, b) => {
        if (a.type !== b.type) {
            return a.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
    });
}

export default function registerRemoteFileRoutes(app, authenticateToken) {

// ============================================================================
// CROSS-HOST FILE FEDERATION
// ----------------------------------------------------------------------------
// An agent shown in the Agents view may run on a DIFFERENT host than this CCUI
// instance. Its files live on that host's disk, so we can't read them locally.
// Each CCUI instance therefore exposes token-authed, cwd-jailed, READ-ONLY
// endpoints that serve files for the agents running on ITS OWN host (resolved
// via ~/.claude/sessions). When a user browses a remote agent this instance
// can't resolve locally, the file routes forward the request to the peer that
// owns the session (see the proxy fallbacks below).
//
// Auth is host-to-host (shared CCUI_FEDERATION_TOKEN), NOT per-user: the CALLING
// instance enforces per-user visibility (isAgentCaptureAllowed) BEFORE it
// proxies, so a restricted user can never reach an out-of-scope agent's files.
// ============================================================================

/** Gate the federation endpoints on the shared host-to-host token. */
function requireFederationToken(req, res, next) {
    const expected = federationToken();
    if (!expected || !inboundFederationEnabled()) {
        return res.status(404).json({ error: 'Federation not enabled' });
    }
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token !== expected) {
        return res.status(401).json({ error: 'Invalid federation token' });
    }
    next();
}

/**
 * Stream a resolved file to the response with correct mime type and HTTP Range
 * support (video/audio seeking). Shared by the user-facing byte route and the
 * federation peer endpoint. `resolved` must already be jail-checked.
 */
async function serveFileBytes(req, res, resolved) {
    // One-instance-per-host: a path in a mapped FOREIGN linux user's home is
    // read AS that user (sudo). Whole-buffer serve — no Range — which is fine
    // for previews/downloads; same-user paths keep the streaming path below.
    const crossUser = ownerForPath(resolved);
    if (crossUser) {
        try {
            const bytes = await readFileAsUser(crossUser, resolved);
            res.setHeader('Content-Type', mime.lookup(resolved) || 'application/octet-stream');
            res.setHeader('Content-Length', bytes.length);
            return res.end(bytes);
        } catch {
            return res.status(404).json({ error: 'File not found' });
        }
    }
    try {
        await fsPromises.access(resolved);
    } catch {
        return res.status(404).json({ error: 'File not found' });
    }

    const mimeType = mime.lookup(resolved) || 'application/octet-stream';
    res.setHeader('Content-Type', mimeType);

    const stat = await fsPromises.stat(resolved);
    const fileSize = stat.size;
    res.setHeader('Accept-Ranges', 'bytes');

    const range = req.headers.range;
    if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) {
            res.setHeader('Content-Range', `bytes */${fileSize}`);
            return res.status(416).end();
        }
        let start = match[1] === '' ? null : parseInt(match[1], 10);
        let end = match[2] === '' ? null : parseInt(match[2], 10);
        // Suffix range ("bytes=-500" => last 500 bytes).
        if (start === null) {
            start = Math.max(0, fileSize - (end ?? 0));
            end = fileSize - 1;
        } else if (end === null || end >= fileSize) {
            end = fileSize - 1;
        }
        if (start > end || start >= fileSize) {
            res.setHeader('Content-Range', `bytes */${fileSize}`);
            return res.status(416).end();
        }

        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        res.setHeader('Content-Length', end - start + 1);
        const rangeStream = fs.createReadStream(resolved, { start, end });
        rangeStream.pipe(res);
        rangeStream.on('error', (error) => {
            console.error('Error streaming file range:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Error reading file' });
            }
        });
        return;
    }

    // No range: stream the whole file.
    res.setHeader('Content-Length', fileSize);
    const fileStream = fs.createReadStream(resolved);
    fileStream.pipe(res);
    fileStream.on('error', (error) => {
        console.error('Error streaming file:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Error reading file' });
        }
    });
}

/**
 * The set of absolute paths a session ever delivered via SendUserFile — the
 * authorization allowlist for the delivered-file endpoints. Derived from the
 * session's append-only relay history. SendUserFile accepts paths RELATIVE to
 * the agent's cwd, so `agentCwd` anchors those; without it a relative delivery
 * used to resolve against the SERVER's cwd and 404 ("file no longer on disk").
 */
function deriveDeliveredPaths(events, agentCwd) {
    const resolveOne = (p) => (path.isAbsolute(p) ? path.resolve(p) : (agentCwd ? path.resolve(agentCwd, p) : path.resolve(p)));
    const delivered = new Set();
    for (const e of events || []) {
        const content = e?.message?.content;
        if (!Array.isArray(content)) continue;
        for (const c of content) {
            if (c?.type === 'tool_use' && c?.name === 'SendUserFile' && Array.isArray(c?.input?.files)) {
                for (const f of c.input.files) if (typeof f === 'string') delivered.add(resolveOne(f));
            }
        }
    }
    return delivered;
}

/** The directory the agent works in — anchors relative delivered paths. */
async function sessionCwdForDelivery(sessionId) {
    const local = resolveLocalSession(sessionId);
    if (local?.cwd) return local.cwd;
    try { return await getRemoteAgentCwd(sessionId); } catch { return null; }
}

/**
 * Resolve a requested delivered path (absolute OR agent-cwd-relative) and check
 * it against the session's SendUserFile allowlist. Serves from the warm
 * in-memory event cache first (topUp:false — NO relay round-trip), because a
 * playing <video> fires many HTTP Range requests and re-hitting the relay on each
 * one stalls playback. On a miss we refresh once (topUp:true) to catch a
 * just-delivered file newer than the cached prefix.
 */
async function resolveDeliveredPath(sessionId, requestedPath) {
    const cwd = await sessionCwdForDelivery(sessionId);
    const resolved = path.isAbsolute(requestedPath)
        ? path.resolve(requestedPath)
        : (cwd ? path.resolve(cwd, requestedPath) : path.resolve(requestedPath));
    const warm = await getSessionEventsCached(sessionId, { topUp: false }).catch(() => []);
    if (deriveDeliveredPaths(warm, cwd).has(resolved)) return { delivered: true, resolved };
    const fresh = await getSessionEventsCached(sessionId, { topUp: true }).catch(() => []);
    return { delivered: deriveDeliveredPaths(fresh, cwd).has(resolved), resolved };
}

// ── Peer-serving endpoints (this host answers for its OWN local sessions) ────

// Ownership probe: does THIS host run the session? Returns its cwd/name/status.
app.get('/api/federation/resolve', requireFederationToken, (req, res) => {
    const session = typeof req.query.session === 'string' ? req.query.session : '';
    const local = resolveLocalSession(session);
    if (!local) {
        return res.status(404).json({ error: 'Session not on this host' });
    }
    res.json({ cwd: local.cwd, name: local.name ?? null, status: local.status ?? null });
});

// File tree for a locally-owned session (cwd-jailed by getFileTree's root).
app.get('/api/federation/files', requireFederationToken, async (req, res) => {
    try {
        const session = typeof req.query.session === 'string' ? req.query.session : '';
        const local = resolveLocalSession(session);
        if (!local) {
            return res.status(404).json({ error: 'Session not on this host' });
        }
        // Same lazy-loading contract as the main files route (depth bound + jailed
        // subtree re-root) — the calling host forwards the browser's params.
        const depthRaw = Number.parseInt(String(req.query.depth ?? ''), 10);
        const treeDepth = Number.isFinite(depthRaw) ? Math.min(Math.max(depthRaw, 1), 10) : 10;
        const subPath = typeof req.query.path === 'string' ? req.query.path : '';
        let treeRoot = local.cwd;
        if (subPath) {
            const validation = validatePathInProject(local.cwd, subPath);
            if (!validation.valid) {
                return res.status(403).json({ error: validation.error });
            }
            treeRoot = validation.resolved;
        }
        try {
            await fsPromises.access(treeRoot);
        } catch {
            return res.status(404).json({ error: `Project path not found: ${treeRoot}` });
        }
        const files = await getFileTree(treeRoot, treeDepth, 0, true);
        // Multi-MB tree JSON is gzipped by the app-wide compression middleware
        // (the caller sends Accept-Encoding: gzip) — essential over slow mesh links.
        res.json(files);
    } catch (error) {
        console.error('[ERROR] Federation file tree error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Text file read for a locally-owned session, cwd-jailed.
app.get('/api/federation/file', requireFederationToken, async (req, res) => {
    try {
        const session = typeof req.query.session === 'string' ? req.query.session : '';
        const filePath = typeof req.query.filePath === 'string' ? req.query.filePath : '';
        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }
        const local = resolveLocalSession(session);
        if (!local) {
            return res.status(404).json({ error: 'Session not on this host' });
        }
        const validation = validatePathInProject(local.cwd, filePath);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }
        const content = await fsPromises.readFile(validation.resolved, 'utf8');
        res.json({ content, path: validation.resolved });
    } catch (error) {
        if (error.code === 'ENOENT') {
            return res.status(404).json({ error: 'File not found' });
        }
        if (error.code === 'EACCES') {
            return res.status(403).json({ error: 'Permission denied' });
        }
        res.status(500).json({ error: error.message });
    }
});

// Raw bytes (with Range) for a locally-owned session, cwd-jailed.
app.get('/api/federation/files/content', requireFederationToken, async (req, res) => {
    try {
        const session = typeof req.query.session === 'string' ? req.query.session : '';
        const filePath = typeof req.query.path === 'string' ? req.query.path : '';
        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }
        const local = resolveLocalSession(session);
        if (!local) {
            return res.status(404).json({ error: 'Session not on this host' });
        }
        const validation = validatePathInProject(local.cwd, filePath);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }
        await serveFileBytes(req, res, validation.resolved);
    } catch (error) {
        console.error('Error serving federated binary file:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
});

// Delivered file (SendUserFile) for a locally-owned session. Unlike the cwd-jailed
// endpoints, a delivered path may sit anywhere on disk — so the gate is the agent's
// OWN act of delivering it: this host re-derives the allowlist from the session's
// relay events and serves only paths that appear in a SendUserFile tool_use.
app.get('/api/federation/delivered-file', requireFederationToken, async (req, res) => {
    try {
        const session = typeof req.query.session === 'string' ? req.query.session : '';
        const filePath = typeof req.query.path === 'string' ? req.query.path : '';
        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }
        if (!resolveLocalSession(session)) {
            return res.status(404).json({ error: 'Session not on this host' });
        }
        const { delivered, resolved } = await resolveDeliveredPath(session, filePath);
        if (!delivered) {
            return res.status(403).json({ error: 'This file was not delivered by the agent' });
        }
        try {
            await fsPromises.access(resolved);
        } catch {
            return res.status(404).json({ error: 'File no longer on disk' });
        }
        res.setHeader('Content-Disposition', `inline; filename="${path.basename(resolved).replace(/"/g, '')}"`);
        await serveFileBytes(req, res, resolved);
    } catch (error) {
        console.error('Error serving federated delivered file:', error);
        if (!res.headersSent) res.status(500).json({ error: error.message });
    }
});

// ── Proxy fallbacks (this host FORWARDS to the peer that owns the session) ───

/**
 * True if the given remote projectId should be federated: it's a remote agent,
 * the current user may see it, and outbound federation is configured. Callers
 * use this AFTER a local cwd resolution miss.
 */
async function shouldFederateRemote(projectId) {
    if (!isRemoteProjectId(projectId) || !outboundFederationEnabled()) return false;
    const sessionId = sessionIdFromProjectId(projectId);
    // Per-user visibility gate: never proxy for an agent this user can't see.
    return await isAgentCaptureAllowed(sessionId);
}

/** Forward a JSON/text federation request to the owning peer; relay the response. */
async function federateJsonResponse(res, sessionId, peerPathAndQuery) {
    const peer = await resolveSessionPeer(sessionId);
    if (!peer) return false;
    try {
        const upstream = await peerFetch(peer, peerPathAndQuery, {
            // 60s: a big file tree over a saturated mesh link needs headroom even
            // gzipped (the box uplink drops to ~140KB/s while an agent renders).
            signal: AbortSignal.timeout(60000),
            headers: { 'Accept-Encoding': 'gzip' },
        });
        const body = await upstream.text();
        res.status(upstream.status);
        const contentType = upstream.headers.get('content-type');
        if (contentType) res.setHeader('Content-Type', contentType);
        res.send(body);
    } catch (error) {
        if (!res.headersSent) {
            res.status(502).json({ error: `Peer file request failed: ${error.message}` });
        }
    }
    return true;
}

/** Forward a byte/range federation request to the owning peer; stream the response. */
async function federateBytesResponse(req, res, sessionId, peerPathAndQuery) {
    const peer = await resolveSessionPeer(sessionId);
    if (!peer) return false;
    try {
        const headers = {};
        if (req.headers.range) headers.Range = req.headers.range;
        const upstream = await peerFetch(peer, peerPathAndQuery, {
            headers,
            signal: AbortSignal.timeout(60000),
        });
        res.status(upstream.status);
        for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
            const v = upstream.headers.get(h);
            if (v) res.setHeader(h, v);
        }
        if (upstream.body) {
            Readable.fromWeb(upstream.body).pipe(res);
        } else {
            res.end();
        }
    } catch (error) {
        if (!res.headersSent) {
            res.status(502).json({ error: `Peer file stream failed: ${error.message}` });
        }
    }
    return true;
}

// Read file content endpoint
app.get('/api/projects/:projectId/file', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { filePath } = req.query;


        // Security: ensure the requested path is inside the project root
        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        // Resolve the absolute project root via the DB-backed helper; the
        // caller passes the DB-assigned `projectId`, not a folder name.
        const projectRoot = await resolveProjectRootById(projectId);
        if (!projectRoot) {
            // Cross-host agent: forward the read to the peer that owns the session.
            if (await shouldFederateRemote(projectId)) {
                const sid = sessionIdFromProjectId(projectId);
                const forwarded = await federateJsonResponse(
                    res,
                    sid,
                    `/api/federation/file?session=${encodeURIComponent(sid)}&filePath=${encodeURIComponent(filePath)}`,
                );
                if (forwarded) return;
            }
            return res.status(404).json({ error: 'Project not found' });
        }

        // Handle both absolute and relative paths
        const resolved = path.isAbsolute(filePath)
            ? path.resolve(filePath)
            : path.resolve(projectRoot, filePath);
        const normalizedRoot = path.resolve(projectRoot) + path.sep;
        if (!resolved.startsWith(normalizedRoot)) {
            return res.status(403).json({ error: 'Path must be under project root' });
        }

        const readOwner = ownerForPath(resolved);
        const content = readOwner
            ? (await readFileAsUser(readOwner, resolved)).toString('utf8')
            : await fsPromises.readFile(resolved, 'utf8');
        res.json({ content, path: resolved });
    } catch (error) {
        console.error('Error reading file:', error);
        if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File not found' });
        } else if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// Serve raw file bytes for previews and downloads.
app.get('/api/projects/:projectId/files/content', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { path: filePath } = req.query;


        // Security: ensure the requested path is inside the project root
        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        // Projects are now addressed by DB `projectId`, resolved to their path here.
        const projectRoot = await resolveProjectRootById(projectId);
        if (!projectRoot) {
            // Cross-host agent: stream the bytes from the peer that owns the session.
            if (await shouldFederateRemote(projectId)) {
                const sid = sessionIdFromProjectId(projectId);
                const forwarded = await federateBytesResponse(
                    req,
                    res,
                    sid,
                    `/api/federation/files/content?session=${encodeURIComponent(sid)}&path=${encodeURIComponent(filePath)}`,
                );
                if (forwarded) return;
            }
            return res.status(404).json({ error: 'Project not found' });
        }

        // Match the text reader endpoint so callers can pass either project-relative
        // or absolute paths without changing how the bytes are served.
        const resolved = path.isAbsolute(filePath)
            ? path.resolve(filePath)
            : path.resolve(projectRoot, filePath);
        const normalizedRoot = path.resolve(projectRoot) + path.sep;
        if (!resolved.startsWith(normalizedRoot)) {
            return res.status(403).json({ error: 'Path must be under project root' });
        }

        // Byte-serving (mime, HTTP Range, streaming) is shared with the
        // cross-host federation peer endpoint via serveFileBytes. `resolved` is
        // already jail-checked above.
        await serveFileBytes(req, res, resolved);
    } catch (error) {
        console.error('Error serving binary file:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
});

// Serve a file an agent explicitly delivered via the SendUserFile tool.
//
// The relay does NOT report a remote agent's cwd (session_context.cwd is often
// empty), so the normal files/content endpoint — which gates on "path under the
// project root" — can't serve these. But the agent's SendUserFile tool_use carries
// the absolute path, and choosing to send it IS the authorization. So we serve the
// exact bytes only when the requested absolute path actually appears in a
// SendUserFile delivery in this session's history — the agent's own act of sending
// is the allowlist, no cwd needed. Host-local read (co-located agents); cross-host
// delivery is a separate, deferred concern.
app.get('/api/projects/:projectId/delivered-file', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { path: filePath } = req.query;
        if (!filePath || typeof filePath !== 'string') {
            return res.status(400).json({ error: 'Missing file path' });
        }
        if (!isRemoteProjectId(projectId)) {
            return res.status(400).json({ error: 'Delivered files are a remote-agent feature' });
        }
        const sessionId = sessionIdFromProjectId(projectId);
        if (!sessionId || !(await isAgentCaptureAllowed(sessionId))) {
            return res.status(404).json({ error: 'Agent not found' });
        }

        // Allowlist = every path this session ever delivered via SendUserFile.
        // On the host that OWNS the agent this is derivable (it can read the
        // session's relay events); a different host may not, and that's fine — a
        // cross-host request is authorized on the owning peer instead (below).
        // resolveDeliveredPath serves from the warm cache first so a playing
        // video's Range requests don't each hit the relay, and anchors relative
        // paths at the agent's cwd.
        const { delivered: isDelivered, resolved } = await resolveDeliveredPath(sessionId, filePath);

        // Serve locally when this host both authorized it (in the allowlist) and
        // holds the bytes on disk — the same-host case.
        if (isDelivered) {
            const deliveredOwner = ownerForPath(resolved);
            let onDisk = true;
            if (deliveredOwner) {
                onDisk = await existsAsUser(deliveredOwner, resolved);
            } else {
                try { await fsPromises.access(resolved); } catch { onDisk = false; }
            }
            if (onDisk) {
                // Inline, mime-typed, Range-capable stream (shared with files/content)
                // so images render and audio/video seek without a manual download.
                res.setHeader('Content-Disposition', `inline; filename="${path.basename(resolved).replace(/"/g, '')}"`);
                await serveFileBytes(req, res, resolved);
                return;
            }
        }

        // Not served locally (cross-host agent, or this host can't authorize/hold
        // it): forward to the peer that owns the session. The peer re-derives the
        // SendUserFile allowlist from its own relay events and streams the bytes,
        // so authorization always happens on the host that actually delivered it.
        if (await shouldFederateRemote(projectId)) {
            const forwarded = await federateBytesResponse(
                req,
                res,
                sessionId,
                `/api/federation/delivered-file?session=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(filePath)}`,
            );
            if (forwarded) return;
        }

        // No peer owns it: it was either never delivered or is gone from disk.
        return res.status(isDelivered ? 404 : 403).json({
            error: isDelivered ? 'File no longer on disk' : 'This file was not delivered by the agent',
        });
    } catch (error) {
        console.error('Error serving delivered file:', error);
        if (!res.headersSent) res.status(500).json({ error: error.message });
    }
});


// Save file content endpoint
app.put('/api/projects/:projectId/file', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { filePath, content } = req.body;


        // Security: ensure the requested path is inside the project root
        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        if (content === undefined) {
            return res.status(400).json({ error: 'Content is required' });
        }

        // Projects are now addressed by DB `projectId`, resolved to their path here.
        const projectRoot = await resolveProjectRootById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Handle both absolute and relative paths
        const resolved = path.isAbsolute(filePath)
            ? path.resolve(filePath)
            : path.resolve(projectRoot, filePath);
        const normalizedRoot = path.resolve(projectRoot) + path.sep;
        if (!resolved.startsWith(normalizedRoot)) {
            return res.status(403).json({ error: 'Path must be under project root' });
        }

        // Write the new content (as the owning linux user for foreign homes).
        const writeOwner = ownerForPath(resolved);
        if (writeOwner) {
            await overwriteFileAsUser(writeOwner, resolved, content);
        } else {
            await fsPromises.writeFile(resolved, content, 'utf8');
        }

        res.json({
            success: true,
            path: resolved,
            message: 'File saved successfully'
        });
    } catch (error) {
        console.error('Error saving file:', error);
        if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File or directory not found' });
        } else if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// MYMU: the stock UI fetches trees via the file-tree module route; remote
// agents' projects alias onto this remote-aware handler (locals fall through).
app.get('/api/file-tree/projects/:projectId/files', authenticateToken, (req, res, next) => {
    if (!String(req.params.projectId || '').startsWith('remote:')) return next();
    return mymuProjectFilesHandler(req, res);
});
const mymuProjectFilesHandler = async (req, res) => {
    try {

        // Using fsPromises from import

        // Resolve the project's absolute path through the DB (projectId is the
        // primary key of the `projects` table after the identifier migration).
        // Lazy-loading contract: ?depth= bounds the walk (directories at the cutoff
        // come back `truncated: true`), ?path= re-roots the walk at a subdirectory
        // (jailed to the project root) so the client expands truncated dirs on
        // demand instead of paying for the whole tree up front.
        const depthRaw = Number.parseInt(String(req.query.depth ?? ''), 10);
        const treeDepth = Number.isFinite(depthRaw) ? Math.min(Math.max(depthRaw, 1), 10) : 10;
        const subPath = typeof req.query.path === 'string' ? req.query.path : '';

        const actualPath = await resolveProjectRootById(req.params.projectId);
        if (!actualPath) {
            // Cross-host agent: fetch the tree from the peer that owns the session.
            if (await shouldFederateRemote(req.params.projectId)) {
                const sid = sessionIdFromProjectId(req.params.projectId);
                const forwarded = await federateJsonResponse(
                    res,
                    sid,
                    `/api/federation/files?session=${encodeURIComponent(sid)}`
                        + `&depth=${treeDepth}${subPath ? `&path=${encodeURIComponent(subPath)}` : ''}`,
                );
                if (forwarded) return;
            }
            return res.status(404).json({ error: 'Project not found' });
        }

        let treeRoot = actualPath;
        if (subPath) {
            const validation = validatePathInProject(actualPath, subPath);
            if (!validation.valid) {
                return res.status(403).json({ error: validation.error });
            }
            treeRoot = validation.resolved;
        }

        // One-instance-per-host: a mapped foreign user's tree walks AS that user.
        const treeOwner = ownerForPath(treeRoot);
        if (treeOwner) {
            return res.json(await treeAsUser(treeOwner, treeRoot, treeDepth));
        }

        // Check if path exists
        try {
            await fsPromises.access(treeRoot);
        } catch (e) {
            return res.status(404).json({ error: `Project path not found: ${treeRoot}` });
        }

        const files = await getFileTree(treeRoot, treeDepth, 0, true);
        res.json(files);
    } catch (error) {
        console.error('[ERROR] File tree error:', error.message);
        res.status(500).json({ error: error.message });
    }
};
app.get('/api/projects/:projectId/files', authenticateToken, mymuProjectFilesHandler);

}
