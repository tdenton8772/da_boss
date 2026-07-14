import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router";
import { ArrowLeft, GitPullRequest, Rocket } from "lucide-react";
import { api } from "../api";
import { useToastHelpers } from "../components/Toast";

/**
 * Reviews queue — every change + deploy awaiting a human decision, across all
 * developers (repo-scoped: you review the repos you work on, not just your own
 * work). Merge/request-changes act on someone else's change using THEIR git token;
 * approve/reject gate deploys.
 */
type Reviews = Awaited<ReturnType<typeof api.getReviews>>;

const recColor = (r: string | null) =>
  r === "merge" || r === "approve" ? "text-green-400" : r === "fix" ? "text-amber-400" : "text-red-400";

export function Reviews() {
  const toast = useToastHelpers();
  const [data, setData] = useState<Reviews | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(() => { api.getReviews().then(setData).catch(() => {}); }, []);
  useEffect(() => { refresh(); const t = setInterval(refresh, 12000); return () => clearInterval(t); }, [refresh]);

  const act = async (id: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(id);
    try { await fn(); toast.success(ok); refresh(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
    finally { setBusy(null); }
  };

  const merge = (id: string, recommendation?: string | null) => {
    const flagged = recommendation === "hold" || recommendation === "fix";
    if (flagged && !confirm(`⚠️ The review is ${recommendation?.toUpperCase()} — the reviewer flagged this change.\n\nMerge anyway? This will be recorded against you.`)) return;
    act(id, () => api.mergeAgent(id, flagged).then((r) => { if (r?.landing) toast.info?.("Landing — rebasing on main + retesting"); }), "Merge started");
  };
  const requestChanges = (id: string) => {
    const fb = prompt("What changes should the agent make?");
    if (fb) act(id, () => api.requestChanges(id, fb), "Sent back to the agent");
  };

  const changes = data?.changes ?? [];
  const deploys = data?.deploys ?? [];
  // group changes by repo (the repo-scoped view)
  const byRepo = changes.reduce<Record<string, typeof changes>>((m, c) => {
    const k = (c.repo_url || "—").replace(/\.git$/, "").replace("https://github.com/", "");
    (m[k] ||= []).push(c); return m;
  }, {});
  const empty = !changes.length && !deploys.length;

  return (
    <div className="min-h-screen bg-gray-950 p-4 md:p-8 max-w-5xl mx-auto text-gray-100">
      <div className="flex items-center gap-3 mb-6">
        <Link to="/" className="text-gray-400 hover:text-gray-200"><ArrowLeft size={20} /></Link>
        <h1 className="text-2xl font-bold">Reviews</h1>
        <span className="text-xs text-gray-500">{changes.length} change(s) · {deploys.length} deploy(s) awaiting you</span>
      </div>

      {empty && (
        <div className="text-gray-500 text-sm bg-gray-900 border border-gray-800 rounded-lg p-8 text-center">
          Nothing awaiting review. Reviewed changes appear here for anyone working on the repo.
        </div>
      )}

      {/* Deploys awaiting approval */}
      {deploys.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-gray-400 mb-2 flex items-center gap-2"><Rocket size={15} /> Deploys awaiting approval</h2>
          <div className="space-y-3">
            {deploys.map((d) => (
              <div key={d.id} className="bg-gray-900 border border-amber-800/50 rounded-lg p-4">
                <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
                  <div className="text-sm">
                    <span className="font-mono text-gray-200">{d.phase}</span>
                    <span className="text-gray-500"> · {(d.repo_url || "").replace("https://github.com/", "")} @ {d.git_ref}</span>
                    <span className="text-gray-600 text-xs ml-2">by {d.owner_email ?? "—"}</span>
                  </div>
                  <div className="flex gap-2">
                    <button disabled={busy === d.id} onClick={() => act(d.id, () => api.approvePipelineRun(d.id), "Deploy approved")}
                      className="text-sm bg-green-700 hover:bg-green-600 disabled:opacity-50 rounded px-3 py-1.5">Approve deploy</button>
                    <button disabled={busy === d.id} onClick={() => act(d.id, () => api.rejectPipelineRun(d.id), "Deploy rejected")}
                      className="text-sm bg-gray-800 hover:bg-gray-700 rounded px-3 py-1.5">Reject</button>
                  </div>
                </div>
                {d.review && <pre className="text-xs text-gray-400 whitespace-pre-wrap font-sans max-h-40 overflow-y-auto">{d.review}</pre>}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Changes awaiting merge, grouped by repo */}
      {Object.entries(byRepo).map(([repo, items]) => (
        <section key={repo} className="mb-8">
          <h2 className="text-sm font-semibold text-gray-400 mb-2 flex items-center gap-2"><GitPullRequest size={15} /> {repo}</h2>
          <div className="space-y-3">
            {items.map((c) => (
              <div key={c.id} className="bg-gray-900 border border-gray-700 rounded-lg p-4">
                <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
                  <div className="text-sm min-w-0">
                    <Link to={`/agent/${c.id}`} className="text-blue-400 hover:text-blue-300 font-medium">{c.name}</Link>
                    {c.pr_url && <a href={c.pr_url} target="_blank" rel="noreferrer" className="text-gray-400 hover:text-gray-200 ml-2">PR #{c.pr_number} ↗</a>}
                    <span className="text-gray-600 text-xs ml-2">by {c.owner_email ?? "—"}</span>
                    <div className="text-xs mt-1">
                      <span className="text-gray-500">recommendation:</span>{" "}
                      <span className={`font-bold uppercase ${recColor(c.recommendation)}`}>{c.recommendation}</span>
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button disabled={busy === c.id || c.landing}
                      title={c.landing ? "A land is already in progress — rebasing on main + retesting before merge." : undefined}
                      onClick={() => merge(c.id, c.recommendation)}
                      className={`text-sm disabled:opacity-50 text-white rounded px-3 py-1.5 ${
                        c.recommendation === "hold" || c.recommendation === "fix"
                          ? "bg-amber-700 hover:bg-amber-600" : "bg-green-700 hover:bg-green-600"
                      }`}>{c.landing ? "Landing…" : (c.recommendation === "hold" || c.recommendation === "fix") ? "Merge anyway" : "Merge PR"}</button>
                    <button disabled={busy === c.id || c.landing} onClick={() => requestChanges(c.id)}
                      className="text-sm bg-gray-800 hover:bg-gray-700 text-gray-200 rounded px-3 py-1.5">Request changes</button>
                  </div>
                </div>
                {c.review && <pre className="text-xs text-gray-400 whitespace-pre-wrap font-sans max-h-48 overflow-y-auto">{c.review}</pre>}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
