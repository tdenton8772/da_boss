import { useEffect, useState, useCallback } from "react";
import { api, type PlanTodo } from "../api";

// The agent's plan — its latest TodoWrite task list, rendered as a checklist with
// per-item status. Otherwise the plan is only visible as a raw blob in the message
// stream. Polls while the agent works so it updates as items complete.

const ICON: Record<string, string> = { completed: "✓", in_progress: "▶", pending: "○" };
const COLOR: Record<string, string> = { completed: "text-green-400", in_progress: "text-blue-400", pending: "text-gray-500" };

export function AgentPlan({ agentId }: { agentId: string }) {
  const [todos, setTodos] = useState<PlanTodo[] | null>(null);

  const load = useCallback(() => {
    api.getAgentPlan(agentId).then((r) => setTodos(r.todos)).catch(() => {});
  }, [agentId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);

  if (!todos || todos.length === 0) return null;
  const done = todos.filter((t) => t.status === "completed").length;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-4">
      <div className="text-sm font-medium text-gray-300 mb-2">
        Plan <span className="text-gray-500">— {done}/{todos.length} done</span>
      </div>
      <ul className="space-y-1">
        {todos.map((t, i) => (
          <li key={i} className={`text-sm flex items-start gap-2 ${COLOR[t.status] || "text-gray-400"}`}>
            <span className="w-4 shrink-0 text-center">{ICON[t.status] || "•"}</span>
            <span className={t.status === "completed" ? "line-through text-gray-500" : ""}>
              {t.status === "in_progress" && t.activeForm ? t.activeForm : t.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
