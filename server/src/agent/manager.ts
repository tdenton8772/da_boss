import { EventEmitter } from "node:events";
import { nanoid } from "nanoid";
import type {
  AgentRecord,
  AgentState,
  CreateAgentRequest,
} from "../types/agent.js";
import { AgentRunner } from "./runner.js";
import { resolvePermissionRequest } from "./permissions.js";
import { TokenBudgetManager } from "../tokens/budget.js";
import { TaskMonitor } from "./task-monitor.js";
import * as queries from "../db/queries.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

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
      });

      // Resume the agent with the full notification (agent needs the details)
      this.resumeWithNotification(agentId, notification).catch((err) => {
        logger.error({ agentId, error: err.message }, "Failed to auto-resume after task completion");
      });
    });
  }

  async createAgent(req: CreateAgentRequest): Promise<AgentRecord> {
    const id = `ag_${nanoid(8)}`;
    const agent = queries.insertAgent({
      id,
      name: req.name,
      prompt: req.prompt,
      cwd: req.cwd,
      state: "pending",
      priority: req.priority || "medium",
      permission_mode: req.permission_mode || "default",
      sdk_session_id: null,
      model: req.model || "claude-sonnet-4-6",
      max_turns: req.max_turns || null,
      max_budget_usd: req.max_budget_usd || null,
      error_message: null,
      supervisor_instructions: req.supervisor_instructions || "",
      permission_policy: req.permission_policy || "auto",
    });

    queries.insertAgentEvent(id, "state_change", {
      from: null,
      to: "pending",
    });

    logger.info({ agentId: id, name: req.name }, "Agent created");
    return agent;
  }

  async startAgent(agentId: string): Promise<void> {
    const agent = queries.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

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
      const agent = queries.getAgent(agentId);
      if (agent) {
        queries.updateAgentState(agentId, "paused");
      }
    }
  }

  async resumeAgent(agentId: string): Promise<void> {
    const agent = queries.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);
    if (!agent.sdk_session_id) {
      throw new Error("Cannot resume agent without a session ID");
    }

    // Just mark as waiting_input — no process starts until user sends a message.
    // This matches terminal behavior: resume loads the session, shows the prompt.
    queries.updateAgentState(agentId, "waiting_input");
    this.eventBus.emit("server-event", {
      type: "agent:state_changed",
      agentId,
      state: "waiting_input",
      previousState: agent.state,
    });
    queries.insertAgentEvent(agentId, "state_change", {
      from: agent.state,
      to: "waiting_input",
    });
    logger.info({ agentId }, "Agent resumed — waiting for input");
  }

  async killAgent(agentId: string): Promise<void> {
    const runner = this.runners.get(agentId);
    if (runner) {
      await runner.kill();
      this.runners.delete(agentId);
    } else {
      const agent = queries.getAgent(agentId);
      if (agent) {
        queries.updateAgentState(agentId, "aborted");
      }
    }
  }

  async sendInput(agentId: string, message: string): Promise<void> {
    const agent = queries.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

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
    this.drainQueue(agentId);
  }

  /** Process queued messages one at a time. Only runs if agent is ready. */
  private drainQueue(agentId: string): void {
    // Already draining — the current turn's finally will call us again
    if (this.draining.has(agentId)) return;

    const queue = this.inputQueues.get(agentId);
    if (!queue || queue.length === 0) return;

    // Check agent is ready for input
    const agent = queries.getAgent(agentId);
    if (!agent) return;
    if (!["waiting_input", "completed"].includes(agent.state)) {
      logger.info({ agentId, state: agent.state, queueSize: queue.length }, "Agent not ready, messages queued");
      return;
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
      this.drainQueue(agentId);
    });
  }

  /** Resume an agent with a system notification (no user message emitted to UI). */
  private async resumeWithNotification(agentId: string, notification: string): Promise<void> {
    // Route through the same queue to prevent duplicate runners
    await this.sendInput(agentId, notification);
  }

  resolvePermission(
    requestId: number,
    decision: "approved" | "denied",
    answer?: string
  ): boolean {
    return resolvePermissionRequest(requestId, decision, this.eventBus, answer);
  }

  getActiveCount(): number {
    let count = 0;
    for (const runner of this.runners.values()) {
      if (runner.running) count++;
    }
    return count;
  }

  /** Get process info for all agents (PIDs + descendant count). */
  getProcessInfo(): Record<string, { pids: number[]; descendants: number[] }> {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
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

  getAllAgents(): AgentRecord[] {
    return queries.getAllAgents();
  }

  getAgent(agentId: string): AgentRecord | undefined {
    return queries.getAgent(agentId);
  }

  /**
   * On server start, check for agents that were running and mark them
   * as needing resume. We don't auto-resume to avoid surprise costs.
   * Also kill any orphaned claude processes from the previous run.
   */
  async restoreAgents(): Promise<void> {
    const interrupted = queries.getAgentsByState(
      "running",
      "waiting_permission",
      "waiting_input"
    );
    for (const agent of interrupted) {
      logger.info(
        { agentId: agent.id, state: agent.state },
        "Marking interrupted agent as paused"
      );
      queries.updateAgentState(agent.id, "paused", {
        error_message: "Server restarted - agent paused, resume manually",
      });
    }

    // Kill orphaned claude processes from previous server run
    await this.killOrphanedProcesses();
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
