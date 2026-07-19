/**
 * Mobile server configuration.
 *
 * The web build is served from the same origin as its API, so every request in
 * the client uses a root-relative path (`/api/...`) or `window.location.host`
 * for the WebSocket. The native apps (Capacitor) are served from a local
 * `https://localhost` / `capacitor://localhost` origin instead, so those
 * relative requests must be redirected to a user-configured remote CCUI server
 * (e.g. https://code.kaxtus.com). This module is the single source of truth for
 * that server origin; `networkShim` reads it to rewrite outbound requests.
 *
 * On the web build `isNativeMobile()` is false and `getServerOrigin()` returns
 * '' so nothing is rewritten — behaviour is byte-for-byte identical.
 */

const SERVER_ORIGIN_KEY = 'mymu-server-origin';

/** Default server offered on the login screen (self-hosters can change it). */
export const DEFAULT_SERVER_ORIGIN = 'https://code.kaxtus.com';

type CapacitorGlobal = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
};

function capacitor(): CapacitorGlobal | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
}

/** True only inside the packaged Android/iOS Capacitor shell. */
export function isNativeMobile(): boolean {
  const cap = capacitor();
  return Boolean(cap?.isNativePlatform?.());
}

/** 'android' | 'ios' | 'web'. */
export function nativePlatform(): string {
  return capacitor()?.getPlatform?.() ?? 'web';
}

/** Normalize a user-typed server URL: add https://, strip trailing slash/path noise. */
export function normalizeServerOrigin(raw: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '';
  }
}

/**
 * The configured remote server origin, or '' when none is set (web build, or a
 * native app before the user has logged in). Only ever non-empty on native.
 */
export function getServerOrigin(): string {
  if (typeof window === 'undefined') return '';
  if (!isNativeMobile()) return '';
  try {
    return window.localStorage.getItem(SERVER_ORIGIN_KEY) || '';
  } catch {
    return '';
  }
}

export function setServerOrigin(origin: string): void {
  if (typeof window === 'undefined') return;
  const normalized = normalizeServerOrigin(origin);
  try {
    if (normalized) {
      window.localStorage.setItem(SERVER_ORIGIN_KEY, normalized);
    } else {
      window.localStorage.removeItem(SERVER_ORIGIN_KEY);
    }
  } catch {
    /* storage unavailable — ignore */
  }
}

export function clearServerOrigin(): void {
  setServerOrigin('');
}
