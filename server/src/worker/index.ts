/**
 * Agent worker — runs ONE agent to completion inside its own k8s pod, writing
 * all events/tokens/state to the shared Postgres (the boss + UI read from there).
 *
 * This is the pod-native replacement for the in-process AgentRunner. It has NO
 * host-process/PID code: the pod boundary IS the process tree, and "kill" is
 * "delete the pod". Permissions round-trip to the human across the pod boundary
 * via the permission_requests table (see canUseTool below): safe tools auto-
 * approve; anything else NOTIFYs the boss (→ UI dialog) and BLOCKS on a DB poll
 * until resolved. The DB row is the channel — there's no in-memory promise to
 * share across processes.
 *
 * Entrypoint: `node dist/worker/index.js` with env AGENT_ID (+ DATABASE_URL,
 * ANTHROPIC_API_KEY, WORK_DIR). Same image as the boss.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, copyFile, readdir, unlink, readFile, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import pg from "pg";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { initDb, closeDb } from "../db/index.js";
import * as queries from "../db/queries.js";
import { shouldAutoApprove, mapPermissionDecision, type PermissionPolicy } from "../agent/tool-policy.js";
import { functionsAtEdits, functionsInFile } from "../leasing/freeze-set.js";
import { normalizeGitUrl, authedUrl as authedUrlWithToken } from "../utils/git.js";
import { config } from "../config.js";
import { ensurePullRequest } from "../forge/github.js";
import { loadProjectContext } from "./project-context.js";
import { loadRepoMcpServers } from "./repo-mcp.js";
import type { AgentRecord } from "../types/agent.js";
import { logger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);

const AGENT_ID = process.env.AGENT_ID;
const WORK_DIR = process.env.WORK_DIR || "/work";
// Per-user shard mount (RWO PVC). When set, agents keep a warm bare mirror here
// and clone locally from it instead of hitting the internet per dispatch.
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "";
const GIT_TOKEN = process.env.GIT_TOKEN || "";
// The turn's prompt: TURN_PROMPT (a resume turn's user message) or the agent's
// original prompt (first turn).
const TURN_PROMPT = process.env.TURN_PROMPT || "";
// How long the agent waits on a human before auto-denying a permission.
const PERMISSION_TIMEOUT_MS = (Number(process.env.PERMISSION_TIMEOUT_MINUTES) || 30) * 60_000;
// Per-event display cap. Assistant text (reviews, verdicts) must survive intact —
// a review's RECOMMENDATION line is at the very END, so a tight cap silently drops
// the verdict (root cause of "review shows no verdict"). Tool output stays tight;
// it's noisy and the full transcript lives on the shard for resume anyway.
const ASSISTANT_MAX = 60_000;
const TOOL_MAX = 4000;

// ── Session persistence (on the per-user shard) ──────────
// The resumable session is the CLI's transcript at ~/.claude/projects/<key>/<id>.jsonl
// — NOT the truncated agent_events. Persist it to the shard so a later pod can
// resume by id. (cwd=/work encodes to project key "-work".)
const CLAUDE_PROJECTS = `${process.env.HOME || "/root"}/.claude/projects`;
const PROJECT_KEY = "-work";
const SESSIONS_DIR = WORKSPACE_DIR ? `${WORKSPACE_DIR}/sessions` : "";

async function findSessionFile(sessionId: string): Promise<string | null> {
  const primary = `${CLAUDE_PROJECTS}/${PROJECT_KEY}/${sessionId}.jsonl`;
  if (existsSync(primary)) return primary;
  try {
    for (const dir of await readdir(CLAUDE_PROJECTS)) {
      const cand = `${CLAUDE_PROJECTS}/${dir}/${sessionId}.jsonl`;
      if (existsSync(cand)) return cand;
    }
  } catch { /* projects dir may not exist yet */ }
  return null;
}

async function restoreSession(sessionId: string): Promise<void> {
  if (!SESSIONS_DIR) return;
  const src = `${SESSIONS_DIR}/${sessionId}.jsonl`;
  if (!existsSync(src)) return;
  const destDir = `${CLAUDE_PROJECTS}/${PROJECT_KEY}`;
  await mkdir(destDir, { recursive: true });
  await copyFile(src, `${destDir}/${sessionId}.jsonl`);
  logger.info({ agentId: AGENT_ID, sessionId }, "Restored session from shard");
}

/**
 * Garbage-collect orphaned session transcripts on this user's shard. A deleted
 * agent's transcript can never be resumed (its id is gone from the DB), so it's
 * dead weight that would otherwise accumulate forever. The worker is the natural
 * GC: it already has the RWO shard mounted. Only removes files NOT referenced by
 * any of the owner's live agents, so concurrent/running agents are never touched.
 */
