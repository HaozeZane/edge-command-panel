import { useEffect, useRef, useState, useCallback } from 'react';
import type { BrowserFrame } from '../types/protocol';

interface WebSocketHookOptions {
  onFrame?: (frame: BrowserFrame) => void;
  onConnect?: (info: { isReconnect: boolean }) => void;
  onReconnect?: () => void;
  /** Set false (for example after Access expires) to stop scheduling retries. */
  enabled?: boolean;
}

export function useWebSocket({ onFrame, onConnect, onReconnect, enabled = true }: WebSocketHookOptions) {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const pingIntervalRef = useRef<number | null>(null);
  const retryCountRef = useRef(0);
  const isUnmountedRef = useRef(false);
  const hasConnectedOnceRef = useRef(false);
  const socketGenerationRef = useRef(0);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  const onConnectRef = useRef(onConnect);
  onConnectRef.current = onConnect;

  const onReconnectRef = useRef(onReconnect);
  onReconnectRef.current = onReconnect;

  const clearSocketTimers = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (isUnmountedRef.current || !enabledRef.current) return;
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      return;
    }

    setIsConnecting(true);

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ui-api/events/ws`;

    const generation = ++socketGenerationRef.current;

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      // Any callback from an older socket must not mutate the state of the
      // current connection (e.g. a late onclose from the previous socket).
      const isCurrentSocket = () =>
        socketGenerationRef.current === generation &&
        wsRef.current === ws &&
        !isUnmountedRef.current;

      ws.onopen = () => {
        if (!isCurrentSocket() || !enabledRef.current) {
          ws.close();
          return;
        }
        setIsConnected(true);
        setIsConnecting(false);

        const isReconnect = hasConnectedOnceRef.current;
        hasConnectedOnceRef.current = true;
        retryCountRef.current = 0;

        // Called on the first open as well, so a snapshot can be scheduled
        // after the initial HTTP fetch without a notification-loss window.
        onConnectRef.current?.({ isReconnect });
        if (isReconnect) onReconnectRef.current?.();

        // Setup 30s text ping keepalive
        if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send('ping');
          }
        }, 30000);
      };

      ws.onmessage = (event) => {
        if (!isCurrentSocket()) return;
        if (typeof event.data !== 'string') return;
        const text = event.data.trim();
        // Ignore plain text pong
        if (text === 'pong' || text === 'PONG') return;

        try {
          const frame = JSON.parse(text) as BrowserFrame;
          if (frame && frame.type) {
            onFrameRef.current?.(frame);
          }
        } catch {
          // Non-JSON or ignored frame
        }
      };

      ws.onerror = () => {
        // Handled in onclose
      };

      ws.onclose = () => {
        // Ignore a stale socket's close event; it must not disconnect or
        // schedule retries for the replacement socket.
        if (socketGenerationRef.current !== generation || wsRef.current !== ws) return;
        wsRef.current = null;
        setIsConnected(false);
        setIsConnecting(false);
        clearSocketTimers();

        if (!isUnmountedRef.current && enabledRef.current) {
          // Exponential backoff reconnect
          const backoff = Math.min(10000, 1000 * Math.pow(1.5, retryCountRef.current));
          retryCountRef.current += 1;
          if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = window.setTimeout(() => {
            connect();
          }, backoff);
        }
      };
    } catch {
      setIsConnecting(false);
      setIsConnected(false);
      if (!isUnmountedRef.current && enabledRef.current) {
        const backoff = Math.min(10000, 1000 * Math.pow(1.5, retryCountRef.current));
        retryCountRef.current += 1;
        reconnectTimeoutRef.current = window.setTimeout(() => connect(), backoff);
      }
    }
  }, [clearSocketTimers]);

  // Mark the hook mounted once for the lifetime of the component.
  useEffect(() => {
    isUnmountedRef.current = false;
    return () => {
      isUnmountedRef.current = true;
    };
  }, []);

  // Connect/disconnect based on enabled. Disabling (session expired) cancels
  // pending backoff timers instead of hammering the backend with retries.
  useEffect(() => {
    if (!enabled) {
      clearSocketTimers();
      socketGenerationRef.current += 1;
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        try {
          ws.close();
        } catch {
          // already closed
        }
      }
      setIsConnected(false);
      setIsConnecting(false);
      return;
    }

    connect();

    return () => {
      clearSocketTimers();
      socketGenerationRef.current += 1;
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        try {
          ws.close();
        } catch {
          // already closed
        }
      }
      setIsConnected(false);
      setIsConnecting(false);
    };
  }, [clearSocketTimers, connect, enabled]);

  return { isConnected, isConnecting };
}
