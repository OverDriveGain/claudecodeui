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
import { a2aCall } from './a2a.js';
import { MANIFEST_FILE } from './seed.js';
import { loadEndpoints, endpointAvailability, PANE_IDS } from './endpoints.js';

export const BLDR_GPT_PROVIDER = process.env.BLDR_GPT_PROVIDER || 'bti-bldr-gpt';

// Every pane the chain produces, in order. Map/location is intentionally excluded.
export const GENERATED_PANES = PANE_IDS;
// front_view is always a real render; the other drawing panes render as images
// when their endpoint is an image endpoint, else fall back to text-drawn SVG.
const RENDER_PANES = new Set(['front_view']);

/** True if at least one pane endpoint is currently callable. */
export function canGenerate() {
  const { endpoints } = loadEndpoints();
  return GENERATED_PANES.some((id) => endpointAvailability(endpoints[id]).ok);
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

// Per-pane prompts for IMAGE-render endpoints (generate_image): real rendered
// architectural drawings, matching the look of BTI proposal sheets — not SVG art.
const RENDER_PROMPTS = {
  top_view: (b) =>
    `Professional architectural floor plan drawing, top view, of ${briefLine(b)}. ` +
    `CAD-style drafted plan on a white sheet: black wall poche, door swings, furniture symbols, ` +
    `room labels with areas in m², dimension lines, north arrow, small title block. ` +
    `Clean technical drafting, monochrome with subtle gray fills, no perspective, no photo background.`,
  section: (b) =>
    `Professional architectural SECTION drawing (vertical cross-section) of ${briefLine(b)}. ` +
    `CAD-style drafted sheet: cut walls with hatch poche, foundation, floor slabs, roof build-up, ` +
    `ceiling-height dimension lines, level markers, ground line with earth hatch, section title "SECTION A-A". ` +
    `Clean technical drafting on white, monochrome, no perspective, no photo background.`,
  elevations: (b) =>
    `Professional architectural ELEVATION sheet of ${briefLine(b)}: front and side elevations stacked ` +
    `on one white sheet. CAD-style drafted linework: window and door openings with frames, roof line, ` +
    `overall height dimension lines, subtle material hatching (layered 3D-printed concrete banding), ` +
    `titles under each view. Clean technical drafting, monochrome, no perspective, no photo background.`,
  front_view: (b) =>
    `Photorealistic architectural exterior render of a modern 3D-printed concrete villa. ` +
    `Design brief: ${briefLine(b)}. Layered concrete-print wall texture, large floor-to-ceiling glazing, ` +
    `warm interior light, flat roof with thin parapet, Dubai desert setting, cinematic golden-hour dusk lighting, ` +
    `minimalist desert landscaping with stone and desert plants, professional real-estate photography, ultra-detailed.`,
};

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

// --- endpoint transport ---------------------------------------------------

// Direct WG server-to-server call (no proxy in between), so the budget can be
// generous: GPT spawn sessions routinely take 4-6 min under load.
const CALL_TIMEOUT_MS = 480000;

/**
 * Send one prompt through a configured endpoint and return the reply text.
 * a2a → the granted fleet agent; openai → any OpenAI-compatible /chat/completions.
 */
async function callEndpoint(ep, message, timeoutMs = CALL_TIMEOUT_MS) {
  if (ep.backend === 'a2a') {
    return a2aCall({ provider: ep.provider, skill: ep.skill, mode: ep.mode, message, timeoutMs });
  }
  if (ep.backend === 'openai') {
    const headers = { 'Content-Type': 'application/json' };
    const key = ep.apiKeyEnv ? process.env[ep.apiKeyEnv] : null;
    headers.Authorization = `Bearer ${key || 'none'}`; // LiteLLM on WG accepts any bearer
    const res = await fetch(`${ep.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: ep.model, messages: [{ role: 'user', content: message }], max_tokens: 16000 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`endpoint ${ep.baseUrl} HTTP ${res.status}`);
    const body = await res.json();
    return String(body?.choices?.[0]?.message?.content || '').trim();
  }
  throw new Error(`unknown backend '${ep.backend}'`);
}

// --- per-pane tasks -------------------------------------------------------

/** Generate one image pane. Returns { id, file:{name,buffer}, source } or null. */
async function genImagePane(id, brief, ep) {
  const reply = await callEndpoint(ep, IMAGE_PROMPTS[id](brief));
  const dataUrl = extractDataUrl(reply);
  if (!dataUrl) return null;
  const mime = dataUrl.slice(5, dataUrl.indexOf(';'));
  const ext = EXT_BY_MIME[mime] || 'svg';
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const buffer = Buffer.from(b64, 'base64');
  if (!buffer.length) return null;
  return { id, file: { name: `${id}.${ext}`, buffer }, sourcePatch: { type: 'image', path: `${id}.${ext}` } };
}

/** Generate a RENDER pane (real image, per-pane drawing/render prompt). An a2a
 * image endpoint (generate_image exec) writes a PNG on box (bti-owned) and
 * returns its absolute path, which this app (same OS user) reads directly. Any
 * other endpoint is asked for a data URL (vector fallback).
 * Returns { id, file, source } or null. */
async function genRenderPane(id, brief, ep) {
  if (ep.backend === 'a2a' && ep.skill === 'generate_image') {
    const reply = await a2aCall({
      provider: ep.provider,
      skill: ep.skill,
      mode: ep.mode,
      params: { prompt: (RENDER_PROMPTS[id] || RENDER_PROMPTS.front_view)(brief), size: '1536x1024' },
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
  // Text-only endpoint: fall back to a drawn SVG front view.
  const reply = await callEndpoint(ep, `${IMAGE_PROMPTS.elevations(brief).replace('ELEVATIONS pane', 'FRONT_VIEW pane (front facade)')}`);
  const dataUrl = extractDataUrl(reply);
  if (!dataUrl) return null;
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const buffer = Buffer.from(b64, 'base64');
  if (!buffer.length) return null;
  return { id, file: { name: `${id}.svg`, buffer }, sourcePatch: { type: 'image', path: `${id}.svg` } };
}

/** Generate the costs pane. Returns { id:'costs', source } or null. */
async function genCostsPane(brief, current, ep) {
  const reply = await callEndpoint(ep, costsPrompt(brief, current));
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
  return { running: j.running, brief: j.brief, panes: j.panes, endpoints: j.endpointLabels, startedAt: j.startedAt, finishedAt: j.finishedAt };
}

const describeEndpoint = (ep) =>
  ep.label || (ep.backend === 'a2a' ? `${ep.provider}/${ep.skill}` : `${ep.model} @ ${ep.baseUrl}`);

async function runJob(workspacePath, job, brief, wanted) {
  const manifest = JSON.parse(fs.readFileSync(path.join(workspacePath, MANIFEST_FILE), 'utf8'));
  const current = { costs: manifest.sources?.costs?.data || null };
  const { endpoints } = loadEndpoints(); // snapshot the chain once per job
  let idx = 0;
  const worker = async () => {
    while (idx < wanted.length) {
      const id = wanted[idx++];
      const ep = endpoints[id];
      const avail = endpointAvailability(ep);
      job.endpointLabels[id] = ep ? describeEndpoint(ep) : 'unconfigured';
      if (!avail.ok) {
        job.panes[id] = 'skipped';
        continue;
      }
      job.panes[id] = 'working';
      try {
        // Dispatch by the pane's ENDPOINT: an image endpoint means a real
        // rendered drawing for any drawing pane; a text endpoint draws SVG.
        const isImageEndpoint = ep.backend === 'a2a' && ep.skill === 'generate_image';
        const r = id === 'costs'
          ? await genCostsPane(brief, current, ep)
          : RENDER_PANES.has(id) || isImageEndpoint
            ? await genRenderPane(id, brief, ep)
            : await genImagePane(id, brief, ep);
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
    endpointLabels: {},
  };
  jobs.set(workspacePath, job);
  runJob(workspacePath, job, brief, wanted); // fire-and-forget
  return getJob(workspacePath);
}
