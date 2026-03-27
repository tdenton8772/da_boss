import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
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
  const now = Date.now();

  // ── Check stuck agents ────────────────────────────────
  const running = queries.getAgentsByState("running");
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

  // ── Check stale permission requests ───────────────────
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

  // ── Check budget enforcement ──────────────────────────
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

  // ── Check completed agents with supervisor instructions ─
  const completed = queries.getAgentsByState("completed");
  for (const agent of completed) {
    if (!agent.supervisor_instructions) continue;

    try {
      const decision = await evaluateAgent(agent.id, agent.name, agent.prompt, agent.supervisor_instructions);

      if (decision.action === "continue") {
        // Send input to continue the agent
        await manager.sendInput(agent.id, decision.message);
        actions.push({
          agentId: agent.id,
          type: "supervisor_continue",
          detail: `Supervisor continued agent: ${decision.message.substring(0, 100)}`,
        });
        logger.info({ agentId: agent.id }, "Supervisor continued agent");
      } else if (decision.action === "notify") {
        await sendNotification(
          `Agent "${agent.name}" needs attention`,
          decision.message,
          "default"
        );
        findings.push({
          agentId: agent.id,
          type: "needs_attention",
          message: decision.message,
        });
      }
      // "done" = no action needed
    } catch (err) {
      logger.error({ agentId: agent.id, err }, "Supervisor evaluation failed");
    }
  }

  // ── Check idle waiting_input agents ───────────────────
  const waiting = queries.getAgentsByState("waiting_input");
  for (const agent of waiting) {
    const lastEvent = queries.getLatestEventTime(agent.id);
    if (!lastEvent) continue;

    const elapsed = now - new Date(lastEvent + "Z").getTime();
    const minutes = elapsed / 60_000;

    // If agent has supervisor instructions and has been idle > 2 min, evaluate
    if (agent.supervisor_instructions && minutes > 2) {
      try {
        const decision = await evaluateAgent(agent.id, agent.name, agent.prompt, agent.supervisor_instructions);
        if (decision.action === "continue") {
          await manager.sendInput(agent.id, decision.message);
          actions.push({
            agentId: agent.id,
            type: "supervisor_input",
            detail: `Supervisor provided input: ${decision.message.substring(0, 100)}`,
          });
          continue; // Skip idle warning
        } else if (decision.action === "done") {
          // Mark agent as completed
          queries.updateAgentState(agent.id, "completed", {
            completed_at: new Date().toISOString(),
          });
          actions.push({
            agentId: agent.id,
            type: "supervisor_complete",
            detail: `Supervisor marked done: ${decision.message.substring(0, 100)}`,
          });
          continue; // Skip idle warning
        } else if (decision.action === "notify") {
          findings.push({
            agentId: agent.id,
            type: "needs_attention",
            message: decision.message,
          });
          await sendNotification(
            `Agent "${agent.name}" needs attention`,
            decision.message,
            "default"
          );
          continue; // Skip generic idle warning
        }
      } catch (err) {
        logger.error({ agentId: agent.id, err }, "Supervisor input evaluation failed");
      }
    }

    // No supervisor instructions or evaluation didn't handle it — warn if idle too long
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

  return { findings, actions };
}

interface SupervisorDecision {
  action: "continue" | "notify" | "done";
  message: string;
}

async function evaluateAgent(
  agentId: string,
  agentName: string,
  originalPrompt: string,
  instructions: string
): Promise<SupervisorDecision> {
  // Get recent messages for context
  const recentEvents = queries.getAgentEvents(agentId, 20);
  const recentMessages = recentEvents
    .filter((e) => e.type === "message")
    .reverse()
    .map((e) => {
      const data = JSON.parse(e.data);
      return `[${data.role}]: ${(data.content || "").substring(0, 300)}`;
    })
    .join("\n");

  const prompt = `You are a supervisor managing an AI coding agent. Evaluate whether this agent needs further instructions or is done.

AGENT: "${agentName}"
ORIGINAL TASK: ${originalPrompt.substring(0, 500)}

SUPERVISOR INSTRUCTIONS:
${instructions}

RECENT AGENT OUTPUT:
${recentMessages || "(no messages yet)"}

Based on the supervisor instructions, decide what to do:
- If the agent should continue with a new task or next step per the instructions, respond with: ACTION: continue
  Then on the next line: MESSAGE: <the instruction to send to the agent>
- If the agent needs human attention (ambiguous situation, error, etc), respond with: ACTION: notify
  Then on the next line: MESSAGE: <what to tell the human>
- If the agent has completed everything in the instructions, respond with: ACTION: done
  Then on the next line: MESSAGE: <summary>

Respond with ONLY the ACTION and MESSAGE lines, nothing else.`;

  try {
    let result = "";
    for await (const msg of sdkQuery({
      prompt,
      options: {
        maxTurns: 1,
        maxBudgetUsd: 0.05,
        model: "claude-haiku-4-5-20251001", // fast + cheap for supervisor decisions
      },
    })) {
      if ("type" in msg && msg.type === "result" && "result" in msg) {
        result = (msg as { result: string }).result || "";
      }
    }

    // Parse the response
    const actionMatch = result.match(/ACTION:\s*(continue|notify|done)/i);
    const messageMatch = result.match(/MESSAGE:\s*(.+)/is);

    const action = (actionMatch?.[1]?.toLowerCase() || "notify") as SupervisorDecision["action"];
    const message = messageMatch?.[1]?.trim() || "Supervisor could not determine next action";

    logger.info({ agentId, action, message: message.substring(0, 100) }, "Supervisor evaluation result");

    return { action, message };
  } catch (err) {
    logger.error({ agentId, err }, "Supervisor Claude call failed");
    return { action: "notify", message: "Supervisor evaluation failed - needs human review" };
  }
}
