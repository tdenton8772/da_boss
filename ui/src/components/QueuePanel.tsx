import { useState, useEffect, useCallback } from "react";
import { api } from "../api";
import { useToastHelpers } from "./Toast";
import { Trash2, ListOrdered, X } from "lucide-react";

export function QueuePanel({ agentId }: { agentId: string }) {
  const [messages, setMessages] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const toast = useToastHelpers();

  const refresh = useCallback(() => {
    api.getAgentQueue(agentId).then((r) => setMessages(r.messages)).catch(() => {});
  }, [agentId]);

  // Always poll for queue count
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  const handleClearAll = async () => {
    try {
      await api.clearAgentQueue(agentId);
      setMessages([]);
      toast.success("Queue cleared");
    } catch {
      toast.error("Failed to clear queue");
    }
  };

  const handleRemove = async (index: number) => {
    // Remove single message by clearing all and re-adding the rest
    // (server only supports clear-all, so we clear and re-send the keepers)
    const keep = messages.filter((_, i) => i !== index);
    try {
      await api.clearAgentQueue(agentId);
      for (const msg of keep) {
        await api.sendInput(agentId, msg);
      }
      setMessages(keep);
      toast.success("Message removed");
    } catch {
      toast.error("Failed to remove message");
      refresh();
    }
  };

  if (messages.length === 0) return null;

  return (
    <div className="mt-2 bg-amber-950/30 border border-amber-800/50 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-amber-950/50"
      >
        <ListOrdered size={14} className="text-amber-400" />
        <span className="text-xs text-amber-300 flex-1">
          {messages.length} message{messages.length !== 1 ? "s" : ""} queued — click to view
        </span>
      </button>

      {open && (
        <div className="border-t border-amber-800/30 px-3 py-2 space-y-2 max-h-64 overflow-y-auto">
          <div className="flex justify-end">
            <button
              onClick={handleClearAll}
              className="flex items-center gap-1 px-2 py-0.5 bg-red-800/50 hover:bg-red-700/50 text-red-300 text-xs rounded"
            >
              <Trash2 size={10} />
              Clear all
            </button>
          </div>
          {messages.map((msg, i) => (
            <div key={i} className="flex items-start gap-2 group">
              <span className="text-xs text-amber-600 font-mono pt-1 shrink-0">
                {i + 1}.
              </span>
              <pre className="text-xs text-gray-300 whitespace-pre-wrap break-words flex-1 bg-gray-900/50 rounded px-2 py-1.5">
                {msg}
              </pre>
              <button
                onClick={() => handleRemove(i)}
                className="opacity-0 group-hover:opacity-100 p-1 text-red-400 hover:text-red-300 hover:bg-red-900/30 rounded shrink-0 transition-opacity"
                title="Remove this message"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
