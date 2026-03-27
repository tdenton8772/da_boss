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
  | { type: "supervisor:finding"; finding: string; action?: string };

type EventHandler = (event: ServerEvent) => void;

export function useWebSocket(onEvent: EventHandler) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let reconnectTimeout: ReturnType<typeof setTimeout>;
    let ws: WebSocket;

    function connect() {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        reconnectTimeout = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as ServerEvent;
          onEvent(event);
        } catch {
          // ignore
        }
      };
    }

    connect();

    return () => {
      clearTimeout(reconnectTimeout);
      ws?.close();
    };
  }, [onEvent]);

  const subscribe = useCallback((agentId: string) => {
    wsRef.current?.send(JSON.stringify({ type: "subscribe", agentId }));
  }, []);

  const unsubscribe = useCallback((agentId: string) => {
    wsRef.current?.send(JSON.stringify({ type: "unsubscribe", agentId }));
  }, []);

  return { connected, subscribe, unsubscribe };
}
