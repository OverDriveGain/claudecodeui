import crypto from 'node:crypto';
import fs from 'node:fs';
import http2 from 'node:http2';

import { notificationChannelEndpointsDb } from '@/modules/database/index.js';

/**
 * Apple Push Notification service (APNs) sender — dependency-free.
 *
 * Token-based (p8) auth: an ES256 provider JWT signed with the AuthKey_*.p8,
 * delivered over HTTP/2 to Apple. No third-party libraries (mirrors the ASC
 * ES256 helper) — node:crypto signs, node:http2 delivers.
 *
 * Config is read from the environment at call time (so the .p8 can be
 * provisioned without a server restart, matching the relay-credential ethos):
 *   APNS_KEY_PATH    absolute path to AuthKey_XXXXXXXXXX.p8  (never committed)
 *   APNS_KEY_ID      the 10-char key id (the XXXX in the filename)
 *   APNS_TEAM_ID     Apple team id (e.g. 7276Y3726M)
 *   APNS_TOPIC       default apns-topic = app bundle id (fallback; per-device
 *                    bundleId from the registration metadata wins)
 *   APNS_PRODUCTION  "0"/"false" -> sandbox host; anything else -> production
 *
 * When APNS_KEY_PATH/ID/TEAM are not all present + readable, the sender is
 * INERT (isApnsConfigured() === false) and every send is a no-op, so the whole
 * feature is safe to ship on hosts that have no key.
 */

export const APNS_CHANNEL = 'apns';

const PRODUCTION_HOST = 'https://api.push.apple.com';
const SANDBOX_HOST = 'https://api.sandbox.push.apple.com';
const TOKEN_MAX_AGE_MS = 50 * 60 * 1000; // Apple accepts a provider token 20-60 min old.
const SEND_TIMEOUT_MS = 10_000;

type ApnsConfig = {
  keyPath: string;
  keyId: string;
  teamId: string;
  topic: string;
  production: boolean;
};

export type ApnsAlert = {
  title: string;
  body: string;
  sessionId?: string | null;
  projectId?: string | null;
  collapseId?: string | null;
};

function readConfig(): ApnsConfig {
  const flag = (process.env.APNS_PRODUCTION || '').trim().toLowerCase();
  return {
    keyPath: (process.env.APNS_KEY_PATH || '').trim(),
    keyId: (process.env.APNS_KEY_ID || '').trim(),
    teamId: (process.env.APNS_TEAM_ID || '').trim(),
    topic: (process.env.APNS_TOPIC || '').trim(),
    production: flag !== '0' && flag !== 'false',
  };
}

export function isApnsConfigured(): boolean {
  const cfg = readConfig();
  if (!cfg.keyPath || !cfg.keyId || !cfg.teamId) return false;
  try {
    fs.accessSync(cfg.keyPath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

let cachedToken: { jwt: string; issuedAt: number; keyId: string; teamId: string } | null = null;

function providerToken(cfg: ApnsConfig): string {
  const now = Date.now();
  if (
    cachedToken
    && cachedToken.keyId === cfg.keyId
    && cachedToken.teamId === cfg.teamId
    && now - cachedToken.issuedAt < TOKEN_MAX_AGE_MS
  ) {
    return cachedToken.jwt;
  }

  const iat = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: cfg.keyId }));
  const claims = base64url(JSON.stringify({ iss: cfg.teamId, iat }));
  const signingInput = `${header}.${claims}`;
  const pem = fs.readFileSync(cfg.keyPath, 'utf8');
  // EC key + 'SHA256' => ECDSA over SHA-256; ieee-p1363 yields the raw R||S
  // signature JOSE (ES256) requires, not the default DER encoding.
  const signature = crypto.sign('SHA256', Buffer.from(signingInput), {
    key: pem,
    dsaEncoding: 'ieee-p1363',
  });
  const jwt = `${signingInput}.${base64url(signature)}`;
  cachedToken = { jwt, issuedAt: now, keyId: cfg.keyId, teamId: cfg.teamId };
  return jwt;
}

type SendResult = { status: number; reason?: string };