async function pruneOrphanSessions(ownerId: string | null): Promise<void> {
  if (!SESSIONS_DIR || !ownerId || !existsSync(SESSIONS_DIR)) return;
  try {
    const referenced = new Set(await queries.getSessionIdsForUser(ownerId));
    let removed = 0;
    for (const f of await readdir(SESSIONS_DIR)) {
      if (!f.endsWith(".jsonl")) continue;
      if (referenced.has(f.slice(0, -".jsonl".length))) continue;
      await unlink(`${SESSIONS_DIR}/${f}`);
      removed++;
    }
    if (removed) logger.info({ agentId: AGENT_ID, removed }, "Pruned orphaned session transcripts from shard");
  } catch (err) {
    logger.warn({ agentId: AGENT_ID, err: err instanceof Error ? err.message : String(err) }, "Session prune failed");
  }
}

async function saveSession(sessionId: string): Promise<void> {
  if (!SESSIONS_DIR || !sessionId) return;
  const file = await findSessionFile(sessionId);
  if (!file) return;
  await mkdir(SESSIONS_DIR, { recursive: true });
  await copyFile(file, `${SESSIONS_DIR}/${sessionId}.jsonl`);
  logger.info({ agentId: AGENT_ID, sessionId }, "Saved session to shard");
}

/** Embed the dispatcher's token (from env) for private clone/push. */
function authedUrl(src: string): string {
  return authedUrlWithToken(src, GIT_TOKEN);
}

/**
 * Listen for `steer` commands (a mid-run redirect from the human/supervisor) on
 * the shared command bus. The worker OWNS 'steer' (the sidecar owns 'snapshot');
 * each completes only its own commands. Returns a stop fn. This is what makes the
 * supervisor able to course-correct WITHOUT killing the turn.
 */
function startSteerListener(agentId: string, onSteer: (message: string) => void): () => void {
  let client: pg.Client | null = null;
  let closed = false;
  const drain = async () => {
    for (const cmd of await queries.getPendingCommands(agentId)) {
      if (cmd.command !== "steer") continue; // not ours — leave it for the sidecar
      const message = String((cmd.args as { message?: string })?.message || "").trim();
      await queries.completeCommand(cmd.id, "done").catch(() => {});
      if (message) onSteer(message);
    }
  };
  const connect = async () => {
    if (closed) return;
    try {
      client = new pg.Client({ connectionString: process.env.DATABASE_URL });
      client.on("error", () => {
        try { void client?.end(); } catch { /* ignore */ }
        client = null;
        if (!closed) setTimeout(connect, 2000);
      });
      client.on("notification", (msg) => { if (msg.payload === agentId) void drain(); });
      await client.connect();
      await client.query("LISTEN daboss_agent_cmd");
      await drain();
    } catch {
      if (!closed) setTimeout(connect, 2000);
    }
  };
  void connect();
  return () => { closed = true; try { void client?.end(); } catch { /* ignore */ } };
}

/**
 * Scripted-agent mode (WORKER_SCRIPT) — a DETERMINISTIC fake agent for testing
 * the coordination pipeline without Claude. It builds a self-contained repo,
 * applies known edits, and holds the uncommitted diff open for `lingerMs` so the
 * real sidecar computes leases/evasion and other agents can collide. This is the
 * primitive behind the collision/evasion scenario runner.
 */
interface WorkerScript {
  initRepo?: Record<string, string>; // path → contents (self-contained; no clone)
  edits?: Array<{ file: string; find: string; replace: string }>;
  appendFunctions?: Array<{ file: string; code: string }>; // for evasion (fork a frozen symbol)
  lingerMs?: number;
}

async function runScripted(workDir: string): Promise<string> {
  const script = JSON.parse(process.env.WORKER_SCRIPT || "{}") as WorkerScript;
  await queries.insertAgentEvent(AGENT_ID!, "message", { role: "system", content: "🧪 Scripted agent (deterministic test — no Claude)." });

  if (script.initRepo) {
    for (const [rel, content] of Object.entries(script.initRepo)) {
      const p = `${workDir}/${rel}`;
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, content, "utf8");
    }
    await execFileAsync("git", ["-C", workDir, "init", "-q"]);
    await execFileAsync("git", ["-C", workDir, "add", "-A"]);
    await execFileAsync("git", ["-C", workDir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
  }
  for (const e of script.edits || []) {
    const p = `${workDir}/${e.file}`;
    await writeFile(p, (await readFile(p, "utf8")).split(e.find).join(e.replace), "utf8");
    await queries.insertAgentEvent(AGENT_ID!, "message", { role: "tool", content: `**Edit**: \`${e.file}\`` });
  }
  for (const a of script.appendFunctions || []) {
    const p = `${workDir}/${a.file}`;
    await writeFile(p, (await readFile(p, "utf8").catch(() => "")) + "\n" + a.code + "\n", "utf8");
    await queries.insertAgentEvent(AGENT_ID!, "message", { role: "tool", content: `**Write**: \`${a.file}\` (+function)` });
  }

  const linger = script.lingerMs ?? 90_000;
  await queries.insertAgentEvent(AGENT_ID!, "message", {
    role: "system",
    content: `Holding uncommitted edits ${Math.round(linger / 1000)}s (lease window)…`,
  });
  await new Promise((r) => setTimeout(r, linger));
  return "Scripted edits applied.";
}

/** PR description: the agent's task + its closing summary + provenance footer. */
function prBody(agent: AgentRecord, summary: string): string {
  const task = agent.prompt.trim().slice(0, 1500);
  const result = summary.trim().slice(0, 4000);
  return [
    "## Task",
    task,
    "",
    "## What the agent did",
    result || "_(no summary produced)_",
    "",
    "---",
    `🤖 Opened by da_boss agent \`${agent.name}\`. Draft until reviewed.`,
  ].join("\n");
}

function extractText(msg: unknown): string | null {
  const m = msg as { message?: { content?: Array<{ type: string; text?: string }> } };
  const parts = (m?.message?.content || [])
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!);
  return parts.length ? parts.join("\n") : null;
}

