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
import * as queries from "../db/queries.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

export class AgentManager {
  private runners = new Map<string, AgentRunner>();
  public budgetManager: TokenBudgetManager;

  constructor(public eventBus: EventEmitter) {
    this.budgetManager = new TokenBudgetManager(eventBus);
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
      this.budgetManager
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

    // Re-start will use the stored sdk_session_id via the resume option
    await this.startAgent(agentId);
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
    const runner = this.runners.get(agentId);
    if (runner) {
      await runner.sendInput(message);
      return;
    }

    // No active runner — if agent is completed/paused, resume with the new message as prompt
    const agent = queries.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    if (["completed", "paused", "failed"].includes(agent.state) && agent.sdk_session_id) {
      // Update the prompt to the new message and resume
      queries.updateAgentState(agentId, agent.state as any, {});
      const db = (await import("../db/index.js")).getDb();
      db.prepare("UPDATE agents SET prompt = ?, updated_at = datetime('now') WHERE id = ?").run(message, agentId);
      await this.startAgent(agentId);
      return;
    }

    throw new Error(`No active runner for agent ${agentId}`);
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
