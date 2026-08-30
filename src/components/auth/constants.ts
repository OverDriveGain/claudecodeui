export const AUTH_TOKEN_STORAGE_KEY = 'auth-token';

// English fallbacks only — the login screen translates known codes via i18n
// (auth:login.errors.*) and uses these when no translation applies.
export const AUTH_ERROR_MESSAGES = {
  authStatusCheckFailed: 'Could not reach the server to check your session. Please try again.',
  loginFailed: 'Login failed',
  registrationFailed: 'Registration failed',
  networkError: 'Network error. Please try again.',
  sessionExpired: 'Your session expired. Please sign in again.',
  signedOut: 'You were signed out. Please sign in again.',
} as const;

/**
 * Client-side feedback codes, unified with the server's `AUTH_*` codes
 * (auth.middleware.ts / auth.service.ts) so the login screen can translate
 * every failure by one vocabulary.
 */
export const AUTH_FEEDBACK_CODES = {
  sessionExpired: 'AUTH_TOKEN_EXPIRED',
  signedOut: 'AUTH_TOKEN_INVALID',
  networkError: 'NETWORK_ERROR',
  statusCheckFailed: 'AUTH_STATUS_CHECK_FAILED',
} as const;
