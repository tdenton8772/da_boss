import { EventEmitter } from "node:events";
import * as queries from "../db/queries.js";
import type { BudgetStatus } from "../types/token.js";
import type { PriorityTier } from "../types/agent.js";
import type { ServerEvent } from "../types/events.js";
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

    // Emergency: over 110% daily
    if (status.daily_percent >= 110) {
      return { allowed: false, reason: "Daily budget exceeded (emergency)" };
    }

    // Over 100%: only high priority
    if (status.daily_percent >= 100 && priority !== "high") {
      return {
        allowed: false,
        reason: "Daily budget reached, only high priority agents allowed",
      };
    }

    // Over 90%: only high and medium
    if (status.daily_percent >= 90 && priority === "low") {
      return {
        allowed: false,
        reason: "Approaching daily budget limit, low priority agents paused",
      };
    }

    // Monthly check
    if (status.monthly_percent >= 100) {
      return { allowed: false, reason: "Monthly budget exceeded" };
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
    const dailySpend = queries.getDailySpend();
    const monthlySpend = queries.getMonthlySpend();

    return {
      config: budgetConfig,
      daily_spend_usd: dailySpend,
      monthly_spend_usd: monthlySpend,
      daily_remaining_usd: Math.max(
        0,
        budgetConfig.daily_budget_usd - dailySpend
      ),
      monthly_remaining_usd: Math.max(
        0,
        budgetConfig.monthly_budget_usd - monthlySpend
      ),
      daily_percent:
        budgetConfig.daily_budget_usd > 0
          ? (dailySpend / budgetConfig.daily_budget_usd) * 100
          : 0,
      monthly_percent:
        budgetConfig.monthly_budget_usd > 0
          ? (monthlySpend / budgetConfig.monthly_budget_usd) * 100
          : 0,
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
