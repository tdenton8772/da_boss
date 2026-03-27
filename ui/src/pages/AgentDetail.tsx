import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, Link, useNavigate } from "react-router";
import { api, type PermissionReq } from "../api";
import { Save } from "lucide-react";
import { useWebSocket, type ServerEvent } from "../ws";
import { MessageStream, type Message } from "../components/MessageStream";
import { ControlBar } from "../components/ControlBar";
import { PermissionDialog } from "../components/PermissionDialog";
import { ArrowLeft } from "lucide-react";

interface AgentData {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  state: string;
  priority: string;
  model: string;
  max_turns: number | null;
  max_budget_usd: number | null;
  error_message: string | null;
  supervisor_instructions?: string;
  total_cost_usd?: number;
  tokens?: { total_cost_usd: number };
}

export function AgentDetail() {
  const params = useParams();
  const navigate = useNavigate();
  const id = params.id;
  const [agent, setAgent] = useState<AgentData | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [permissions, setPermissions] = useState<PermissionReq[]>([]);
  const [streamBuffer, setStreamBuffer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  const [instructionsDirty, setInstructionsDirty] = useState(false);
  const [savingInstructions, setSavingInstructions] = useState(false);
  const subscribedRef = useRef(false);

  const refresh = useCallback(() => {
    if (!id) return;
    api
      .getAgent(id)
      .then((a) => {
        const data = a as AgentData;
        setAgent(data);
        if (!instructionsDirty) {
          setInstructions(data.supervisor_instructions || "");
        }
      })
      .catch((err) => setError(err.message));
    api
      .getPendingPermissions()
      .then((all) => setPermissions(all.filter((p) => p.agent_id === id)))
      .catch(() => {});
  }, [id]);

  // Load events on mount
  useEffect(() => {
    if (!id) return;
    refresh();
    api
      .getEvents(id, 200)
      .then((events) => {
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
      })
      .catch(() => {});
  }, [id, refresh]);

  const handleEvent = useCallback(
    (event: ServerEvent) => {
      if (!id) return;

      if (event.type === "agent:message" && event.agentId === id) {
        setMessages((prev) => {
          // Deduplicate: skip if last message has same role and content
          const last = prev[prev.length - 1];
          if (last && last.role === event.role && last.content === event.content) {
            return prev;
          }
          return [
            ...prev,
            {
              role: event.role,
              content: event.content,
              timestamp: event.timestamp,
            },
          ];
        });
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
        api
          .getPendingPermissions()
          .then((all) => setPermissions(all.filter((p) => p.agent_id === id)))
          .catch(() => {});
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

  if (error) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-400 mb-4">{error}</p>
          <Link to="/" className="text-blue-400 hover:text-blue-300">
            Back to dashboard
          </Link>
        </div>
      </div>
    );
  }

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

      <div className="flex items-start justify-between mb-4 gap-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg md:text-xl font-bold text-gray-100 truncate">{agent.name}</h1>
          <p className="text-xs text-gray-500 truncate">{agent.cwd}</p>
        </div>
        <div className="text-right text-sm shrink-0">
          <div className="text-gray-400">{agent.state}</div>
          <div className="text-gray-500 font-mono">${cost.toFixed(4)}</div>
        </div>
      </div>

      {/* Info */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 mb-4 text-sm text-gray-400 overflow-hidden">
        <div className="mb-1 min-w-0">
          <span className="text-gray-500">Prompt:</span>
          <pre className="whitespace-pre-wrap break-words mt-0.5 font-sans overflow-x-hidden text-xs md:text-sm">{agent.prompt}</pre>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
          <span>Priority: {agent.priority}</span>
          <span>Model: {agent.model}</span>
          {agent.max_turns && <span>Max turns: {agent.max_turns}</span>}
          {agent.max_budget_usd && (
            <span>Budget: ${agent.max_budget_usd}</span>
          )}
        </div>
      </div>

      {/* Supervisor Instructions */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 mb-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-gray-300">Supervisor Instructions</h3>
          {instructionsDirty && (
            <button
              onClick={async () => {
                setSavingInstructions(true);
                try {
                  await fetch(`/api/agents/${agent.id}/instructions`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ supervisor_instructions: instructions }),
                  });
                  setInstructionsDirty(false);
                } catch {} finally {
                  setSavingInstructions(false);
                }
              }}
              className="flex items-center gap-1 px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded"
            >
              <Save size={12} />
              {savingInstructions ? "Saving..." : "Save"}
            </button>
          )}
        </div>
        <textarea
          value={instructions}
          onChange={(e) => {
            setInstructions(e.target.value);
            setInstructionsDirty(true);
          }}
          placeholder="Tell the supervisor what this agent should do, what to do when it finishes, and when to escalate to you..."
          rows={3}
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-200 text-sm placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-y"
        />
        <p className="text-xs text-gray-600 mt-1">
          The supervisor checks every 5 min. When this agent completes or needs input, it uses these instructions to decide the next step.
        </p>
      </div>

      {/* Permissions */}
      {permissions.length > 0 && (
        <div className="mb-4">
          <PermissionDialog
            permissions={permissions}
            onResolved={refresh}
            agentNames={agent ? { [agent.id]: agent.name } : undefined}
          />
        </div>
      )}

      {/* Controls */}
      <div className="mb-4">
        <ControlBar agentId={agent.id} state={agent.state} onAction={refresh} onDelete={() => navigate("/")} />
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
      {agent.error_message && !agent.error_message.toLowerCase().includes("imported from existing session") && !agent.error_message.toLowerCase().includes("claude code process exited") && !agent.error_message.toLowerCase().includes("server restarted") && (
        <div className="mt-4 bg-red-950/30 border border-red-900/50 rounded-lg p-2 md:p-3 text-xs md:text-sm text-red-300">
          <p>{agent.error_message}</p>
          {(agent.error_message.toLowerCase().includes("fresh start") || agent.error_message.toLowerCase().includes("too long") || agent.error_message.toLowerCase().includes("too large") || agent.error_message.toLowerCase().includes("compact") || agent.error_message.toLowerCase().includes("trim")) && (
            <div className="flex flex-wrap gap-2 mt-2">
              <button
                onClick={async () => {
                  try {
                    await fetch(`/api/agents/${agent.id}/compact`, { method: "POST" });
                    refresh();
                  } catch {
                    alert("Failed to start compaction");
                  }
                }}
                className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-xs rounded"
              >
                Compact (summarize history)
              </button>
              <button
                onClick={async () => {
                  try {
                    const res = await fetch(`/api/agents/${agent.id}/trim`, { method: "POST" });
                    const data = await res.json();
                    if (!res.ok) alert(data.error);
                    refresh();
                  } catch {
                    alert("Failed to trim");
                  }
                }}
                className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white text-xs rounded"
              >
                Trim (keep last 10 messages)
              </button>
              <button
                onClick={async () => {
                  const newPrompt = window.prompt("Enter a prompt for the fresh start (or leave empty to reuse the original):");
                  if (newPrompt === null) return;
                  try {
                    await fetch(`/api/agents/${agent.id}/fresh-start`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ prompt: newPrompt || undefined }),
                    });
                    refresh();
                  } catch {
                    alert("Failed to start");
                  }
                }}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded"
              >
                Fresh Start (no history)
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
