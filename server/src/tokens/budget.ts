import { EventEmitter } from "node:events";
import * as queries from "../db/queries.js";
import type { BudgetStatus } from "../types/token.js";
import type { PriorityTier } from "../types/agent.js";
import type { ServerEvent } from "../types/events.js";
import { getEffectiveUtilization, recordTokensConsumed } from "../api/usage.js";
import { logger } from "../utils/logger.js";

export class TokenBudgetManager {
  constructor(private eventBus: EventEmitter) {}

  recordUsage(
    agentId: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadInputTokens: number,
    cacheCreationInputTokens: number,
    costUsd: number
  ): void {
    queries.insertTokenUsage(
      agentId,
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      costUsd
    );

    // Feed predictive utilization tracking
    recordTokensConsumed(inputTokens + outputTokens);

    const agentTotal = queries.getAgentTotalCost(agentId);

    const event: ServerEvent = {
      type: "agent:token_usage",
      agentId,
      inputTokens,
      outputTokens,
      costUsd,
      totalCostUsd: agentTotal,
    };
    this.eventBus.emit("server-event", event);

    this.broadcastBudgetStatus();
  }

  canAllocate(priority: PriorityTier): { allowed: boolean; reason?: string } {
    const status = this.getStatus();

    // 5-hour window (treated as "daily" in the legacy field name)
    if (status.daily_percent >= 100) {
      return { allowed: false, reason: `5-hour usage at ${status.daily_percent.toFixed(0)}% of your ${status.config.daily_budget_usd}% threshold` };
    }
    if (status.daily_percent >= 90 && priority === "low") {
      return { allowed: false, reason: `5-hour usage at ${status.daily_percent.toFixed(0)}%, low priority agents paused` };
    }

    // 7-day window (treated as "monthly" in the legacy field name)
    if (status.monthly_percent >= 100) {
      return { allowed: false, reason: `Weekly usage at ${status.monthly_percent.toFixed(0)}% of your ${status.config.monthly_budget_usd}% threshold` };
    }

    return { allowed: true };
  }

  /**
   * Returns list of agent IDs that should be paused based on budget.
   */
  getAgentsToPause(): string[] {
    const status = this.getStatus();
    const toPause: string[] = [];

    if (status.daily_percent < 90) return toPause;

    const runningAgents = queries.getAgentsByState("running");

    for (const agent of runningAgents) {
      if (status.daily_percent >= 110) {
        // Emergency: pause all
        toPause.push(agent.id);
      } else if (status.daily_percent >= 100 && agent.priority !== "high") {
        // Over budget: pause low + medium
        toPause.push(agent.id);
      } else if (status.daily_percent >= 90 && agent.priority === "low") {
        // Approaching: pause low only
        toPause.push(agent.id);
      }
    }

    return toPause;
  }

  getStatus(): BudgetStatus {
    const budgetConfig = queries.getBudgetConfig();
    // Reinterpret budget config as percentage thresholds.
    // daily_budget_usd  = 5-hour utilization threshold (default 80)
    // monthly_budget_usd = weekly utilization threshold (default 80)
    const util = getEffectiveUtilization();
    const fiveHourThreshold = budgetConfig.daily_budget_usd;
    const sevenDayThreshold = budgetConfig.monthly_budget_usd;

    // daily_percent = how close we are to the threshold (5h util / threshold * 100)
    const dailyPercent = fiveHourThreshold > 0 ? (util.fivehour / fiveHourThreshold) * 100 : 0;
    const monthlyPercent = sevenDayThreshold > 0 ? (util.sevenday / sevenDayThreshold) * 100 : 0;

    return {
      config: budgetConfig,
      daily_spend_usd: util.fivehour,
      monthly_spend_usd: util.sevenday,
      daily_remaining_usd: Math.max(0, fiveHourThreshold - util.fivehour),
      monthly_remaining_usd: Math.max(0, sevenDayThreshold - util.sevenday),
      daily_percent: dailyPercent,
      monthly_percent: monthlyPercent,
    };
  }

  private broadcastBudgetStatus(): void {
    const status = this.getStatus();
    const event: ServerEvent = {
      type: "budget:updated",
      dailySpendUsd: status.daily_spend_usd,
      dailyBudgetUsd: status.config.daily_budget_usd,
      monthlySpendUsd: status.monthly_spend_usd,
      monthlyBudgetUsd: status.config.monthly_budget_usd,
    };
    this.eventBus.emit("server-event", event);
  }
}
