import { EventEmitter } from "node:events";
import { nanoid } from "nanoid";
import { DEFAULT_MODEL } from "../models.js";
import type {
  AgentRecord,
  AgentState,
  CreateAgentRequest,
} from "../types/agent.js";
import { AgentRunner } from "./runner.js";
import { createAgentPod, deleteAgentPod, deleteAgentRemoteBranch, deleteUserWorkspacePvc } from "./pod-dispatcher.js";
import { resolvePermissionRequest } from "./permissions.js";
import { TokenBudgetManager } from "../tokens/budget.js";
import { TaskMonitor } from "./task-monitor.js";
import { normalizeSize } from "./sizing.js";
import * as queries from "../db/queries.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

function slugify(s: string, max = 40): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max);
}

/** Reduce to a valid git ref: allowed chars, no // or leading/trailing junk. */
function sanitizeBranch(b: string): string {
  return (
    b
      .replace(/[^a-zA-Z0-9._/-]/g, "-")
      .replace(/\.{2,}/g, ".")
      .replace(/\/{2,}/g, "/")
      .replace(/^[-/.]+|[-/.]+$/g, "") || "work"
  );
}

/** Branch belongs to the work: type/username/issue-id-description (your convention).
 *  issue_id keeps hyphens (Jira keys like PROJ-1234). */
function buildBranchName(req: CreateAgentRequest, username?: string | null): string {
  const type = (req.branch_type || "feat").toLowerCase().replace(/[^a-z]/g, "") || "feat";
  const user = (username || "agent").replace(/[^a-zA-Z0-9._-]/g, "").toLowerCase() || "agent";
  const issue = req.issue_id ? `${req.issue_id.trim().replace(/[^a-zA-Z0-9._-]/g, "")}-` : "";
  const desc = slugify(req.name) || "task";
  return sanitizeBranch(`${type}/${user}/${issue}${desc}`);
}

export class AgentManager {
  private runners = new Map<string, AgentRunner>();
  /** Per-agent input queue. Messages wait here until the agent is ready. */
  private inputQueues = new Map<string, string[]>();
  /** Agents currently draining their queue (processing a message). */
  private draining = new Set<string>();
  public budgetManager: TokenBudgetManager;
  public taskMonitor: TaskMonitor;

  constructor(public eventBus: EventEmitter) {
    this.budgetManager = new TokenBudgetManager(eventBus);
    this.taskMonitor = new TaskMonitor(eventBus);

    // Listen for background task completions from runners
    eventBus.on("agent:task-completed", ({ agentId, notification }: { agentId: string; notification: string }) => {
      logger.info({ agentId }, "Background task completed — auto-resuming agent");

      // Show a clean system message in the UI (not the raw XML)
      const outputFile = notification.match(/<output-file>(.*?)<\/output-file>/)?.[1] || "unknown";
      eventBus.emit("server-event", {
        type: "agent:message",
        agentId,
        role: "system",
        content: `Background task completed: ${outputFile}`,
        timestamp: new Date().toISOString(),
      });
      queries.insertAgentEvent(agentId, "message", {
        role: "system",
        content: `Background task completed: ${outputFile}`,
      }).catch((err) => logger.error({ agentId, error: err.message }, "Failed to log task-completed event"));

      // Resume the agent with the full notification (agent needs the details)
      this.resumeWithNotification(agentId, notification).catch((err) => {
        logger.error({ agentId, error: err.message }, "Failed to auto-resume after task completion");
      });
    });
  }

