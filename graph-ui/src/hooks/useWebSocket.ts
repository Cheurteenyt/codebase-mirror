// graph-ui/src/hooks/useWebSocket.ts
// R25: WebSocket hook for real-time push notifications.
//
// Connects to the V2 UI server's WebSocket endpoint and receives
// 'notification' events when the human memory DB or code graph changes.
//
// Features:
//   - Automatic reconnection with exponential backoff (1s → 2s → 4s → 8s → 15s cap)
//   - Ping/pong keepalive every 30s
//   - Stale connection detection (if no pong within 10s, reconnect)
//   - Project filter (only receive events for the active project)
//   - Cleanup on unmount (closes the WebSocket)
//
// Usage:
//   const { connected, lastEvent } = useWebSocket(project, (event) => {
//     if (event.type === 'human_nodes_changed') {
//       refreshDashboard();
//     }
//   });

import { useEffect, useRef, useState, useCallback } from "react";
import { getSecurityBootstrap } from "../api/client";

export interface WsNotification {
  type: string;
  event: string;
  project: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

interface UseWebSocketResult {
  connected: boolean;
  lastEvent: WsNotification | null;
  reconnect: () => void;
}

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000];
const PING_INTERVAL = 30000;
const PONG_TIMEOUT = 10000;

export function useWebSocket(
  project: string | null,
  onNotification?: (event: WsNotification) => void,
): UseWebSocketResult {
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<WsNotification | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pongTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  // R40: generation counter to invalidate stale WS callbacks. When project
  // changes or the component unmounts, we increment this. Any callback (onopen,
  // onmessage, onclose, onerror) captured by a previous socket checks its
  // captured gen against the current value and bails if stale. This prevents
  // the zombie-connection race where the OLD socket's onclose fires after the
  // NEW socket is already open, scheduling a reconnect to the OLD project and
  // leaking project-A events into project-B's view.
  const wsGenRef = useRef(0);
  // R25: keep the latest onNotification in a ref so the WebSocket listener
  // always calls the latest callback without re-connecting.
  const callbackRef = useRef(onNotification);
  useEffect(() => { callbackRef.current = onNotification; }, [onNotification]);

  const connect = useCallback(async () => {
    if (!project || !mountedRef.current) return;

    // Reserve a generation before awaiting bootstrap. A project change or
    // unmount increments the counter and prevents the stale continuation from
    // creating a socket after the credential request resolves.
    const gen = ++wsGenRef.current;
    let csrfToken: string;
    try {
      // A reconnect can follow a server restart. The runtime-only credential
      // changes on every start, so bypass the cached bootstrap after the first
      // failed/closed connection attempt.
      csrfToken = (
        await getSecurityBootstrap(reconnectAttemptRef.current > 0)
      ).csrf_token;
    } catch {
      if (wsGenRef.current === gen && mountedRef.current) scheduleReconnect();
      return;
    }
    if (wsGenRef.current !== gen || !mountedRef.current) return;

    // Build WebSocket URL from the current page URL.
    // R26: use /ws path so Vite dev server can proxy it separately from HMR.
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws?csrf=${encodeURIComponent(csrfToken)}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      // WebSocket construction failed — schedule reconnect.
      scheduleReconnect();
      return;
    }

    wsRef.current = ws;

    ws.onopen = () => {
      if (wsGenRef.current !== gen) return; // stale socket
      if (!mountedRef.current) return;
      reconnectAttemptRef.current = 0;
      setConnected(true);
      // Send subscribe message to filter by project.
      ws.send(JSON.stringify({ type: 'subscribe', project }));
      // Start ping keepalive.
      startPing();
    };

    ws.onmessage = (event: MessageEvent) => {
      if (wsGenRef.current !== gen) return; // stale socket
      if (!mountedRef.current) return;
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'pong') {
          // Pong received — clear the pong timeout.
          if (pongTimerRef.current) {
            clearTimeout(pongTimerRef.current);
            pongTimerRef.current = null;
          }
          return;
        }
        if (msg.type === 'notification') {
          const notification: WsNotification = {
            type: msg.type,
            event: msg.event,
            project: msg.project,
            timestamp: msg.timestamp,
            data: msg.data,
          };
          setLastEvent(notification);
          callbackRef.current?.(notification);
        }
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      // R40: if the generation changed, this close is from a stale socket
      // (project changed or component unmounted). Do NOT scheduleReconnect —
      // the new socket is already being managed by the new effect run.
      if (wsGenRef.current !== gen) return;
      if (!mountedRef.current) return;
      setConnected(false);
      stopPing();
      scheduleReconnect();
    };

    ws.onerror = () => {
      if (wsGenRef.current !== gen) return; // stale socket
      // The close event will fire after error — no need to handle separately.
      // Just close the socket to trigger the close handler.
      try { ws.close(); } catch { /* ignore */ }
    };
  }, [project]);

  const startPing = useCallback(() => {
    stopPing();
    pingTimerRef.current = setInterval(() => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      // Send ping.
      try {
        ws.send(JSON.stringify({ type: 'ping' }));
      } catch {
        return;
      }
      // Set pong timeout — if no pong within 10s, force reconnect.
      if (pongTimerRef.current) clearTimeout(pongTimerRef.current);
      pongTimerRef.current = setTimeout(() => {
        // No pong received — connection is stale. Force reconnect.
        try { ws.close(); } catch { /* ignore */ }
      }, PONG_TIMEOUT);
    }, PING_INTERVAL);
  }, []);

  const stopPing = useCallback(() => {
    if (pingTimerRef.current) {
      clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
    if (pongTimerRef.current) {
      clearTimeout(pongTimerRef.current);
      pongTimerRef.current = null;
    }
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current) return;
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    const delay = RECONNECT_DELAYS[Math.min(reconnectAttemptRef.current, RECONNECT_DELAYS.length - 1)];
    reconnectAttemptRef.current++;
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      if (mountedRef.current) void connect();
    }, delay);
  }, [connect]);

  const reconnect = useCallback(() => {
    reconnectAttemptRef.current = 0;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (wsRef.current) {
      try { wsRef.current.close(); } catch { /* ignore */ }
    }
    // A synchronous/mock close handler, or a browser that dispatches `close`
    // immediately, can schedule a timer while handling the manual close.
    // Manual reconnect owns the next attempt, so cancel that timer as well.
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    void connect();
  }, [connect]);

  useEffect(() => {
    mountedRef.current = true;
    // A project change (including pausing a hidden tab with project=null)
    // invalidates the previous connection immediately. Its stale onclose is
    // intentionally ignored by the generation guard, so reset state here.
    setConnected(false);
    void connect();
    return () => {
      mountedRef.current = false;
      // R40: increment the generation to invalidate any in-flight callbacks
      // (onopen/onmessage/onclose/onerror) captured by the previous socket.
      // Without this, the old socket's onclose fires after the new socket is
      // already open, scheduling a reconnect to the OLD project (zombie
      // connection that leaks cross-project events into the current view).
      wsGenRef.current++;
      stopPing();
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        try { wsRef.current.close(); } catch { /* ignore */ }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  return { connected, lastEvent, reconnect };
}
