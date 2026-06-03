import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../components/auth/context/AuthContext';
import { IS_PLATFORM } from '../constants/config';

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

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false); // Track if component is unmounted
  const hasConnectedRef = useRef(false); // Track if we've ever connected (to detect reconnects)
  // Messages sent before the socket is OPEN (e.g. the very first message after a
  // fresh page load, while the WS is still CONNECTING) are buffered here and
  // flushed in onopen, instead of being silently dropped.
  const sendQueueRef = useRef<string[]>([]);
  const MAX_QUEUED_MESSAGES = 50;
  // App-level heartbeat. Reverse proxies (Cloudflare / nginx / the Vite dev
  // proxy) idle-close a quiet websocket after ~60-120s; a send into that
  // not-yet-detected-dead socket is silently lost. Pinging every 25s keeps the
  // socket non-idle, and a missing pong forces a fast reconnect so we never
  // send into a half-open socket.
  const heartbeatRef = useRef<NodeJS.Timeout | null>(null);
  const pongTimerRef = useRef<NodeJS.Timeout | null>(null);
  const HEARTBEAT_MS = 25000;
  const PONG_TIMEOUT_MS = 10000;
  const [latestMessage, setLatestMessage] = useState<any>(null);
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const { token } = useAuth();

  const clearTimers = () => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    if (pongTimerRef.current) {
      clearTimeout(pongTimerRef.current);
      pongTimerRef.current = null;
    }
  };

  useEffect(() => {
    // Reset on every (re)mount. Without this, React 18 StrictMode's
    // mount→cleanup→mount cycle in dev latches unmountedRef=true on the first
    // cleanup, and the second mount's connect() bails forever — leaving the app
    // with NO websocket (REST still works, so the UI looks fine, but nothing the
    // user sends ever reaches the server). Re-arming here makes connect() run on
    // the real (second) mount and on every token change.
    unmountedRef.current = false;
    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      clearTimers();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
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
      // Assign immediately (not just in onopen) so sendMessage can observe the
      // CONNECTING state and queue rather than drop.
      wsRef.current = websocket;

      websocket.onopen = () => {
        // Stale/aborted connection: the provider unmounted or a newer socket
        // (StrictMode's real mount, or a token change) already superseded this
        // one. Don't flip state live — just close this orphan.
        if (unmountedRef.current || (wsRef.current && wsRef.current !== websocket)) {
          try { websocket.close(); } catch { /* noop */ }
          return;
        }
        setIsConnected(true);
        wsRef.current = websocket;
        // Flush anything queued while the socket was connecting/reconnecting.
        if (sendQueueRef.current.length > 0) {
          const queued = sendQueueRef.current;
          sendQueueRef.current = [];
          for (const payload of queued) {
            try {
              websocket.send(payload);
            } catch (error) {
              console.error('Failed to flush queued WebSocket message:', error);
            }
          }
        }
        if (hasConnectedRef.current) {
          // This is a reconnect — signal so components can catch up on missed messages
          setLatestMessage({ type: 'websocket-reconnected', timestamp: Date.now() });
        }
        hasConnectedRef.current = true;

        // Start the keep-alive heartbeat.
        clearTimers();
        heartbeatRef.current = setInterval(() => {
          if (websocket.readyState !== WebSocket.OPEN) return;
          try {
            websocket.send(JSON.stringify({ type: 'ping' }));
          } catch {
            return;
          }
          // Expect a pong; if none arrives, the socket is half-dead — force a
          // close so onclose schedules a reconnect (and sends then queue/flush).
          if (pongTimerRef.current) clearTimeout(pongTimerRef.current);
          pongTimerRef.current = setTimeout(() => {
            try {
              websocket.close();
            } catch {
              /* noop */
            }
          }, PONG_TIMEOUT_MS);
        }, HEARTBEAT_MS);
      };

      websocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          // Heartbeat reply — connection is alive; not a real app message.
          if (data && data.type === 'pong') {
            if (pongTimerRef.current) {
              clearTimeout(pongTimerRef.current);
              pongTimerRef.current = null;
            }
            return;
          }
          setLatestMessage(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = () => {
        clearTimers();
        // Only the *active* socket drives state + reconnect. A superseded socket
        // (StrictMode's discarded first mount, or an old token's socket) closing
        // must not flip isConnected or spawn a duplicate reconnect loop.
        if (wsRef.current !== websocket) return;
        setIsConnected(false);
        wsRef.current = null;
        if (unmountedRef.current) return; // unmounted / token changed — no reconnect

        // Attempt to reconnect after 3 seconds
        if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
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

  const sendMessage = useCallback((message: any) => {
    const payload = JSON.stringify(message);
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(payload);
      return;
    }
    // Socket is still connecting or temporarily down (reconnecting). Queue the
    // message and let onopen flush it, so the first message after a fresh load
    // isn't lost. Cap the buffer so a never-connecting socket can't grow it
    // unbounded; drop the oldest if we somehow exceed the cap.
    sendQueueRef.current.push(payload);
    if (sendQueueRef.current.length > MAX_QUEUED_MESSAGES) {
      sendQueueRef.current.shift();
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