  async createAgent(
    req: CreateAgentRequest,
    createdByUserId?: string | null,
    username?: string | null
  ): Promise<AgentRecord> {
    const id = `ag_${nanoid(8)}`;
    const branch = req.branch?.trim() ? sanitizeBranch(req.branch.trim()) : buildBranchName(req, username);
    const agent = await queries.insertAgent({
      id,
      name: req.name,
      prompt: req.prompt,
      cwd: req.cwd,
      state: "pending",
      priority: req.priority || "medium",
      permission_mode: req.permission_mode || "default",
      sdk_session_id: null,
      model: req.model || DEFAULT_MODEL, // code work defaults to Opus
      max_turns: req.max_turns || null,
      max_budget_usd: req.max_budget_usd || null,
      error_message: null,
      supervisor_instructions: req.supervisor_instructions || "",
      permission_policy: req.permission_policy || "auto",
      created_by_user_id: createdByUserId ?? null,
      repo_url: req.repo_url?.trim() || null,
      repo_ref: req.repo_ref?.trim() || null,
      branch,
      service_account: req.service_account?.trim() || null,
      worker_image: req.worker_image?.trim() || null,
      // only mark adoption when a branch override was actually given
      adopted_ref: req.branch?.trim() ? (req.adopted_ref?.trim() || branch) : null,
      size: normalizeSize(req.size), // explicit t-shirt size (else null → supervisor sizes it)
      toolchain: req.toolchain?.trim() || null, // Dockerfile target (toolchain flavor)
    });

    await queries.insertAgentEvent(id, "state_change", {
      from: null,
      to: "pending",
    });

    logger.info({ agentId: id, name: req.name }, "Agent created");
    return agent;
  }

  async startAgent(agentId: string): Promise<void> {
    const agent = await queries.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    // Pod mode: the SUPERVISOR owns pod-building. Queue the agent + notify; the
    // supervisor's queue processor sizes it (if no explicit size) and builds the
    // pod. One control loop — so the supervisor can later assess more than size.
    if (config.agentExecution === "pod") {
      await queries.updateAgentState(agentId, "queued", {});
      await queries.insertAgentEvent(agentId, "message", {
        role: "system",
        content: "Queued — the supervisor will size and dispatch it.",
      });
      await queries.notifyAgentQueued(agentId);
      logger.info({ agentId }, "Queued agent for supervisor dispatch");
      return;
    }

    // Check concurrency limit
    const activeCount = this.getActiveCount();
    if (activeCount >= config.maxConcurrentAgents) {
      throw new Error(
        `Max concurrent agents (${config.maxConcurrentAgents}) reached`
      );
    }

    const runner = new AgentRunner(
      agentId,
      this.eventBus,
      this.budgetManager,
      this.taskMonitor
    );
    this.runners.set(agentId, runner);

    // Start in background — don't await, so the API returns immediately
    runner.start().catch((err) => {
      logger.error({ agentId, error: err.message }, "Agent start failed");
    }).finally(() => {
      // Clean up runner reference when done
      if (this.runners.get(agentId) === runner) {
        this.runners.delete(agentId);
      }
    });

    logger.info({ agentId }, "Agent started");
  }

  async pauseAgent(agentId: string): Promise<void> {
    const runner = this.runners.get(agentId);
    if (runner) {
      await runner.pause();
    } else {
      // No runner but agent might be in a pausable state in DB
      const agent = await queries.getAgent(agentId);
      if (agent) {
        await queries.updateAgentState(agentId, "paused");
      }
    }
  }

  async resumeAgent(agentId: string): Promise<void> {
    const agent = await queries.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);
    if (!agent.sdk_session_id) {
      throw new Error("Cannot resume agent without a session ID");
    }

    // Just mark as waiting_input — no process starts until user sends a message.
    // This matches terminal behavior: resume loads the session, shows the prompt.
    await queries.updateAgentState(agentId, "waiting_input");
    this.eventBus.emit("server-event", {
      type: "agent:state_changed",
      agentId,
      state: "waiting_input",
      previousState: agent.state,
    });
    await queries.insertAgentEvent(agentId, "state_change", {
      from: agent.state,
      to: "waiting_input",
    });
    logger.info({ agentId }, "Agent resumed — waiting for input");

