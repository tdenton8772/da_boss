import { useState, useEffect } from "react";
import { Workflow } from "lucide-react";
import { api, type PipelineRunInfo } from "../api";
import { useToastHelpers } from "./Toast";

/** Recent pipeline runs + the human approval gate (gate: human → Approve to ship). */
export function PipelinePanel() {
  const toast = useToastHelpers();
  const [runs, setRuns] = useState<PipelineRunInfo[]>([]);

  const refresh = () => api.listPipelineRuns().then(setRuns).catch(() => {});
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  const approve = async (id: string) => {
    if (!confirm("Approve this deploy — it will run now against the configured target.")) return;
    try { await api.approvePipelineRun(id); toast.success("Approved — running"); refresh(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Approve failed"); }
  };
  const reject = async (id: string) => {
    try { await api.rejectPipelineRun(id); toast.success("Rejected"); refresh(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Reject failed"); }
  };

  const color = (s: string) =>
    s === "passed" ? "text-green-400" : s === "failed" ? "text-red-400"
    : s === "pending_approval" ? "text-amber-400" : "text-blue-400";
  const recBadge = (rec: string | null) =>
    rec === "approve" ? "text-green-400" : rec === "reject" ? "text-red-400" : "text-amber-400";

  if (runs.length === 0) return null;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
      <h2 className="text-lg font-semibold text-gray-100 mb-2 flex items-center gap-2">
        <Workflow size={18} /> Pipeline Runs
      </h2>
      <div className="divide-y divide-gray-800">
        {runs.map((r) => (
          <div key={r.id} className="py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 text-sm">
                <span className="font-mono text-gray-200">{r.phase}</span>
                <span className="text-gray-600 text-xs ml-2 truncate">{r.git_ref || ""}</span>
                <div className={`text-xs ${color(r.status)}`}>
                  {r.status === "pending_review" ? "🔎 reviewing…" : r.status}
                  {r.exit_code !== null ? ` (exit ${r.exit_code})` : ""}
                </div>
              </div>
              {r.status === "pending_approval" && (
                <div className="shrink-0 flex gap-2">
                  <button onClick={() => reject(r.id)} className="bg-gray-800 hover:bg-red-700 text-gray-300 text-sm rounded px-3 py-1.5">Reject</button>
                  <button onClick={() => approve(r.id)} className="bg-amber-600 hover:bg-amber-500 text-white text-sm rounded px-3 py-1.5">Approve &amp; deploy</button>
                </div>
              )}
            </div>
            {/* Pre-audited review packet */}
            {r.status === "pending_approval" && r.review && (
              <div className="mt-2 bg-gray-950 border border-gray-800 rounded p-3">
                {r.recommendation && (
                  <div className="text-xs mb-1">
                    Reviewer recommendation:{" "}
                    <span className={`font-semibold uppercase ${recBadge(r.recommendation)}`}>{r.recommendation}</span>
                  </div>
                )}
                <pre className="text-xs text-gray-400 whitespace-pre-wrap font-sans max-h-48 overflow-y-auto">{r.review}</pre>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
