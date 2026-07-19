/**
 * bldr — proposal PDF generator.
 *
 * When a customer clicks "Proceed with the project", we produce a BTI-branded PDF
 * proposal that mirrors the real BTI proposal deck (16:9 landscape pages). It is a
 * HYBRID document:
 *   - FIXED marketing pages (cover / title / about / why / commission) are the real
 *     BTI deck pages, embedded full-bleed → pixel-perfect brand, zero per-customer work.
 *   - VARIABLE pages (renders, concept floor plan + area, site, elevations, and a
 *     live COSTS page) are built from the customer's workspace: the image panes
 *     (top_view / section / elevations / front_view) and the costs dataset in
 *     bldr.json. As the design changes, the PDF changes with it.
 *
 * Rendering is dependency-free: we write a self-contained HTML file (all images
 * base64-embedded) and run headless Chrome `--print-to-pdf`. No npm PDF lib needed.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { MANIFEST_FILE } from './seed.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.join(HERE, 'proposal-assets');

const RED = '#D52027';
const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function chromeBin() {
  for (const c of CHROME_CANDIDATES) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** Read a file and return a data: URI, or null if it is missing. */
function dataUri(file, mime) {
  try {
    if (!fs.existsSync(file)) return null;
    const b64 = fs.readFileSync(file).toString('base64');
    return `data:${mime};base64,${b64}`;
  } catch {
    return null;
  }
}

const MIME_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gif': 'image/gif' };

/** A fixed template page (real BTI deck page) as an embedded data URI. */
function templatePage(name) {
  return dataUri(path.join(TEMPLATE_DIR, `${name}.png`), 'image/png');
}

/** A workspace image source (top_view / section / …) as an embedded data URI. */
function workspaceImage(workspacePath, manifest, id) {
  const src = manifest?.sources?.[id];
  if (!src || src.type !== 'image' || !src.path) return null;
  const file = path.join(workspacePath, src.path);
  const mime = MIME_BY_EXT[path.extname(file).toLowerCase()] || 'image/png';
  return dataUri(file, mime);
}

function fmtMoney(n, currency) {
  if (typeof n !== 'number' || !isFinite(n)) return '—';
  return `${currency || 'AED'} ${n.toLocaleString('en-US')}`;
}

/** Escape text for safe HTML interpolation. */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- page builders -------------------------------------------------------

const PAGE_OPEN = '<section class="page">';
const PAGE_CLOSE = '</section>';

function fullBleedPage(uri, fallbackLabel) {
  if (uri) return `${PAGE_OPEN}<img class="bleed" src="${uri}"/>${PAGE_CLOSE}`;
  return `${PAGE_OPEN}<div class="fallback">${esc(fallbackLabel)}</div>${PAGE_CLOSE}`;
}

/** A framed variable page: BTI header strip + a title + a body drawing. */
function drawingPage({ eyebrow, title, sub, imgUri, contain = true, dark = false }) {
  const body = imgUri
    ? `<div class="drawing ${contain ? 'contain' : 'cover'}"><img src="${imgUri}"/></div>`
    : `<div class="drawing empty">Drawing pending</div>`;
  return `${PAGE_OPEN}
    <div class="sheet ${dark ? 'dark' : ''}">
      <header class="hd">
        <div class="brand"><span class="mark">BTi</span><span class="brandsub">BUILD&nbsp;TECH&nbsp;INNOVATIONS</span></div>
        <div class="hdmeta">100 m² Single-Floor Residential Unit</div>
      </header>
      <div class="ttl"><h1>${esc(title)}</h1>${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ''}${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>
      ${body}
      <footer class="ft">BUILDTECH INNOVATIONS 3D PRINTING CONSTRUCTION L.L.C · Business Bay, Dubai · +971 4 452 0966 · info@bti3d.com</footer>
    </div>
  ${PAGE_CLOSE}`;
}

