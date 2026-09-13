export {
  // Used by notification tests and delivery workflows to create channel payloads.
  buildNotificationPayload,
  // Used by provider runtimes and Settings to create normalized notification events.
  createNotificationEvent,
  // Used by provider runtimes and Settings to deliver events through enabled channels.
  notifyUserIfEnabled,
  // Used by provider runtimes to report failed agent runs.
  notifyRunFailed,
  // Used by provider runtimes to report stopped or completed agent runs.
  notifyRunStopped,
  // Used by provider runtimes to report background work that finished after its turn ended.
  notifyBackgroundWorkCompleted,
  // Used by the relay gateway to fire a mobile push when a live agent's turn completes.
  notifyTurnCompleted,
} from '@/modules/notifications/services/notification-orchestrator.service.js';
// Native (APNs) push device registry sender + configuration probe.
export { APNS_CHANNEL, isApnsConfigured, sendApnsToUser } from '@/modules/notifications/services/apns.service.js';
// Session presence tracker — drives push suppression while a conversation is open.
export {
  markSessionPresence,
  clearSessionPresence,
  touchSessionPresence,
  releaseSessionPresence,
  isUserPresentOnSession,
} from '@/modules/notifications/services/session-presence.service.js';
export {
  registerDesktopNotificationClient,
  sendDesktopNotification,
  unregisterDesktopNotificationClient,
} from '@/modules/notifications/services/desktop-notification-clients.service.js';
export { handleDesktopNotificationsConnection } from '@/modules/notifications/websocket/desktop-notifications-websocket.service.js';
// getPublicKey: used by Settings to expose the Web Push subscription key.
export { getPublicKey } from './vapid-keys.service.js';
// configureWebPush: used by the server entrypoint during notification startup.
export { configureWebPush } from './vapid-keys.service.js';
