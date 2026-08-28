import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, Link, useNavigate } from "react-router";
import { api, type PermissionReq, type SubagentInfo } from "../api";
import { Save, ChevronDown, ChevronRight, Cpu } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useWebSocket, type ServerEvent } from "../ws";
import { MessageStream, type Message } from "../components/MessageStream";
import { ControlBar } from "../components/ControlBar";
import { deriveStatus } from "../agentStatus";
import { AgentActivity } from "../components/AgentActivity";
import { AgentPlans } from "../components/AgentPlans";
import { AgentFiles } from "../components/AgentFiles";
import { PermissionDialog } from "../components/PermissionDialog";
import { useToastHelpers } from "../components/Toast";
import { ArrowLeft } from "lucide-react";
import { FileBrowser } from "../components/FileBrowser";

interface AgentData {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  state: string;
  priority: string;
  model: string;
  max_turns: number | null;
  max_budget_usd: number | null;
  error_message: string | null;
  supervisor_instructions?: string;
  pr_url?: string | null;
  pr_number?: number | null;
  repo_url?: string | null;
  repo_ref?: string | null;
  review?: string | null;
  recommendation?: string | null;
  total_cost_usd?: number;
  testing?: boolean;
  landing?: boolean;
  staging_validated?: boolean;
  deploy_pending?: boolean;
  deploy_status?: string | null;
  deploy_agent_state?: string | null;
  review_agent_id?: string | null;
  review_of_agent_id?: string | null;
  deployed_by_agent_id?: string | null;
  adopted_ref?: string | null;
  branch?: string | null;
  size?: string | null;
  is_deploy_agent?: boolean;
  shipped?: Array<{ id: string; pr_number: number | null; name: string }>;
  tokens?: { total_cost_usd: number };
}

