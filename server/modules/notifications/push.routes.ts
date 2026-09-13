import express from 'express';

import { notificationChannelEndpointsDb, notificationPreferencesDb } from '@/modules/database/index.js';
import { APNS_CHANNEL } from '@/modules/notifications/services/apns.service.js';

/**
 * Native push-notification device registry (currently iOS/APNs).
 *
 * A thin, explicit façade the mobile client speaks to; it stores device tokens
 * in the shared `notification_channel_endpoints` table under channel `apns`
 * (endpoint_id = the APNs device token) so the notification orchestrator's
 * existing per-user fan-out, preferences and dedupe all apply unchanged.
 *
 * Mounted under `/api/push`, behind `authenticateToken` — every registration is
 * scoped to the authenticated user.
 */

const router = express.Router();

function readUserId(req: express.Request): number {
  const userId = Number((req as any).user?.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('Authenticated user is missing');
  }
  return userId;
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeRegistration(endpoint: any) {
  const metadata = notificationChannelEndpointsDb.parseMetadata(endpoint.metadata_json);
  return {
    deviceToken: endpoint.endpoint_id,
    platform: typeof metadata.platform === 'string' ? metadata.platform : null,
    bundleId: typeof metadata.bundleId === 'string' ? metadata.bundleId : null,
    appVersion: typeof metadata.appVersion === 'string' ? metadata.appVersion : null,
    enabled: Boolean(endpoint.enabled),
    lastSeenAt: endpoint.last_seen_at,
    createdAt: endpoint.created_at,
    updatedAt: endpoint.updated_at,
  };
}

// Keep the user's `apns` channel preference in step with whether any enabled
// device remains — the orchestrator only fans out to channels the user has on.
function syncApnsChannelPreference(userId: number): void {
  const currentPrefs = notificationPreferencesDb.getPreferences(userId);
  const hasEnabledDevice = notificationChannelEndpointsDb.getEnabledEndpoints(userId, APNS_CHANNEL).length > 0;
  notificationPreferencesDb.updatePreferences(userId, {
    ...currentPrefs,
    channels: { ...currentPrefs.channels, [APNS_CHANNEL]: hasEnabledDevice },
  });
}

// POST /api/push/register
// Body: { deviceToken, platform?: "ios", bundleId?: "com.mymu.app", appVersion? }
router.post('/register', (req, res) => {
  try {
    const { deviceToken, platform, bundleId, appVersion } = req.body || {};
    const token = readText(deviceToken);
    if (!token) {
      return res.status(400).json({ error: 'deviceToken is required' });
    }

    const userId = readUserId(req);
    const endpoint = notificationChannelEndpointsDb.upsertEndpoint({
      userId,
      channel: APNS_CHANNEL,
      endpointId: token,
      label: readText(bundleId) || null,
      metadata: {
        platform: readText(platform) || 'ios',
        bundleId: readText(bundleId) || null,
        appVersion: readText(appVersion) || null,
      },
      enabled: true,
    });
    syncApnsChannelPreference(userId);

    return res.json({ success: true, registration: sanitizeRegistration(endpoint) });
  } catch (error) {
    console.error('Error registering push device:', error);
    return res.status(500).json({ error: 'Failed to register push device' });
  }
});

// DELETE /api/push/register        Body: { deviceToken }
// DELETE /api/push/register/:deviceToken
function unregister(req: express.Request, res: express.Response) {
  try {
    const token = readText(req.params.deviceToken) || readText((req.body || {}).deviceToken);
    if (!token) {
      return res.status(400).json({ error: 'deviceToken is required' });
    }

    const userId = readUserId(req);
    const removed = notificationChannelEndpointsDb.removeEndpoint(userId, APNS_CHANNEL, token);
    syncApnsChannelPreference(userId);

    if (!removed) {
      return res.status(404).json({ error: 'Push device not found' });
    }
    return res.json({ success: true });
  } catch (error) {
    console.error('Error unregistering push device:', error);
    return res.status(500).json({ error: 'Failed to unregister push device' });
  }
}
router.delete('/register', unregister);
router.delete('/register/:deviceToken', unregister);

// GET /api/push/registrations — this user's registered devices (debug / app UI).
router.get('/registrations', (req, res) => {
  try {
    const userId = readUserId(req);
    const registrations = notificationChannelEndpointsDb
      .getEndpoints(userId, APNS_CHANNEL)
      .map(sanitizeRegistration);
    return res.json({ success: true, registrations });
  } catch (error) {
    console.error('Error listing push devices:', error);
    return res.status(500).json({ error: 'Failed to list push devices' });
  }
});

export default router;
