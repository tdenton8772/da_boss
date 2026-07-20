import { useEffect, useState, useCallback } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type AgentPlanEntry } from "../api";

// The agent's plan-mode plans (from ExitPlanMode), viewable after approval — the plan
// document rendered as markdown, with its approved/rejected status.
const STATUS_COLOR: Record<string, string> = { approved: "text-green-400", denied: "text-red-400", pending: "text-amber-400" };

export function AgentPlans({ agentId }: { agentId: string }) {
  const [plans, setPlans] = useState<AgentPlanEntry[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(() => {
    api.getAgentPlans(agentId).then((p) => {
      setPlans(p);
      setOpen((cur) => (cur === null && p.length ? p[0].id : cur)); // expand newest by default
    }).catch(() => {});
  }, [agentId]);

  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  if (!plans || plans.length === 0) return null;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-4">
      <div className="text-sm font-medium text-gray-300 mb-2">Plans <span className="text-gray-500">— {plans.length}</span></div>
      {plans.map((p) => (
        <div key={p.id} className="border-b border-gray-800 last:border-0">
          <button onClick={() => setOpen(open === p.id ? null : p.id)} className="w-full flex items-center gap-2 text-left py-2 hover:bg-gray-800/40 px-1 rounded">
            <span className="text-gray-500 w-4">{open === p.id ? "▾" : "▸"}</span>
            <span className={`text-xs uppercase ${STATUS_COLOR[p.status] || "text-gray-400"}`}>{p.status}</span>
            <span className="text-sm text-gray-300 truncate flex-1">{(p.plan.split("\n").find((l) => l.trim()) || "Plan").replace(/^#+\s*/, "")}</span>
            <span className="text-xs text-gray-600 font-mono">{new Date(p.created_at).toLocaleString()}</span>
          </button>
          {open === p.id && (
            <div className="max-h-[28rem] overflow-y-auto bg-gray-950 border border-gray-800 rounded p-3 mb-2 mx-1 prose prose-invert prose-sm max-w-none
              prose-headings:text-gray-200 prose-p:text-gray-300 prose-li:text-gray-300 prose-strong:text-gray-200
              prose-code:text-green-400 prose-code:bg-gray-800 prose-code:px-1 prose-code:rounded prose-code:text-xs
              prose-pre:bg-gray-800 prose-pre:border prose-pre:border-gray-700 prose-a:text-blue-400">
              <Markdown remarkPlugins={[remarkGfm]}>{p.plan}</Markdown>
              {p.resolution_answer && <p className="text-xs text-gray-500 mt-2 not-prose">Feedback: {p.resolution_answer}</p>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
