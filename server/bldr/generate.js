/**
 * Route B — per-pane generation via bti-bldr-gpt (A2A).
 *
 * The app asks the design agent to produce content for EACH pane except Map:
 *   - top_view / section / elevations / front_view → an SVG drawing (data: URL)
 *   - costs → strict JSON (our pinned schema)
 * The agent is text-only, so image panes come back as vector SVG (not photoreal
 * renders). Results are written into the workspace (svg files + bldr.json), which
 * `/api/bldr/manifest` already serves — no pane/endpoint changes.
 */
import fs from 'fs';
import path from 'path';
import { a2aCall, hasGrant } from './a2a.js';
import { MANIFEST_FILE } from './seed.js';

export const BLDR_GPT_PROVIDER = process.env.BLDR_GPT_PROVIDER || 'bti-bldr-gpt';

// Every pane the agent produces, in order. Map/location is intentionally excluded.
export const GENERATED_PANES = ['top_view', 'section', 'elevations', 'front_view', 'costs'];
// SVG line-drawing panes (agent draws vector); front_view is a photoreal RENDER
// via the generate_image exec skill; costs is JSON.
const SVG_PANES = new Set(['top_view', 'section', 'elevations']);
const RENDER_PANES = new Set(['front_view']);

/** True if the app can currently reach the design agent over A2A. */
export function canGenerate() {
  return hasGrant(BLDR_GPT_PROVIDER, 'general_query');
}

const briefLine = (brief) =>
  brief && brief.trim() ? brief.trim() : 'a standard BTI single-floor 3-bedroom concrete villa, full fit-out, Dubai';

// --- per-pane prompts -----------------------------------------------------

const SVG_TAIL =
  'Return an SVG drawing as a single-line data URL and NOTHING ELSE: ' +
  'data:image/svg+xml;base64,<base64 of the SVG document>. ' +
  'viewBox 0 0 800 600, clean architectural line style, dark-on-light, legible labels, ' +
  'a small title top-left. Keep the base64 payload under 200 KB. No prose, no code fences.';

const IMAGE_PROMPTS = {
  top_view: (b) =>
    `Generate the TOP_VIEW pane (architectural floor plan) for ${briefLine(b)}. ` +
    `Show room rectangles with wall lines and labels (bedrooms, living, kitchen, bathrooms, entrance) with areas in m². ${SVG_TAIL}`,
  section: (b) =>
    `Generate the SECTION pane (vertical cross-section) for ${briefLine(b)}. ` +
    `Show floor slab, printed concrete walls, roof, ceiling height dimension, and a ground line. ${SVG_TAIL}`,
  elevations: (b) =>
    `Generate the ELEVATIONS pane for ${briefLine(b)}. ` +
    `Show front and side elevations stacked, with window/door openings, roof line, and a height dimension. ${SVG_TAIL}`,
};

// Prompt for the photoreal exterior render (front_view), built from the brief.
const renderPrompt = (b) =>
  `Photorealistic architectural exterior render of a modern 3D-printed concrete villa. ` +
  `Design brief: ${briefLine(b)}. Layered concrete-print wall texture, large floor-to-ceiling glazing, ` +
  `warm interior light, flat roof with thin parapet, Dubai desert setting, cinematic golden-hour dusk lighting, ` +
  `minimalist desert landscaping with stone and desert plants, professional real-estate photography, ultra-detailed.`;

const costsPrompt = (b, current) =>
  `Generate the COSTS pane for ${briefLine(b)}.\n` +
  (current ? `Current values for reference: ${JSON.stringify(current)}\n` : '') +
  'Return STRICT JSON ONLY (no prose, no fences), exact schema:\n' +
  '{ "name":"3D building cost", "currency":"AED", ' +
  '"rows":[{"item":string,"qty":number,"unit":string,"cost":number}], "total":number }\n' +
  'Rows must cover foundation, 3D-printed walls, roof/slab, MEP, finishes (add more if relevant). ' +
  'AED, realistic for Dubai; total = sum of row costs. Output the JSON object and nothing else.';

// --- parsing helpers ------------------------------------------------------

/** Pull the first `data:image/...;base64,...` URL out of a reply. */
function extractDataUrl(text) {
  const m = String(text || '').match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/);
  if (!m) return null;
  return m[0].replace(/\s+/g, '');
}

