/**
 * Native network shim.
 *
 * The React client issues every request against its own origin: fetch/EventSource
 * use root-relative paths (`/api/...`) and the WebSocket is built from
 * `window.location.host`. In the packaged Capacitor app that origin is a local
 * webview (`https://localhost` on Android, `capacitor://localhost` on iOS), which
 * has no server. This shim transparently rewrites those local/relative requests
 * to the user-configured remote CCUI server so 100% of the existing chat,
 * streaming, list and auth code works unchanged.
 *
 * It is a strict no-op when no server origin is configured (i.e. always on the
 * web build). Install it once, as early as possible, before the app mounts.
 */

import { getServerOrigin } from './serverConfig';

let installed = false;

/** Hosts that identify the local webview origin (not a real server). */
function isLocalWebviewHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '' ||
    host.startsWith('localhost:') ||
    host.startsWith('127.0.0.1') ||
    host.startsWith('10.0.2.2') // Android emulator loopback to host
  );
}

const baseHref = (): string =>
  typeof window !== 'undefined' && window.location ? window.location.href : 'https://localhost/';

/**
 * Pure rewrite of an http(s) fetch/EventSource URL against an explicit server
 * origin. Exported for unit testing. Returns `rawUrl` unchanged when `origin`
 * is empty or the URL does not target the local webview.
 */
export function rewriteHttpUrlWith(origin: string, rawUrl: string, base = baseHref()): string {
  if (!origin) return rawUrl;
  if (typeof rawUrl !== 'string') return rawUrl;

  // Root-relative path: `/api/...`, `/shapes/...` — but not protocol-relative `//`.
  if (rawUrl.startsWith('/') && !rawUrl.startsWith('//')) {
    return origin + rawUrl;
  }

  // Absolute URL that points at the local webview origin -> swap to the server.
  try {
    const parsed = new URL(rawUrl, base);
    if (isLocalWebviewHost(parsed.host)) {
      const serverUrl = new URL(origin);
      parsed.protocol = serverUrl.protocol;
      parsed.host = serverUrl.host;
      return parsed.toString();
    }
  } catch {
    /* not a parseable absolute URL — leave as-is */
  }
  return rawUrl;
}

/** Pure rewrite of a ws(s):// URL built from the local webview host to the server. */
export function rewriteWsUrlWith(origin: string, rawUrl: string, base = baseHref()): string {
  if (!origin) return rawUrl;
  if (typeof rawUrl !== 'string') return rawUrl;
  try {
    const parsed = new URL(rawUrl, base);
    if (isLocalWebviewHost(parsed.host)) {
      const serverUrl = new URL(origin);
      parsed.protocol = serverUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      parsed.host = serverUrl.host;
      return parsed.toString();
    }
  } catch {
    /* leave as-is */
  }
  return rawUrl;
}

function rewriteHttpUrl(rawUrl: string): string {
  return rewriteHttpUrlWith(getServerOrigin(), rawUrl);
}

function rewriteWsUrl(rawUrl: string): string {
  return rewriteWsUrlWith(getServerOrigin(), rawUrl);
}

export function installNetworkShim(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  // --- fetch ---------------------------------------------------------------
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      if (typeof input === 'string') {
        return originalFetch(rewriteHttpUrl(input), init);
      }
      if (input instanceof URL) {
        return originalFetch(rewriteHttpUrl(input.toString()), init);
      }
      if (input instanceof Request) {
        const rewritten = rewriteHttpUrl(input.url);
        if (rewritten !== input.url) {
          return originalFetch(new Request(rewritten, input), init);
        }
      }
    } catch {
      /* fall through to original on any rewrite error */
    }
    return originalFetch(input as RequestInfo, init);
  };

  // --- WebSocket -----------------------------------------------------------
  const OriginalWebSocket = window.WebSocket;
  const PatchedWebSocket = function (
    this: WebSocket,
    url: string | URL,
    protocols?: string | string[],
  ) {
    const rewritten = rewriteWsUrl(typeof url === 'string' ? url : url.toString());
    return protocols !== undefined
      ? new OriginalWebSocket(rewritten, protocols)
      : new OriginalWebSocket(rewritten);
  } as unknown as typeof WebSocket;
  PatchedWebSocket.prototype = OriginalWebSocket.prototype;
  // Copy the readyState constants (CONNECTING/OPEN/CLOSING/CLOSED) so callers
  // that read `WebSocket.OPEN` off the global keep working.
  for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'] as const) {
    (PatchedWebSocket as unknown as Record<string, number>)[key] = OriginalWebSocket[key];
  }
  window.WebSocket = PatchedWebSocket;

  // --- EventSource (conversation search) -----------------------------------
  if (typeof window.EventSource !== 'undefined') {
    const OriginalEventSource = window.EventSource;
    const PatchedEventSource = function (
      this: EventSource,
      url: string | URL,
      init?: EventSourceInit,
    ) {
      const rewritten = rewriteHttpUrl(typeof url === 'string' ? url : url.toString());
      return new OriginalEventSource(rewritten, init);
    } as unknown as typeof EventSource;
    PatchedEventSource.prototype = OriginalEventSource.prototype;
    for (const key of ['CONNECTING', 'OPEN', 'CLOSED'] as const) {
      (PatchedEventSource as unknown as Record<string, number>)[key] = OriginalEventSource[key];
    }
    window.EventSource = PatchedEventSource;
  }
}
