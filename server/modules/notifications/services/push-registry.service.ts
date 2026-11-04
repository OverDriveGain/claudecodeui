import { notificationChannelEndpointsDb, notificationPreferencesDb } from '@/modules/database/index.js';
import { APNS_CHANNEL } from '@/modules/notifications/services/apns.service.js';
import { UNIFIEDPUSH_CHANNEL } from '@/modules/notifications/services/unifiedpush.service.js';

/**
 * Native mobile push device registry (iOS/APNs + Android/UnifiedPush).
 *
 * Both channels share the `notification_channel_endpoints` table so the
 * orchestrator's per-user fan-out, preferences and dedupe apply unchanged.
 * endpoint_id is the APNs device token or the UnifiedPush endpoint URL.
 */

// Channels the /api/push façade manages. Order = listing order.
const MOBILE_PUSH_CHANNELS = [APNS_CHANNEL, UNIFIEDPUSH_CHANNEL];

type PushRegistrationInput = {
  userId: number;
  channel: string;
  endpointId: string;
  label: string | null;
  metadata: Record<string, unknown>;
};

type PushRegistration = {
  channel: string;
  deviceToken: string;
  platform: string | null;
  bundleId: string | null;
  appVersion: string | null;
  enabled: boolean;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
};

function toRegistration(endpoint: any): PushRegistration {
  const metadata = notificationChannelEndpointsDb.parseMetadata(endpoint.metadata_json);
  return {
    channel: endpoint.channel,
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

// Keep the user's per-channel preference in step with whether any enabled
// device remains — the orchestrator only fans out to channels the user has on.
function syncChannelPreference(userId: number, channel: string): void {
  const currentPrefs = notificationPreferencesDb.getPreferences(userId);
  const hasEnabledDevice = notificationChannelEndpointsDb.getEnabledEndpoints(userId, channel).length > 0;
  notificationPreferencesDb.updatePreferences(userId, {
    ...currentPrefs,
    channels: { ...currentPrefs.channels, [channel]: hasEnabledDevice },
  });
}

/** Upserts a device registration and enables its channel. Used by push.routes POST /register. */
export function registerPushDevice(input: PushRegistrationInput): PushRegistration {
  const endpoint = notificationChannelEndpointsDb.upsertEndpoint({
    userId: input.userId,
    channel: input.channel,
    endpointId: input.endpointId,
    label: input.label,
    metadata: input.metadata,
    enabled: true,
  });
  syncChannelPreference(input.userId, input.channel);
  return toRegistration(endpoint);
}

/**
 * Removes a device token / endpoint URL from every mobile push channel it is
 * registered under. Returns false when nothing matched.
 * Used by push.routes DELETE /register.
 */
export function unregisterPushDevice(userId: number, endpointId: string): boolean {
  let removed = false;
  for (const channel of MOBILE_PUSH_CHANNELS) {
    if (notificationChannelEndpointsDb.removeEndpoint(userId, channel, endpointId)) {
      removed = true;
    }
    syncChannelPreference(userId, channel);
  }
  return removed;
}

/** Lists the user's devices across all mobile push channels. Used by push.routes GET /registrations. */
export function listPushRegistrations(userId: number): PushRegistration[] {
  return MOBILE_PUSH_CHANNELS.flatMap((channel) =>
    notificationChannelEndpointsDb.getEndpoints(userId, channel).map(toRegistration),
  );
}
