/**
 * bldr project routes — serve the per-user project manifest and its assets.
 * Mounted at /api/bldr behind authenticateToken, so `req.user` is the signed-in
 * user and everything is scoped to THEIR workspace (no cross-user access).
 */
import express from 'express';
import fs from 'fs';
import path from 'path';
import { workspacePathFor } from '../bldr/workspace.js';
import { seedWorkspace, MANIFEST_FILE } from '../bldr/seed.js';
import { generateProposalPdf } from '../bldr/proposal.js';
import { startGeneration, getJob, listJobs, canGenerate, BLDR_GPT_PROVIDER } from '../bldr/generate.js';
import { loadEndpoints, saveEndpoints, endpointAvailability, PANE_IDS, PRESETS } from '../bldr/endpoints.js';
import { listProjects, restoreProject, beginNewProject, MAX_PROJECTS } from '../bldr/gallery.js';

const router = express.Router();

// --- admin gate -----------------------------------------------------------
// Admin = the first (owner) account, plus any usernames/emails listed in
// ADMIN_USERS (comma-separated). Customers signing in via chat-login are never
// admins unless explicitly listed.
const ADMIN_USERS = (process.env.ADMIN_USERS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export const isAdminUser = (user) =>
  !!user && (user.id === 1 || ADMIN_USERS.includes(String(user.username || '').toLowerCase()));

const requireAdmin = (req, res, next) => {
  if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Admin only.' });
  next();
};

const EXT_MIME = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.html': 'text/html',
};

const workspaceOf = (req) => workspacePathFor(req.user?.username);

// The project manifest (bldr.json) = the source of truth for the panes.
router.get('/manifest', (req, res) => {
  try {
    const wp = workspaceOf(req);
    const manifestPath = path.join(wp, MANIFEST_FILE);
    if (!fs.existsSync(manifestPath)) {
      seedWorkspace(wp); // self-heal: a logged-in user always has a project
    }
    if (!fs.existsSync(manifestPath)) {
      return res.status(404).json({ error: 'No project manifest.' });
    }
    const raw = fs.readFileSync(manifestPath, 'utf8');
    res.type('application/json').send(raw);
  } catch (err) {
    console.error('[bldr] manifest error:', err);
    res.status(500).json({ error: 'Failed to read project manifest.' });
  }
});

// Serve a single asset by RELATIVE path, strictly inside the user's workspace.
router.get('/asset', (req, res) => {
  try {
    const wp = workspaceOf(req);
    const rel = String(req.query.path || '');
    if (!rel) return res.status(400).json({ error: 'path is required.' });

    // Resolve and confine to the workspace — blocks `..` traversal / absolute paths.
    const resolved = path.resolve(wp, rel);
    const root = path.resolve(wp);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return res.status(403).json({ error: 'Path outside workspace.' });
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return res.status(404).json({ error: 'Asset not found.' });
    }

    const mime = EXT_MIME[path.extname(resolved).toLowerCase()];
    if (mime) res.type(mime);
    // Assets are versioned by a ?rev= query param from the client, so each rev is
    // a distinct URL — safe to cache the bytes of a given rev.
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    fs.createReadStream(resolved).pipe(res);
  } catch (err) {
    console.error('[bldr] asset error:', err);
    res.status(500).json({ error: 'Failed to read asset.' });
  }
});

// "Proceed with the project" — generate & download the BTI proposal PDF for the
// signed-in user's current design (fixed BTI deck pages + their live variable pages).
router.get('/proposal.pdf', (req, res) => {
  let artifact = null;
  try {
    const wp = workspaceOf(req);
    const manifestPath = path.join(wp, MANIFEST_FILE);
    if (!fs.existsSync(manifestPath)) seedWorkspace(wp);
    if (!fs.existsSync(manifestPath)) {
      return res.status(404).json({ error: 'No project to export yet.' });
    }
    artifact = generateProposalPdf(wp);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="BTI-Proposal.pdf"');
    res.setHeader('Cache-Control', 'no-store');
    const stream = fs.createReadStream(artifact.pdfPath);
    stream.on('close', () => { try { fs.rmSync(artifact.tmpDir, { recursive: true, force: true }); } catch {} });
    stream.on('error', () => { try { fs.rmSync(artifact.tmpDir, { recursive: true, force: true }); } catch {} });
    stream.pipe(res);
  } catch (err) {
    if (artifact?.tmpDir) { try { fs.rmSync(artifact.tmpDir, { recursive: true, force: true }); } catch {} }
    console.error('[bldr] proposal.pdf error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate proposal PDF.' });
  }
});

