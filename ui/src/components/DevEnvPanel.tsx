import { useState, useEffect, useCallback, type ReactNode } from "react";
import { Link } from "react-router";
import { Laptop, Play, Square, RefreshCw, Clock, Copy, Check, Loader, ScrollText, Undo2 } from "lucide-react";
import { api, type DevEnvView } from "../api";
import { useToastHelpers } from "./Toast";

/**
 * A change's dev environment: a pod (declared by the repo's .daboss/dev.yaml)
 * running the branch, so a human + their local Claude can iterate against it
 * through a port-forward, then hand the change back for checks + review.
 * Renders nothing when the feature isn't enabled on this da_boss.
 */

function CopyLine({ label, text, hint }: { label: string; text: string; hint?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  };
  return (
    <div className="mb-2 min-w-0">
      {(label || hint) && <div className="text-xs text-gray-500 mb-1">{label}{hint && <span className="text-gray-600">{label ? " — " : ""}{hint}</span>}</div>}
      <div className="flex items-start gap-2 min-w-0">
        <code className="flex-1 min-w-0 block bg-gray-950 border border-gray-800 rounded px-2 py-1.5 text-xs text-gray-200 font-mono break-all whitespace-pre-wrap">
          {text}
        </code>
        <button onClick={copy} title="Copy" className="shrink-0 p-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300">
          {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
        </button>
      </div>
    </div>
  );
}

/** A button that copies `text` (the full text, whatever is on screen). */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {})}
      className="flex items-center gap-1 text-sm rounded px-3 py-1.5 bg-violet-700 hover:bg-violet-600 text-white">
      {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : label}
    </button>
  );
}

function Step({ n, title, children }: { n: number; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex gap-3 mb-3 min-w-0">
      <div className="shrink-0 w-5 h-5 rounded-full bg-violet-900/60 text-violet-200 text-xs flex items-center justify-center mt-0.5">{n}</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-gray-200 mb-1">{title}</div>
        {children}
      </div>
    </div>
  );
}

/** da_boss's MCP endpoint as this browser reaches it (same origin + base path). */
function mcpUrl(): string {
  return `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/?$/, "/")}mcp`;
}

function expiresIn(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return "expiring";
  const h = Math.floor(ms / 3600_000);
  const m = Math.round((ms % 3600_000) / 60_000);
  return h ? `${h}h ${m}m` : `${m}m`;
}

const STATUS: Record<string, { label: string; color: string; spin?: boolean }> = {
  starting: { label: "Starting", color: "text-violet-300", spin: true },
  ready: { label: "Ready", color: "text-green-400" },
  failed: { label: "Failed", color: "text-red-400" },
  stopping: { label: "Stopping", color: "text-gray-400", spin: true },
};

