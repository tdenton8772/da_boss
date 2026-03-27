import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, Link } from "react-router";
import { api, type AgentDetail as AgentDetailType, type PermissionReq } from "../api";
import { useWebSocket, type ServerEvent } from "../ws";
import { MessageStream, type Message } from "../components/MessageStream";
import { ControlBar } from "../components/ControlBar";
import { PermissionDialog } from "../components/PermissionDialog";
import { ArrowLeft } from "lucide-react";

export function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const [agent, setAgent] = useState<AgentDetailType | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [permissions, setPermissions] = useState<PermissionReq[]>([]);
  const [streamBuffer, setStreamBuffer] = useState("");
  const subscribedRef = useRef(false);

  const refresh = useCallback(() => {
    if (!id) return;
    api.getAgent(id).then(setAgent).catch(() => {});
    api.getPendingPermissions().then((all) =>
      setPermissions(all.filter((p) => p.agent_id === id))
    ).catch(() => {});
  }, [id]);

  // Load events on mount
  useEffect(() => {
    if (!id) return;
    refresh();
    api.getEvents(id, 200).then((events) => {
      const msgs: Message[] = events
        .filter((e) => e.type === "message")
        .reverse()
        .map((e) => {
          const data = JSON.parse(e.data);
          return {
            role: data.role || "system",
            content: data.content || "",
            timestamp: e.created_at,
          };
        });
      setMessages(msgs);
    }).catch(() => {});
  }, [id, refresh]);

  const handleEvent = useCallback(
    (event: ServerEvent) => {
      if (!id) return;

      if (event.type === "agent:message" && event.agentId === id) {
        setMessages((prev) => [
          ...prev,
          {
            role: event.role,
            content: event.content,
            timestamp: event.timestamp,
          },
        ]);
        setStreamBuffer("");
      }

      if (event.type === "agent:stream" && event.agentId === id) {
        setStreamBuffer((prev) => prev + event.delta);
      }

      if (event.type === "agent:state_changed" && event.agentId === id) {
        refresh();
      }

      if (event.type === "agent:token_usage" && event.agentId === id) {
        refresh();
      }

      if (
        event.type === "permission:requested" ||
        event.type === "permission:resolved"
      ) {
        api.getPendingPermissions().then((all) =>
          setPermissions(all.filter((p) => p.agent_id === id))
        ).catch(() => {});
      }

      if (event.type === "agent:error" && event.agentId === id) {
        setMessages((prev) => [
          ...prev,
          {
            role: "system",
            content: `Error: ${event.error}`,
            timestamp: new Date().toISOString(),
          },
        ]);
      }
    },
    [id, refresh]
  );

  const { subscribe, unsubscribe } = useWebSocket(handleEvent);

  // Subscribe to streaming for this agent
  useEffect(() => {
    if (!id || subscribedRef.current) return;
    subscribe(id);
    subscribedRef.current = true;
    return () => {
      unsubscribe(id);
      subscribedRef.current = false;
    };
  }, [id, subscribe, unsubscribe]);

  if (!agent) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center text-gray-400">
        Loading...
      </div>
    );
  }

  const cost = agent.total_cost_usd ?? agent.tokens?.total_cost_usd ?? 0;

  return (
    <div className="min-h-screen bg-gray-950 p-4 md:p-8 max-w-4xl mx-auto">
      {/* Header */}
      <Link
        to="/"
        className="flex items-center gap-1 text-gray-500 hover:text-gray-300 text-sm mb-4"
      >
        <ArrowLeft size={14} />
        Back
      </Link>

      <div className="flex items-start justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold text-gray-100">{agent.name}</h1>
          <p className="text-sm text-gray-500">{agent.cwd}</p>
        </div>
        <div className="text-right text-sm">
          <div className="text-gray-400">
            {agent.state}
          </div>
          <div className="text-gray-500 font-mono">
            ${cost.toFixed(4)}
          </div>
        </div>
      </div>

      {/* Info */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 mb-4 text-sm text-gray-400">
        <p className="mb-1">
          <span className="text-gray-500">Prompt:</span> {agent.prompt}
        </p>
        <div className="flex gap-4 text-xs text-gray-500">
          <span>Priority: {agent.priority}</span>
          <span>Model: {agent.model}</span>
          {agent.max_turns && <span>Max turns: {agent.max_turns}</span>}
          {agent.max_budget_usd && (
            <span>Budget: ${agent.max_budget_usd}</span>
          )}
        </div>
      </div>

      {/* Permissions */}
      {permissions.length > 0 && (
        <div className="mb-4">
          <PermissionDialog permissions={permissions} onResolved={refresh} />
        </div>
      )}

      {/* Controls */}
      <div className="mb-4">
        <ControlBar agentId={agent.id} state={agent.state} onAction={refresh} />
      </div>

      {/* Messages */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <h3 className="text-sm font-medium text-gray-300 mb-3">Messages</h3>
        <MessageStream messages={messages} />
        {streamBuffer && (
          <div className="text-xs text-gray-400 font-mono whitespace-pre-wrap bg-gray-950 rounded p-2 mt-2 border border-gray-800">
            {streamBuffer}
            <span className="animate-pulse">|</span>
          </div>
        )}
      </div>

      {/* Error */}
      {agent.error_message && (
        <div className="mt-4 bg-red-950/30 border border-red-900/50 rounded-lg p-3 text-sm text-red-300">
          {agent.error_message}
        </div>
      )}
    </div>
  );
}
