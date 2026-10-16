import { useState, useEffect, useCallback } from "react";
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
      <div className="text-xs text-gray-500 mb-1">{label}{hint && <span className="text-gray-600"> — {hint}</span>}</div>
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
              <button disabled={!!busy} title="Pull the branch's pushed commits into the pod and run the repo's sync steps"
                onClick={() => act("sync", () => api.syncDevEnv(agentId), "Synced the pushed commits")}
                className={`${btn} bg-gray-800 hover:bg-gray-700 text-gray-200`}>
                <RefreshCw size={14} className={busy === "sync" ? "animate-spin" : ""} /> Sync
              </button>
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
          {env && (
            <button disabled={!!busy} title="Push your work first — opens/updates the PR, runs the checks and queues the review"
              onClick={() => act("handback", async () => {
                const r = await api.handback(agentId);
                success(`Handed back — PR #${r.pr?.number}${r.runs.length ? `, ${r.runs.length} check(s)` : ""}${r.review_agent_id ? ", review queued" : ""}`);
                if (r.notes.length) error(r.notes.join(" "));
              })}
              className={`${btn} bg-blue-700 hover:bg-blue-600 text-white`}>
              <Undo2 size={14} /> Hand back
            </button>
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
        <p className="text-sm text-gray-500">
          Run this branch in a dev pod (as the repo's <code className="text-gray-400">.daboss/dev.yaml</code> declares),
          port-forward to it, and work on it locally with your own Claude — then hand it back for checks and review.
        </p>
      )}

      {env?.detail && <p className={`text-xs mb-3 whitespace-pre-wrap break-words ${env.status === "failed" ? "text-red-300" : "text-gray-400"}`}>{env.detail}</p>}

      {env && view && env.status !== "stopping" && (
        <>
          <CopyLine label="1. Port-forward (keep it running)" text={view.commands.port_forward} hint={view.commands.context_hint} />
          <div className="text-xs text-gray-500 mb-3">
            2. Open <a href={view.commands.url} target="_blank" rel="noreferrer" className="text-violet-300 hover:underline">{view.commands.url}</a>
          </div>
          <CopyLine label="Copy your working tree in (from the repo root, uncommitted)" text={view.commands.copy_tree} />
          <button onClick={() => setShowPrompt((s) => !s)} className="text-xs text-violet-300 hover:underline mb-2">
            {showPrompt ? "Hide" : "Show"} the prompt for your local Claude
          </button>
          {showPrompt && <CopyLine label="Paste into Claude Code (it needs da_boss's MCP server connected)" text={view.local_claude_prompt} />}
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
