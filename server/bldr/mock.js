/**
 * Emulated pane generation — a fake GPT for development.
 *
 * No external call, no cost: each pane is drawn locally as a BTI-styled SVG
 * sheet (same title block / sheet codes as the real GPT renders) after a
 * realistic delay, so the whole flow — job, per-pane progress UX, manifest
 * revs, gallery — behaves exactly like a real generation. Costs are computed
 * from the brief (area × Dubai rates). Deterministic per brief: the same brief
 * always draws the same sheets.
 *
 * Selected via the 'Emulated (free, dev)' preset in /admin ({ backend:'mock' }).
 */
import crypto from 'crypto';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Deterministic pseudo-random ints in [0,1) from the brief. */
function seeded(brief, salt) {
  const h = crypto.createHash('sha256').update(`${salt}:${brief}`).digest();
  return (i) => h[i % h.length] / 256;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const RED = '#D52027';
const INK = '#1a1a1a';

/** The shared bottom title block — same layout the real render prompts ask for. */
function titleBlock(code, sheetName, brief) {
  const name = esc(brief.length > 64 ? `${brief.slice(0, 61)}…` : brief);
  return `
  <g font-family="Helvetica,Arial,sans-serif">
    <text x="770" y="548" text-anchor="end" font-size="9" fill="#999">EMULATED PREVIEW — FREE DEV MODE</text>
    <line x1="30" y1="558" x2="770" y2="558" stroke="${RED}" stroke-width="2"/>
    <text x="30" y="580" font-size="11" letter-spacing="2" fill="${INK}">BTI — BUILD TECH INNOVATION 3D</text>
    <text x="400" y="580" text-anchor="middle" font-size="10" fill="#555">${name}</text>
    <text x="770" y="580" text-anchor="end" font-size="11" font-family="monospace" fill="${RED}">${code} ${sheetName}</text>
  </g>`;
}

const frame = (inner, code, sheetName, brief) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600">
  <rect width="800" height="600" fill="#ffffff"/>
  ${inner}
  ${titleBlock(code, sheetName, brief)}
</svg>`;

function topViewSvg(brief) {
  const r = seeded(brief, 'top');
  const rooms = 3 + Math.floor(r(0) * 3); // 3-5 rooms along the top
  const w = 560, h = 380, x0 = 120, y0 = 80;
  let inner = `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="none" stroke="${INK}" stroke-width="6"/>`;
  const roomW = w / rooms;
  const labels = ['BEDROOM', 'BEDROOM', 'MAJLIS', 'KITCHEN', 'BATH'];
  for (let i = 1; i < rooms; i++) {
    inner += `<line x1="${x0 + i * roomW}" y1="${y0}" x2="${x0 + i * roomW}" y2="${y0 + h * 0.45}" stroke="${INK}" stroke-width="3"/>`;
  }
  inner += `<line x1="${x0}" y1="${y0 + h * 0.45}" x2="${x0 + w}" y2="${y0 + h * 0.45}" stroke="${INK}" stroke-width="3"/>`;
  for (let i = 0; i < rooms; i++) {
    const area = Math.round(12 + r(i + 1) * 20);
    inner += `<text x="${x0 + i * roomW + roomW / 2}" y="${y0 + 80}" text-anchor="middle" font-size="11" fill="${INK}" font-family="Helvetica,Arial,sans-serif">${labels[i % labels.length]}</text>
      <text x="${x0 + i * roomW + roomW / 2}" y="${y0 + 96}" text-anchor="middle" font-size="9" fill="#777" font-family="Helvetica,Arial,sans-serif">${area} m²</text>`;
  }
  inner += `<text x="${x0 + w / 2}" y="${y0 + h * 0.75}" text-anchor="middle" font-size="12" fill="${INK}" font-family="Helvetica,Arial,sans-serif">LIVING / DINING</text>`;
  // entrance + north arrow
  inner += `<line x1="${x0 + w / 2 - 25}" y1="${y0 + h}" x2="${x0 + w / 2 + 25}" y2="${y0 + h}" stroke="#fff" stroke-width="6"/>
    <path d="M ${x0 + w / 2 - 25} ${y0 + h} A 50 50 0 0 1 ${x0 + w / 2 + 25} ${y0 + h}" fill="none" stroke="${INK}" stroke-width="1.5"/>
    <circle cx="720" cy="100" r="22" fill="none" stroke="${INK}" stroke-width="1.5"/>
    <path d="M 720 84 L 726 106 L 720 100 L 714 106 Z" fill="${RED}"/>
    <text x="720" y="140" text-anchor="middle" font-size="10" fill="${INK}" font-family="Helvetica,Arial,sans-serif">N</text>`;
  return frame(inner, 'A-101', 'FLOOR PLAN', brief);
}

function sectionSvg(brief) {
  const r = seeded(brief, 'sec');
  const storeys = /g\+3|4 floors/i.test(brief) ? 4 : /g\+2|3 floors/i.test(brief) ? 3 : /g\+1|2 floors/i.test(brief) ? 2 : 1;
  const fh = Math.min(110, 330 / storeys);
  const x0 = 160, w = 460, ground = 470;
  let inner = `<line x1="60" y1="${ground}" x2="740" y2="${ground}" stroke="${INK}" stroke-width="3"/>`;
  for (let g = 0; g < 30; g++) inner += `<line x1="${64 + g * 23}" y1="${ground}" x2="${54 + g * 23}" y2="${ground + 12}" stroke="${INK}" stroke-width="1"/>`;
  for (let s = 0; s < storeys; s++) {
    const y = ground - (s + 1) * fh;
    inner += `<rect x="${x0}" y="${y}" width="${w}" height="${fh}" fill="none" stroke="${INK}" stroke-width="4"/>
      <rect x="${x0}" y="${y}" width="14" height="${fh}" fill="url(#h)"/><rect x="${x0 + w - 14}" y="${y}" width="14" height="${fh}" fill="url(#h)"/>`;
  }
  const top = ground - storeys * fh;
  inner += `<line x1="${x0 - 20}" y1="${top - Math.round(20 + r(2) * 25)}" x2="${x0 + w / 2}" y2="${top - Math.round(45 + r(3) * 30)}" stroke="${INK}" stroke-width="3"/>
    <line x1="${x0 + w / 2}" y1="${top - Math.round(45 + r(3) * 30)}" x2="${x0 + w + 20}" y2="${top - Math.round(20 + r(2) * 25)}" stroke="${INK}" stroke-width="3"/>`;
  inner += `<defs><pattern id="h" width="6" height="6" patternUnits="userSpaceOnUse"><path d="M0 6 L6 0" stroke="${INK}" stroke-width="1"/></pattern></defs>
    <line x1="120" y1="${ground}" x2="120" y2="${ground - fh}" stroke="${RED}" stroke-width="1"/>
    <text x="106" y="${ground - fh / 2}" text-anchor="middle" font-size="10" fill="${RED}" font-family="Helvetica,Arial,sans-serif" transform="rotate(-90 106 ${ground - fh / 2})">3.20 m</text>
    <text x="400" y="520" text-anchor="middle" font-size="12" letter-spacing="3" fill="${INK}" font-family="Helvetica,Arial,sans-serif">SECTION A-A</text>`;
  return frame(inner, 'A-201', 'SECTION', brief);
}

function elevationsSvg(brief) {
  const r = seeded(brief, 'ele');
  const winsF = 3 + Math.floor(r(0) * 3);
  const winsS = 2 + Math.floor(r(1) * 3);
  const facade = (x0, y0, w, h, wins, caption) => {
    let s = `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="none" stroke="${INK}" stroke-width="3"/>`;
    for (let b = 0; b < 6; b++) s += `<line x1="${x0}" y1="${y0 + (b + 1) * (h / 7)}" x2="${x0 + w}" y2="${y0 + (b + 1) * (h / 7)}" stroke="#ccc" stroke-width="0.8"/>`;
    const ww = w / (wins * 2);
    for (let i = 0; i < wins; i++) {
      s += `<rect x="${x0 + ww * (2 * i + 0.6)}" y="${y0 + h * 0.25}" width="${ww}" height="${h * 0.42}" fill="none" stroke="${INK}" stroke-width="1.6"/>`;
    }
    s += `<text x="${x0 + w / 2}" y="${y0 + h + 22}" text-anchor="middle" font-size="11" letter-spacing="2" fill="${INK}" font-family="Helvetica,Arial,sans-serif">${caption}</text>`;
    return s;
  };
  let inner = facade(120, 70, 560, 150, winsF, 'FRONT ELEVATION');
  inner += facade(120, 300, 560, 150, winsS, 'SIDE ELEVATION');
  inner += `<line x1="700" y1="70" x2="700" y2="220" stroke="${RED}" stroke-width="1"/>
    <text x="714" y="150" text-anchor="middle" font-size="10" fill="${RED}" font-family="Helvetica,Arial,sans-serif" transform="rotate(90 714 150)">+6.40 m</text>`;
  return frame(inner, 'A-301', 'ELEVATIONS', brief);
}

function frontViewSvg(brief) {
  const r = seeded(brief, 'fv');
  const skew = 40 + Math.round(r(0) * 40);
  let inner = `<rect x="0" y="0" width="800" height="540" fill="#f6f2ec"/>
    <circle cx="${640 + Math.round(r(1) * 60)}" cy="90" r="34" fill="${RED}" opacity="0.85"/>
    <line x1="0" y1="440" x2="800" y2="440" stroke="${INK}" stroke-width="2"/>
    <polygon points="150,440 150,220 ${470 - skew},200 470,240 470,440" fill="#ffffff" stroke="${INK}" stroke-width="3"/>
    <polygon points="470,240 ${470 - skew},200 ${640 - skew},210 640,250 640,440 470,440" fill="#eee6da" stroke="${INK}" stroke-width="3"/>`;
  for (let b = 0; b < 9; b++) {
    inner += `<line x1="152" y1="${250 + b * 20}" x2="468" y2="${252 + b * 20}" stroke="#d8cfc2" stroke-width="1.4"/>`;
  }
  inner += `<rect x="200" y="280" width="120" height="160" fill="#bcd6e2" stroke="${INK}" stroke-width="2"/>
    <rect x="345" y="280" width="80" height="160" fill="#bcd6e2" stroke="${INK}" stroke-width="2"/>
    <line x1="150" y1="220" x2="470" y2="240" stroke="${INK}" stroke-width="4"/>
    <path d="M 90 440 q 6 -46 0 -78 q 20 30 14 78 Z" fill="#7a9c6e" stroke="${INK}" stroke-width="1"/>
    <path d="M 706 440 q 8 -56 0 -92 q 24 36 18 92 Z" fill="#7a9c6e" stroke="${INK}" stroke-width="1"/>
    <text x="30" y="60" font-size="12" letter-spacing="3" fill="${INK}" font-family="Helvetica,Arial,sans-serif">EXTERIOR CONCEPT — 3D-PRINTED SHELL</text>`;
  return frame(inner, 'R-401', 'EXTERIOR RENDER', brief);
}

const SVG_BUILDERS = { top_view: topViewSvg, section: sectionSvg, elevations: elevationsSvg, front_view: frontViewSvg };

function mockCosts(brief) {
  const areaMatch = brief.match(/(\d{2,4})\s*m/i);
  const area = Math.min(1200, Math.max(30, areaMatch ? Number(areaMatch[1]) : 200));
  const finishRate = /premium/i.test(brief) ? 1400 : /shell/i.test(brief) ? 150 : 850;
  const rows = [
    { item: 'Foundation & raft slab', qty: area, unit: 'm²', cost: Math.round(area * 580) },
    { item: '3D-printed concrete walls', qty: Math.round(area * 2.4), unit: 'm²', cost: Math.round(area * 1850) },
    { item: 'Roof & slab structure', qty: area, unit: 'm²', cost: Math.round(area * 640) },
    { item: 'MEP (mech/elec/plumb)', qty: 1, unit: 'lot', cost: Math.round(area * 540) },
    { item: 'Finishes & fit-out', qty: area, unit: 'm²', cost: Math.round(area * finishRate) },
  ];
  const total = rows.reduce((a, r) => a + r.cost, 0);
  return { name: '3D building cost', currency: 'AED', rows, total };
}

/** Emulate one pane end-to-end: realistic delay, then a locally-drawn result. */
export async function genMockPane(id, brief, ep, meta = null) {
  if (meta) meta.prompt = `[emulated ${id}] brief: ${brief}`;
  const r = seeded(brief, `delay:${id}`);
  const delay = Number.isFinite(ep.delayMs) ? ep.delayMs : 7000 + Math.round(r(0) * 8000); // 7–15 s
  await sleep(delay);
  if (id === 'costs') {
    const data = mockCosts(brief);
    if (meta) meta.reply = `emulated costs, total ${data.currency} ${data.total.toLocaleString('en-US')}`;
    return { id, sourcePatch: { type: 'cost-table', name: 'Cost estimate', data } };
  }
  const builder = SVG_BUILDERS[id];
  if (!builder) return null;
  const buffer = Buffer.from(builder(brief), 'utf8');
  if (meta) meta.reply = `emulated ${id}.svg drawn locally (${buffer.length} bytes)`;
  return { id, file: { name: `${id}.svg`, buffer }, sourcePatch: { type: 'image', path: `${id}.svg` } };
}
