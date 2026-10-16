import { useState, useEffect, useCallback, type ReactNode } from "react";
import { Link } from "react-router";
import { Laptop, Play, Square, RefreshCw, Clock, Copy, Check, Loader, ScrollText, Undo2, AlertTriangle } from "lucide-react";
import { api, type DevEnvView, type DevEnvPreview } from "../api";
import { useToastHelpers } from "./Toast";

/**
 * A change's dev environment: a pod (declared by the repo's .daboss/dev.yaml)
 * running the branch, so a human + their local Claude can iterate against it
 * through a port-forward, then hand the change back for checks + review.
 *
 * Every step shows the REAL command — before Start too (the server previews the
 * pod name/namespace/port from dev.yaml), so people can set up while it boots.
 * Renders nothing when the feature isn't enabled on this da_boss.
 */

function CopyLine({ text, label }: { text: string; label?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  };
  return (
    <div className="mb-2 min-w-0">
      {label && <div className="text-xs text-gray-500 mb-1">{label}</div>}
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

function Step({ n, title, children, dim }: { n: ReactNode; title: ReactNode; children?: ReactNode; dim?: boolean }) {
  return (
    <div className={`flex gap-3 mb-3 min-w-0 ${dim ? "opacity-60" : ""}`}>
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
  const [kubeSetup, setKubeSetup] = useState<string | null>(null);
  const [view, setView] = useState<DevEnvView | null>(null);
  const [preview, setPreview] = useState<DevEnvPreview | null>(null);
  const [busy, setBusy] = useState<string>("");
  const [log, setLog] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const { success, error } = useToastHelpers();

  const load = useCallback(() => {
    api.getDevEnv(agentId).then((r) => {
      setEnabled(r.enabled); setKubeSetup(r.kube_setup); setView(r.view); setPreview(r.preview);
    }).catch(() => {});
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
  // The commands to show: the live env's, else the preview's (same shape).
  const live = !!env && env.status !== "stopping";
  const cmds = live ? view!.commands : preview?.available ? preview.commands : null;
  const prompt = live ? view!.local_claude_prompt : preview?.available ? preview.local_claude_prompt : "";
  const ready = env?.status === "ready";
  const unavailable = !env && preview && !preview.available ? preview.reason : null;
  let n = 0;
  const next = () => ++n;

  return (
    <div className="bg-gray-900 border border-violet-900/50 rounded-lg p-4 mb-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 className="flex items-center gap-2 text-sm font-medium text-gray-200">
          <Laptop size={16} className="text-violet-400" /> Dev environment — work on this branch locally
          {st && (
            <span className={`flex items-center gap-1 text-xs ${st.color}`}>
              {st.spin && <Loader size={12} className="animate-spin" />}{st.label}
            </span>
          )}
          {live && <span className="flex items-center gap-1 text-xs text-gray-500"><Clock size={12} /> stops in {expiresIn(env!.expires_at)}</span>}
        </h3>
        {live && (
          <div className="flex flex-wrap gap-2">
            {ready && (
              <>
                <button disabled={!!busy} onClick={() => act("logs", async () => setLog((await api.devEnvLogs(agentId)).log))}
                  className={`${btn} bg-gray-800 hover:bg-gray-700 text-gray-200`}>
                  <ScrollText size={14} /> App log
                </button>
                <button disabled={!!busy} title={`Keep it ${env!.ttl_hours}h from now`}
                  onClick={() => act("extend", () => api.extendDevEnv(agentId), "Extended")}
                  className={`${btn} bg-gray-800 hover:bg-gray-700 text-gray-200`}>
                  <Clock size={14} /> Extend
                </button>
              </>
            )}
            <button disabled={!!busy} onClick={() => act("stop", () => api.stopDevEnv(agentId), "Dev environment stopped")}
              className={`${btn} bg-gray-800 hover:bg-red-900 text-gray-200`}>
              <Square size={14} /> Stop
            </button>
          </div>
        )}
      </div>

      {unavailable && (
        <div className="flex gap-2 text-sm text-amber-300 bg-amber-950/30 border border-amber-900/50 rounded p-3 mb-3">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <span className="whitespace-pre-wrap break-words">{unavailable}</span>
        </div>
      )}

      {kubeSetup && (
        <Step n="0" title="Once per laptop: get kubectl access to the cluster">
          <CopyLine text={kubeSetup} />
        </Step>
      )}

      <Step n={next()} title={env ? "Dev pod" : "Start the dev pod (~1–2 min) — you can do the next steps while it boots"}>
        {!env || env.status === "failed" ? (
          <button disabled={!!busy || !!unavailable} onClick={() => act("start", () => api.startDevEnv(agentId), "Dev environment starting")}
            className={`${btn} bg-violet-700 hover:bg-violet-600 text-white`}>
            {busy === "start" ? <Loader size={14} className="animate-spin" /> : <Play size={14} />} {env ? "Restart" : "Start"}
          </button>
        ) : null}
        {env?.detail && (
          <p className={`text-xs mt-1 whitespace-pre-wrap break-words ${env.status === "failed" ? "text-red-300" : "text-gray-400"}`}>{env.detail}</p>
        )}
      </Step>

      {cmds && (
        <>
          <Step n={next()} title="In a terminal, port-forward to it — leave this running">
            <CopyLine text={cmds.port_forward} />
            {cmds.context_hint && <p className="text-xs text-gray-500">{cmds.context_hint}</p>}
          </Step>

          <Step n={next()} title={<>Open <a href={cmds.url} target="_blank" rel="noreferrer" className="text-violet-300 hover:underline">{cmds.url}</a> — the app on this branch, logged in as you</>}>
            {!ready && <p className="text-xs text-gray-500">Works once the pod shows Ready.</p>}
          </Step>

          <Step n={next()} title="In your local checkout of the repo, get on this branch">
            <CopyLine text={cmds.checkout} />
          </Step>

          <Step n={next()} title="Start Claude Code there and paste this prompt — it makes the changes and copies them into the pod">
            <div className="flex items-center gap-3 mb-2">
              <CopyButton text={prompt} label="Copy prompt" />
              <button onClick={() => setShowPrompt((v) => !v)} className="text-xs text-violet-300 hover:underline">
                {showPrompt ? "Hide" : "Show"} it
              </button>
            </div>
            {showPrompt && (
              <pre className="bg-gray-950 border border-gray-800 rounded p-2 text-xs text-gray-300 whitespace-pre-wrap break-words mb-2">{prompt}</pre>
            )}
            <CopyLine label="Editing by hand instead? From the repo root, this copies your working tree (uncommitted) into the pod — then refresh the browser:"
              text={cmds.copy_tree} />
            <CopyLine label="Tail the app's log:" text={cmds.logs} />
          </Step>

          <Step n={next()} title="Pushed commits? Sync them into the pod" dim={!ready}>
            <div className="flex flex-wrap items-center gap-2">
              <button disabled={!!busy || !ready} title="Pull the branch's pushed commits into the pod and run the repo's sync steps"
                onClick={() => act("sync", () => api.syncDevEnv(agentId), "Synced the pushed commits")}
                className={`${btn} bg-gray-800 hover:bg-gray-700 text-gray-200`}>
                <RefreshCw size={14} className={busy === "sync" ? "animate-spin" : ""} /> Sync
              </button>
              <span className="text-xs text-gray-500">Not needed for files you copied in — those are live already. Also resets the stop timer.</span>
            </div>
          </Step>

          <Step n={next()} title="Done? Push everything, then hand it back" dim={!env}>
            <div className="flex flex-wrap items-center gap-2">
              <button disabled={!!busy || !env} title="Opens/updates the PR, runs the checks and queues the review"
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

          <Step n={next()} title={<>Finished? <span className="text-gray-400">Stop</span> the pod (top right)</>} dim={!env}>
            <p className="text-xs text-gray-500">It also stops on its own{env ? ` in ${expiresIn(env.expires_at)}` : " after a few hours"} — Sync or Extend pushes that out.</p>
          </Step>

          <div className="mt-3 border-t border-gray-800 pt-3">
            <div className="text-xs text-gray-400 mb-1">Optional, once: let your local Claude Sync and Hand back by itself (otherwise it asks you to click the buttons)</div>
            <p className="text-xs text-gray-500 mb-2">
              Create a token in <Link to="/settings" className="text-violet-300 hover:underline">Settings → API tokens</Link> (default scopes), then in your local checkout run:
            </p>
            <CopyLine text={`claude mcp add --transport http daboss ${mcpUrl()} --header "Authorization: Bearer <your dbt_ token>"`} />
          </div>
        </>
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