/** Read the most-recently-written plan doc the agent saved under .claude/plans/. Some
 *  agents write their plan to a file and call ExitPlanMode with empty input, so the
 *  approval card has nothing to show — this recovers the plan text so the card can
 *  render it. Best-effort. */
async function readLatestPlanFile(): Promise<string | null> {
  try {
    const dir = `${WORK_DIR}/.claude/plans`;
    if (!existsSync(dir)) return null;
    const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
    let best = "", bestMtime = -1;
    for (const f of files) {
      try { const st = statSync(`${dir}/${f}`); if (st.mtimeMs > bestMtime) { bestMtime = st.mtimeMs; best = `${dir}/${f}`; } } catch { /* skip */ }
    }
    return best ? await readFile(best, "utf8") : null;
  } catch { return null; }
}

function extractToolUses(msg: unknown): string[] {
  const m = msg as {
    message?: { content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }> };
  };
  return (m?.message?.content || [])
    .filter((b) => b.type === "tool_use" && b.name)
    .map((b) => {
      const input = b.input || {};
      if (b.name === "Bash" && input.command) return `**Bash**: \`${input.command}\``;
      if ((b.name === "Write" || b.name === "Edit") && input.file_path) return `**${b.name}**: \`${input.file_path}\``;
      if (b.name === "Read" && input.file_path) return `**Read**: \`${input.file_path}\``;
      return `**${b.name}**: ${JSON.stringify(input).slice(0, 300)}`;
    });
}

