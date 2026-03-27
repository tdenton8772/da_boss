import { useState } from "react";
import { api } from "../api";
import { Play, Pause, Square, RotateCcw, Send, Trash2 } from "lucide-react";

export function ControlBar({
  agentId,
  state,
  onAction,
  onDelete,
}: {
  agentId: string;
  state: string;
  onAction: () => void;
  onDelete?: () => void;
}) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  const exec = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onAction();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Action failed");
    }
  };

  const handleSendInput = async () => {
    if (!input.trim()) return;
    setSending(true);
    try {
      await api.sendInput(agentId, input);
      setInput("");
      onAction();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to send input");
    } finally {
      setSending(false);
    }
  };

  const showStart = state === "pending" || state === "failed";
  const showResume = state === "paused" || state === "completed";
  const showPause = state === "running";
  const showKill = ["running", "paused", "waiting_permission", "waiting_input"].includes(state);
  const showInput = ["running", "waiting_input", "completed"].includes(state);

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
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
            label="Delete"
            onClick={() => {
              if (confirm("Delete this agent permanently? This cannot be undone.")) {
                api.deleteAgent(agentId).then(() => onDelete()).catch(() => alert("Delete failed"));
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
          >
            <Send size={16} />
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
