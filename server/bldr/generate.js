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
import crypto from 'crypto';
import { DOMParser, onErrorStopParsing } from '@xmldom/xmldom';
import { a2aCall } from './a2a.js';
import { getOtel, flushOtel, OTEL_DEBUG_TEXT } from './otel.js';
import { MANIFEST_FILE } from './seed.js';
import { loadEndpoints, endpointAvailability, PANE_IDS } from './endpoints.js';
import { genMockPane } from './mock.js';

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
//
// ONE DRAWING SET: every sheet shares the same visual language and the same
// title block, so the four panes (and the app's matching pane chrome) read as
// one document, not four unrelated images.
const SHEET_STYLE = (code, sheetName) =>
  `Present it as ONE SHEET of a professional architecture drawing set, consistent with its sibling sheets: ` +
  `pure white paper background, precise black ink CAD linework, a single accent color red #D52027 used only sparingly ` +
  `(sheet-code text, small marker accents). Along the very bottom edge a slim horizontal TITLE BLOCK: thin red rule on top, ` +
  `left "BTI — BUILD TECH INNOVATION 3D" in small capitals, center the project name, right the sheet code "${code} ${sheetName}". ` +
  `Same margins, same lettering style (clean engineering sans-serif capitals) as the rest of the set. ` +
  `No watermark, no logo images, no decorative borders.`;