async function main(): Promise<void> {
  if (!AGENT_ID) throw new Error("AGENT_ID env var is required");
  await initDb();

  const agent = await queries.getAgent(AGENT_ID);
  if (!agent) throw new Error(`Agent ${AGENT_ID} not found`);

  const pod = process.env.HOSTNAME || "unknown-pod";
  logger.info({ agentId: AGENT_ID, pod, cwd: WORK_DIR }, "Worker starting agent in pod");

  // GC dead transcripts left by this user's deleted agents before we do anything
  // else — keeps the per-user shard from growing without bound.
  await pruneOrphanSessions(agent.created_by_user_id);

  await queries.updateAgentState(AGENT_ID, "running", { started_at: new Date().toISOString() });
  await queries.insertAgentEvent(AGENT_ID, "state_change", { from: agent.state, to: "running" });
  await queries.insertAgentEvent(AGENT_ID, "message", {
    role: "system",
    content: `Running in pod \`${pod}\` (cwd ${WORK_DIR})`,
  });

  // Bring source INTO the pod over the network (never mounted from node storage).
  // Blobless clone (blobs fetched lazily → skip the bulk of a big repo's weight),
  // then the agent's own branch. The clone SOURCE is configurable so switching to
  // a shared NFS mirror (option B) later is just REPO_MOUNT, not a rewrite.
  if (agent.repo_url && !process.env.WORKER_SCRIPT) {
    const branch = agent.branch || `daboss/${AGENT_ID}`;
    const cleanUrl = normalizeGitUrl(agent.repo_url);
    const repoName = (cleanUrl.replace(/\.git$/, "").split("/").pop() || "repo").replace(/[^a-zA-Z0-9._-]/g, "-");
    await queries.insertAgentEvent(AGENT_ID, "message", {
      role: "system",
      content: `Cloning ${agent.repo_url}${agent.repo_ref ? ` @ ${agent.repo_ref}` : ""} → ${WORK_DIR} (branch ${branch})…`,
    });
    try {
      if (WORKSPACE_DIR) {
        // Per-user shard: keep a bare mirror warm in the shard (fetched with the
        // user's token, under an flock so this user's parallel agents don't race),
        // then clone LOCALLY from it — no internet per agent. The token is scrubbed
        // from the persisted mirror config; it only lives in the ephemeral /work.
        const reposDir = `${WORKSPACE_DIR}/repos`;
        const mirrorDir = `${reposDir}/${repoName}.git`;
        const lockFile = `${WORKSPACE_DIR}/.${repoName}.lock`;
        const script = [
          "set -e",
          `mkdir -p "${reposDir}"`,
          `if [ -d "${mirrorDir}" ]; then`,
          `  git -C "${mirrorDir}" remote set-url origin "$SRC"`,
          `  git -C "${mirrorDir}" remote update --prune`,
          `else`,
          `  git clone --mirror "$SRC" "${mirrorDir}"`,
          `fi`,
          `git -C "${mirrorDir}" remote set-url origin "$CLEAN"`,
          `git clone "${mirrorDir}" "${WORK_DIR}"`,
        ].join("\n");
        await execFileAsync("flock", [lockFile, "sh", "-c", script], {
          timeout: 600_000,
          maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, SRC: authedUrl(agent.repo_url), CLEAN: cleanUrl },
        });
        // /work's origin points at the local mirror — repoint at the fork for push
        await execFileAsync("git", ["-C", WORK_DIR, "remote", "set-url", "origin", authedUrl(agent.repo_url)], { timeout: 30_000 });
      } else {
        // direct blobless clone from origin (no shard — dev/fallback)
        await execFileAsync("git", ["clone", "--filter=blob:none", authedUrl(agent.repo_url), WORK_DIR], {
          timeout: 300_000,
          maxBuffer: 16 * 1024 * 1024,
        });
      }
      // Continue the work's branch if it already exists on the remote; otherwise
      // create it from the base ref. The branch belongs to the work, not this run.
      const branchExists = await execFileAsync("git", ["-C", WORK_DIR, "rev-parse", "--verify", "--quiet", `origin/${branch}`])
        .then(() => true)
        .catch(() => false);
      if (branchExists) {
        await execFileAsync("git", ["-C", WORK_DIR, "checkout", "-B", branch, `origin/${branch}`], { timeout: 30_000 });
      } else {
        if (agent.repo_ref) {
          // Base the new branch on repo_ref. Usually a branch/tag/sha already in
          // the clone; if it isn't (e.g. a PR head ref like `refs/pull/N/head`,
          // used to review an EXTERNAL contribution whose head lives on a fork),
          // fetch it explicitly from origin — GitHub serves pull heads on the base
          // repo, so this reads the fork's code without adding the fork as a remote.
          const ok = await execFileAsync("git", ["-C", WORK_DIR, "checkout", agent.repo_ref], { timeout: 60_000 })
            .then(() => true)
            .catch(() => false);
          if (!ok) {
            await execFileAsync("git", ["-C", WORK_DIR, "fetch", "origin", agent.repo_ref], { timeout: 120_000 });
            await execFileAsync("git", ["-C", WORK_DIR, "checkout", "--detach", "FETCH_HEAD"], { timeout: 60_000 });
          }
        }
        await execFileAsync("git", ["-C", WORK_DIR, "checkout", "-b", branch], { timeout: 30_000 });
      }
      // Configure a git identity so the AGENT can commit locally (the system prompt
      // says committing is optional-but-fine). Without this, `git commit` fails with
      // "Committer identity unknown" and the agent gets stuck. Same identity the
      // worker uses for its own end-of-run commit.
      await execFileAsync("git", ["-C", WORK_DIR, "config", "user.email", "agent@daboss.local"], { timeout: 15_000 }).catch(() => {});
      await execFileAsync("git", ["-C", WORK_DIR, "config", "user.name", "da_boss agent"], { timeout: 15_000 }).catch(() => {});
      await queries.insertAgentEvent(AGENT_ID, "message", {
        role: "system",
        content: `Cloned${WORKSPACE_DIR ? " from your workspace shard" : ""}; ${branchExists ? "continuing" : "on new"} branch \`${branch}\`.`,
      });
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      const detail = (e.stderr && e.stderr.trim()) ? e.stderr.trim() : e.message || String(err);
      logger.error({ agentId: AGENT_ID, error: detail }, "git clone failed");
      await queries.updateAgentState(AGENT_ID, "failed", { error_message: `git clone failed: ${detail.slice(0, 300)}` });
      await queries.insertAgentEvent(AGENT_ID, "error", { error: `git clone failed: ${detail.slice(0, 600)}` });
      await closeDb();
      process.exit(1);
    }
  }

  // Permission round-trip (M3). Safe tools auto-approve (same policy as the boss).
  // Everything else — including AskUserQuestion / ExitPlanMode — is written to
  // permission_requests (which NOTIFYs the boss → UI dialog) and the worker BLOCKS,
  // polling the row until a human resolves it. The pod is a different process from
  // the boss, so we can't use an in-memory promise; the DB row IS the channel.
  const agentCwd = WORK_DIR;
  const policy: PermissionPolicy = (agent.permission_policy as PermissionPolicy) || "auto";

  // ── Edit-time freeze-lease hook ───────────────────────────
  // Before the agent edits a NEW function, review the leases and acquire it —
  // blocking (enforce mode) if another agent already holds that function. This is
  // the proactive counterpart to the sidecar's periodic blast-radius pass: fast,
  // per-function, at the point of edit. heldFns skips re-checking our own symbols.
  const repoKey = agent.repo_url ? normalizeGitUrl(agent.repo_url) : null;
  const heldFns = new Set<string>();

  const leaseHook = async (
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<PermissionResult | null> => {
    if (!repoKey || config.leaseMode === "off") return null;
    if (toolName !== "Edit" && toolName !== "MultiEdit" && toolName !== "Write") return null;
    try {
      const file = String(toolInput.file_path || "");
      if (!file) return null;
      // Write rewrites the whole file → lease every function in it. Edit/MultiEdit
      // localize to the function(s) containing the changed snippet(s).
      const found =
        toolName === "Write"
          ? await functionsInFile(WORK_DIR, file)
          : await functionsAtEdits(
              WORK_DIR,
              file,
              toolName === "MultiEdit"
                ? ((toolInput.edits as Array<{ old_string?: string }>) || []).map((e) => e.old_string || "")
                : [String(toolInput.old_string || "")]
            );
      const fns = found.filter((f) => !heldFns.has(f));
      if (!fns.length) return null;

      const conflicts = await queries.getLeaseConflicts(repoKey, fns, AGENT_ID!);
      if (conflicts.length) {
        const detail = conflicts
          .map((c) => `\`${c.resource_ref.split("#").pop()}\` (agent ${c.holder_agent_id})`)
          .join(", ");
        await queries.insertAgentEvent(AGENT_ID!, "message", {
          role: "system",
          content: `🔒 Freeze-lease ${config.leaseMode === "enforce" ? "blocked edit" : "conflict"} — held by another agent: ${detail}.`,
        });
        if (config.leaseMode === "enforce") {
          return {
            behavior: "deny",
            message: `That code is frozen by another da_boss agent (${detail}) who is actively changing it. Do NOT edit it — work on a different part of the task, or stop and coordinate.`,
          };
        }
        // advisory: allowed, but proceeding into frozen territory is a strike
        await queries.bumpAdvisoryStrikes(AGENT_ID!).catch(() => {});
      }
      await queries.acquireLeases(AGENT_ID!, repoKey, fns);
      fns.forEach((f) => heldFns.add(f));
      return null;
    } catch (err) {
      logger.warn({ agentId: AGENT_ID, err: err instanceof Error ? err.message : String(err) }, "lease hook failed");
      return null; // never block the agent on a hook error
    }
  };

  const waitForResolution = async (
    requestId: number,
    signal: AbortSignal
  ): Promise<{ decision: "approved" | "denied"; answer: string | null }> => {
    const start = Date.now();
    while (Date.now() - start < PERMISSION_TIMEOUT_MS) {
      if (signal?.aborted) return { decision: "denied", answer: "Aborted" };
      const p = await queries.getPermission(requestId);
      if (p && p.status !== "pending") {
        return { decision: p.status as "approved" | "denied", answer: p.resolution_answer };
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    // Timed out with no human — auto-deny and record it so the UI stops waiting too.
    await queries.resolvePermission(requestId, "denied", "Permission timed out").catch(() => {});
    return { decision: "denied", answer: "Permission timed out" };
  };

  const canUseTool = async (
    toolName: string,
    toolInput: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID: string }
  ): Promise<PermissionResult> => {
    // Freeze-lease hook runs first: it may block an edit into another agent's
    // territory before the normal safe-tool auto-approval.
    const gate = await leaseHook(toolName, toolInput);
    if (gate) return gate;

    if (shouldAutoApprove(toolName, toolInput, agentCwd, policy)) {
      return { behavior: "allow", updatedInput: toolInput };
    }
    // Plan approval: if the agent wrote its plan to a .claude/plans/*.md file and
    // called ExitPlanMode with no `plan` in the input, pull the file content in so the
    // approval card can render the plan instead of showing an empty box.
    let permInput = toolInput;
    if (toolName === "ExitPlanMode" && !toolInput.plan) {
      const planText = await readLatestPlanFile();
      if (planText) permInput = { ...toolInput, plan: planText };
    }
    const request = await queries.insertPermissionRequest(AGENT_ID!, toolName, permInput, options.toolUseID);
    logger.info({ agentId: AGENT_ID, toolName, requestId: request.id }, "Permission requested from pod");
    await queries.insertAgentEvent(AGENT_ID!, "message", {
      role: "system",
      content: `⏸ Waiting for your approval — **${toolName}**`,
    });
    const { decision, answer } = await waitForResolution(request.id, options.signal);
    await queries.insertAgentEvent(AGENT_ID!, "message", {
      role: "system",
      content: `▶ ${toolName} ${decision === "approved" ? "approved" : "denied"}${answer ? `: ${answer}` : ""}`,
    });
    // The agent is about to continue working — flip the state back to running so the
    // UI stops showing "Needs Approval/Input" while it's actively producing. (The
    // boss set the waiting state when the request was raised; nothing reset it.)
    await queries.updateAgentState(AGENT_ID!, "running", {}).catch(() => {});
    return mapPermissionDecision(toolName, toolInput, decision, answer);
  };

  let sessionId = agent.sdk_session_id ?? undefined;
  let hadError = false;
  let errorMsg = "";
  let finalSummary = ""; // the agent's closing result — used as the PR body
  let producedOutput = false; // did the agent stream substantive work this run?

  // Resume turn: restore the prior session transcript from the shard first.
  if (sessionId) {
    try {
      await restoreSession(sessionId);
    } catch (err) {
      logger.warn({ agentId: AGENT_ID, err: err instanceof Error ? err.message : String(err) }, "Session restore failed");
    }
  }

  const scripted = !!process.env.WORKER_SCRIPT;

  // A steer command mid-turn: interrupt the current turn, then re-run resuming the
  // SAME session (context intact) with the new instruction — no pod kill, no lost work.
  let currentQuery: { interrupt?: () => Promise<void> } | null = null;
  let pendingSteer: string | null = null;
  const stopSteerListener = scripted
    ? () => {}
    : startSteerListener(AGENT_ID, (message) => {
        pendingSteer = message;
        void currentQuery?.interrupt?.().catch(() => {});
      });

  if (scripted) {
    try {
      finalSummary = await runScripted(WORK_DIR);
    } catch (err) {
      hadError = true;
      errorMsg = err instanceof Error ? err.message : String(err);
    }
  } else try {
    let turnPrompt = TURN_PROMPT || agent.prompt;
    // The SDK's settingSources:["project"] is SUPPOSED to load the repo's CLAUDE.md,
    // but CLI 2.0.77 does NOT honor it in print/stream mode — verified in-pod, the
    // repo's project context never reaches the model. So load it ourselves and inject
    // it into the system prompt, so the agent actually adopts the repo's conventions.
    const projectContext = await loadProjectContext(WORK_DIR);
    await queries.insertAgentEvent(AGENT_ID, "message", {
      role: "system",
      content: projectContext
        ? `📖 Loaded the repo's CLAUDE.md${existsSync(`${WORK_DIR}/.claude`) ? " + .claude/ conventions" : ""} into context (${projectContext.length} chars).`
        : `ℹ️ No CLAUDE.md at the repo root — running without project-specific instructions.`,
    }).catch(() => {});
    // Load the repo's OWN MCP servers (its .mcp.json) so the agent gets the repo's
    // tools (memory / knowledge base, etc.) and honors its rules — the piece that
    // makes the repo's mcp_tool hooks actually run. Command hooks (PreToolUse
    // guards) already fire via settingSources:["project"]. NOT for review agents:
    // starting a repo's servers runs its code, which must never happen for a fork.
    const repoMcpServers = agent.review_of_agent_id ? {} : await loadRepoMcpServers(WORK_DIR);
    const repoMcpNames = Object.keys(repoMcpServers);
    if (repoMcpNames.length) {
      await queries.insertAgentEvent(AGENT_ID, "message", {
        role: "system",
        content: `🔌 Loaded ${repoMcpNames.length} MCP server(s) from the repo's .mcp.json: ${repoMcpNames.join(", ")}.`,
      }).catch(() => {});
    }
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const q = sdkQuery({
        prompt: turnPrompt,
        options: {
          cwd: WORK_DIR,
          canUseTool,
          // Keep settingSources for .claude/settings.json (permissions + command
          // hooks like the repo's PreToolUse guards, which DO fire) and CLAUDE.md.
          settingSources: ["project"],
          // The repo's own MCP servers (from its .mcp.json) — the SDK doesn't
          // auto-load these, so we pass them. Empty for review agents (see above).
          ...(repoMcpNames.length ? { mcpServers: repoMcpServers } : {}),
          ...(agent.model ? { model: agent.model } : {}),
          systemPrompt: {
            type: "preset" as const,
            preset: "claude_code" as const,
            append:
              `You are a da_boss agent running inside a Kubernetes pod. Your working directory is ${WORK_DIR}. ` +
              `When you finish, da_boss automatically commits any uncommitted changes, pushes your branch, and opens or updates the pull request. ` +
              `So do NOT run \`git push\` and do NOT try to create a PR yourself — the \`gh\` CLI is not installed and no PR token is in your shell, and da_boss handles all of that for you. Just make the changes (committing locally is fine but optional) and stop.` +
              projectContext,
          },
          ...(agent.max_turns ? { maxTurns: agent.max_turns } : {}),
          ...(sessionId ? { resume: sessionId } : {}),
        },
      });
      currentQuery = q as unknown as { interrupt?: () => Promise<void> };

      try {
        for await (const msg of q) {
          if ("type" in msg && msg.type === "system" && "session_id" in msg && (msg as { session_id?: string }).session_id) {
            sessionId = (msg as { session_id: string }).session_id;
            await queries.updateAgentState(AGENT_ID, "running", { sdk_session_id: sessionId });
          }

          if ("type" in msg && msg.type === "assistant") {
            const text = extractText(msg);
            if (text) { producedOutput = true; await queries.insertAgentEvent(AGENT_ID, "message", { role: "assistant", content: text.slice(0, ASSISTANT_MAX) }); }
            for (const tu of extractToolUses(msg)) {
              await queries.insertAgentEvent(AGENT_ID, "message", { role: "tool", content: tu.slice(0, TOOL_MAX) });
            }
            const usage = (msg as { message?: { usage?: Record<string, number> } }).message?.usage;
            if (usage && (usage.input_tokens || usage.output_tokens)) {
              const cost = (usage.input_tokens || 0) * 0.000003 + (usage.output_tokens || 0) * 0.000015;
              await queries.insertTokenUsage(
                AGENT_ID,
                usage.input_tokens || 0,
                usage.output_tokens || 0,
                usage.cache_read_input_tokens || 0,
                usage.cache_creation_input_tokens || 0,
                cost
              );
            }
          }

          if ("type" in msg && msg.type === "result") {
            const r = msg as { session_id?: string; is_error?: boolean; errors?: string[]; subtype?: string; result?: string };
            if (r.session_id) sessionId = r.session_id;
            if (r.is_error) {
              const emsg = (r.errors || []).join("; ") || r.subtype || "Unknown error";
              // Same principle as the outer catch (line ~594): a trailing SDK/API
              // error AFTER the agent already produced its work is a cleanup crash,
              // not a task failure. The SDK's streaming "only prompt commands" guard
              // and a mid-stream 403 land HERE as an is_error result even though the
              // change is already made — don't mark a working agent failed.
              if (producedOutput && /only prompt commands|streaming mode|status code 403|exited with code|process exited|exit code/i.test(emsg)) {
                logger.warn({ agentId: AGENT_ID, err: emsg }, "Trailing SDK error after producing output — completing, not failing");
              } else {
                hadError = true;
                errorMsg = emsg;
              }
            } else if (r.result) {
              finalSummary = String(r.result);
              producedOutput = true;
              await queries.insertAgentEvent(AGENT_ID, "message", { role: "assistant", content: finalSummary.slice(0, ASSISTANT_MAX) });
            }
          }
        }
      } catch (err) {
        if (!pendingSteer) throw err; // a real error, not our intentional interrupt
      }
      currentQuery = null;

      if (pendingSteer) {
        const steer = pendingSteer;
        pendingSteer = null;
        hadError = false; // the interrupt isn't a failure
        errorMsg = "";
        await queries.insertAgentEvent(AGENT_ID, "message", {
          role: "system",
          content: `↪️ Steered mid-run — new instruction: ${steer.slice(0, 300)}`,
        });
        turnPrompt = steer;
        continue; // resume the SAME session with the redirect
      }
      break;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // The Claude Code CLI subprocess sometimes exits non-zero on the way OUT —
    // after the agent has already streamed its work and summary (seen repeatedly
    // on long deploy runs). That's a cleanup crash, not a task failure: if the
    // agent produced output this run, complete it rather than showing a confusing
    // "failed". A crash BEFORE any output is still a real failure.
    if (producedOutput && /exited with code|process exited|exit code/i.test(msg)) {
      logger.warn({ agentId: AGENT_ID, err: msg }, "Claude process exited non-zero after producing output — completing, not failing");
    } else {
      hadError = true;
      errorMsg = msg;
    }
  } finally {
    stopSteerListener();
  }

  // Persist the session transcript to the shard so the next turn can resume it.
  if (sessionId) {
    try {
      await saveSession(sessionId);
    } catch (err) {
      logger.warn({ agentId: AGENT_ID, err: err instanceof Error ? err.message : String(err) }, "Session save failed");
    }
  }

  // Push the agent's branch back to the repo (your fork) so the work survives the
  // pod. Commit anything the agent left uncommitted, then push. A failed push does
  // NOT fail the agent — the work is recorded either way.
  //
  // A REVIEW agent NEVER pushes or opens a PR. It checks out the code under review
  // (for an adopted PR, the PR head itself), so its branch legitimately carries
  // those commits — but pushing them would relaunder the reviewed (possibly
  // untrusted, fork) code onto origin under the reviewer's name. Reviews are read-only.
  const isReviewAgent = !!agent.review_of_agent_id;
  // A DEPLOY-MANAGER agent (linked to a pipeline_run) runs a command — it is NOT a
  // code change. It must never push, open a PR, or be treated as a reviewable
  // change: its run is tracked by the deploy's exit code (recorder sidecar), not a
  // branch. It also writes /work/.daboss/{log,exit} into the repo tree, which a
  // push would turn into a junk PR (the orphan-review bug).
  const isDeployAgent = !!agent.pipeline_run_id;
  if (agent.repo_url && !hadError && !scripted && !isReviewAgent && !isDeployAgent) {
    const branch = agent.branch || `daboss/${AGENT_ID}`;
    // Only push if the branch has commits beyond its base. A deploy/no-op agent
    // that changed nothing shouldn't litter the remote with an empty branch.
    let shouldPush = true;
    try {
      // The pipeline recorder writes /work/.daboss/{log,exit,artifact} INSIDE the
      // repo tree at runtime. Never let `git add -A` stage those pod-local
      // artifacts into a commit/PR. Repo-local exclude — leaves tracked files
      // (e.g. the committed .daboss/pipeline.yaml) untouched.
      await writeFile(`${WORK_DIR}/.git/info/exclude`, "\n.daboss/log\n.daboss/exit\n.daboss/artifact\n", { flag: "a" }).catch(() => {});
      await execFileAsync("git", ["-C", WORK_DIR, "add", "-A"], { timeout: 60_000 });
      const { stdout: status } = await execFileAsync("git", ["-C", WORK_DIR, "status", "--porcelain"], { timeout: 30_000 });
      if (status.trim()) {
        await execFileAsync(
          "git",
          ["-C", WORK_DIR, "-c", "user.email=agent@daboss.local", "-c", "user.name=da_boss agent",
           "commit", "-m", `da_boss agent ${AGENT_ID}: ${agent.name}`],
          { timeout: 60_000 }
        );
      }
      // Count commits ahead of the base. If we can't resolve the base, push to be
      // safe — never silently drop real work. We only ever *skip* a push here;
      // nothing is deleted.
      try {
        const baseRef = agent.repo_ref ? `origin/${agent.repo_ref}` : "origin/HEAD";
        const { stdout: ahead } = await execFileAsync(
          "git", ["-C", WORK_DIR, "rev-list", "--count", `${baseRef}..HEAD`], { timeout: 30_000 });
        shouldPush = parseInt(ahead.trim(), 10) > 0;
      } catch {
        shouldPush = true; // base unknown — don't risk losing work
      }
      if (!shouldPush) {
        await queries.insertAgentEvent(AGENT_ID, "message", {
          role: "system",
          content: `No changes to push — the agent didn't modify the repo, so no branch was created.`,
        });
      } else {
        await execFileAsync("git", ["-C", WORK_DIR, "push", "origin", branch], { timeout: 180_000 });
        await queries.insertAgentEvent(AGENT_ID, "message", {
          role: "system",
          content: `Pushed branch \`${branch}\` to ${agent.repo_url}.`,
        });
      }
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      const detail = (e.stderr && e.stderr.trim()) ? e.stderr.trim() : e.message || String(err);
      logger.warn({ agentId: AGENT_ID, error: detail }, "git push failed");
      await queries.insertAgentEvent(AGENT_ID, "error", { error: `git push failed: ${detail.slice(0, 500)}` });
    }

    // Open (or find) the PR so the work is reviewable — authored by the dispatching
    // user via their token, which is already in this pod. Best-effort: a failure
    // never fails the agent (the branch is pushed regardless). Opens as a draft;
    // the future sidecar test-gate flips it ready.
    if (GIT_TOKEN && shouldPush) {
      try {
        const pr = await ensurePullRequest({
          repoUrl: agent.repo_url,
          token: GIT_TOKEN,
          branch,
          base: agent.repo_ref || undefined,
          title: agent.name,
          body: prBody(agent, finalSummary),
          draft: (process.env.DABOSS_PR_DRAFT || "true") !== "false",
        });
        if (pr) {
          await queries.setAgentPullRequest(AGENT_ID, pr.url, pr.number);
          await queries.insertAgentEvent(AGENT_ID, "message", {
            role: "system",
            content: `${pr.created ? "Opened" : "Updated"} PR #${pr.number}: ${pr.url}`,
          });
        } else {
          await queries.insertAgentEvent(AGENT_ID, "message", {
            role: "system",
            content: `Branch pushed; no PR opened (no changes vs base, or unsupported host).`,
          });
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        logger.warn({ agentId: AGENT_ID, error: detail }, "PR creation failed");
        await queries.insertAgentEvent(AGENT_ID, "error", { error: `PR creation failed: ${detail.slice(0, 400)}` });
      }
    }
  }

  if (hadError) {
    logger.error({ agentId: AGENT_ID, error: errorMsg }, "Agent failed in pod");
    await queries.updateAgentState(AGENT_ID, "failed", {
      error_message: errorMsg,
      ...(sessionId ? { sdk_session_id: sessionId } : {}),
    });
    await queries.insertAgentEvent(AGENT_ID, "error", { error: errorMsg });
  } else {
    logger.info({ agentId: AGENT_ID }, "Agent completed in pod");
    await queries.updateAgentState(AGENT_ID, "completed", {
      completed_at: new Date().toISOString(),
      ...(sessionId ? { sdk_session_id: sessionId } : {}),
    });
    await queries.insertAgentEvent(AGENT_ID, "state_change", { from: "running", to: "completed" });
  }

  await closeDb();
  process.exit(hadError ? 1 : 0);
}

main().catch(async (err) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err: message }, "Worker fatal error");
  try {
    if (AGENT_ID) await queries.updateAgentState(AGENT_ID, "failed", { error_message: message });
  } catch { /* best effort */ }
  process.exit(1);
});
