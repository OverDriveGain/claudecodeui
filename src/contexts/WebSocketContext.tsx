import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../components/auth/context/AuthContext';
import { IS_PLATFORM } from '../constants/config';
import { useRemoteHosts, hostForSession, type RemoteHost } from '../utils/remoteHosts';

type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: any) => void;
  latestMessage: any | null;
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
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`; // OSS mode: Use same host:port that served the page
};

/** ws(s) URL for a connected PEER host (multi-host mode) — bearer token via query. */
const buildRemoteWebSocketUrl = (host: RemoteHost) => {
  const wsOrigin = host.url.replace(/^http/, 'ws');
  return `${wsOrigin}/ws?token=${encodeURIComponent(host.token)}`;
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
  const [latestMessage, setLatestMessage] = useState<any>(null);
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const { token } = useAuth();
  const remoteHosts = useRemoteHosts();
  // url -> live socket for connected peer hosts (multi-host mode). Peer frames
  // funnel into the SAME latestMessage feed, tagged __hostUrl, so every consumer
  // (chat realtime, projects_updated, session_activity) sees one stream.
  const remoteSocketsRef = useRef<Map<string, { ws: WebSocket | null; timer: NodeJS.Timeout | null; closed: boolean }>>(new Map());

  useEffect(() => {
    // The cleanup below sets unmountedRef = true. Without this reset, every
    // re-run of the effect (e.g. on token refresh) would short-circuit connect()
    // at its unmounted guard and leave the socket permanently disconnected.
    unmountedRef.current = false;
    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [token]); // everytime token changes, we reconnect

  const connect = useCallback(() => {
    if (unmountedRef.current) return; // Prevent connection if unmounted
    try {
      // Construct WebSocket URL
      const wsUrl = buildWebSocketUrl(token);

      if (!wsUrl) return console.warn('No authentication token found for WebSocket connection');

      const websocket = new WebSocket(wsUrl);

      websocket.onopen = () => {
        setIsConnected(true);
        wsRef.current = websocket;
        if (hasConnectedRef.current) {
          // This is a reconnect — signal so components can catch up on missed messages
          setLatestMessage({ type: 'websocket-reconnected', timestamp: Date.now() });
        }
        hasConnectedRef.current = true;
      };

      websocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          setLatestMessage(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = () => {
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
  }, [token]); // everytime token changes, we reconnect

  // One additional socket per connected peer host, with the same 3s reconnect
  // loop as the primary. Sockets for removed hosts are torn down.
  useEffect(() => {
    const sockets = remoteSocketsRef.current;
    const wanted = new Set(remoteHosts.map((h) => h.url));

    for (const [url, entry] of sockets) {
      if (!wanted.has(url)) {
        entry.closed = true;
        if (entry.timer) clearTimeout(entry.timer);
        entry.ws?.close();
        sockets.delete(url);
      }
    }

    for (const host of remoteHosts) {
      if (sockets.has(host.url)) continue;
      const entry: { ws: WebSocket | null; timer: NodeJS.Timeout | null; closed: boolean } = {
        ws: null,
        timer: null,
        closed: false,
      };
      sockets.set(host.url, entry);
      const open = () => {
        if (entry.closed) return;
        try {
          const socket = new WebSocket(buildRemoteWebSocketUrl(host));
          entry.ws = socket;
          socket.onmessage = (event) => {
            try {
              const data = JSON.parse(event.data);
              setLatestMessage({ ...data, __hostUrl: host.url });
            } catch {
              /* malformed frame from peer — drop */
            }
          };
          socket.onclose = () => {
            entry.ws = null;
            if (entry.closed) return;
            entry.timer = setTimeout(open, 3000);
          };
          socket.onerror = () => {
            /* onclose handles the retry */
          };
        } catch {
          entry.timer = setTimeout(open, 3000);
        }
      };
      open();
    }
  }, [remoteHosts]);

  useEffect(() => {
    const sockets = remoteSocketsRef.current;
    return () => {
      for (const [, entry] of sockets) {
        entry.closed = true;
        if (entry.timer) clearTimeout(entry.timer);
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
      } else {
        console.warn(`WebSocket to ${target.url} not connected`);
      }
      return;
    }
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket not connected');
    }
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    latestMessage,
    isConnected
  }), [sendMessage, latestMessage, isConnected]);

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
