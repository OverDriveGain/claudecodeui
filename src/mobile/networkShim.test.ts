/**
 * Pure-logic tests for the native network shim URL rewriting and server-origin
 * normalization. Run: npx tsx src/mobile/networkShim.test.ts
 */
import assert from 'node:assert';

import { rewriteHttpUrlWith, rewriteWsUrlWith } from './networkShim';
import { normalizeServerOrigin } from './serverConfig';

const SERVER = 'https://code.kaxtus.com';
const BASE = 'https://localhost/'; // the Capacitor webview origin

let passed = 0;
function ok(name: string, cond: boolean) {
  assert.ok(cond, name);
  passed += 1;
}

// --- http rewriting ---
ok(
  'root-relative /api goes to the server',
  rewriteHttpUrlWith(SERVER, '/api/projects', BASE) === 'https://code.kaxtus.com/api/projects',
);
ok(
  'root-relative with query preserved',
  rewriteHttpUrlWith(SERVER, '/api/providers/search/sessions?q=x&token=t', BASE) ===
    'https://code.kaxtus.com/api/providers/search/sessions?q=x&token=t',
);
ok(
  'absolute localhost url is swapped to the server',
  rewriteHttpUrlWith(SERVER, 'https://localhost/api/auth/user', BASE) ===
    'https://code.kaxtus.com/api/auth/user',
);
ok(
  'empty origin is a no-op (web build)',
  rewriteHttpUrlWith('', '/api/projects', BASE) === '/api/projects',
);
ok(
  'a url already pointing at the server is left alone',
  rewriteHttpUrlWith(SERVER, 'https://code.kaxtus.com/api/x', BASE) ===
    'https://code.kaxtus.com/api/x',
);
ok(
  'protocol-relative url is not treated as root-relative',
  rewriteHttpUrlWith(SERVER, '//cdn.example.com/a.js', BASE) === '//cdn.example.com/a.js',
);

// --- websocket rewriting ---
ok(
  'ws from localhost swaps host and upgrades to wss for https server',
  rewriteWsUrlWith(SERVER, 'ws://localhost/ws?token=abc', BASE) ===
    'wss://code.kaxtus.com/ws?token=abc',
);
ok(
  'ws stays ws for an http server',
  rewriteWsUrlWith('http://192.168.1.5:3099', 'ws://localhost/ws?token=abc', BASE) ===
    'ws://192.168.1.5:3099/ws?token=abc',
);
ok('empty origin ws is a no-op', rewriteWsUrlWith('', 'ws://localhost/ws', BASE) === 'ws://localhost/ws');

// --- origin normalization ---
ok('adds https scheme', normalizeServerOrigin('code.kaxtus.com') === 'https://code.kaxtus.com');
ok('strips trailing slash + path', normalizeServerOrigin('https://code.kaxtus.com/') === 'https://code.kaxtus.com');
ok('keeps explicit http + port', normalizeServerOrigin('http://10.0.0.2:3099') === 'http://10.0.0.2:3099');
ok('empty stays empty', normalizeServerOrigin('  ') === '');

console.log(`networkShim: ${passed} assertions passed`);
