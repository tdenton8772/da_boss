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

    // Create a runner and start a new turn with the user's message
    const activeCount = this.getActiveCount();
    if (activeCount >= config.maxConcurrentAgents) {
      throw new Error(`Max concurrent agents (${config.maxConcurrentAgents}) reached`);
    }

    const runner = new AgentRunner(agentId, this.eventBus, this.budgetManager, this.taskMonitor);
    this.runners.set(agentId, runner);

    runner.resumeWithInput(message).catch((err) => {
      logger.error({ agentId, error: err.message }, "Resume with input failed");
    }).finally(() => {
      if (this.runners.get(agentId) === runner) {
        this.runners.delete(agentId);
      }
    });
  }

  /** Resume an agent with a system notification (no user message emitted to UI). */
  private async resumeWithNotification(agentId: string, notification: string): Promise<void> {
    const agent = queries.getAgent(agentId);
    if (!agent) return;
    if (!agent.sdk_session_id) return;
    if (agent.state !== "waiting_input") return;

    const activeCount = this.getActiveCount();
    if (activeCount >= config.maxConcurrentAgents) {
      logger.warn({ agentId }, "Cannot auto-resume: max concurrent agents reached");
      return;
    }

    const runner = new AgentRunner(agentId, this.eventBus, this.budgetManager, this.taskMonitor);
    this.runners.set(agentId, runner);

    // Use runTurn directly — sends the notification as the prompt without emitting it as a user message
    runner.runTurn(notification, true).catch((err) => {
      logger.error({ agentId, error: err.message }, "Auto-resume after task completion failed");
    }).finally(() => {
      if (this.runners.get(agentId) === runner) {
        this.runners.delete(agentId);
      }
    });
  }

  resolvePermission(
    requestId: number,
    decision: "approved" | "denied"
  ): boolean {
    return resolvePermissionRequest(requestId, decision, this.eventBus);
  }

  getActiveCount(): number {
    let count = 0;
    for (const runner of this.runners.values()) {
      if (runner.running) count++;
    }
    return count;
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
  }
}
