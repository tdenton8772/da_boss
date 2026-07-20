import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router";
import { api, type AgentActivity as Activity, type ActivityRun } from "../api";

// The associated-work trace for an agent: every pipeline run (tests, land-retests,
// deploy) and every child agent (reviews, the deploy agent, shipped siblings) — the
// things that otherwise run in pods with no visible page. Pipeline-run logs expand
// inline (fetched on demand). Polls while anything is still in flight.

const RUN_ACTIVE = new Set(["pending", "pending_review", "pending_approval", "running", "queued"]);

function runColor(status: string): string {
  if (status === "passed") return "text-green-400";
  if (status === "failed") return "text-red-400";
  if (status === "pending_approval") return "text-amber-400";
  if (RUN_ACTIVE.has(status)) return "text-blue-400";
  return "text-gray-400";
}

function RunRow({ run }: { run: ActivityRun }) {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && log === null && run.has_log) {
      setLoading(true);
      try {
        const full = await api.getPipelineRun(run.id);
        setLog((full as { log?: string }).log || "(empty log)");
      } catch {
        setLog("(couldn't load log)");
      } finally {
        setLoading(false);
      }
    }
  };

  const kind = run.deploy_gate_run_id ? "deploy-gate" : run.land_on_pass ? "land" : "";
  return (
    <div className="border-b border-gray-800 last:border-0">
      <button
        onClick={toggle}
        className="w-full flex items-center gap-3 py-2 text-left hover:bg-gray-800/40 px-1 rounded"
      >
        <span className="text-gray-500 w-4">{run.has_log ? (open ? "▾" : "▸") : "·"}</span>
        <span className="font-mono text-sm text-gray-200">{run.phase}</span>
        {kind && <span className="text-[10px] uppercase tracking-wide text-gray-500 border border-gray-700 rounded px-1">{kind}</span>}
        <span className={`text-sm ${runColor(run.status)}`}>
          {run.status}{run.exit_code !== null && run.status === "failed" ? ` (exit ${run.exit_code})` : ""}
        </span>
        {run.recommendation && <span className="text-xs text-gray-400">→ {run.recommendation}</span>}
        <span className="ml-auto text-xs text-gray-600 font-mono">{new Date(run.created_at).toLocaleTimeString()}</span>
      </button>
      {open && (
        <pre className="text-xs bg-black/50 text-gray-300 rounded p-3 mb-2 mx-1 overflow-x-auto max-h-96 overflow-y-auto whitespace-pre-wrap">
          {loading ? "Loading log…" : run.has_log ? log : "(no log captured for this run)"}
        </pre>
      )}
    </div>
  );
}

export function AgentActivity({ agentId }: { agentId: string }) {
  const [act, setAct] = useState<Activity | null>(null);

  const load = useCallback(() => {
    api.getAgentActivity(agentId).then(setAct).catch(() => {});
  }, [agentId]);

  useEffect(() => {
    load();
    const anyActive = act?.runs.some((r) => RUN_ACTIVE.has(r.status)) ?? true;
    const t = setInterval(load, anyActive ? 5000 : 20000);
    return () => clearInterval(t);
  }, [load, act?.runs]);

  if (!act) return null;
  const nothing = act.runs.length === 0 && act.reviews.length === 0 && !act.deploy_agent && act.shipped.length === 0;
  if (nothing) return null;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-4">
      <div className="text-sm font-medium text-gray-300 mb-2">Activity — associated runs &amp; agents</div>

      {act.reviews.length > 0 && (
        <div className="mb-3">
          <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">Reviews</div>
          {act.reviews.map((r) => (
            <Link key={r.id} to={`/agent/${r.id}`} className="flex items-center gap-2 py-1 text-sm text-blue-300 hover:text-blue-200">
              🔍 <span className="truncate">{r.name}</span>
              <span className="text-gray-500">· {r.state}{r.recommendation ? ` → ${r.recommendation}` : ""}</span>
            </Link>
          ))}
        </div>
      )}

      {act.runs.length > 0 && (
        <div className="mb-2">
          <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">Pipeline runs</div>
          {act.runs.map((r) => <RunRow key={r.id} run={r} />)}
        </div>
      )}

      {act.deploy_agent && (
        <Link to={`/agent/${act.deploy_agent.id}`} className="flex items-center gap-2 py-1 text-sm text-emerald-300 hover:text-emerald-200">
          🚀 <span>Deploy agent</span> <span className="text-gray-500">· {act.deploy_agent.state}</span>
        </Link>
      )}

      {act.shipped.length > 0 && (
        <div className="mt-2">
          <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">Shipped in this deploy</div>
          <div className="flex flex-wrap gap-2">
            {act.shipped.map((s) => (
              <Link key={s.id} to={`/agent/${s.id}`} className="text-sm text-emerald-400 hover:text-emerald-200 underline">
                {s.pr_number ? `PR #${s.pr_number}` : s.name}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
