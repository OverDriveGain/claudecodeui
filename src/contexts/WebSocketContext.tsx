import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../components/auth/context/AuthContext';
import { IS_PLATFORM } from '../constants/config';
import { useRemoteHosts, hostForSession, type RemoteHost } from '../utils/remoteHosts';
import { expireAuthSession, isAuthTokenExpired } from '../utils/api';

/**
 * One frame received from the chat websocket. The server guarantees every
 * frame carries a `kind` (provider message kinds plus gateway kinds such as
 * `chat_subscribed`, `session_upserted`, `loading_progress`,
 * `protocol_error`). The synthetic `websocket_reconnected` kind is injected
 * client-side when the socket re-opens after a drop.
 */
export type ServerEvent = {
  kind?: string;
  type?: string;
  sessionId?: string;
  seq?: number;
  [key: string]: unknown;
};

type ServerEventListener = (event: ServerEvent) => void;

type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  /**
   * Subscribes to every websocket frame. Returns an unsubscribe function.
   *
   * This is the primary consumption API: events are dispatched synchronously
   * to every listener, so rapid back-to-back frames can never be coalesced or
   * dropped the way a single "latest message" state slot could.
   */
  subscribe: (listener: ServerEventListener) => () => void;
  /**
   * Legacy state-based access to the most recent frame.
   *
   * Kept only for low-frequency consumers (TaskMaster broadcasts). High-rate
   * chat streams must use `subscribe` — React may batch state updates, which
   * makes `latestMessage` lossy under load.
   */
  latestMessage: ServerEvent | null;
  isConnected: boolean;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