export function AgentDetail() {
  const params = useParams();
  const navigate = useNavigate();
  const toast = useToastHelpers();
  const id = params.id;
  const [agent, setAgent] = useState<AgentData | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [permissions, setPermissions] = useState<PermissionReq[]>([]);
  const [streamBuffer, setStreamBuffer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  const [instructionsDirty, setInstructionsDirty] = useState(false);
  const [savingInstructions, setSavingInstructions] = useState(false);
  const [subagents, setSubagents] = useState<SubagentInfo[]>([]);
  const [queuedCount, setQueuedCount] = useState(0);
  const [actionBusy, setActionBusy] = useState(false);
  const subscribedRef = useRef(false);

  const refresh = useCallback(() => {
    if (!id) return;
    api.getSubagents(id).then(setSubagents).catch(() => {});
    api.getQueue().then((q) => setQueuedCount(q[id!] || 0)).catch(() => {});
    api
      .getAgent(id)
      .then((a) => {
        const data = a as AgentData;
        setAgent(data);
        if (!instructionsDirty) {
          setInstructions(data.supervisor_instructions || "");
        }
      })
      .catch((err) => setError(err.message));
    api
      .getPendingPermissions()
      .then((all) => setPermissions(all.filter((p) => p.agent_id === id)))
      .catch(() => {});
  }, [id]);

  // Load events on mount
  useEffect(() => {
    if (!id) return;
    refresh();
    api
      .getEvents(id, 200)
      .then((events) => {
        const msgs: Message[] = events
          .filter((e) => e.type === "message")
          .reverse()
          .map((e) => {
            const data = JSON.parse(e.data);
            return {
              role: data.role || "system",
              content: data.content || "",
              timestamp: e.created_at,
            };
          });
        setMessages(msgs);
      })
      .catch(() => {});
  }, [id, refresh]);

  const handleEvent = useCallback(
    (event: ServerEvent) => {
      if (!id) return;

      if (event.type === "agent:message" && event.agentId === id) {
        setMessages((prev) => {
          // Deduplicate: skip if last message has same role and content
          const last = prev[prev.length - 1];
          if (last && last.role === event.role && last.content === event.content) {
            return prev;
          }
          return [
            ...prev,
            {
              role: event.role,
              content: event.content,
              timestamp: event.timestamp,
            },
          ];
        });
        setStreamBuffer("");
        // System messages can change the agent record (PR opened, review landed,
        // gated) — refetch it so the verdict card / PR link reflect the change.
        if (event.role === "system") refresh();
      }

      if (event.type === "agent:stream" && event.agentId === id) {
        setStreamBuffer((prev) => prev + event.delta);
      }

      if (event.type === "agent:state_changed" && event.agentId === id) {
        refresh();
      }

      if (event.type === "agent:token_usage" && event.agentId === id) {
        refresh();
      }

      if (
        event.type === "permission:requested" ||
        event.type === "permission:resolved"
      ) {
        api
          .getPendingPermissions()
          .then((all) => setPermissions(all.filter((p) => p.agent_id === id)))
          .catch(() => {});
      }

      if (
        (event.type === "agent:subagent_start" || event.type === "agent:subagent_stop") &&
        event.agentId === id
      ) {
        api.getSubagents(id).then(setSubagents).catch(() => {});
      }

      if (event.type === "agent:error" && event.agentId === id) {
        setMessages((prev) => [
          ...prev,
          {
            role: "system",
            content: `Error: ${event.error}`,
            timestamp: new Date().toISOString(),
          },
        ]);
      }
    },
    [id, refresh]
  );

  const { subscribe, unsubscribe } = useWebSocket(handleEvent);

  // Subscribe to streaming for this agent
  useEffect(() => {
    if (!id || subscribedRef.current) return;
    subscribe(id);
    subscribedRef.current = true;
    return () => {
      unsubscribe(id);
      subscribedRef.current = false;
    };
  }, [id, subscribe, unsubscribe]);

  if (error) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-400 mb-4">{error}</p>
          <Link to="/" className="text-blue-400 hover:text-blue-300">
            Back to dashboard
          </Link>
        </div>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center text-gray-400">
        Loading...
      </div>
    );
  }

  const cost = agent.total_cost_usd ?? agent.tokens?.total_cost_usd ?? 0;

  return (
    <div className="min-h-screen bg-gray-950 p-4 md:p-8 max-w-4xl mx-auto">
      {/* Header */}
      <Link
        to="/"
        className="flex items-center gap-1 text-gray-500 hover:text-gray-300 text-sm mb-4"
      >
        <ArrowLeft size={14} />
        Back
      </Link>

      <div className="flex items-start justify-between mb-4 gap-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg md:text-xl font-bold text-gray-100 truncate">{agent.name}</h1>
          <p className="text-xs text-gray-500 truncate">{agent.cwd}</p>
          {agent.pr_url && (
            <a
              href={agent.pr_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 mt-1 text-xs text-blue-400 hover:text-blue-300"
            >
              🔀 PR #{agent.pr_number}
            </a>
          )}
        </div>
        <div className="text-right text-sm shrink-0 flex flex-col items-end gap-1">
          <div className={deriveStatus(agent).color}>{deriveStatus(agent).label}</div>
          <div className="text-gray-500 font-mono">${cost.toFixed(4)}</div>
          {agent.is_deploy_agent && (
            <div className="mt-1 text-xs text-gray-500 italic">Deploy agent — give it feedback below; it isn't a deployable change.</div>
          )}
          {!agent.is_deploy_agent && (
            <button
              onClick={() => {
                api.testAgent(agent.id)
                  .then((r) => toast.success(`Running ${r.phase} phase — will gate the PR`))
                  .catch((e) => toast.error(e instanceof Error ? e.message : "Test failed to start"));
              }}
              className="mt-1 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 rounded px-2 py-1"
              title="Run the repo's test phase for this branch; result gates the PR"
            >
              🧪 Run tests
            </button>
          )}
          {agent.repo_url && agent.branch && !agent.review_of_agent_id && !agent.is_deploy_agent && (
            <button
              onClick={() => {
                api.queueReview(agent.id)
                  .then((r) => { toast.success("Review queued — reading the code in depth"); navigate(`/agent/${r.reviewAgentId}`); })
                  .catch((e) => toast.error(e instanceof Error ? e.message : "Couldn't queue review"));
              }}
              className="mt-1 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 rounded px-2 py-1"
              title="Queue the standard review agent for this branch — correctness + security/operational risk, ends with a recommendation"
            >
              🔍 Queue review
            </button>
          )}
          {agent.state !== "running" && agent.state !== "queued" && (
            <div className="mt-1 flex items-center gap-1 text-xs text-gray-400" title="Pod size for the next resume/dispatch. Bump it if a task OOM-killed its pod (e.g. a big compile).">
              <span>Pod size:</span>
              <select
                value={agent.size || ""}
                onChange={(e) => {
                  const size = e.target.value as "s" | "m" | "l" | "xl";
                  if (!size) return;
                  api.resizeAgent(agent.id, size)
                    .then(() => { toast.success(`Resized to ${size.toUpperCase()} — applies on next resume`); refresh(); })
                    .catch((err) => toast.error(err instanceof Error ? err.message : "Resize failed"));
                }}
                className="bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-gray-200"
              >
                <option value="">{agent.size ? agent.size.toUpperCase() : "auto"}</option>
                {["s", "m", "l", "xl"].map((s) => <option key={s} value={s}>{s.toUpperCase()}</option>)}
              </select>
            </div>
          )}
          {agent.state !== "running" && agent.state !== "queued" && (
            <button
              onClick={async () => {
                // Continue a colleague's agent on YOUR credential (e.g. they hit
                // their Claude limit). Admin-only server-side; keeps the agent's
                // identity, resets session context on next dispatch.
                try {
                  const users = (await api.listUsers()).filter((u) => !!u.email);
                  const email = prompt(
                    `Transfer this agent to which user? (their credential + workspace take over; session context resets, branch work is intact)\n\nUsers: ${users.map((u) => u.email).join(", ")}`
                  )?.trim();
                  if (!email) return;
                  const target = users.find((u) => u.email!.toLowerCase() === email.toLowerCase());
                  if (!target) { toast.error("No user with that email"); return; }
                  const r = await api.transferAgent(agent.id, target.id);
                  toast.success(`Transferred to ${r.owner} — Resume to continue on their credential`);
                  refresh();
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Transfer failed");
                }
              }}
              className="mt-1 text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 rounded px-2 py-1"
              title="Transfer ownership — future turns run on the new owner's Claude credential and workspace (admin only)."
            >
              👥 Transfer owner
            </button>
          )}
          {agent.repo_url && agent.branch && !agent.review_of_agent_id && !agent.is_deploy_agent && (
            <button
              onClick={() => {
                if (!confirm(`Merge the latest \`${agent.repo_ref || "main"}\` into branch \`${agent.branch}\`?\n\nUse this when the branch was cut from an older ${agent.repo_ref || "main"} and they've diverged. A clean merge happens server-side (then resume the agent). If it conflicts, the agent merges and resolves the conflicts itself, then da_boss pushes.`)) return;
                api.syncMain(agent.id)
                  .then((r) => toast.success(r.clean ? `Merged ${agent.repo_ref || "main"} in cleanly — resume the agent to pick it up` : `Agent is merging ${agent.repo_ref || "main"} and resolving conflicts…`))
                  .catch((e) => toast.error(e instanceof Error ? e.message : "Sync failed"));
              }}
              className="mt-1 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 rounded px-2 py-1"
              title={`Merge the latest ${agent.repo_ref || "main"} into this feature branch (for a branch cut from an older ${agent.repo_ref || "main"} that has diverged)`}
            >
              ⬇️ Merge {agent.repo_ref || "main"} in
            </button>
          )}
          {agent.repo_url && agent.branch && !agent.review_of_agent_id && !agent.is_deploy_agent && (
            <button
              onClick={() => {
                if (!confirm(`Deploy branch \`${agent.branch}\` to STAGING now?\n\nThis bypasses the main-only gate and ships the branch to shared staging (replacing what's there until main is redeployed) so you can see the build before merging.`)) return;
                api.deployBranch(agent.id)
                  .then((r) => { toast.success("Deploying branch to staging…"); if (r.agentId) navigate(`/agent/${r.agentId}`); })
                  .catch((e) => toast.error(e instanceof Error ? e.message : "Branch deploy failed"));
              }}
              className="mt-1 text-xs bg-emerald-900 hover:bg-emerald-800 text-emerald-200 rounded px-2 py-1"
              title="Deploy THIS branch to staging (bypasses main) so you can see the build before the PR merges"
            >
              🌿 Deploy branch → staging
            </button>
          )}
        </div>
      </div>

      {/* Link to the review agent's live trace (watch it review, or read the full reasoning) */}
      {agent.review_agent_id && (
        <Link
          to={`/agent/${agent.review_agent_id}`}
          className="flex items-center gap-2 bg-blue-900/30 border border-blue-700/50 hover:border-blue-500 text-blue-300 rounded-lg px-4 py-2.5 mb-4 text-sm"
        >
          🔍 <span className="font-medium">Review agent</span>
          <span className="text-blue-400/80">— {agent.recommendation ? "read the full in-depth review" : "watch it review the code live"} →</span>
        </Link>
      )}
      {/* If THIS is a review agent: loud guard — feedback sent HERE goes to the
          REVIEWER, not the working agent. A mis-routed request-changes once made
          a reviewer implement the fixes itself and then self-review them. */}
      {agent.review_of_agent_id && (
        <div className="bg-amber-900/25 border border-amber-600/50 rounded-lg px-4 py-3 mb-4 text-sm">
          <div className="flex items-center gap-2 text-amber-300 font-medium">
            🔍 This is a REVIEW agent — it audits, it doesn't implement.
          </div>
          <div className="text-amber-200/80 mt-1">
            Messages typed here go to the <em>reviewer</em> and won't reach the working
            agent or count as a verdict. Change feedback belongs on{" "}
            <Link to={`/agent/${agent.review_of_agent_id}`} className="underline font-medium text-amber-300">
              the reviewed agent's page →
            </Link>
          </div>
        </div>
      )}
      {/* Adopting an existing PR/branch — pushes onto it instead of creating one */}
      {agent.adopted_ref && (
        <div className="flex items-center gap-2 bg-amber-900/20 border border-amber-700/40 text-amber-300 rounded-lg px-4 py-2.5 mb-4 text-sm">
          📎 <span className="font-medium">Adopting {agent.adopted_ref}</span>
          {agent.branch && agent.branch !== agent.adopted_ref && (
            <span className="text-amber-400/80">— branch <code>{agent.branch}</code></span>
          )}
          <span className="text-amber-400/70">· pushes onto this existing branch</span>
        </div>
      )}
      {/* This change shipped in a deploy → link to it (one trace: work→review→deploy) */}
      {agent.deployed_by_agent_id && (
        <Link
          to={`/agent/${agent.deployed_by_agent_id}`}
          className="flex items-center gap-2 bg-emerald-900/30 border border-emerald-700/50 hover:border-emerald-500 text-emerald-300 rounded-lg px-4 py-2.5 mb-4 text-sm"
        >
          🚀 <span className="font-medium">Shipped in a deploy</span> — view it →
        </Link>
      )}
      {/* If THIS is a deploy agent, show what it shipped */}
      {agent.shipped && agent.shipped.length > 0 && (
        <div className="bg-emerald-900/20 border border-emerald-700/40 rounded-lg px-4 py-3 mb-4 text-sm">
          <div className="text-emerald-300 font-medium mb-1">📦 This deploy shipped {agent.shipped.length} change{agent.shipped.length === 1 ? "" : "s"}:</div>
          <div className="flex flex-wrap gap-2">
            {agent.shipped.map((s) => (
              <Link key={s.id} to={`/agent/${s.id}`} className="text-emerald-400 hover:text-emerald-200 underline">
                {s.pr_number ? `PR #${s.pr_number}` : s.name}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Plans (ExitPlanMode plan docs) + user file uploads to the agent. */}
      <AgentPlans agentId={agent.id} />
      <AgentFiles agentId={agent.id} />

      {/* Activity trace — every pipeline run + child agent associated with this agent
          (tests/land/deploy run as pods with no page of their own; surfaced here). */}
      <AgentActivity agentId={agent.id} />

      {/* Verdict card — the report-back: reviewer recommendation + next steps */}
      {agent.recommendation && (
        <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 mb-4">
          <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
            <div className="text-sm">
              <span className="text-gray-400">Reviewer recommendation:</span>{" "}
              <span className={`font-bold uppercase ${
                agent.recommendation === "merge" ? "text-green-400"
                : agent.recommendation === "fix" ? "text-amber-400" : "text-red-400"
              }`}>{agent.recommendation}</span>
            </div>
            {agent.state !== "verified" ? (
              <div className="flex gap-2">
                <button
                  disabled={actionBusy || agent.landing}
                  title={agent.landing ? "A land is already in progress — rebasing on main + retesting before merge." : undefined}
                  onClick={() => {
                    // HOLD-merge guard: the reviewer flagged this — make the human pause.
                    // Unless the branch was deployed to staging AFTER the review and
                    // passed: watching it work IS the "human should look" the hold asked
                    // for, so that merges cleanly with no override recorded.
                    const flagged = agent.recommendation === "hold" || agent.recommendation === "fix";
                    if (flagged && agent.staging_validated) {
                      if (!confirm(
                        `The review is ${agent.recommendation?.toUpperCase()}, but this branch was deployed to staging after the review and passed — you've validated it empirically.\n\nMerge?`
                      )) return;
                    } else if (flagged && !confirm(
                      `⚠️ The review is ${agent.recommendation?.toUpperCase()} — the reviewer flagged this change (see the verdict below).\n\nTip: "Deploy branch → staging" and verify it — a passed branch deploy unlocks a clean merge.\n\nMerge anyway? This will be recorded against you.`
                    )) return;
                    setActionBusy(true);
                    api.mergeAgent(agent.id, flagged && !agent.staging_validated)
                      .then((r) => { toast.success(r?.landing ? "Landing — rebasing on main + retesting before merge…" : "Merged"); refresh(); })
                      .catch((e) => toast.error(e instanceof Error ? e.message : "Merge failed"))
                      .finally(() => setActionBusy(false));
                  }}
                  className={`text-sm disabled:opacity-40 text-white rounded px-3 py-1.5 ${
                    (agent.recommendation === "hold" || agent.recommendation === "fix") && !agent.staging_validated
                      ? "bg-amber-700 hover:bg-amber-600" : "bg-green-700 hover:bg-green-600"
                  }`}
                >{(actionBusy || agent.landing) ? "Landing…" : (agent.recommendation === "hold" || agent.recommendation === "fix") ? (agent.staging_validated ? "Merge (staging-validated)" : "Merge anyway") : "Merge PR"}</button>
                <button
                  disabled={actionBusy}
                  onClick={() => {
                    const fb = prompt("What changes should the agent make?");
                    if (fb) api.requestChanges(agent.id, fb).then(() => { toast.success("Sent back to the agent"); refresh(); }).catch((e) => toast.error(e instanceof Error ? e.message : "Failed"));
                  }}
                  className="text-sm bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-gray-200 rounded px-3 py-1.5"
                >Request changes</button>
              </div>
            ) : agent.repo_url && (() => {
              // A deploy in flight → label the button by what stage it's actually at,
              // so it doesn't read "Deploy in progress" while it's really testing main.
              const deployLabel: Record<string, string> = {
                pending_review: "Deploy gate: testing main…",
                pending_approval: "Deploy: approve in Reviews →",
                pending: "Deploying…",
                running: "Deploying…",
              };
              const inFlight = agent.deploy_status ? deployLabel[agent.deploy_status] ?? "Deploy in progress…" : null;
              return (
              <button
                disabled={actionBusy || !!agent.deploy_pending}
                title={inFlight
                  ? "A deploy is already in flight for this ref — see its stage on the label / in Reviews."
                  : `Deploy ${agent.repo_ref || "main"} — proposes a gated deploy you approve in Reviews`}
                onClick={() => {
                  if (!confirm(`Deploy \`${agent.repo_ref || "main"}\`?\n\nThis proposes the repo's deploy phase. It's gated — you'll still approve it in Reviews before anything ships.`)) return;
                  setActionBusy(true);
                  api.runPipeline(agent.repo_url!, "deploy", agent.repo_ref || "main")
                    .then(() => { toast.success("Deploy proposed — approve it in Reviews"); refresh(); })
                    .catch((e) => toast.error(e instanceof Error ? e.message : "Deploy failed"))
                    .finally(() => setActionBusy(false));
                }}
                className="text-sm bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white rounded px-3 py-1.5"
              >{inFlight ?? (actionBusy ? "Proposing…" : `Deploy ${agent.repo_ref || "main"}`)}</button>
              );
            })()
            }
          </div>
          {agent.review && (
            <pre className="text-xs text-gray-400 whitespace-pre-wrap font-sans max-h-56 overflow-y-auto">{agent.review}</pre>
          )}
        </div>
      )}

      {/* Info */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 mb-4 text-sm text-gray-400 overflow-hidden">
        <div className="mb-1 min-w-0">
          <span className="text-gray-500">Prompt:</span>
          <pre className="whitespace-pre-wrap break-words mt-0.5 font-sans overflow-x-hidden text-xs md:text-sm">{agent.prompt}</pre>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
          <span>Priority: {agent.priority}</span>
          <span>Model: {agent.model}</span>
          {agent.max_turns && <span>Max turns: {agent.max_turns}</span>}
          {agent.max_budget_usd && (
            <span>Budget: ${agent.max_budget_usd}</span>
          )}
        </div>
      </div>

      {/* Supervisor Instructions */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 mb-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-gray-300">Supervisor Instructions</h3>
          {instructionsDirty && (
            <button
              onClick={async () => {
                setSavingInstructions(true);
                try {
                  await fetch(`/api/agents/${agent.id}/instructions`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ supervisor_instructions: instructions }),
                  });
                  setInstructionsDirty(false);
                } catch {} finally {
                  setSavingInstructions(false);
                }
              }}
              className="flex items-center gap-1 px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded"
            >
              <Save size={12} />
              {savingInstructions ? "Saving..." : "Save"}
            </button>
          )}
        </div>
        <textarea
          value={instructions}
          onChange={(e) => {
            setInstructions(e.target.value);
            setInstructionsDirty(true);
          }}
          placeholder="Tell the supervisor what this agent should do, what to do when it finishes, and when to escalate to you..."
          rows={3}
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-200 text-sm placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-y"
        />
        <p className="text-xs text-gray-600 mt-1">
          The supervisor checks every 5 min. When this agent completes or needs input, it uses these instructions to decide the next step.
        </p>
      </div>

      {/* Permissions */}
      {permissions.length > 0 && (
        <div className="mb-4">
          <PermissionDialog
            permissions={permissions}
            onResolved={refresh}
            agentNames={agent ? { [agent.id]: agent.name } : undefined}
          />
        </div>
      )}

      {/* Controls */}
      <div className="mb-4">
        <ControlBar agentId={agent.id} state={agent.state} testing={agent.testing} onAction={refresh} onDelete={() => navigate("/")} />
        {queuedCount > 0 && (
          <div className="mt-2 px-3 py-1.5 bg-amber-950/30 border border-amber-800/50 rounded text-xs text-amber-300">
            {queuedCount} message{queuedCount !== 1 ? "s" : ""} queued — waiting for agent to be ready
          </div>
        )}
      </div>

      {/* Subagents */}
      {subagents.length > 0 && (
        <div className="mb-4 space-y-2">
          <h3 className="flex items-center gap-2 text-sm font-medium text-gray-300">
            <Cpu size={14} />
            Subagents ({subagents.length})
          </h3>
          {subagents.map((sub) => (
            <SubagentPanel key={sub.agentId} subagent={sub} />
          ))}
        </div>
      )}

      {/* File Browser */}
      <div className="mb-4">
        <FileBrowser defaultDir={agent.cwd} />
      </div>

      {/* Messages */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <h3 className="text-sm font-medium text-gray-300 mb-3">Messages</h3>
        <MessageStream messages={messages} />
        {streamBuffer && (
          <div className="text-xs text-gray-400 font-mono whitespace-pre-wrap bg-gray-950 rounded p-2 mt-2 border border-gray-800">
            {streamBuffer}
            <span className="animate-pulse">|</span>
          </div>
        )}
      </div>

      {/* Error */}
      {agent.error_message && !agent.error_message.toLowerCase().includes("imported from existing session") && !agent.error_message.toLowerCase().includes("claude code process exited") && !agent.error_message.toLowerCase().includes("server restarted") && (
        <div className="mt-4 bg-red-950/30 border border-red-900/50 rounded-lg p-2 md:p-3 text-xs md:text-sm text-red-300">
          <p>{agent.error_message}</p>
          {(agent.error_message.toLowerCase().includes("fresh start") || agent.error_message.toLowerCase().includes("too long") || agent.error_message.toLowerCase().includes("too large") || agent.error_message.toLowerCase().includes("compact") || agent.error_message.toLowerCase().includes("trim")) && (
            <div className="flex flex-wrap gap-2 mt-2">
              <button
                onClick={async () => {
                  try {
                    await fetch(`/api/agents/${agent.id}/compact`, { method: "POST" });
                    refresh();
                  } catch {
                    alert("Failed to start compaction");
                  }
                }}
                className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-xs rounded"
              >
                Compact (summarize history)
              </button>
              <button
                onClick={async () => {
                  try {
                    const res = await fetch(`/api/agents/${agent.id}/trim`, { method: "POST" });
                    const data = await res.json();
                    if (!res.ok) alert(data.error);
                    refresh();
                  } catch {
                    alert("Failed to trim");
                  }
                }}
                className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white text-xs rounded"
              >
                Trim (keep last 10 messages)
              </button>
              <button
                onClick={async () => {
                  const newPrompt = window.prompt("Enter a prompt for the fresh start (or leave empty to reuse the original):");
                  if (newPrompt === null) return;
                  try {
                    await fetch(`/api/agents/${agent.id}/fresh-start`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ prompt: newPrompt || undefined }),
                    });
                    refresh();
                  } catch {
                    alert("Failed to start");
                  }
                }}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded"
              >
                Fresh Start (no history)
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SubagentPanel({ subagent }: { subagent: SubagentInfo }) {
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState<Array<{ role: string; content: string }>>([]);
  const [loaded, setLoaded] = useState(false);

  const loadTranscript = async () => {
    if (loaded || !subagent.transcriptPath) return;
    try {
      const msgs = await api.getSubagentTranscript(subagent.transcriptPath);
      setMessages(msgs);
      setLoaded(true);
    } catch { /* ignore */ }
  };

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) loadTranscript();
  };

  const isActive = !subagent.stoppedAt;

  return (
    <div className={`bg-gray-900 border rounded-lg overflow-hidden ${isActive ? "border-green-800/50" : "border-gray-800"}`}>
      <button
        onClick={toggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-800/50"
      >
        {expanded ? <ChevronDown size={14} className="text-gray-500" /> : <ChevronRight size={14} className="text-gray-500" />}
        <span className={`text-xs font-medium px-2 py-0.5 rounded ${isActive ? "bg-green-900/50 text-green-300" : "bg-gray-800 text-gray-400"}`}>
          {subagent.agentType}
        </span>
        <span className="text-xs text-gray-500 truncate flex-1">{subagent.agentId}</span>
        {isActive && <span className="text-xs text-green-400 animate-pulse">running</span>}
        {!isActive && <span className="text-xs text-gray-600">done</span>}
      </button>

      {expanded && (
        <div className="border-t border-gray-800 px-3 py-2 max-h-64 overflow-y-auto space-y-1">
          {messages.length === 0 && (
            <div className="text-xs text-gray-600">{loaded ? "No messages" : "Loading..."}</div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className="text-xs">
              <span className={`font-medium ${msg.role === "assistant" ? "text-blue-400" : msg.role === "tool" ? "text-green-400" : "text-gray-500"}`}>
                {msg.role}
              </span>
              <div className="text-gray-400 ml-2 prose prose-invert prose-xs max-w-none prose-p:my-0.5 prose-code:text-green-400 prose-code:bg-gray-800 prose-code:px-1 prose-code:rounded">
                <Markdown remarkPlugins={[remarkGfm]}>{msg.content}</Markdown>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
