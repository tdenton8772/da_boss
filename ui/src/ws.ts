import { useEffect, useRef, useCallback, useState } from "react";

export type ServerEvent =
  | { type: "agent:state_changed"; agentId: string; state: string; previousState: string }
  | { type: "agent:message"; agentId: string; role: string; content: string; timestamp: string }
  | { type: "agent:stream"; agentId: string; delta: string }
  | { type: "agent:token_usage"; agentId: string; inputTokens: number; outputTokens: number; costUsd: number; totalCostUsd: number }
  | { type: "agent:error"; agentId: string; error: string }
  | { type: "permission:requested"; request: { id: number; agent_id: string; tool_name: string; tool_input: string; status: string } }
  | { type: "permission:resolved"; requestId: number; decision: string }
  | { type: "budget:updated"; dailySpendUsd: number; dailyBudgetUsd: number; monthlySpendUsd: number; monthlyBudgetUsd: number }
  | { type: "supervisor:finding"; finding: string; action?: string }
  | { type: "agent:subagent_start"; agentId: string; subagent: { agentId: string; agentType: string; sessionId: string; transcriptPath: string; startedAt: string } }
  | { type: "agent:subagent_stop"; agentId: string; subagentId: string; transcriptPath: string };

type EventHandler = (event: ServerEvent) => void;

export function useWebSocket(onEvent: EventHandler) {
  const wsRef = useRef<WebSocket | null>(null);
  const onEventRef = useRef(onEvent);
  const [connected, setConnected] = useState(false);
  // Agent subscriptions live on the SOCKET server-side, so a reconnect (e.g. the
  // boss restarting on a deploy) starts unsubscribed — remember them and re-send.
  const subsRef = useRef(new Set<string>());
  // Bumped on every (re)connect. A page can refetch on reconnects (generation > 1)
  // to pick up whatever happened while the socket was down.
  const [generation, setGeneration] = useState(0);

  // Keep the callback ref up to date without causing reconnects
  onEventRef.current = onEvent;

  useEffect(() => {
    let reconnectTimeout: ReturnType<typeof setTimeout>;
    let ws: WebSocket;
    let closed = false;

    function connect() {
      if (closed) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const prefix = import.meta.env.BASE_URL.replace(/\/$/, ""); // "" or "/daboss"
      ws = new WebSocket(`${protocol}//${window.location.host}${prefix}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        for (const agentId of subsRef.current) ws.send(JSON.stringify({ type: "subscribe", agentId }));
        setGeneration((g) => g + 1);
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) {
          reconnectTimeout = setTimeout(connect, 3000);
        }
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as ServerEvent;
          onEventRef.current(event);
        } catch {
          // ignore
        }
      };
    }

    connect();

    return () => {
      closed = true;
      clearTimeout(reconnectTimeout);
      ws?.close();
    };
  }, []); // stable — never reconnects due to callback changes

  const safeSend = useCallback((data: string) => {
    const ws = wsRef.current;
    if (!ws) return;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    } else if (ws.readyState === WebSocket.CONNECTING) {
      // Queue until open
      const onOpen = () => {
        ws.removeEventListener("open", onOpen);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      };
      ws.addEventListener("open", onOpen);
    }
  }, []);

  const subscribe = useCallback((agentId: string) => {
    subsRef.current.add(agentId);
    safeSend(JSON.stringify({ type: "subscribe", agentId }));
  }, [safeSend]);

  const unsubscribe = useCallback((agentId: string) => {
    subsRef.current.delete(agentId);
    safeSend(JSON.stringify({ type: "unsubscribe", agentId }));
  }, [safeSend]);

  return { connected, subscribe, unsubscribe, generation };
}