function costsPage(costs) {
  const currency = costs?.currency || 'AED';
  const rows = Array.isArray(costs?.rows) ? costs.rows : [];
  const total = typeof costs?.total === 'number'
    ? costs.total
    : rows.reduce((a, r) => a + (Number(r.cost) || 0), 0);
  const body = rows.map((r) => `
    <tr>
      <td class="c-item">${esc(r.item)}</td>
      <td class="c-num">${esc(r.qty)}</td>
      <td class="c-unit">${esc(r.unit)}</td>
      <td class="c-cost">${fmtMoney(Number(r.cost), currency)}</td>
    </tr>`).join('');
  return `${PAGE_OPEN}
    <div class="sheet dark">
      <header class="hd">
        <div class="brand"><span class="mark">BTi</span><span class="brandsub">BUILD&nbsp;TECH&nbsp;INNOVATIONS</span></div>
        <div class="hdmeta">Indicative project cost</div>
      </header>
      <div class="ttl"><h1>Cost estimate</h1><div class="eyebrow">${esc(costs?.name || '3D building cost')}</div></div>
      <table class="costs">
        <thead><tr><th>Item</th><th>Qty</th><th>Unit</th><th class="c-cost">Cost</th></tr></thead>
        <tbody>${body}</tbody>
        <tfoot><tr><td class="c-item">Total</td><td></td><td></td><td class="c-cost">${fmtMoney(total, currency)}</td></tr></tfoot>
      </table>
      <div class="costnote">Indicative only. Final pricing depends on site conditions, package (Structural-Only or Full Fit-Out), and finishes. A tailored proposal follows your site requirements.</div>
      <footer class="ft">BUILDTECH INNOVATIONS 3D PRINTING CONSTRUCTION L.L.C · Business Bay, Dubai · +971 4 452 0966 · info@bti3d.com</footer>
    </div>
  ${PAGE_CLOSE}`;
}

/** Build the full HTML document from the workspace manifest.
 *
 * Mockup phase: the deck pages (cover…elevations, commission) are the real BTI
 * proposal pages, embedded full-bleed for pixel-perfect fidelity. The one
 * app-GENERATED page is the live COSTS page, computed from the customer's
 * bldr.json (`costs` source), inserted before the commission/contact page. When
 * dedicated agents produce real per-customer renders later, swap the relevant
 * page() below for a drawingPage(workspaceImage(...)). */
