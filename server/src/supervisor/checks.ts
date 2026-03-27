import * as queries from "../db/queries.js";
import type { AgentManager } from "../agent/manager.js";
import { sendNotification } from "../notifications/ntfy.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

interface Finding {
  agentId: string;
  type: string;
  message: string;
}

interface Action {
  agentId: string;
  type: string;
  detail: string;
}

export async function runChecks(
  manager: AgentManager
): Promise<{ findings: Finding[]; actions: Action[] }> {
  const findings: Finding[] = [];
  const actions: Action[] = [];

  // Check stuck agents (running with no events for N minutes)
  const running = queries.getAgentsByState("running");
  const now = Date.now();

  for (const agent of running) {
    const lastEvent = queries.getLatestEventTime(agent.id);
    if (lastEvent) {
      const elapsed = now - new Date(lastEvent + "Z").getTime();
      const minutes = elapsed / 60_000;

      if (minutes > config.stuckThresholdMinutes) {
        findings.push({
          agentId: agent.id,
          type: "stuck",
          message: `No activity for ${Math.round(minutes)} minutes`,
        });

        await sendNotification(
          `Agent "${agent.name}" may be stuck`,
          `No activity for ${Math.round(minutes)} minutes. Task: ${agent.prompt.substring(0, 100)}`,
          "high"
        );
      }
    }
  }

  // Check stale permission requests
  const pending = queries.getPendingPermissions();
  for (const perm of pending) {
    const elapsed = now - new Date(perm.created_at + "Z").getTime();
    const minutes = elapsed / 60_000;

    if (minutes > config.permissionTimeoutMinutes) {
      findings.push({
        agentId: perm.agent_id,
        type: "permission_timeout",
        message: `Permission for ${perm.tool_name} pending ${Math.round(minutes)} min`,
      });
    }
  }

  // Check budget enforcement
  const toPause = manager.budgetManager.getAgentsToPause();
  for (const agentId of toPause) {
    const agent = queries.getAgent(agentId);
    if (!agent) continue;

    try {
      await manager.pauseAgent(agentId);
      actions.push({
        agentId,
        type: "budget_pause",
        detail: `Paused ${agent.priority} priority agent due to budget`,
      });

      await sendNotification(
        `Agent "${agent.name}" paused (budget)`,
        `${agent.priority} priority agent paused due to daily budget threshold`,
        "high"
      );
    } catch (err) {
      logger.error({ agentId, err }, "Failed to pause agent for budget");
    }
  }

  // Check idle waiting_input agents
  const waiting = queries.getAgentsByState("waiting_input");
  for (const agent of waiting) {
    const lastEvent = queries.getLatestEventTime(agent.id);
    if (lastEvent) {
      const elapsed = now - new Date(lastEvent + "Z").getTime();
      const minutes = elapsed / 60_000;

      if (minutes > 60) {
        findings.push({
          agentId: agent.id,
          type: "idle_waiting",
          message: `Waiting for input for ${Math.round(minutes)} minutes`,
        });

        await sendNotification(
          `Agent "${agent.name}" needs input`,
          `Waiting for ${Math.round(minutes)} minutes. Task: ${agent.prompt.substring(0, 100)}`,
          "default"
        );
      }
    }
  }

  return { findings, actions };
}
