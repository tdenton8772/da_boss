import { useState } from "react";
import { api } from "../api";
import { useToastHelpers } from "./Toast";
import { Play, Pause, Square, RotateCcw, Send, Trash2, Zap } from "lucide-react";

export function ControlBar({
  agentId,
  state,
  testing,
  onAction,
  onDelete,
}: {
  agentId: string;
  state: string;
  testing?: boolean;
  onAction: () => void;
  onDelete?: () => void;
}) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const toast = useToastHelpers();

  const exec = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onAction();
    } catch (err: unknown) {
      toast.error("Action failed", err instanceof Error ? err.message : "Unknown error");
    }
  };

  const handleSendInput = async () => {
    if (!input.trim()) return;
    setSending(true);
    try {
      await api.sendInput(agentId, input);
      setInput("");
      onAction();
      toast.success("Input queued");
    } catch (err: unknown) {
      toast.error("Failed to send input", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSending(false);
    }
  };

  const handleSendUrgent = async () => {
    if (!input.trim()) return;
    setSending(true);
    try {
      const result = await api.sendUrgent(agentId, input);
      setInput("");
      onAction();
      if (result.delivered === "immediate") {
        toast.success("Urgent message delivered to running agent");
      } else {
        toast.success("Agent not running — message queued");
      }
    } catch (err: unknown) {
      toast.error("Failed to send urgent", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSending(false);
    }
  };

  const showStart = state === "pending";
  // While the agent's test phases run (in separate pods) it sits in `completed`,
  // which would otherwise show a finished-looking Resume. Suppress Resume and show
  // a Testing indicator instead so it doesn't read as done/idle.
  const showResume = !testing && ["paused", "completed", "failed"].includes(state);
  // The recovery hammer: requeue through the dispatcher (same path the
  // self-healing uses) — for agents wedged in ways Resume can't fix.
  const showRedispatch = ["paused", "failed", "waiting_permission", "waiting_input", "aborted"].includes(state);
  const showPause = state === "running" || state === "waiting_input";
  const showKill = ["running", "paused", "waiting_permission", "waiting_input"].includes(state);
  // Every non-terminal state takes input — the queue holds it and delivers on the
  // next turn. Hiding the field in waiting_permission/queued left the page a
  // dead-end ("waiting on input" with nowhere to type) when a pod died mid-ask.
  const showInput = ["running", "waiting_input", "waiting_permission", "queued", "pending", "completed", "paused", "failed"].includes(state);

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {testing && (
          <span className="flex items-center gap-2 bg-blue-900/40 border border-blue-700/50 text-blue-300 text-sm rounded px-3 py-1.5">
            <RotateCcw size={14} className="animate-spin" /> Testing…
          </span>
        )}
        {showStart && (
          <ActionButton
            icon={<Play size={16} />}
            label="Start"
            onClick={() => exec(() => api.startAgent(agentId))}
            color="bg-green-700 hover:bg-green-600"
          />
        )}
        {showResume && (
          <ActionButton
            icon={<RotateCcw size={16} />}
            label="Resume"
            onClick={() => exec(() => api.resumeAgent(agentId))}
            color="bg-green-700 hover:bg-green-600"
          />
        )}
        {showPause && (
          <ActionButton
            icon={<Pause size={16} />}
            label="Pause"
            onClick={() => exec(() => api.pauseAgent(agentId))}
            color="bg-yellow-700 hover:bg-yellow-600"
          />
        )}
        {showRedispatch && (
          <ActionButton
            icon={<RotateCcw size={16} />}
            label="Re-dispatch"
            onClick={() => exec(() => api.redispatchAgent(agentId))}
            color="bg-orange-800 hover:bg-orange-700"
          />
        )}
        {showKill && (
          <ActionButton
            icon={<Square size={16} />}
            label="Kill"
            onClick={() => {
              if (confirm("Kill this agent?")) {
                exec(() => api.killAgent(agentId));
              }
            }}
            color="bg-red-700 hover:bg-red-600"
          />
        )}
        {onDelete && (
          <ActionButton
            icon={<Trash2 size={16} />}
            label="Remove"
            onClick={() => {
              if (confirm("Remove this agent from da_boss? Its remote branch is deleted too (unless another agent still uses it). The Claude session on disk is NOT deleted — you can reimport it later.")) {
                api.deleteAgent(agentId).then((res) => {
                  const bc = res?.branchCleanup;
                  toast.success(bc?.deleted ? `Agent removed — deleted branch ${bc.branch}` : "Agent removed");
                  onDelete();
                }).catch(() => toast.error("Remove failed"));
              }
            }}
            color="bg-gray-700 hover:bg-red-700"
          />
        )}
      </div>

      {showInput && (
        <div className="flex gap-2 items-end">
          <textarea
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              // Auto-resize
              e.target.style.height = "auto";
              e.target.style.height = e.target.scrollHeight + "px";
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSendInput();
              }
            }}
            rows={1}
            placeholder="Send input to agent... (Shift+Enter for newline)"
            className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-100 text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none overflow-hidden min-h-[38px] max-h-48"
          />
          <button
            onClick={handleSendInput}
            disabled={sending || !input.trim()}
            className="px-3 py-2 bg-blue-700 hover:bg-blue-600 disabled:bg-gray-700 text-white rounded"
            title="Queue message (delivered when agent is ready)"
          >
            <Send size={16} />
          </button>
          <button
            onClick={handleSendUrgent}
            disabled={sending || !input.trim()}
            className="px-3 py-2 bg-amber-600 hover:bg-amber-500 disabled:bg-gray-700 text-white rounded"
            title="Interrupt agent with urgent message (delivered immediately)"
          >
            <Zap size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  color: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-sm text-white rounded ${color}`}
    >
      {icon}
      {label}
    </button>
  );
}
