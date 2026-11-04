import express from 'express';

import { APNS_CHANNEL } from '@/modules/notifications/services/apns.service.js';
import {
  listPushRegistrations,
  registerPushDevice,
  unregisterPushDevice,
} from '@/modules/notifications/services/push-registry.service.js';
import {
  normalizeUnifiedPushEndpoint,
  UNIFIEDPUSH_CHANNEL,
  UNIFIEDPUSH_PLATFORM,
} from '@/modules/notifications/services/unifiedpush.service.js';

/**
 * Native push-notification device registry (iOS/APNs + Android/UnifiedPush).
 *
 * A thin, explicit façade the mobile clients speak to. A registration with
 * `platform: "android-up"` is stored under channel `unifiedpush`
 * (deviceToken = the UnifiedPush endpoint URL); everything else under `apns`
 * (deviceToken = the APNs device token).
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

// POST /api/push/register
// iOS:     { deviceToken, platform?: "ios", bundleId?: "com.mymu.app", appVersion? }
// Android: { deviceToken: <https UnifiedPush endpoint URL>, platform: "android-up", appVersion? }
router.post('/register', (req, res) => {
  try {
    const { deviceToken, platform, bundleId, appVersion } = req.body || {};
    const token = readText(deviceToken);
    if (!token) {
      return res.status(400).json({ error: 'deviceToken is required' });
    }

    const userId = readUserId(req);
    const platformText = readText(platform);

    if (platformText === UNIFIEDPUSH_PLATFORM) {
      const endpointUrl = normalizeUnifiedPushEndpoint(token);
      if (!endpointUrl) {
        return res.status(400).json({ error: 'deviceToken must be an https UnifiedPush endpoint URL (max 1024 chars)' });
      }
      const registration = registerPushDevice({
        userId,
        channel: UNIFIEDPUSH_CHANNEL,
        endpointId: endpointUrl,
        label: null,
        metadata: { platform: UNIFIEDPUSH_PLATFORM, appVersion: readText(appVersion) || null },
      });
      return res.json({ success: true, registration });
    }

    const registration = registerPushDevice({
      userId,
      channel: APNS_CHANNEL,
      endpointId: token,
      label: readText(bundleId) || null,
      metadata: {
        platform: platformText || 'ios',
        bundleId: readText(bundleId) || null,
        appVersion: readText(appVersion) || null,
      },
    });
    return res.json({ success: true, registration });
  } catch (error) {
    console.error('Error registering push device:', error);
    return res.status(500).json({ error: 'Failed to register push device' });
  }
});

// DELETE /api/push/register        Body: { deviceToken }  (APNs token or UnifiedPush URL)
// DELETE /api/push/register/:deviceToken
function unregister(req: express.Request, res: express.Response) {
  try {
    const token = readText(req.params.deviceToken) || readText((req.body || {}).deviceToken);
    if (!token) {
      return res.status(400).json({ error: 'deviceToken is required' });
    }

    const userId = readUserId(req);
    const removed = unregisterPushDevice(userId, token);

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

// GET /api/push/registrations — this user's registered devices on both channels.
router.get('/registrations', (req, res) => {
  try {
    const userId = readUserId(req);
    const registrations = listPushRegistrations(userId);
    return res.json({ success: true, registrations });
  } catch (error) {
    console.error('Error listing push devices:', error);
    return res.status(500).json({ error: 'Failed to list push devices' });
  }
});

export default router;
