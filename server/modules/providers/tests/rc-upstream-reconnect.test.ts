// Regression tests for the remote-control upstream reconnect loop in
// server/remote-control/rc-client.js, run against a local mock relay.
//  - 1003 "not_found" (deleted session) must drop the subscription after ONE dial;
//    it used to reconnect every second forever.
//  - A relay that accepts the socket and then drops it must back off exponentially;
//    the retry counter used to reset on every OPEN, pinning the delay at 1s.
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';

import { WebSocketServer } from 'ws';

type Behaviour = 'not-found' | 'drop' | 'stream-then-drop';
const behaviourBySession = new Map<string, Behaviour>();
const dialsBySession = new Map<string, number[]>();
// Events-API contents per session (default: no events).
const eventsBySession = new Map<string, Array<{ uuid: string; type: string }>>();

const server = http.createServer((req, res) => {
  const sessionId = /\/v1\/sessions\/([^/]+)\/events/.exec(req.url || '')?.[1] || '';
  const data = eventsBySession.get(sessionId) || [];
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data, has_more: false, last_id: data.at(-1)?.uuid ?? null }));
});
const wss = new WebSocketServer({ server });
wss.on('connection', (socket, req) => {
  const sessionId = /\/ws\/([^/]+)\/subscribe/.exec(req.url || '')?.[1] || '';
  dialsBySession.set(sessionId, [...(dialsBySession.get(sessionId) || []), Date.now()]);
  const behaviour = behaviourBySession.get(sessionId);
  const dial = dialsBySession.get(sessionId)?.length || 0;
  if (behaviour === 'not-found') socket.close(1003, 'not_found');
  else if (behaviour === 'stream-then-drop') {
    if (dial > 1) return; // the reconnected socket stays up
    // Deliver two events live, then drop. Only afterwards does the events API show
    // them, plus a third event the dead socket never delivered.
    socket.send(JSON.stringify({ uuid: 'ev-a', type: 'assistant' }));
    socket.send(JSON.stringify({ uuid: 'ev-b', type: 'assistant' }));
    setTimeout(() => {
      eventsBySession.set(sessionId, [
        { uuid: 'ev-a', type: 'assistant' },
        { uuid: 'ev-b', type: 'assistant' },
        { uuid: 'ev-c', type: 'assistant' },
      ]);
      socket.terminate();
    }, 300);
  } else socket.terminate(); // accepted, then dropped without a close frame (1006)
});

let rc: typeof import('../../../remote-control/rc-client.js');

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  process.env.RC_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.RC_ACCOUNTS = JSON.stringify([{ label: 'test', token: 'tok', orgUuid: 'org' }]);
  process.env.RC_EVENTS_CACHE_DIR = mkdtempSync(path.join(os.tmpdir(), 'rc-events-'));
  rc = await import('../../../remote-control/rc-client.js');
});

after(async () => {
  wss.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function fakeWriter() {
  const frames: Array<{ kind?: string; exitCode?: number; id?: string }> = [];
  return { frames, writer: { send: (frame: { kind?: string }) => { frames.push(frame); } } };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('a 1003 not_found close drops the subscription instead of reconnecting', async () => {
  const sessionId = 'cse_deleted';
  behaviourBySession.set(sessionId, 'not-found');
  const { frames, writer } = fakeWriter();
  await rc.attachSession(sessionId, writer, () => []);
  await sleep(3500);
  assert.equal(dialsBySession.get(sessionId)?.length, 1, 'exactly one dial, no reconnect loop');
  assert.ok(frames.some((f) => f.kind === 'complete' && f.exitCode === 1), 'viewer is told the stream ended');
  assert.equal(rc.detachSession(sessionId), false, 'entry was already dropped');
});

test('an accept-then-drop relay backs off exponentially', async () => {
  const sessionId = 'cse_flapping';
  behaviourBySession.set(sessionId, 'drop');
  const { writer } = fakeWriter();
  await rc.attachSession(sessionId, writer, () => []).catch(() => {});
  await sleep(7500);
  rc.detachSession(sessionId);
  const dials = dialsBySession.get(sessionId) || [];
  // Backoff 1s, 2s, 4s → dials at ~0, 1, 3, 7s. The old reset-on-open loop dialled
  // every ~1s (≈8 dials in this window).
  assert.ok(dials.length >= 3 && dials.length <= 4, `expected 3-4 dials, got ${dials.length}`);
  const gaps = dials.slice(1).map((t, i) => t - dials[i]);
  for (let i = 1; i < gaps.length; i += 1) {
    assert.ok(gaps[i] > gaps[i - 1] * 1.5, `gaps should grow: ${gaps.join(', ')}`);
  }
});

test('the reconnect top-up re-emits only events the dropped socket never delivered', async () => {
  const sessionId = 'cse_topup';
  behaviourBySession.set(sessionId, 'stream-then-drop');
  const { frames, writer } = fakeWriter();
  const normalize = (m: { uuid: string }) => [{ kind: 'text', id: m.uuid }];
  await rc.attachSession(sessionId, writer, normalize);
  await sleep(2500);
  rc.detachSession(sessionId);
  assert.equal(dialsBySession.get(sessionId)?.length, 2, 'dropped once, reconnected once');
  const ids = frames.filter((f) => f.kind === 'text').map((f) => f.id);
  assert.deepEqual(ids, ['ev-a', 'ev-b', 'ev-c'], 'each event reaches the viewer exactly once');
});