const EXT_BY_MIME = { 'image/svg+xml': 'svg', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** Pull the first balanced {...} JSON object out of a possibly-chatty reply. */
function extractJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) {
      try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

function validCosts(c) {
  return c && Array.isArray(c.rows) && c.rows.every((r) => r && typeof r.item === 'string' && typeof r.cost === 'number');
}

// --- per-pane tasks -------------------------------------------------------

const CALL_TIMEOUT_MS = 280000; // each spawn session is slow; stay under nginx-free server-to-server budget

/** Generate one image pane. Returns { id, file:{name,buffer}, source } or null. */
async function genImagePane(id, brief) {
  const reply = await a2aCall({
    provider: BLDR_GPT_PROVIDER, skill: 'general_query', mode: 'spawn', message: IMAGE_PROMPTS[id](brief),
    timeoutMs: CALL_TIMEOUT_MS,
  });
  const dataUrl = extractDataUrl(reply);
  if (!dataUrl) return null;
  const mime = dataUrl.slice(5, dataUrl.indexOf(';'));
  const ext = EXT_BY_MIME[mime] || 'svg';
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const buffer = Buffer.from(b64, 'base64');
  if (!buffer.length) return null;
  return { id, file: { name: `${id}.${ext}`, buffer }, sourcePatch: { type: 'image', path: `${id}.${ext}` } };
}

/** Generate a photoreal RENDER pane via the generate_image exec skill.
 * The provider writes a PNG on box (bti-owned) and returns its absolute path,
 * which this app (same OS user) reads directly. Returns { id, file, source } or null. */
async function genRenderPane(id, brief) {
  const reply = await a2aCall({
    provider: BLDR_GPT_PROVIDER,
    skill: 'generate_image',
    mode: 'exec',
    params: { prompt: renderPrompt(brief), size: '1536x1024' },
    timeoutMs: CALL_TIMEOUT_MS,
  });
  // The exec skill returns the absolute PNG path (possibly with surrounding text).
  const m = String(reply || '').match(/\/\S+\.png/);
  const filePath = m?.[0];
  if (!filePath || !fs.existsSync(filePath)) return null;
  const buffer = fs.readFileSync(filePath);
  if (!buffer.length) return null;
  return { id, file: { name: `${id}.png`, buffer }, sourcePatch: { type: 'image', path: `${id}.png` } };
}

/** Generate the costs pane. Returns { id:'costs', source } or null. */
async function genCostsPane(brief, current) {
  const reply = await a2aCall({
    provider: BLDR_GPT_PROVIDER, skill: 'general_query', mode: 'spawn', message: costsPrompt(brief, current),
    timeoutMs: CALL_TIMEOUT_MS,
  });
  const data = extractJson(reply);
  if (!validCosts(data)) return null;
  const total = typeof data.total === 'number' ? data.total : data.rows.reduce((a, r) => a + (Number(r.cost) || 0), 0);
  return { id: 'costs', sourcePatch: { type: 'cost-table', name: data.name || 'Cost estimate', data: { ...data, total } } };
}

/** Write a single completed pane result into the workspace (svg file + manifest). */
function applyPane(workspacePath, id, result) {
  const manifestPath = path.join(workspacePath, MANIFEST_FILE);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.sources = manifest.sources || {};
  if (result.file) fs.writeFileSync(path.join(workspacePath, result.file.name), result.file.buffer);
  const prevRev = manifest.sources[id]?.rev || 0;
  manifest.sources[id] = { ...result.sourcePatch, rev: prevRev + 1 };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

// --- async job model ------------------------------------------------------
// Generating 5 panes takes minutes (a fresh agent session per pane), so a
// synchronous request would exceed the proxy timeout. Instead we run a
// background job per workspace, write each pane the moment it lands, and let the
// client poll `/generate/job` + re-read the manifest to fill panes live.

const CONCURRENCY = 2; // the provider effectively handles ~2 spawn sessions at once
const jobs = new Map(); // workspacePath -> job

/** Current job status for a workspace (safe to serialize), or null. */
export function getJob(workspacePath) {
  const j = jobs.get(workspacePath);
  if (!j) return null;
  return { running: j.running, brief: j.brief, panes: j.panes, startedAt: j.startedAt, finishedAt: j.finishedAt };
}

async function runJob(workspacePath, job, brief, wanted) {
  const manifest = JSON.parse(fs.readFileSync(path.join(workspacePath, MANIFEST_FILE), 'utf8'));
  const current = { costs: manifest.sources?.costs?.data || null };
  let idx = 0;
  const worker = async () => {
    while (idx < wanted.length) {
      const id = wanted[idx++];
      job.panes[id] = 'working';
      try {
        const r = RENDER_PANES.has(id)
          ? await genRenderPane(id, brief)
          : SVG_PANES.has(id)
            ? await genImagePane(id, brief)
            : await genCostsPane(brief, current);
        if (r) { applyPane(workspacePath, id, r); job.panes[id] = 'done'; }
        else job.panes[id] = 'failed';
      } catch (err) {
        console.error('[bldr] pane', id, 'failed:', err?.message || err);
        job.panes[id] = 'failed';
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, wanted.length) }, worker));
  } finally {
    job.running = false;
    job.finishedAt = Date.now();
  }
}

/**
 * Start (or return the in-flight) generation job for a workspace. Non-blocking:
 * returns the initial job status immediately; panes fill in as calls complete.
 */
export function startGeneration(workspacePath, brief, panes = GENERATED_PANES) {
  const existing = jobs.get(workspacePath);
  if (existing?.running) return getJob(workspacePath);
  const wanted = panes.filter((p) => GENERATED_PANES.includes(p));
  const job = {
    running: true,
    brief: brief || '',
    startedAt: Date.now(),
    finishedAt: null,
    panes: Object.fromEntries(wanted.map((id) => [id, 'pending'])),
  };
  jobs.set(workspacePath, job);
  runJob(workspacePath, job, brief, wanted); // fire-and-forget
  return getJob(workspacePath);
}