    // Drain any queued messages now that agent is ready
    await this.drainQueue(agentId);
  }

  async killAgent(agentId: string): Promise<void> {
    // Pod mode: kill = delete the pod (the pod boundary IS the process tree).
    if (config.agentExecution === "pod") {
      await deleteAgentPod(agentId);
      const agent = await queries.getAgent(agentId);
      if (agent && !["completed", "failed", "aborted"].includes(agent.state)) {
        await queries.updateAgentState(agentId, "aborted");
        await queries.insertAgentEvent(agentId, "state_change", { from: agent.state, to: "aborted" });
      }
      return;
    }

    const runner = this.runners.get(agentId);
    if (runner) {
      await runner.kill();
      this.runners.delete(agentId);
    } else {
      const agent = await queries.getAgent(agentId);
      if (agent) {
        await queries.updateAgentState(agentId, "aborted");
      }
    }
  }

  async sendUrgent(agentId: string, message: string): Promise<boolean> {
    // Pod mode: a running agent is steered mid-turn via the command bus — the
    // worker interrupts its current turn and resumes the same session with this
    // message (no pod kill). A non-running agent falls back to a fresh resume pod.
    if (config.agentExecution === "pod") {
      const agent = await queries.getAgent(agentId);
      if (agent && ["running", "waiting_permission"].includes(agent.state)) {
        await queries.insertAgentCommand(agentId, "steer", { message });
        return true;
      }
      await this.sendInput(agentId, message);
      return false;
    }

    const runner = this.runners.get(agentId);
    if (!runner || !runner.running) {
      // Not running — fall back to queue
      await this.sendInput(agentId, message);
      return false;
    }
    // Interrupt the agent, then queue the message for immediate delivery on resume
    const interrupted = await runner.sendUrgent(message);
    if (interrupted) {
      // Queue the message — it'll be delivered as soon as the turn ends from interrupt
      if (!this.inputQueues.has(agentId)) this.inputQueues.set(agentId, []);
      this.inputQueues.get(agentId)!.unshift(message); // Front of queue
    }
    return interrupted;
  }

  async sendInput(agentId: string, message: string): Promise<void> {
    const agent = await queries.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    // Pod mode: a follow-up message = dispatch a fresh pod that resumes the
    // session (restored from the shard) with this message as the turn prompt.
    if (config.agentExecution === "pod") {
      await queries.insertAgentEvent(agentId, "message", { role: "user", content: message });
      // Make it unmistakable this is a RESUME of THIS agent, not a new one — the pod
      // re-dispatch below re-emits build/clone/load lines that read like a fresh boot.
      await queries.insertAgentEvent(agentId, "message", {
        role: "system",
        content: `↻ Resuming **this same agent** with your message${agent.branch ? ` on branch \`${agent.branch}\`` : ""}${agent.pr_number ? ` (PR #${agent.pr_number})` : ""}. The setup lines below are its pod restarting to pick up your input — **not** a new agent.`,
      });
      try {
        await createAgentPod(agentId, message);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await queries.updateAgentState(agentId, "failed", { error_message: msg });
        await queries.insertAgentEvent(agentId, "error", { error: msg });
        throw err;
      }
      return;
    }

    if (!agent.sdk_session_id) {
      throw new Error("Cannot send input to agent without a session");
    }

    // Queue the message
    if (!this.inputQueues.has(agentId)) {
      this.inputQueues.set(agentId, []);
    }
    this.inputQueues.get(agentId)!.push(message);
    logger.info({ agentId, queueSize: this.inputQueues.get(agentId)!.length }, "Message queued");

    // Try to drain
    await this.drainQueue(agentId);
  }

  /** Process queued messages one at a time. Only runs if agent is ready. */
  private async drainQueue(agentId: string): Promise<void> {
    // Pod mode never runs agents in-process — input is dispatched via sendInput → pod.
    if (config.agentExecution === "pod") return;
    // Already draining — the current turn's finally will call us again
    if (this.draining.has(agentId)) return;

    const queue = this.inputQueues.get(agentId);
    if (!queue || queue.length === 0) return;

    // Check agent is ready for input
    const agent = await queries.getAgent(agentId);
    if (!agent) return;
    if (!agent.sdk_session_id) return;

    const readyStates = ["waiting_input", "completed", "failed", "paused"];
    if (!readyStates.includes(agent.state)) {
      logger.info({ agentId, state: agent.state, queueSize: queue.length }, "Agent not ready, messages queued");
      return;
    }

    // Transition failed/paused agents to waiting_input so runTurn can proceed
    if (agent.state === "failed" || agent.state === "paused") {
      await queries.updateAgentState(agentId, "waiting_input");
    }

    // Check if a runner already exists (shouldn't, but guard against it)
    const existingRunner = this.runners.get(agentId);
    if (existingRunner?.running) {
      logger.warn({ agentId }, "Runner still active, deferring queue drain");
      return;
    }

    // Check concurrency
    const activeCount = this.getActiveCount();
    if (activeCount >= config.maxConcurrentAgents) {
      logger.warn({ agentId }, "Max concurrent agents reached, deferring queue drain");
      return;
    }

    // Combine all queued messages into one
    const message = queue.length === 1
      ? queue.shift()!
      : queue.splice(0, queue.length).join("\n\n");
    this.draining.add(agentId);

    const runner = new AgentRunner(agentId, this.eventBus, this.budgetManager, this.taskMonitor);
    this.runners.set(agentId, runner);

    runner.resumeWithInput(message).catch((err) => {
      logger.error({ agentId, error: err.message }, "Resume with input failed");
    }).finally(() => {
      if (this.runners.get(agentId) === runner) {
        this.runners.delete(agentId);
      }
      this.draining.delete(agentId);
      // Drain next message if any
      void this.drainQueue(agentId).catch(() => {});
    });
  }

  /** Resume an agent with a system notification (no user message emitted to UI). */
  private async resumeWithNotification(agentId: string, notification: string): Promise<void> {
    const agent = await queries.getAgent(agentId);
    if (!agent) return;

    // Pod mode: resume by dispatching a fresh pod with the notification as input.
    if (config.agentExecution === "pod") {
      if (agent.sdk_session_id) await createAgentPod(agentId, notification).catch(() => {});
      return;
    }
    if (!agent.sdk_session_id) return;
    if (agent.state !== "waiting_input") return;

    // Check if already draining or a runner exists
    if (this.draining.has(agentId)) {
      // Queue it — it'll drain after current turn
      if (!this.inputQueues.has(agentId)) this.inputQueues.set(agentId, []);
      this.inputQueues.get(agentId)!.push(notification);
      return;
    }

    const existingRunner = this.runners.get(agentId);
    if (existingRunner?.running) return;

    const activeCount = this.getActiveCount();
    if (activeCount >= config.maxConcurrentAgents) return;

    this.draining.add(agentId);
    const runner = new AgentRunner(agentId, this.eventBus, this.budgetManager, this.taskMonitor);
    this.runners.set(agentId, runner);

    // Use runTurn directly — sends the notification as the prompt without emitting it as a user message
    runner.runTurn(notification, true).catch((err) => {
      logger.error({ agentId, error: err.message }, "Auto-resume after notification failed");
    }).finally(() => {
      if (this.runners.get(agentId) === runner) {
        this.runners.delete(agentId);
      }
      this.draining.delete(agentId);
      void this.drainQueue(agentId).catch(() => {});
    });
  }

  async resolvePermission(
    requestId: number,
    decision: "approved" | "denied",
    answer?: string
  ): Promise<boolean> {
    return resolvePermissionRequest(requestId, decision, this.eventBus, answer);
  }

  /**
   * Offboard a user: tear down all of their agents (kill pod, delete remote
   * branch, drop DB rows), reclaim their workspace shard, wipe their credential
   * vault, and delete the user. Ordered so branch cleanup still has the user's
   * git token, and the shard PVC delete removes every session at once (no
   * per-agent cleanup pods needed). Best-effort per step — one failure doesn't
   * strand the rest.
   */
  async offboardUser(
    userId: string,
    offboardedBy?: string
  ): Promise<{ agentsRemoved: number; branchesDeleted: number }> {
    const user = await queries.getUserById(userId);
    const agents = await queries.getAgentsByUser(userId);
    let branchesDeleted = 0;

    for (const agent of agents) {
      if (["running", "waiting_permission", "waiting_input"].includes(agent.state)) {
        await this.killAgent(agent.id).catch((err) =>
          logger.warn({ agentId: agent.id, err: String(err) }, "Offboard: kill failed")
        );
      }
      const bc = await deleteAgentRemoteBranch(agent).catch(() => ({ deleted: false }));
      if (bc.deleted) branchesDeleted++;
      await queries.deleteAgent(agent.id);
    }

    // Reclaim the whole shard — takes all persisted sessions/mirrors with it.
    if (config.agentExecution === "pod") {
      await deleteUserWorkspacePvc(userId).catch((err) =>
        logger.warn({ userId, err: String(err) }, "Offboard: PVC delete failed")
      );
    }

    await queries.deleteUserCredential(userId);
    await queries.deleteUserGitCredential(userId);

    // Tombstone the identity so neither auth provider re-admits it (OIDC would
    // otherwise re-provision on the next valid IdP token; local would allow
    // re-registration). Recorded BEFORE the row is deleted so we have the keys.
    if (user) {
      await queries.recordOffboardedIdentity({
        externalId: user.external_id,
        email: user.email,
        offboardedBy,
      });
    }
    await queries.deleteUser(userId);

    logger.info({ userId, agentsRemoved: agents.length, branchesDeleted }, "User offboarded");
    return { agentsRemoved: agents.length, branchesDeleted };
  }

  getActiveCount(): number {
    let count = 0;
    for (const runner of this.runners.values()) {
      if (runner.running) count++;
    }
    return count;
  }

  /** Get queued message count per agent. */
  getQueueInfo(): Record<string, number> {
    const info: Record<string, number> = {};
    for (const [agentId, queue] of this.inputQueues) {
      if (queue.length > 0) info[agentId] = queue.length;
    }
    return info;
  }

  /** Get subagent info for an agent. */
  getSubagents(agentId: string): import("./runner.js").SubagentInfo[] {
    const runner = this.runners.get(agentId);
    if (!runner) return [];
    return [...runner.subagents.values()];
  }

  /** Get process info for all agents (PIDs + descendant count). */
  async getProcessInfo(): Promise<Record<string, { pids: number[]; descendants: number[] }>> {
    const { execSync } = await import("node:child_process");
    const info: Record<string, { pids: number[]; descendants: number[] }> = {};
    for (const [agentId, runner] of this.runners) {
      const pids = [...runner.trackedPids];
      const descendants: number[] = [];
      for (const pid of pids) {
        try {
          const output = execSync(`pgrep -P ${pid}`, { encoding: "utf-8", timeout: 2000 }).trim();
          for (const line of output.split("\n")) {
            const childPid = parseInt(line.trim());
            if (childPid) descendants.push(childPid);
          }
        } catch { /* no children */ }
      }
      info[agentId] = { pids, descendants };
    }
    return info;
  }

  async getAllAgents(): Promise<AgentRecord[]> {
    return queries.getAllAgents();
  }

  async getAgent(agentId: string): Promise<AgentRecord | undefined> {
    return queries.getAgent(agentId);
  }

  /**
   * On server start, check for agents that were running and mark them
   * as needing resume. We don't auto-resume to avoid surprise costs.
   * Also kill any orphaned claude processes from the previous run.
   */
  async restoreAgents(): Promise<void> {
    const active = await queries.getAgentsByState(
      "running",
      "waiting_permission",
      "waiting_input"
    );
    // Only pause agents whose POD IS GONE. A pod that survived the control-plane
    // restart keeps beating (the pod↔boss bus is Postgres, so its events keep
    // flowing and this new control plane picks them up) — pausing it would be the
    // churn that froze the forecast agent on every redeploy. A FRESH heartbeat = the
    // pod is alive → leave it running; stale/absent = dead → pause. The periodic
    // reaper (startAgentReaper) handles pods that die AFTER startup.
    const freshCutoff = Date.now() - config.reaperStaleSeconds * 1000;
    const interrupted = active.filter((a) => {
      const hb = a.last_heartbeat_at ? new Date(a.last_heartbeat_at).getTime() : 0;
      return hb < freshCutoff; // no fresh heartbeat → pod gone
    });
    for (const agent of interrupted) {
      logger.info(
        { agentId: agent.id, state: agent.state },
        "Restart: pod heartbeat stale/absent — pausing"
      );
      await queries.updateAgentState(agent.id, "paused", {
        error_message: "Server restarted and this agent's pod was gone — paused; resume to continue.",
      });
      await queries.insertAgentEvent(agent.id, "message", {
        role: "system",
        content: "⚠ Server restarted and this agent's pod was no longer beating — reconciled to **paused**. Resume to continue.",
      }).catch(() => {});
    }
    const kept = active.length - interrupted.length;
    if (kept > 0) logger.info({ kept }, "Restart: left live-pod agents running (fresh heartbeat)");

    // Kill orphaned claude processes from a previous server run — but ONLY if the
    // DB shows agents that were mid-flight. The sweep greps for ALL `claude`
    // processes system-wide (it can't attribute PIDs across restarts), so on a
    // fresh/empty DB there is nothing we could have orphaned and running it would
    // SIGTERM unrelated interactive `claude` sessions and other da_boss instances.
    if (interrupted.length > 0) {
      await this.killOrphanedProcesses();
    } else {
      logger.info("No interrupted agents in DB — skipping orphan process sweep");
    }
  }

  /**
   * Find and kill claude processes that were spawned by da_boss but are
   * no longer tracked by any runner (orphans from server restart/crash).
   */
  async killOrphanedProcesses(): Promise<number> {
    const { execSync } = await import("node:child_process");
    try {
      // Find claude processes that are NOT the user's interactive session
      // (interactive sessions have --dangerously-skip-permissions or a tty)
      const output = execSync(
        "ps -eo pid,ppid,command | grep '[c]laude' | grep -v 'skip-permissions' | grep -v 'Code Helper' | grep -v grep",
        { encoding: "utf-8", timeout: 5000 }
      ).trim();

      if (!output) return 0;

      const myPid = process.pid;
      const lines = output.split("\n").filter(Boolean);
      let killed = 0;

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[0]);
        const ppid = parseInt(parts[1]);

        // Skip our own process and direct children of current node process
        if (pid === myPid) continue;

        // Check if this process is tracked by an active runner
        let tracked = false;
        for (const runner of this.runners.values()) {
          if (runner.running) {
            tracked = true;
            break;
          }
        }

        // If no runners are active (startup), all claude processes are orphans
        if (!tracked && ppid !== myPid) {
          try {
            process.kill(pid, "SIGTERM");
            killed++;
            logger.info({ pid, command: parts.slice(2).join(" ").substring(0, 80) }, "Killed orphaned claude process");
          } catch {
            // Process may have already exited
          }
        }
      }

      if (killed > 0) {
        logger.info({ killed }, "Cleaned up orphaned claude processes");
      }
      return killed;
    } catch {
      // grep returns exit 1 if no matches — that's fine
      return 0;
    }
  }
}