function sendOne(production: boolean, jwt: string, deviceToken: string, topic: string, alert: ApnsAlert): Promise<SendResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: SendResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const host = production ? PRODUCTION_HOST : SANDBOX_HOST;
    let client: http2.ClientHttp2Session;
    try {
      client = http2.connect(host);
    } catch (err) {
      done({ status: 0, reason: err instanceof Error ? err.message : String(err) });
      return;
    }
    client.on('error', (err) => done({ status: 0, reason: err instanceof Error ? err.message : String(err) }));

    const payload = {
      aps: {
        alert: { title: alert.title, body: alert.body },
        sound: 'default',
        ...(alert.sessionId ? { 'thread-id': alert.sessionId } : {}),
      },
      sessionId: alert.sessionId ?? null,
      projectId: alert.projectId ?? null,
    };

    const headers: Record<string, string | number> = {
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${jwt}`,
      'apns-topic': topic,
      'apns-push-type': 'alert',
      'apns-priority': 10,
    };
    if (alert.collapseId) {
      headers['apns-collapse-id'] = String(alert.collapseId).slice(0, 64);
    }

    let req: http2.ClientHttp2Stream;
    try {
      req = client.request(headers);
    } catch (err) {
      client.close();
      done({ status: 0, reason: err instanceof Error ? err.message : String(err) });
      return;
    }

    const timer = setTimeout(() => {
      try { req.close(); } catch { /* noop */ }
      try { client.close(); } catch { /* noop */ }
      done({ status: 0, reason: 'timeout' });
    }, SEND_TIMEOUT_MS);

    let status = 0;
    let data = '';
    req.on('response', (h) => { status = Number(h[':status']) || 0; });
    req.setEncoding('utf8');
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      clearTimeout(timer);
      let reason: string | undefined;
      if (data) {
        try { reason = JSON.parse(data)?.reason; } catch { /* non-JSON body */ }
      }
      try { client.close(); } catch { /* noop */ }
      done({ status, reason });
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      try { client.close(); } catch { /* noop */ }
      done({ status: 0, reason: err instanceof Error ? err.message : String(err) });
    });

    req.end(JSON.stringify(payload));
  });
}

// Reasons that mean the device token is permanently dead — prune it so we stop
// paying to push to a token Apple will never deliver. `BadDeviceToken` is here
// too, but it is ALSO the signal for an environment mismatch (a sandbox token
// hit the production gateway or vice-versa), so the send loop first retries the
// opposite APNs environment; it is only pruned when it fails on BOTH.
const DEAD_TOKEN_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);

type ApnsEnv = 'production' | 'sandbox';

function envFromMetadata(metadata: Record<string, unknown>): ApnsEnv | null {
  return metadata.apnsEnv === 'production' || metadata.apnsEnv === 'sandbox' ? metadata.apnsEnv : null;
}

// Persist which APNs environment actually delivered for this device so later
// pushes skip the wrong-gateway round-trip. Best-effort; preserves the existing
// registration metadata (platform/bundleId/appVersion).
function rememberEnv(
  userId: number,
  endpoint: { endpoint_id: string; label: string | null; metadata_json: string | null },
  production: boolean,
): void {
  try {
    const metadata = notificationChannelEndpointsDb.parseMetadata(endpoint.metadata_json);
    const env: ApnsEnv = production ? 'production' : 'sandbox';
    if (metadata.apnsEnv === env) return;
    notificationChannelEndpointsDb.upsertEndpoint({
      userId,
      channel: APNS_CHANNEL,
      endpointId: endpoint.endpoint_id,
      label: endpoint.label,
      metadata: { ...metadata, apnsEnv: env },
      enabled: true,
    });
  } catch {
    // metadata bookkeeping must never break delivery
  }
}

/**
 * Deliver an alert to every enabled APNs device registered by `userId`.
 * Prunes tokens Apple reports as dead (HTTP 410 or a dead-token reason).
 * Returns delivery counts; safe no-op when the sender is not configured.
 */
export async function sendApnsToUser(userId: number, alert: ApnsAlert): Promise<{ attempted: number; sent: number }> {
  if (!isApnsConfigured()) return { attempted: 0, sent: 0 };

  const cfg = readConfig();
  const endpoints = notificationChannelEndpointsDb.getEnabledEndpoints(userId, APNS_CHANNEL);
  if (!endpoints.length) return { attempted: 0, sent: 0 };

  let jwt: string;
  try {
    jwt = providerToken(cfg);
  } catch (err) {
    console.error('[apns] failed to mint provider token:', err instanceof Error ? err.message : err);
    return { attempted: 0, sent: 0 };
  }

  let attempted = 0;
  let sent = 0;
  for (const endpoint of endpoints) {
    const metadata = notificationChannelEndpointsDb.parseMetadata(endpoint.metadata_json);
    const topic = (typeof metadata.bundleId === 'string' && metadata.bundleId.trim()) || cfg.topic;
    if (!topic) continue; // no bundle id anywhere -> can't address a topic
    attempted += 1;

    // Per-device environment selection without an env field in the registration:
    // start with whatever last delivered for this device, else the configured
    // default (production for TestFlight). A `BadDeviceToken` means the token was
    // minted for the other environment (dev/debug builds use sandbox), so retry
    // the opposite gateway once before treating the token as dead.
    let production = envFromMetadata(metadata) === 'sandbox' ? false
      : envFromMetadata(metadata) === 'production' ? true
      : cfg.production;
    let result = await sendOne(production, jwt, endpoint.endpoint_id, topic, alert);
    if (result.status !== 200 && result.reason === 'BadDeviceToken') {
      production = !production;
      result = await sendOne(production, jwt, endpoint.endpoint_id, topic, alert);
    }

    if (result.status === 200) {
      sent += 1;
      notificationChannelEndpointsDb.touchEndpoint(userId, APNS_CHANNEL, endpoint.endpoint_id);
      rememberEnv(userId, endpoint, production);
    } else if (result.status === 410 || (result.reason && DEAD_TOKEN_REASONS.has(result.reason))) {
      notificationChannelEndpointsDb.removeEndpoint(userId, APNS_CHANNEL, endpoint.endpoint_id);
    } else if (result.status !== 0) {
      console.warn(`[apns] send to user ${userId} returned ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
    }
  }
  return { attempted, sent };
}
