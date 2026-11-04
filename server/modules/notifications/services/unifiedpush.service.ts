import { notificationChannelEndpointsDb } from '@/modules/database/index.js';
import type { MobilePushAlert } from '@/shared/types.js';

/**
 * UnifiedPush sender (Android, no Firebase) — dependency-free.
 *
 * The Android app obtains an endpoint URL from its UnifiedPush distributor
 * (e.g. a self-hosted ntfy: `https://ntfy.example.com/upAbC123?up=1`). Pushing is
 * a plain `POST <endpointUrl>` with the message body; there is no auth or key —
 * the unguessable URL is the capability. Endpoints live in the shared
 * `notification_channel_endpoints` table under channel `unifiedpush`
 * (endpoint_id = the endpoint URL).
 */

// Used by push.routes (registration) and the notification orchestrator (fan-out).
export const UNIFIEDPUSH_CHANNEL = 'unifiedpush';

// Mobile `platform` value that routes a /api/push/register call to this channel.
// Used by push.routes to pick the channel for a registration.
export const UNIFIEDPUSH_PLATFORM = 'android-up';

const MAX_ENDPOINT_LENGTH = 1024;
const SEND_TIMEOUT_MS = 10_000;

/**
 * Returns the normalized endpoint URL, or null when it is not an acceptable
 * UnifiedPush endpoint (must parse, be https, carry a host, and be <= 1 KB).
 * Used by push.routes to reject bad registrations with a 400.
 */
export function normalizeUnifiedPushEndpoint(value: string): string | null {
  if (!value || value.length > MAX_ENDPOINT_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !url.hostname) return null;
  // Credentials in the URL would be sent as Basic auth and logged nowhere useful.
  if (url.username || url.password) return null;
  return value;
}

type SendResult = { status: number; reason?: string };

async function postOne(endpointUrl: string, alert: MobilePushAlert): Promise<SendResult> {
  // Keys are a wire contract with the Android app — keep them exactly as-is.
  const body = JSON.stringify({
    title: alert.title,
    body: alert.body,
    sessionId: alert.sessionId ?? null,
    projectId: alert.projectId ?? null,
    collapseId: alert.collapseId ?? null,
  });
  try {
    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    // Drain so the socket is released back to the pool.
    await response.arrayBuffer().catch(() => undefined);
    return { status: response.status };
  } catch (err) {
    const reason = err instanceof Error
      ? (err.name === 'TimeoutError' ? 'timeout' : err.message)
      : String(err);
    return { status: 0, reason };
  }
}

/**
 * Deliver an alert to every enabled UnifiedPush endpoint registered by `userId`.
 * Prunes endpoints the distributor reports as gone (HTTP 404/410).
 * Used by the notification orchestrator next to the APNs sender.
 */
export async function sendUnifiedPushToUser(
  userId: number,
  alert: MobilePushAlert,
): Promise<{ attempted: number; sent: number }> {
  const endpoints = notificationChannelEndpointsDb.getEnabledEndpoints(userId, UNIFIEDPUSH_CHANNEL);
  if (!endpoints.length) {
    console.log('[push] no enabled UnifiedPush endpoints registered for user', userId);
    return { attempted: 0, sent: 0 };
  }

  let attempted = 0;
  let sent = 0;
  for (const endpoint of endpoints) {
    attempted += 1;
    const result = await postOne(endpoint.endpoint_id, alert);
    // Never log the endpoint URL itself: it is the push capability.
    if (result.status >= 200 && result.status < 300) {
      sent += 1;
      console.log('[push] UnifiedPush delivered', { userId, status: result.status });
      notificationChannelEndpointsDb.touchEndpoint(userId, UNIFIEDPUSH_CHANNEL, endpoint.endpoint_id);
    } else if (result.status === 404 || result.status === 410) {
      console.warn(`[push] UnifiedPush pruning unregistered endpoint for user ${userId}: status ${result.status}`);
      notificationChannelEndpointsDb.removeEndpoint(userId, UNIFIEDPUSH_CHANNEL, endpoint.endpoint_id);
    } else {
      console.warn(`[push] UnifiedPush send to user ${userId} failed: status ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
    }
  }
  return { attempted, sent };
}