const buildWebSocketUrl = (token: string | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (IS_PLATFORM) return `${protocol}//${window.location.host}/ws`; // Platform mode: Use same domain as the page (goes through proxy)
  if (!token) return null;
  if (isAuthTokenExpired(token)) {
    expireAuthSession();
    return null;
  }
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`; // OSS mode: Use same host:port that served the page
};

/** ws(s) URL for a connected PEER host (multi-host mode) — bearer token via query. */
const buildRemoteWebSocketUrl = (host: RemoteHost) => {
  const wsOrigin = host.url.replace(/^http/, 'ws');
  return `${wsOrigin}/ws?token=${encodeURIComponent(host.token)}`;
};

/** How long a queued send waits for its host's socket to revive before failing loudly. */
const SEND_QUEUE_TTL_MS = 10_000;
/**
 * A WSS upgrade can hang in CONNECTING indefinitely (origin dropped mid-handshake
 * behind the CDN — flaky-uplink hosts hit this). A hung socket never fires
 * `close`, so the 3s retry loop dies and every later send to that host fails
 * until a page reload. Kill handshakes that outlive this and let onclose retry.
 */
const CONNECT_TIMEOUT_MS = 6_000;

type QueuedSend = { message: any; hostLabel: string; expireTimer: NodeJS.Timeout };

type PeerSocketEntry = {
  ws: WebSocket | null;
  timer: NodeJS.Timeout | null;
  connectTimer: NodeJS.Timeout | null;
  closed: boolean;
  /** Sends held while the socket revives; flushed on open, failed on TTL expiry. */
  queue: QueuedSend[];
  /** Connect immediately (cancels a pending backoff timer); no-op if already connecting. */
  openNow: () => void;
};

/** Which host a client→server message belongs to, by the session it addresses. */
const targetHostFor = (message: any): RemoteHost | null => {
  const sid =
    (typeof message?.sessionId === 'string' && message.sessionId) ||
    (typeof message?.options?.remoteControl === 'string' && message.options.remoteControl) ||
    (typeof message?.options?.sessionId === 'string' && message.options.sessionId) ||
    null;
  return hostForSession(sid);
};

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false); // Track if component is unmounted
  const hasConnectedRef = useRef(false); // Track if we've ever connected (to detect reconnects)
  /**
   * Listener registry for the subscribe API. A ref (not state) because the
   * set must be readable synchronously inside `onmessage` and never trigger
   * re-renders of the provider tree.
   */
  const listenersRef = useRef(new Set<ServerEventListener>());
  const [latestMessage, setLatestMessage] = useState<ServerEvent | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const { isLoading: isAuthLoading, token, user } = useAuth();

  const dispatch = useCallback((event: ServerEvent) => {
    for (const listener of listenersRef.current) {
      try {
        listener(event);
      } catch (error) {
        console.error('WebSocket listener error:', error);
      }
    }
    setLatestMessage(event);
  }, []);
  // MYMU: connected peer hosts (multi-host mode). Peer frames funnel into the
  // SAME dispatch pipeline, tagged __hostUrl, so every consumer sees one stream.
  const remoteHosts = useRemoteHosts();
  const remoteSocketsRef = useRef<Map<string, PeerSocketEntry>>(new Map());


  useEffect(() => {
    // The cleanup below sets unmountedRef = true. Without this reset, every
    // re-run of the effect (e.g. on token refresh) would short-circuit connect()
    // at its unmounted guard and leave the socket permanently disconnected.
    unmountedRef.current = false;
    if (!IS_PLATFORM && (isAuthLoading || !user)) {
      return undefined;
    }
    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      const activeSocket = wsRef.current;
      if (activeSocket) {
        // Prevent the intentionally closed, old-token socket from scheduling
        // a reconnect after the refreshed-token effect has already started.
        activeSocket.onopen = null;
        activeSocket.onmessage = null;
        activeSocket.onclose = null;
        activeSocket.onerror = null;
        activeSocket.close();
        wsRef.current = null;
      }
    };
  }, [isAuthLoading, token, user]); // reconnect after authentication or token refresh

  const connect = useCallback(() => {
    if (unmountedRef.current) return; // Prevent connection if unmounted
    if (!IS_PLATFORM && (isAuthLoading || !user)) return;
    try {
      // Construct WebSocket URL
      const wsUrl = buildWebSocketUrl(token);

      if (!wsUrl) return console.warn('No authentication token found for WebSocket connection');

      const websocket = new WebSocket(wsUrl);
      // Store connecting sockets too, so a token refresh can close them before
      // their handshake completes with stale credentials.
      wsRef.current = websocket;

      websocket.onopen = () => {
        setIsConnected(true);
        if (hasConnectedRef.current) {
          // This is a reconnect — signal so components can catch up on missed messages
          dispatch({ kind: 'websocket_reconnected', timestamp: Date.now() });
        }
        hasConnectedRef.current = true;
      };

      websocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as ServerEvent;
          dispatch(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = () => {
        if (wsRef.current !== websocket) {
          return;
        }
        setIsConnected(false);
        wsRef.current = null;

        // Attempt to reconnect after 3 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          if (unmountedRef.current) return; // Prevent reconnection if unmounted
          connect();
        }, 3000);
      };

      websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
    }
  }, [dispatch, isAuthLoading, token, user]); // reconnect with current authentication state

  // A send that can't reach its socket must FAIL LOUDLY in the chat: the
  // composer flips its loader on optimistically, so a silently dropped frame
  // reads as "working" forever (bti-all ping case — peer socket down on a
  // flaky uplink). Synthesize the same error+complete frames the server would
  // send, scoped to the addressed session, so the error bubble shows and the
  // loader clears.
  const surfaceSendFailure = useCallback((message: any, hostLabel: string) => {
    const sid =
      (typeof message?.sessionId === 'string' && message.sessionId) ||
      (typeof message?.options?.remoteControl === 'string' && message.options.remoteControl) ||
      (typeof message?.options?.sessionId === 'string' && message.options.sessionId) ||
      null;
    if (!sid) return;
    const stamp = new Date().toISOString();
    dispatch({
      kind: 'error',
      id: `send-fail-${Date.now()}`,
      content: `Message not sent: no connection to ${hostLabel} (waited ${Math.round(SEND_QUEUE_TTL_MS / 1000)}s for it to come back). Check the Hosts dialog and send again.`,
      sessionId: sid,
      provider: 'claude',
      timestamp: stamp,
    });
    // Follow with complete so the working loader clears (same order the server uses).
    setTimeout(() => {
      dispatch({ kind: 'complete', exitCode: 1, sessionId: sid, provider: 'claude', timestamp: stamp });
    }, 0);
  }, []);

  // One additional socket per connected peer host, with the same 3s reconnect
  // loop as the primary plus a CONNECTING watchdog (see CONNECT_TIMEOUT_MS) so a
  // hung handshake can never strand the loop. Sockets for removed hosts are torn
  // down and their queued sends failed loudly.
  const teardownPeerEntry = useCallback((entry: PeerSocketEntry) => {
    entry.closed = true;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.connectTimer) clearTimeout(entry.connectTimer);
    for (const item of entry.queue.splice(0)) {
      clearTimeout(item.expireTimer);
      surfaceSendFailure(item.message, item.hostLabel);
    }
    entry.ws?.close();
  }, [surfaceSendFailure]);

  useEffect(() => {
    const sockets = remoteSocketsRef.current;
    const wanted = new Set(remoteHosts.map((h) => h.url));

    for (const [url, entry] of sockets) {
      if (!wanted.has(url)) {
        teardownPeerEntry(entry);
        sockets.delete(url);
      }
    }

    for (const host of remoteHosts) {
      if (sockets.has(host.url)) continue;
      const entry: PeerSocketEntry = {
        ws: null,
        timer: null,
        connectTimer: null,
        closed: false,
        queue: [],
        openNow: () => {},
      };
      sockets.set(host.url, entry);
      const open = () => {
        if (entry.closed) return;
        if (entry.timer) {
          clearTimeout(entry.timer);
          entry.timer = null;
        }
        if (entry.ws) return; // already connecting or connected
        try {
          const socket = new WebSocket(buildRemoteWebSocketUrl(host));
          entry.ws = socket;
          entry.connectTimer = setTimeout(() => {
            entry.connectTimer = null;
            if (socket.readyState === WebSocket.CONNECTING) socket.close();
          }, CONNECT_TIMEOUT_MS);
          socket.onopen = () => {
            if (entry.connectTimer) {
              clearTimeout(entry.connectTimer);
              entry.connectTimer = null;
            }
            // Flush sends held while the socket was reviving.
            for (const item of entry.queue.splice(0)) {
              clearTimeout(item.expireTimer);
              try {
                socket.send(JSON.stringify(item.message));
              } catch {
                surfaceSendFailure(item.message, item.hostLabel);
              }
            }
          };
          socket.onmessage = (event) => {
            try {
              const data = JSON.parse(event.data);
              dispatch({ ...data, __hostUrl: host.url });
            } catch {
              /* malformed frame from peer — drop */
            }
          };
          socket.onclose = () => {
            if (entry.connectTimer) {
              clearTimeout(entry.connectTimer);
              entry.connectTimer = null;
            }
            entry.ws = null;
            if (entry.closed) return;
            // Someone is waiting on this socket — retry now, not in 3s.
            entry.timer = setTimeout(open, entry.queue.length > 0 ? 250 : 3000);
          };
          socket.onerror = () => {
            /* onclose handles the retry */
          };
        } catch {
          entry.ws = null;
          entry.timer = setTimeout(open, 3000);
        }
      };
      entry.openNow = open;
      open();
    }
  }, [remoteHosts, surfaceSendFailure, teardownPeerEntry]);

  useEffect(() => {
    const sockets = remoteSocketsRef.current;
    return () => {
      for (const [, entry] of sockets) {
        entry.closed = true;
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.connectTimer) clearTimeout(entry.connectTimer);
        for (const item of entry.queue.splice(0)) clearTimeout(item.expireTimer);
        entry.ws?.close();
      }
      sockets.clear();
    };
  }, []);

  const sendMessage = useCallback((message: any) => {
    // Multi-host routing: a message that addresses a session owned by a
    // connected peer host goes over THAT host's socket; everything else goes
    // to the primary. Call sites stay host-unaware.
    const target = targetHostFor(message);
    if (target) {
      const entry = remoteSocketsRef.current.get(target.url);
      if (entry?.ws && entry.ws.readyState === WebSocket.OPEN) {
        entry.ws.send(JSON.stringify(message));
      } else if (entry && !entry.closed) {
        // Socket down or mid-handshake: hold the send while the reconnect loop
        // (kicked to run now) revives it — flushed in onopen. Peer hosts ride
        // flaky uplinks; most outages are shorter than the TTL, so sends just
        // work instead of demanding a manual retry. Only a host that stays dead
        // surfaces the failure bubble.
        console.warn(`WebSocket to ${target.url} not connected — queueing send for up to ${SEND_QUEUE_TTL_MS}ms`);
        const hostLabel = new URL(target.url).hostname;
        const item: QueuedSend = {
          message,
          hostLabel,
          expireTimer: setTimeout(() => {
            const i = entry.queue.indexOf(item);
            if (i >= 0) {
              entry.queue.splice(i, 1);
              surfaceSendFailure(message, hostLabel);
            }
          }, SEND_QUEUE_TTL_MS),
        };
        entry.queue.push(item);
        if (!entry.ws) entry.openNow();
        // A socket stuck CONNECTING is left to the watchdog, which closes it
        // within CONNECT_TIMEOUT_MS; onclose then reconnects on the fast path.
      } else {
        console.warn(`WebSocket to ${target.url} not connected`);
        surfaceSendFailure(message, new URL(target.url).hostname);
      }
      return;
    }
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket not connected');
      surfaceSendFailure(message, 'this server');
    }
  }, [surfaceSendFailure]);

  const subscribe = useCallback((listener: ServerEventListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    subscribe,
    latestMessage,
    isConnected
  }), [sendMessage, subscribe, latestMessage, isConnected]);

  return value;
};

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();

  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;