// Route B — the app asks bti-bldr-gpt (over A2A) to produce the computed pane
// values (costs + location) and writes them into this user's bldr.json. The
// panes then reflect them on the next manifest read. Degrades cleanly to 503
// when the A2A grant isn't in place yet.
router.get('/generate/status', (req, res) => {
  res.json({ enabled: canGenerate(), provider: BLDR_GPT_PROVIDER });
});

// Current async job for this user's workspace (panes fill in as calls complete).
router.get('/generate/job', (req, res) => {
  res.json(getJob(workspaceOf(req)) || { running: false, panes: {} });
});

// Kick off async per-pane generation and return immediately. Panes are written
// to bldr.json as each agent call lands; the client polls /generate/job + manifest.
router.post('/generate', express.json({ limit: '32kb' }), (req, res) => {
  try {
    if (!canGenerate()) {
      return res.status(503).json({
        error: `Design agent not reachable yet — no A2A grant for '${BLDR_GPT_PROVIDER}'.`,
        code: 'NO_GRANT',
      });
    }
    const wp = workspaceOf(req);
    if (!fs.existsSync(path.join(wp, MANIFEST_FILE))) seedWorkspace(wp);
    const brief = typeof req.body?.brief === 'string' ? req.body.brief : '';
    const panes = Array.isArray(req.body?.panes) && req.body.panes.length ? req.body.panes : undefined;
    // A FULL run is a new project: archive the one on screen into the gallery
    // first (pane-subset runs — admin tests, retries — edit the current one).
    if (!panes && !getJob(wp)?.running) beginNewProject(wp, brief);
    const job = startGeneration(wp, brief, panes);
    res.json({ ok: true, job });
  } catch (err) {
    console.error('[bldr] generate error:', err?.message || err);
    res.status(500).json({ error: 'Design generation failed to start.', code: 'GENERATE_FAILED' });
  }
});

// --- project gallery ------------------------------------------------------
// Up to MAX_PROJECTS past projects per visitor, retrievable at any time.

router.get('/projects', (req, res) => {
  try {
    res.json({ projects: listProjects(workspaceOf(req)), max: MAX_PROJECTS });
  } catch (err) {
    console.error('[bldr] projects list error:', err?.message || err);
    res.status(500).json({ error: 'Failed to list projects.' });
  }
});

// Swap a past project back in as the current one (current gets archived).
router.post('/projects/:id/restore', (req, res) => {
  try {
    const wp = workspaceOf(req);
    if (getJob(wp)?.running) {
      return res.status(409).json({ error: 'A generation is running — wait for it to finish.' });
    }
    const manifest = restoreProject(wp, String(req.params.id));
    res.json({ ok: true, manifest, projects: listProjects(wp) });
  } catch (err) {
    console.error('[bldr] project restore error:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to restore project.' });
  }
});

// --- admin: the pane→endpoint chain ---------------------------------------

// Whether the signed-in user may see the admin page at all.
router.get('/admin/me', (req, res) => {
  res.json({ admin: isAdminUser(req.user) });
});

// Live activity: every in-flight generation + the last finished runs, across
// all visitors — per-pane state, endpoint, duration, and error text.
router.get('/admin/jobs', requireAdmin, (req, res) => {
  res.json(listJobs());
});

// The full chain: per-pane endpoint config + live availability + presets.
router.get('/admin/endpoints', requireAdmin, (req, res) => {
  const cfg = loadEndpoints();
  const availability = Object.fromEntries(
    PANE_IDS.map((id) => [id, endpointAvailability(cfg.endpoints[id])])
  );
  res.json({ ...cfg, availability, presets: PRESETS, panes: PANE_IDS });
});

// Change the chain. Body = { endpoints: { <pane>: <endpoint> } } (partial ok).
// Takes effect on the next generation — no restart.
router.put('/admin/endpoints', requireAdmin, express.json({ limit: '64kb' }), (req, res) => {
  try {
    const cfg = saveEndpoints(req.body || {});
    const availability = Object.fromEntries(
      PANE_IDS.map((id) => [id, endpointAvailability(cfg.endpoints[id])])
    );
    res.json({ ok: true, ...cfg, availability });
  } catch (err) {
    console.error('[bldr] admin endpoints save error:', err?.message || err);
    res.status(500).json({ error: 'Failed to save endpoints.' });
  }
});

export default router;
