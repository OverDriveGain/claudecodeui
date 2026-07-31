#!/usr/bin/env node
// MYMU: idempotent branding sweep (FORK.md S7-branding).
//
// Upstream ships as "CloudCLI"; MyMu rebrands every USER-VISIBLE occurrence.
// Instead of maintaining a fragile diff over dozens of files, this script
// re-applies the rename mechanically — run it once after every upstream pull:
//
//   node scripts/mymu-rebrand.mjs
//
// What it touches:
//   - src/i18n/locales/**/*.json — string VALUES only (never key names)
//   - src/**/*.{ts,tsx,jsx}     — word-bounded "CloudCLI" literals/comments
//     (identifiers like `prismCloudCLI` or paths like `.cloudcli` are excluded
//     by the word boundary)
// What it deliberately does NOT touch:
//   - package.json name, npm scope, data dirs (~/.cloudcli asset store) —
//     runtime identifiers stay upstream so migrations/paths keep working.
//   - public/ and index.html — those are wholesale MyMu-owned files.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
let localeValues = 0;
let codeFiles = 0;

function* walk(dir, exts) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      yield* walk(p, exts);
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      yield p;
    }
  }
}

// 1. Locale values
for (const file of walk(path.join(ROOT, 'src/i18n/locales'), ['.json'])) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rewrite = (o) => {
    if (Array.isArray(o)) return o.map(rewrite);
    if (o && typeof o === 'object') return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, rewrite(v)]));
    if (typeof o === 'string' && o.includes('CloudCLI')) {
      localeValues += 1;
      return o.replaceAll('CloudCLI', 'MyMu');
    }
    return o;
  };
  fs.writeFileSync(file, JSON.stringify(rewrite(data), null, 2) + '\n');
}

// 2. Code literals/comments (word-bounded)
for (const file of walk(path.join(ROOT, 'src'), ['.ts', '.tsx', '.jsx'])) {
  const s = fs.readFileSync(file, 'utf8');
  const out = s.replace(/(?<![A-Za-z])CloudCLI(?![A-Za-z])/g, 'MyMu');
  if (out !== s) {
    fs.writeFileSync(file, out);
    codeFiles += 1;
  }
}

console.log(`mymu-rebrand: ${localeValues} locale values, ${codeFiles} code files updated`);