export function buildProposalHtml(workspacePath, manifest) {
  const costs = manifest?.sources?.costs?.data || null;

  const page = (name, label) => fullBleedPage(templatePage(name), label);

  const pages = [
    page('page-01', 'BUILDTECH INNOVATIONS'),            // cover
    page('page-02', '3D-Printed Concrete Housing Units'),// title
    page('page-03', 'About BTI'),                        // building by the millimetre
    page('page-04', 'Why 3D-printed'),                   // six reasons
    page('page-05', 'Exterior Design — Option 1'),       // render 1
    page('page-06', 'Exterior Design — Option 2'),       // render 2
    page('page-07', 'Concept design'),                   // floor plan + area
    page('page-08', 'Concept design in the land'),       // site placement
    page('page-09', 'Elevations'),                       // right / left
    page('page-10', 'Elevations'),                       // back / front
    costsPage(costs),                                    // ← live, app-generated
    page('page-11', 'Choose your house. We’ll print it.'), // commission / contact
  ];

  return `<!doctype html><html><head><meta charset="utf-8"/>
<style>
  @page { size: 1440px 810px; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111; background: #fff; }
  .page { width: 1440px; height: 810px; position: relative; overflow: hidden; page-break-after: always; background: #fff; }
  .page:last-child { page-break-after: auto; }
  .bleed { width: 1440px; height: 810px; object-fit: cover; display: block; }
  .fallback { width:100%; height:100%; display:flex; align-items:center; justify-content:center; background:#111; color:#fff; font-size:44px; font-weight:700; }
  /* framed sheet */
  .sheet { width: 100%; height: 100%; padding: 46px 64px 40px; display: flex; flex-direction: column; background:#fff; }
  .sheet.dark { background:#111; color:#f2f0ec; }
  .hd { display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid rgba(0,0,0,.12); padding-bottom:14px; }
  .sheet.dark .hd { border-color: rgba(255,255,255,.14); }
  .brand { display:flex; align-items:center; gap:12px; }
  .mark { background:#111; color:#fff; font-weight:800; letter-spacing:.5px; font-size:22px; padding:5px 10px; border-radius:3px; }
  .mark::after { content:''; display:inline-block; width:7px; height:7px; border-radius:50%; background:${RED}; margin-left:3px; vertical-align:top; }
  .sheet.dark .mark { background:#fff; color:#111; }
  .brandsub { font-size:11px; letter-spacing:1.5px; color:#666; font-weight:700; }
  .sheet.dark .brandsub { color:#999; }
  .hdmeta { font-size:12px; letter-spacing:2px; text-transform:uppercase; color:#888; }
  .ttl { margin: 30px 0 18px; }
  .ttl h1 { font-size:52px; font-weight:400; margin:0; letter-spacing:-1px; }
  .eyebrow { color:${RED}; font-size:22px; font-weight:600; margin-top:6px; }
  .sub { color:#888; font-size:16px; margin-top:8px; }
  .drawing { flex:1; min-height:0; display:flex; align-items:center; justify-content:center; }
  .drawing img { max-width:100%; max-height:100%; }
  .drawing.cover { align-items:stretch; }
  .drawing.cover img { width:100%; height:100%; object-fit:cover; border-radius:4px; }
  .drawing.empty { color:#bbb; font-size:20px; }
  /* costs */
  table.costs { width:100%; border-collapse:collapse; margin-top:10px; font-size:22px; }
  table.costs th { text-align:left; color:#9a9a9a; font-weight:600; font-size:14px; letter-spacing:1.5px; text-transform:uppercase; padding:0 16px 14px; border-bottom:1px solid rgba(255,255,255,.16); }
  table.costs td { padding:18px 16px; border-bottom:1px solid rgba(255,255,255,.08); }
  table.costs .c-num, table.costs .c-unit { color:#b9b9b9; }
  table.costs .c-cost { text-align:right; font-variant-numeric:tabular-nums; }
  table.costs tfoot td { font-size:26px; font-weight:700; color:#fff; border-bottom:none; border-top:2px solid ${RED}; padding-top:20px; }
  .costnote { margin-top:22px; color:#8a8a8a; font-size:14px; max-width:900px; line-height:1.5; }
  .ft { margin-top:auto; padding-top:16px; font-size:10px; letter-spacing:.4px; color:#9a9a9a; }
</style></head>
<body>${pages.join('\n')}</body></html>`;
}

/**
 * Generate the proposal PDF for a workspace. Returns the path to a temp PDF file
 * (caller streams it then deletes it). Throws if Chrome is unavailable.
 */
export function generateProposalPdf(workspacePath) {
  const manifestPath = path.join(workspacePath, MANIFEST_FILE);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const html = buildProposalHtml(workspacePath, manifest);

  const bin = chromeBin();
  if (!bin) throw new Error('No Chrome/Chromium binary found for PDF rendering.');

  const stamp = crypto.randomBytes(8).toString('hex');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bldr-pdf-'));
  const htmlPath = path.join(tmpDir, 'proposal.html');
  const pdfPath = path.join(tmpDir, `BTI-Proposal-${stamp}.pdf`);
  fs.writeFileSync(htmlPath, html);

  const args = [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer',
    `--user-data-dir=${path.join(tmpDir, 'cud')}`,
    `--print-to-pdf=${pdfPath}`,
    `file://${htmlPath}`,
  ];
  const out = spawnSync(bin, args, { timeout: 90000, encoding: 'utf8' });
  if (!fs.existsSync(pdfPath)) {
    throw new Error(`Chrome failed to produce PDF: ${out.stderr || out.error?.message || 'unknown'}`);
  }
  return { pdfPath, tmpDir };
}
