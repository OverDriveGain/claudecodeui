import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  notificationChannelEndpointsDb,
  notificationPreferencesDb,
  userDb,
} from '@/modules/database/index.js';

import {
  listPushRegistrations,
  registerPushDevice,
  unregisterPushDevice,
} from '../services/push-registry.service.js';
import {
  normalizeUnifiedPushEndpoint,
  sendUnifiedPushToUser,
  UNIFIEDPUSH_CHANNEL,
} from '../services/unifiedpush.service.js';

async function withIsolatedDatabase(runTest: (userId: number) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'unifiedpush-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  await initializeDatabase();
  try {
    const { id } = userDb.createUser('up-tester', 'x');
    await runTest(Number(id));
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

test('normalizeUnifiedPushEndpoint accepts https URLs only, up to 1 KB', () => {
  const good = 'https://ntfy.example.com/upAbC123?up=1';
  assert.equal(normalizeUnifiedPushEndpoint(good), good);
  assert.equal(normalizeUnifiedPushEndpoint('http://ntfy.example.com/up1'), null);
  assert.equal(normalizeUnifiedPushEndpoint('not a url'), null);
  assert.equal(normalizeUnifiedPushEndpoint('https://u:p@ntfy.example.com/up1'), null);
  assert.equal(normalizeUnifiedPushEndpoint(`https://ntfy.example.com/${'a'.repeat(1024)}`), null);
  assert.equal(normalizeUnifiedPushEndpoint(''), null);
});

test('registry keeps APNs and UnifiedPush separate, lists both, deletes either', async () => {
  await withIsolatedDatabase((userId) => {
    registerPushDevice({ userId, channel: 'apns', endpointId: 'abc123', label: null, metadata: { platform: 'ios' } });
    registerPushDevice({
      userId,
      channel: UNIFIEDPUSH_CHANNEL,
      endpointId: 'https://ntfy.example.com/up1?up=1',
      label: null,
      metadata: { platform: 'android-up', appVersion: '1.0' },
    });
    let prefs = notificationPreferencesDb.getPreferences(userId);
    assert.equal(prefs.channels.apns, true);
    assert.equal(prefs.channels[UNIFIEDPUSH_CHANNEL], true);

    const regs = listPushRegistrations(userId);
    assert.deepEqual(regs.map((r) => r.channel), ['apns', UNIFIEDPUSH_CHANNEL]);
    assert.equal(regs[1].platform, 'android-up');
    assert.equal(regs[1].appVersion, '1.0');

    assert.equal(unregisterPushDevice(userId, 'https://ntfy.example.com/up1?up=1'), true);
    prefs = notificationPreferencesDb.getPreferences(userId);
    assert.equal(prefs.channels[UNIFIEDPUSH_CHANNEL], false);
    assert.equal(prefs.channels.apns, true);
    assert.equal(unregisterPushDevice(userId, 'nope'), false);
  });
});

test('sendUnifiedPushToUser POSTs the alert JSON and prunes 404/410 endpoints', async () => {
  const received: Array<{ path: string; type: string | undefined; body: unknown }> = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      received.push({ path: req.url || '', type: req.headers['content-type'], body: JSON.parse(data) });
      res.statusCode = req.url?.startsWith('/gone') ? 410 : req.url?.startsWith('/missing') ? 404 : 200;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    await withIsolatedDatabase(async (userId) => {
      for (const p of ['/ok?up=1', '/gone', '/missing']) {
        notificationChannelEndpointsDb.upsertEndpoint({
          userId, channel: UNIFIEDPUSH_CHANNEL, endpointId: `${base}${p}`, label: null, metadata: {}, enabled: true,
        });
      }
      const alert = { title: 't', body: 'b', sessionId: 's1', projectId: 'p1', collapseId: 's1' };
      const result = await sendUnifiedPushToUser(userId, alert);
      assert.deepEqual(result, { attempted: 3, sent: 1 });
      assert.equal(received.length, 3);
      for (const r of received) {
        assert.equal(r.type, 'application/json');
        assert.deepEqual(r.body, alert);
      }
      const left = notificationChannelEndpointsDb.getEndpoints(userId, UNIFIEDPUSH_CHANNEL).map((e) => e.endpoint_id);
      assert.deepEqual(left, [`${base}/ok?up=1`]);
    });
  } finally {
    server.close();
  }
});
