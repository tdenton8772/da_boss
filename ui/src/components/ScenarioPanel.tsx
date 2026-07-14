import { useState, useEffect } from "react";
import { Link } from "react-router";
import { FlaskConical } from "lucide-react";
import { api } from "../api";
import { useToastHelpers } from "./Toast";

/**
 * Admin panel to run live test scenarios (real agents on narrative prompts, owned
 * by the hidden test-harness user). Kicks off the run and polls the verdict.
 */
export function ScenarioPanel() {
  const toast = useToastHelpers();
  const [isAdmin, setIsAdmin] = useState(false);
  const [scenarios, setScenarios] = useState<Array<{ name: string; description: string }>>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [liveAgent, setLiveAgent] = useState<string | null>(null);
  const [report, setReport] = useState<{ name: string; state: string; verdict: string; checks: Array<{ label: string; pass: boolean }> } | null>(null);

  useEffect(() => {
    api.me().then((res) => {
      if (res.user?.role === "admin") {
        setIsAdmin(true);
        api.listScenarios().then(setScenarios).catch(() => {});
      }
    }).catch(() => {});
  }, []);

  if (!isAdmin) return null;

  const run = async (name: string) => {
    setRunning(name);
    setReport(null);
    setLiveAgent(null);
    try {
      const { agentId } = await api.runScenario(name);
      setLiveAgent(agentId); // surface the link immediately so you can watch it work
      toast.success(`Running ${name}…`);
      // Poll the verdict for ~6 min (real agents clone + work + push + PR).
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const rep = await api.scenarioReport(name, agentId).catch(() => null);
        if (rep) {
          setReport({ name, ...rep });
          if (rep.verdict !== "pending" && rep.state === "completed") break;
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Scenario failed to start");
    } finally {
      setRunning(null);
    }
  };

  const arm = async () => {
    setRunning("land-conflict");
    setReport(null);
    setLiveAgent(null);
    try {
      const r = await api.armLandConflict();
      setLiveAgent(r.agentId);
      setReport({
        name: "land-conflict",
        state: "completed",
        verdict: r.conflict ? "pass" : "fail",
        checks: [
          { label: `Branch + main diverge on the same line (PR #${r.prNumber})`, pass: true },
          { label: "Land gate's rebase step reports a conflict", pass: r.conflict },
          { label: "Open the agent → click Merge → expect 409 'resolve via Request changes'", pass: r.conflict },
        ],
      });
      toast.success(r.conflict ? "Armed — conflict confirmed. Open the agent and click Merge." : "Armed, but no conflict detected");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to arm conflict");
    } finally {
      setRunning(null);
    }
  };

  const badge = (v: string) =>
    v === "pass" ? "text-green-400" : v === "fail" ? "text-red-400" : "text-yellow-400";

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
      <h2 className="text-lg font-semibold text-gray-100 mb-2 flex items-center gap-2">
        <FlaskConical size={18} /> Live Test Scenarios
      </h2>
      <p className="text-gray-400 text-sm mb-4">
        Run a real agent through a scripted narrative to validate the live paths (e.g. mid-turn steer).
        Agents are owned by the hidden test-harness user and use your Claude credential.
      </p>

      <div className="space-y-2">
        {scenarios.map((s) => (
          <div key={s.name} className="flex items-center justify-between gap-3 py-2 border-b border-gray-800">
            <div className="min-w-0">
              <div className="text-gray-200 text-sm font-mono">{s.name}</div>
              <div className="text-gray-500 text-xs">{s.description}</div>
            </div>
            <button
              onClick={() => run(s.name)}
              disabled={!!running}
              className="shrink-0 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm rounded px-3 py-1.5"
            >
              {running === s.name ? "Running…" : "Run"}
            </button>
          </div>
        ))}
        {scenarios.length === 0 && <div className="text-gray-500 text-sm">No scenarios.</div>}

        {/* Scripted (no Claude): arm a deterministic land conflict via the forge. */}
        <div className="flex items-center justify-between gap-3 py-2 border-b border-gray-800">
          <div className="min-w-0">
            <div className="text-gray-200 text-sm font-mono">land-conflict</div>
            <div className="text-gray-500 text-xs">Scripts branch + main to diverge on the same line, then wires an agent to the PR — click Merge on it to see the land gate return a conflict (409).</div>
          </div>
          <button
            onClick={arm}
            disabled={!!running}
            className="shrink-0 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm rounded px-3 py-1.5"
          >
            {running === "land-conflict" ? "Arming…" : "Arm conflict"}
          </button>
        </div>
      </div>

      {liveAgent && (
        <div className="mt-4 text-sm">
          <Link to={`/agent/${liveAgent}`} className="text-blue-400 hover:text-blue-300">
            ▶ Watch the agent work (live event stream) →
          </Link>
        </div>
      )}

      {report && (
        <div className="mt-3 bg-gray-950 border border-gray-800 rounded p-3">
          <div className="text-sm mb-2">
            <span className="text-gray-400">{report.name}:</span>{" "}
            <span className={`font-semibold uppercase ${badge(report.verdict)}`}>
              {report.verdict === "pending" ? "running…" : report.verdict}
            </span>
            <span className="text-gray-600 text-xs ml-2">(agent {report.state})</span>
          </div>
          {report.checks.map((c, i) => (
            <div key={i} className={`text-xs ${c.pass ? "text-green-400" : "text-gray-500"}`}>
              {c.pass ? "✓" : "○"} {c.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
