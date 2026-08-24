import { EventEmitter } from "node:events";
import * as queries from "../db/queries.js";
import type { BudgetStatus } from "../types/token.js";
import type { PriorityTier } from "../types/agent.js";
import type { ServerEvent } from "../types/events.js";
import { logger } from "../utils/logger.js";

export class TokenBudgetManager {
  constructor(private eventBus: EventEmitter) {}

  async recordUsage(
    agentId: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadInputTokens: number,
    cacheCreationInputTokens: number,
    costUsd: number
  ): Promise<void> {
    await queries.insertTokenUsage(
      agentId,
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      costUsd
    );

    const agentTotal = await queries.getAgentTotalCost(agentId);

    const event: ServerEvent = {
      type: "agent:token_usage",
      agentId,
      inputTokens,
      outputTokens,
      costUsd,
      totalCostUsd: agentTotal,
    };
    this.eventBus.emit("server-event", event);

    await this.broadcastBudgetStatus();
  }

  async canAllocate(priority: PriorityTier): Promise<{ allowed: boolean; reason?: string }> {
    const status = await this.getStatus();

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
   * Agents that should be paused, with WHY. Two tiers:
   *  - GLOBAL fleet ceiling (budget_config daily): the priority ladder below.
   *  - PER-USER caps (user override ?? config default; NULL = uncapped): each
   *    user's spend on their OWN credential vs their own cap — one user's burn
   *    never pauses another user's agents at this tier.
   */
  async getAgentsToPause(): Promise<Array<{ agentId: string; reason: string }>> {
    const status = await this.getStatus();
    const toPause = new Map<string, string>();

    const runningAgents = await queries.getAgentsByState("running");

    // ── Global fleet ceiling (priority ladder) ──
    if (status.daily_percent >= 90) {
      for (const agent of runningAgents) {
        if (status.daily_percent >= 110) {
          toPause.set(agent.id, `global daily budget emergency (${Math.round(status.daily_percent)}% of $${status.config.daily_budget_usd})`);
        } else if (status.daily_percent >= 100 && agent.priority !== "high") {
          toPause.set(agent.id, `global daily budget reached ($${status.config.daily_budget_usd})`);
        } else if (status.daily_percent >= 90 && agent.priority === "low") {
          toPause.set(agent.id, `approaching global daily budget (${Math.round(status.daily_percent)}% of $${status.config.daily_budget_usd})`);
        }
      }
    }

    // ── Per-user caps ──
    const overrides = await queries.getUserBudgetOverrides();
    const spend = new Map((await queries.getSpendByUser()).map((s) => [s.user_id, s]));
    for (const u of overrides) {
      const dailyCap = u.daily_budget_usd ?? status.config.user_daily_default_usd;
      const monthlyCap = u.monthly_budget_usd ?? status.config.user_monthly_default_usd;
      if (dailyCap == null && monthlyCap == null) continue;
      const s = spend.get(u.id);
      if (!s) continue;
      let reason: string | null = null;
      if (dailyCap != null && s.daily >= dailyCap) {
        reason = `${u.email}'s daily budget reached ($${s.daily.toFixed(2)} of $${dailyCap})`;
      } else if (monthlyCap != null && s.monthly >= monthlyCap) {
        reason = `${u.email}'s monthly budget reached ($${s.monthly.toFixed(2)} of $${monthlyCap})`;
      }
      if (!reason) continue;
      for (const agent of runningAgents) {
        if (agent.created_by_user_id === u.id && !toPause.has(agent.id)) {
          toPause.set(agent.id, reason);
        }
      }
    }

    return [...toPause.entries()].map(([agentId, reason]) => ({ agentId, reason }));
  }

  /** Admin view: every user's spend vs their effective caps. */
  async getUserBudgets(): Promise<import("../types/token.js").UserBudget[]> {
    const [config, overrides, spendRows] = await Promise.all([
      queries.getBudgetConfig(),
      queries.getUserBudgetOverrides(),
      queries.getSpendByUser(),
    ]);
    const spend = new Map(spendRows.map((s) => [s.user_id, s]));
    return overrides.map((u) => {
      const s = spend.get(u.id);
      return {
        user_id: u.id,
        email: u.email,
        daily_spend_usd: s?.daily ?? 0,
        monthly_spend_usd: s?.monthly ?? 0,
        daily_budget_usd: u.daily_budget_usd,
        monthly_budget_usd: u.monthly_budget_usd,
        effective_daily_usd: u.daily_budget_usd ?? config.user_daily_default_usd,
        effective_monthly_usd: u.monthly_budget_usd ?? config.user_monthly_default_usd,
      };
    });
  }

  async getStatus(): Promise<BudgetStatus> {
    const [budgetConfig, dailySpend, monthlySpend] = await Promise.all([
      queries.getBudgetConfig(),
      queries.getDailySpend(),
      queries.getMonthlySpend(),
    ]);

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

  private async broadcastBudgetStatus(): Promise<void> {
    const status = await this.getStatus();
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