export function DevEnvPanel({ agentId, hasBranch }: { agentId: string; hasBranch: boolean }) {
  const [enabled, setEnabled] = useState(false);
  const [view, setView] = useState<DevEnvView | null>(null);
  const [busy, setBusy] = useState<string>("");
  const [log, setLog] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const { success, error } = useToastHelpers();

  const load = useCallback(() => {
    api.getDevEnv(agentId).then((r) => { setEnabled(r.enabled); setView(r.view); }).catch(() => {});
  }, [agentId]);
  useEffect(() => { load(); }, [load]);
  // Poll while something is in motion.
  useEffect(() => {
    if (!view || !["starting", "stopping"].includes(view.env.status)) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [view, load]);

  const act = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try { await fn(); if (ok) success(ok); load(); }
    catch (e) { error(e instanceof Error ? e.message : "Failed"); }
    finally { setBusy(""); }
  };

  if (!enabled || !hasBranch) return null;
  const env = view?.env;
  const st = env ? STATUS[env.status] : undefined;
  const btn = "flex items-center gap-1 text-sm rounded px-3 py-1.5 disabled:opacity-50";

  return (
    <div className="bg-gray-900 border border-violet-900/50 rounded-lg p-4 mb-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <h3 className="flex items-center gap-2 text-sm font-medium text-gray-200">
          <Laptop size={16} className="text-violet-400" /> Dev environment
          {st && (
            <span className={`flex items-center gap-1 text-xs ${st.color}`}>
              {st.spin && <Loader size={12} className="animate-spin" />}{st.label}
            </span>
          )}
          {env && env.status !== "stopping" && (
            <span className="flex items-center gap-1 text-xs text-gray-500"><Clock size={12} /> {expiresIn(env.expires_at)}</span>
          )}
        </h3>
        <div className="flex flex-wrap gap-2">
          {(!env || env.status === "failed") && (
            <button disabled={!!busy} onClick={() => act("start", () => api.startDevEnv(agentId), "Dev environment starting")}
              className={`${btn} bg-violet-700 hover:bg-violet-600 text-white`}>
              {busy === "start" ? <Loader size={14} className="animate-spin" /> : <Play size={14} />} {env ? "Restart" : "Start"}
            </button>
          )}
          {env?.status === "ready" && (
            <>
              <button disabled={!!busy} onClick={() => act("logs", async () => setLog((await api.devEnvLogs(agentId)).log))}
                className={`${btn} bg-gray-800 hover:bg-gray-700 text-gray-200`}>
                <ScrollText size={14} /> Log
              </button>
              <button disabled={!!busy} title={`Keep it ${env.ttl_hours}h from now`}
                onClick={() => act("extend", () => api.extendDevEnv(agentId), "Extended")}
                className={`${btn} bg-gray-800 hover:bg-gray-700 text-gray-200`}>
                <Clock size={14} /> Extend
              </button>
            </>
          )}
          {env && env.status !== "stopping" && (
            <button disabled={!!busy} onClick={() => act("stop", () => api.stopDevEnv(agentId), "Dev environment stopped")}
              className={`${btn} bg-gray-800 hover:bg-red-900 text-gray-200`}>
              <Square size={14} /> Stop
            </button>
          )}
        </div>
      </div>

      {!env && (
        <div className="text-sm text-gray-500">
          <p className="mb-1">Work on this branch yourself, against a live copy of the app:</p>
          <ol className="list-decimal list-inside space-y-0.5 text-xs">
            <li><span className="text-gray-300">Start</span> runs the branch in a dev pod, as the repo's <code className="text-gray-400">.daboss/dev.yaml</code> declares (~1–2 min).</li>
            <li>You port-forward to it and open the app in your browser.</li>
            <li>Your local Claude (or you) edits the code and copies it into the pod.</li>
            <li><span className="text-gray-300">Hand back</span> sends the change through checks + review.</li>
          </ol>
        </div>
      )}

      {env?.detail && <p className={`text-xs mb-3 whitespace-pre-wrap break-words ${env.status === "failed" ? "text-red-300" : "text-gray-400"}`}>{env.detail}</p>}

      {env && view && env.status !== "stopping" && (
        <div className="mt-3">
          <Step n={1} title="Port-forward to the pod — keep this running in a terminal">
            <CopyLine label="" text={view.commands.port_forward} hint={view.commands.context_hint} />
          </Step>
          <Step n={2} title={<>Open <a href={view.commands.url} target="_blank" rel="noreferrer" className="text-violet-300 hover:underline">{view.commands.url}</a> — the app on this branch, logged in as you</>}>
            {env.status !== "ready" && <p className="text-xs text-gray-500">Available once the environment is ready.</p>}
          </Step>
          <Step n={3} title="Work on it with your local Claude">
            <p className="text-xs text-gray-500 mb-2">
              In your local checkout of the repo, start Claude Code and paste this prompt. It checks out the branch,
              makes your changes and copies them into the pod — refresh the browser to see them.
            </p>
            <div className="flex items-center gap-3 mb-2">
              <CopyButton text={view.local_claude_prompt} label="Copy prompt" />
              <button onClick={() => setShowPrompt((v) => !v)} className="text-xs text-violet-300 hover:underline">
                {showPrompt ? "Hide" : "Show"} it
              </button>
            </div>
            {showPrompt && (
              <pre className="bg-gray-950 border border-gray-800 rounded p-2 text-xs text-gray-300 whitespace-pre-wrap break-words mb-2">{view.local_claude_prompt}</pre>
            )}
            <details className="text-xs text-gray-500">
              <summary className="cursor-pointer hover:text-gray-300">Copying files in yourself instead</summary>
              <div className="mt-2">
                <CopyLine label="From the repo root — copies your working tree (uncommitted) into the pod" text={view.commands.copy_tree} />
                <CopyLine label="Check out the branch locally" text={view.commands.checkout} />
              </div>
            </details>
          </Step>
          <Step n={4} title="Pushed commits? Sync them into the pod">
            <div className="flex flex-wrap items-center gap-2">
              <button disabled={!!busy || env.status !== "ready"} title="Pull the branch's pushed commits into the pod and run the repo's sync steps"
                onClick={() => act("sync", () => api.syncDevEnv(agentId), "Synced the pushed commits")}
                className={`${btn} bg-gray-800 hover:bg-gray-700 text-gray-200`}>
                <RefreshCw size={14} className={busy === "sync" ? "animate-spin" : ""} /> Sync
              </button>
              <span className="text-xs text-gray-500">Not needed for files you copied in — those are live already. Also resets the expiry.</span>
            </div>
          </Step>
          <Step n={5} title="Done? Push everything, then hand it back">
            <div className="flex flex-wrap items-center gap-2">
              <button disabled={!!busy} title="Opens/updates the PR, runs the checks and queues the review"
                onClick={() => act("handback", async () => {
                  const r = await api.handback(agentId);
                  success(`Handed back — PR #${r.pr?.number}${r.runs.length ? `, ${r.runs.length} check(s)` : ""}${r.review_agent_id ? ", review queued" : ""}`);
                  if (r.notes.length) error(r.notes.join(" "));
                })}
                className={`${btn} bg-blue-700 hover:bg-blue-600 text-white`}>
                <Undo2 size={14} /> Hand back
              </button>
              <span className="text-xs text-gray-500">Opens/updates the PR, runs the checks and queues the review — the verdict lands on this page.</span>
            </div>
          </Step>
          <Step n={6} title={<>Finished with the pod? <span className="text-gray-400">Stop</span> it (top right)</>}>
            <p className="text-xs text-gray-500">It also stops on its own in {expiresIn(env.expires_at)} — Sync or Extend pushes that out.</p>
          </Step>

          <details className="mt-2 border-t border-gray-800 pt-3 text-xs text-gray-500">
            <summary className="cursor-pointer hover:text-gray-300">Optional: let your local Claude Sync and Hand back by itself</summary>
            <div className="mt-2">
              <p className="mb-2">
                Connect da_boss's MCP server to Claude Code once. Without it, Claude asks you to click Sync / Hand back instead.
              </p>
              <p className="mb-2">
                1. Create a token in <Link to="/settings" className="text-violet-300 hover:underline">Settings → API tokens</Link> (the default scopes are right).
              </p>
              <CopyLine label="2. In your local checkout, run (paste your token)" text={`claude mcp add --transport http daboss ${mcpUrl()} --header "Authorization: Bearer <your dbt_ token>"`} />
            </div>
          </details>
        </div>
      )}

      {log !== null && (
        <div className="mt-2">
          <div className="flex justify-between text-xs text-gray-500 mb-1"><span>App log (last 200 lines)</span>
            <button onClick={() => setLog(null)} className="hover:text-gray-300">hide</button></div>
          <pre className="bg-gray-950 border border-gray-800 rounded p-2 text-xs text-gray-300 max-h-72 overflow-auto whitespace-pre-wrap break-words">{log || "(empty)"}</pre>
        </div>
      )}
    </div>
  );
}