const RENDER_PROMPTS = {
  top_view: (b) =>
    `Professional architectural floor plan drawing, top view, of ${briefLine(b)}. ` +
    `CAD-style drafted plan: black wall poche, door swings, furniture symbols, ` +
    `room labels with areas in m², dimension lines, north arrow. ` +
    `Clean technical drafting, monochrome with subtle gray fills, no perspective, no photo background. ` +
    SHEET_STYLE('A-101', 'FLOOR PLAN'),
  section: (b) =>
    `Professional architectural SECTION drawing (vertical cross-section) of ${briefLine(b)}. ` +
    `CAD-style drafted: cut walls with hatch poche, foundation, floor slabs, roof build-up, ` +
    `ceiling-height dimension lines, level markers, ground line with earth hatch, view caption "SECTION A-A". ` +
    `Clean technical drafting, monochrome, no perspective, no photo background. ` +
    SHEET_STYLE('A-201', 'SECTION'),
  elevations: (b) =>
    `Professional architectural ELEVATION sheet of ${briefLine(b)}: front and side elevations stacked. ` +
    `CAD-style drafted linework: window and door openings with frames, roof line, ` +
    `overall height dimension lines, subtle material hatching (layered 3D-printed concrete banding), ` +
    `captions under each view. Clean technical drafting, monochrome, no perspective, no photo background. ` +
    SHEET_STYLE('A-301', 'ELEVATIONS'),
  front_view: (b) =>
    `Photorealistic architectural exterior render of a modern 3D-printed concrete building. ` +
    `Design brief: ${briefLine(b)}. Layered concrete-print wall texture, large floor-to-ceiling glazing, ` +
    `warm interior light, Dubai setting, cinematic golden-hour dusk lighting, ` +
    `minimalist desert landscaping, professional real-estate photography, ultra-detailed. ` +
    `The photograph fills the sheet edge-to-edge above the title block. ` +
    SHEET_STYLE('R-401', 'EXTERIOR RENDER'),
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

/** Reject malformed/truncated SVG so a bad drawing never replaces a good pane
 * (the pane then reads 'failed' and keeps its previous version — the browser
 * would only show a broken-image icon for these). */
function isRenderableSvg(buffer) {
  if (buffer.length < 300) return false;
  try {
    const doc = new DOMParser({ onError: onErrorStopParsing }).parseFromString(buffer.toString('utf8'), 'image/svg+xml');
    return doc?.documentElement?.nodeName === 'svg';
  } catch {
    return false;
  }
}

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
async function callEndpoint(ep, message, timeoutMs = CALL_TIMEOUT_MS, meta = null) {
  if (meta) meta.prompt = message;
  if (ep.backend === 'a2a') {
    const reply = await a2aCall({ provider: ep.provider, skill: ep.skill, mode: ep.mode, message, timeoutMs });
    if (meta) meta.reply = reply;
    return reply;
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
    if (meta && body?.usage) {
      meta.usage = { input: body.usage.prompt_tokens, output: body.usage.completion_tokens };
    }
    const reply = String(body?.choices?.[0]?.message?.content || '').trim();
    if (meta) meta.reply = reply;
    return reply;
  }
  throw new Error(`unknown backend '${ep.backend}'`);
}

// --- per-pane tasks -------------------------------------------------------

/** Generate one image pane. Returns { id, file:{name,buffer}, source } or null. */
async function genImagePane(id, brief, ep, meta = null) {
  const reply = await callEndpoint(ep, IMAGE_PROMPTS[id](brief), CALL_TIMEOUT_MS, meta);
  const dataUrl = extractDataUrl(reply);
  if (!dataUrl) return null;
  const mime = dataUrl.slice(5, dataUrl.indexOf(';'));
  const ext = EXT_BY_MIME[mime] || 'svg';
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const buffer = Buffer.from(b64, 'base64');
  if (!buffer.length) return null;
  if (ext === 'svg' && !isRenderableSvg(buffer)) return null;
  return { id, file: { name: `${id}.${ext}`, buffer }, sourcePatch: { type: 'image', path: `${id}.${ext}` } };
}

/** Generate a RENDER pane (real image, per-pane drawing/render prompt). An a2a
 * image endpoint (generate_image exec) writes a PNG on box (bti-owned) and
 * returns its absolute path, which this app (same OS user) reads directly. Any
 * other endpoint is asked for a data URL (vector fallback).
 * Returns { id, file, source } or null. */
async function genRenderPane(id, brief, ep, meta = null) {
  if (ep.backend === 'a2a' && ep.skill === 'generate_image') {
    const prompt = (RENDER_PROMPTS[id] || RENDER_PROMPTS.front_view)(brief);
    if (meta) meta.prompt = prompt;
    const reply = await a2aCall({
      provider: ep.provider,
      skill: ep.skill,
      mode: ep.mode,
      params: { prompt, size: '1536x1024' },
      timeoutMs: CALL_TIMEOUT_MS,
    });
    if (meta) meta.reply = reply;
    // The exec skill returns the absolute PNG path (possibly with surrounding text).
    const m = String(reply || '').match(/\/\S+\.png/);
    const filePath = m?.[0];
    if (!filePath || !fs.existsSync(filePath)) return null;
    const buffer = fs.readFileSync(filePath);
    if (!buffer.length) return null;
    return { id, file: { name: `${id}.png`, buffer }, sourcePatch: { type: 'image', path: `${id}.png` } };
  }
  // Text-only endpoint: fall back to a drawn SVG front view.
  const reply = await callEndpoint(ep, `${IMAGE_PROMPTS.elevations(brief).replace('ELEVATIONS pane', 'FRONT_VIEW pane (front facade)')}`, CALL_TIMEOUT_MS, meta);
  const dataUrl = extractDataUrl(reply);
  if (!dataUrl) return null;
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const buffer = Buffer.from(b64, 'base64');
  if (!buffer.length || !isRenderableSvg(buffer)) return null;
  return { id, file: { name: `${id}.svg`, buffer }, sourcePatch: { type: 'image', path: `${id}.svg` } };
}

/** Generate the costs pane. Returns { id:'costs', source } or null. */
async function genCostsPane(brief, current, ep, meta = null) {
  const reply = await callEndpoint(ep, costsPrompt(brief, current), CALL_TIMEOUT_MS, meta);
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
const MAX_HISTORY = 30;
const history = []; // finished job snapshots, newest first (admin Live activity)

const snapshotJob = (workspacePath, j) => ({
  workspace: path.basename(workspacePath),
  running: j.running,
  brief: j.brief,
  panes: j.panes,
  trace: j.trace,
  endpoints: j.endpointLabels,
  startedAt: j.startedAt,
  finishedAt: j.finishedAt,
});

/** Current job status for a workspace (safe to serialize), or null. */
export function getJob(workspacePath) {
  const j = jobs.get(workspacePath);
  if (!j) return null;
  return snapshotJob(workspacePath, j);
}

/** Admin view: every in-flight job + the last finished runs, all workspaces. */
export function listJobs() {
  const active = [];
  for (const [wp, j] of jobs) if (j.running) active.push(snapshotJob(wp, j));
  active.sort((a, b) => b.startedAt - a.startedAt);
  return { active, recent: history.slice(0, MAX_HISTORY) };
}

const describeEndpoint = (ep) =>
  ep.label || (ep.backend === 'a2a' ? `${ep.provider}/${ep.skill}` : `${ep.model} @ ${ep.baseUrl}`);

// One JSON line per event on stdout → journald → (optionally) Loki/Grafana.
// Grep key: [bldr-trace]. Keep fields flat and stable — dashboards parse these.
const logTrace = (event, fields) =>
  console.log('[bldr-trace]', JSON.stringify({ event, ts: new Date().toISOString(), ...fields }));

async function runJob(workspacePath, job, brief, wanted) {
  const manifest = JSON.parse(fs.readFileSync(path.join(workspacePath, MANIFEST_FILE), 'utf8'));
  const current = { costs: manifest.sources?.costs?.data || null };
  const { endpoints } = loadEndpoints(); // snapshot the chain once per job
  // Tracing (no-op unless BLDR_OTEL=1): one parent span per request, one child
  // span per LLM call — the pane fan-out shows as a tree in Tempo.
  const otel = await getOtel();
  const briefText = briefLine(brief);
  const parentSpan = otel?.tracer.startSpan('bldr.generate', {
    attributes: {
      'bldr.workspace': path.basename(workspacePath),
      'bldr.panes': wanted.join(','),
      'bldr.brief.sha256': crypto.createHash('sha256').update(briefText).digest('hex').slice(0, 16),
      'bldr.brief.length': briefText.length,
      ...(OTEL_DEBUG_TEXT ? { 'bldr.brief': briefText.slice(0, 300) } : {}),
    },
  });
  const paneCtx = parentSpan ? otel.trace.setSpan(otel.context.active(), parentSpan) : null;
  if (parentSpan) console.log('[bldr-otel] trace', parentSpan.spanContext().traceId);
  let idx = 0;
  const worker = async () => {
    while (idx < wanted.length) {
      const id = wanted[idx++];
      const ep = endpoints[id];
      const avail = endpointAvailability(ep);
      job.endpointLabels[id] = ep ? describeEndpoint(ep) : 'unconfigured';
      const t = job.trace[id];
      t.endpoint = job.endpointLabels[id];
      if (!avail.ok) {
        job.panes[id] = t.state = 'skipped';
        t.error = avail.reason || 'endpoint unavailable';
        continue;
      }
      job.panes[id] = t.state = 'working';
      t.startedAt = Date.now();
      logTrace('pane_start', { workspace: path.basename(workspacePath), pane: id, endpoint: t.endpoint });
      const span = paneCtx
        ? otel.tracer.startSpan(`llm.${id}`, {
            attributes: {
              'bldr.pane': id,
              'bldr.endpoint': t.endpoint,
              'gen_ai.system': ep.backend === 'mock' ? 'emulated' : ep.backend === 'a2a' ? `a2a:${ep.provider}` : 'openai',
              'gen_ai.request.model': ep.model || (ep.backend === 'mock' ? 'emulated' : `${ep.provider || '?'}/${ep.skill || '?'}`),
            },
          }, paneCtx)
        : null;
      const meta = {};
      try {
        // Dispatch by the pane's ENDPOINT: an image endpoint means a real
        // rendered drawing for any drawing pane; a text endpoint draws SVG.
        const isImageEndpoint = ep.backend === 'a2a' && ep.skill === 'generate_image';
        const r = ep.backend === 'mock'
          ? await genMockPane(id, brief, ep, meta)
          : id === 'costs'
            ? await genCostsPane(brief, current, ep, meta)
            : RENDER_PANES.has(id) || isImageEndpoint
              ? await genRenderPane(id, brief, ep, meta)
              : await genImagePane(id, brief, ep, meta);
        if (r) { applyPane(workspacePath, id, r); job.panes[id] = t.state = 'done'; }
        else {
          job.panes[id] = t.state = 'failed';
          t.error = 'endpoint replied, but the reply had no usable output (wrong/empty format)';
        }
      } catch (err) {
        console.error('[bldr] pane', id, 'failed:', err?.message || err);
        job.panes[id] = t.state = 'failed';
        t.error = String(err?.message || err);
      }
      t.finishedAt = Date.now();
      t.ms = t.finishedAt - (t.startedAt || t.finishedAt);
      // Admin-visible request/response excerpt (Live activity → prompt & reply).
      if (meta.prompt) t.prompt = String(meta.prompt).slice(0, 1500);
      if (meta.reply) {
        const rep = String(meta.reply);
        t.reply = /^data:image\//.test(rep.trim())
          ? `(image data-URL reply, ${rep.length} chars)`
          : rep.slice(0, 600);
      }
      if (span) {
        span.setAttributes({
          'bldr.state': t.state,
          'bldr.latency_ms': t.ms,
          ...(meta.usage?.input != null ? { 'gen_ai.usage.input_tokens': meta.usage.input } : {}),
          ...(meta.usage?.output != null ? { 'gen_ai.usage.output_tokens': meta.usage.output } : {}),
          ...(OTEL_DEBUG_TEXT && meta.prompt ? { 'gen_ai.prompt': String(meta.prompt).slice(0, 500) } : {}),
        });
        if (t.error) span.setStatus({ code: otel.SpanStatusCode.ERROR, message: t.error });
        span.end();
      }
      logTrace('pane_end', {
        workspace: path.basename(workspacePath),
        pane: id,
        state: t.state,
        ms: t.ms,
        endpoint: t.endpoint,
        ...(t.error ? { error: t.error } : {}),
      });
    }
  };
  logTrace('job_start', { workspace: path.basename(workspacePath), brief, panes: wanted });
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, wanted.length) }, worker));
  } finally {
    job.running = false;
    job.finishedAt = Date.now();
    const states = Object.values(job.panes);
    const doneCount = states.filter((s) => s === 'done').length;
    const failedCount = states.filter((s) => s === 'failed' || s === 'skipped').length;
    if (parentSpan) {
      parentSpan.setAttributes({ 'bldr.done': doneCount, 'bldr.failed': failedCount, 'bldr.total': states.length });
      if (doneCount === 0 && states.length > 0) {
        parentSpan.setStatus({ code: otel.SpanStatusCode.ERROR, message: 'all panes failed' });
      }
      parentSpan.end();
      flushOtel();
    }
    logTrace('job_end', {
      workspace: path.basename(workspacePath),
      ms: job.finishedAt - job.startedAt,
      done: doneCount,
      failed: failedCount,
      total: states.length,
    });
    history.unshift(snapshotJob(workspacePath, job));
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
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
    trace: Object.fromEntries(wanted.map((id) => [id, { state: 'pending' }])),
    endpointLabels: {},
  };
  jobs.set(workspacePath, job);
  runJob(workspacePath, job, brief, wanted); // fire-and-forget
  return getJob(workspacePath);
}
