/**
 * bldr project gallery — keep a visitor's PAST projects retrievable.
 *
 * The workspace ROOT stays the single "current project" (manifest + pane
 * assets), untouched in shape — generation, panes, and the proposal PDF all
 * keep working on it as before. The gallery is a ring of snapshots under
 * workspace/projects/<id>/, capped at MAX_PROJECTS (oldest dropped):
 *
 *   - Starting a NEW full generation archives the current project first
 *     (only if it's a real generated design, never the pristine seed).
 *   - Restoring swaps: current → gallery, chosen snapshot → current.
 *
 * Snapshot ids are timestamps, so recency ordering = lexical ordering.
 */
import fs from 'fs';
import path from 'path';
import { MANIFEST_FILE } from './seed.js';

export const PROJECTS_DIR = 'projects';
export const MAX_PROJECTS = 5;

const ID_RE = /^p\d+$/; // p<millis> — validated on restore (no traversal)

const readManifest = (dir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8'));
  } catch {
    return null;
  }
};

/** Files a project is made of: the manifest + every file its sources point to. */
const projectFiles = (manifest) => {
  const files = [MANIFEST_FILE];
  for (const src of Object.values(manifest?.sources || {})) {
    if (typeof src?.path === 'string' && src.path && !src.path.includes('/')) files.push(src.path);
  }
  return files;
};

/** A real design the visitor made — not the seeded mock (brief set, or any rev bumped). */
const isRealProject = (manifest) =>
  !!manifest &&
  (typeof manifest.brief === 'string' && manifest.brief.trim() !== '' ||
    Object.values(manifest.sources || {}).some((s) => (s?.rev || 0) > 1));

const copyProject = (fromDir, toDir, manifest) => {
  fs.mkdirSync(toDir, { recursive: true });
  for (const f of projectFiles(manifest)) {
    const src = path.join(fromDir, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(toDir, f));
  }
};

const galleryIds = (wp) => {
  const dir = path.join(wp, PROJECTS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => ID_RE.test(n)).sort().reverse(); // newest first
};

/** Newest-first list of retrievable past projects for the gallery UI. */
export function listProjects(wp) {
  return galleryIds(wp)
    .map((id) => {
      const manifest = readManifest(path.join(wp, PROJECTS_DIR, id));
      if (!manifest) return null;
      const front = manifest.sources?.front_view;
      const thumbFile = typeof front?.path === 'string' ? front.path : null;
      return {
        id,
        name: (manifest.brief || manifest.name || 'Project').slice(0, 120),
        savedAt: Number(id.slice(1)) || null,
        thumb: thumbFile ? `${PROJECTS_DIR}/${id}/${thumbFile}` : null,
        thumbRev: thumbFile ? front?.rev || 0 : 0,
      };
    })
    .filter(Boolean);
}

/**
 * Snapshot the current project into the gallery (no-op for the pristine seed),
 * pruning to MAX_PROJECTS. Returns the new snapshot id or null.
 */
export function archiveCurrent(wp) {
  const manifest = readManifest(wp);
  if (!isRealProject(manifest)) return null;
  const id = `p${Date.now()}`;
  copyProject(wp, path.join(wp, PROJECTS_DIR, id), manifest);
  for (const old of galleryIds(wp).slice(MAX_PROJECTS)) {
    try { fs.rmSync(path.join(wp, PROJECTS_DIR, old), { recursive: true, force: true }); } catch {}
  }
  return id;
}

/**
 * Make a gallery snapshot the current project (swap: current is archived first,
 * the snapshot leaves the gallery). Source revs are bumped past the current
 * ones so every pane cache-busts and reloads. Returns the restored manifest.
 */
export function restoreProject(wp, id) {
  if (!ID_RE.test(id)) throw new Error('Invalid project id.');
  const snapDir = path.join(wp, PROJECTS_DIR, id);
  const snapshot = readManifest(snapDir);
  if (!snapshot) throw new Error('Project not found.');

  // Take the snapshot OUT of the ring first — archiving the current project
  // below can prune the oldest entry, which on a full gallery is this one.
  const holdDir = path.join(wp, PROJECTS_DIR, `.restoring-${id}`);
  fs.renameSync(snapDir, holdDir);
  try {
    const current = readManifest(wp);
    archiveCurrent(wp); // keep what's on screen retrievable too

    copyProject(holdDir, wp, snapshot);
    for (const [srcId, src] of Object.entries(snapshot.sources || {})) {
      src.rev = Math.max(src.rev || 0, (current?.sources?.[srcId]?.rev || 0)) + 1;
    }
    fs.writeFileSync(path.join(wp, MANIFEST_FILE), JSON.stringify(snapshot, null, 2));
  } finally {
    try { fs.rmSync(holdDir, { recursive: true, force: true }); } catch {}
  }
  return snapshot;
}

/**
 * Called when a NEW full generation starts: archive what's there, then stamp
 * the (kept-visible) current manifest as the new project with its brief — the
 * stamp is what later marks it archivable and names it in the gallery.
 */
export function beginNewProject(wp, brief) {
  archiveCurrent(wp);
  const manifest = readManifest(wp);
  if (!manifest) return;
  manifest.brief = String(brief || '').slice(0, 300);
  manifest.generatedAt = Date.now();
  fs.writeFileSync(path.join(wp, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
}

/**
 * Start from a BLANK slate: archive the current design (if real), then empty
 * every generated pane — sheets show their "no content yet" state until the
 * next generation fills them. The location map keeps its pin. Revs bump past
 * the old ones so panes repaint. Returns the new manifest.
 */
export function resetProject(wp) {
  archiveCurrent(wp);
  const manifest = readManifest(wp);
  if (!manifest) return null;
  const sources = manifest.sources || {};
  for (const [id, src] of Object.entries(sources)) {
    if (src?.type === 'image') {
      sources[id] = { type: 'image', rev: (src.rev || 0) + 1 };
    } else if (src?.type === 'cost-table') {
      sources[id] = { type: 'cost-table', rev: (src.rev || 0) + 1 };
    } // map-cesium keeps its pin
  }
  delete manifest.brief;
  delete manifest.generatedAt;
  manifest.sources = sources;
  fs.writeFileSync(path.join(wp, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
  try { fs.rmSync(path.join(wp, 'project-params.json'), { force: true }); } catch { /* none */ }
  return manifest;
}
