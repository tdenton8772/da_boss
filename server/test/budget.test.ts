import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { TokenBudgetManager } from "../src/tokens/budget.js";
import * as queries from "../src/db/queries.js";

describe("TokenBudgetManager", () => {
  let eventBus: EventEmitter;
  let budget: TokenBudgetManager;

  const agentBase = {
    name: "budget-test",
    prompt: "test",
    cwd: "/tmp",
    state: "running" as const,
    priority: "medium" as const,
    permission_mode: "default" as const,
    sdk_session_id: null,
    model: "claude-sonnet-4-6",
    max_turns: null,
    max_budget_usd: null,
    error_message: null,
      supervisor_instructions: "",
      permission_policy: "auto" as const,
  };

  beforeEach(() => {
    eventBus = new EventEmitter();
    budget = new TokenBudgetManager(eventBus);
  });

  describe("canAllocate", () => {
    it("allows allocation when under budget", () => {
      const result = budget.canAllocate("medium");
      expect(result.allowed).toBe(true);
    });

    it("denies low priority at 90%+ daily spend", () => {
      queries.updateBudgetConfig(1.0, 200.0); // $1 daily budget
      queries.insertAgent({ ...agentBase, id: "ag_b1" });
      queries.insertTokenUsage("ag_b1", 10000, 5000, 0, 0, 0.91); // $0.91 of $1.00

      const result = budget.canAllocate("low");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("low priority");
    });

    it("allows high priority at 90%", () => {
      queries.updateBudgetConfig(1.0, 200.0);
      queries.insertAgent({ ...agentBase, id: "ag_b2" });
      queries.insertTokenUsage("ag_b2", 10000, 5000, 0, 0, 0.91);

      const result = budget.canAllocate("high");
      expect(result.allowed).toBe(true);
    });

    it("denies medium at 100%+ daily spend", () => {
      queries.updateBudgetConfig(1.0, 200.0);
      queries.insertAgent({ ...agentBase, id: "ag_b3" });
      queries.insertTokenUsage("ag_b3", 10000, 5000, 0, 0, 1.01);

      const medium = budget.canAllocate("medium");
      expect(medium.allowed).toBe(false);

      const high = budget.canAllocate("high");
      expect(high.allowed).toBe(true);
    });

    it("denies all at 110%+ daily spend (emergency)", () => {
      queries.updateBudgetConfig(1.0, 200.0);
      queries.insertAgent({ ...agentBase, id: "ag_b4" });
      queries.insertTokenUsage("ag_b4", 10000, 5000, 0, 0, 1.11);

      const high = budget.canAllocate("high");
      expect(high.allowed).toBe(false);
      expect(high.reason).toContain("emergency");
    });

    it("denies when monthly budget exceeded", () => {
      queries.updateBudgetConfig(100.0, 5.0); // large daily, small monthly
      queries.insertAgent({ ...agentBase, id: "ag_b5" });
      queries.insertTokenUsage("ag_b5", 10000, 5000, 0, 0, 5.01);

      const result = budget.canAllocate("high");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Monthly");
    });
  });

  describe("getAgentsToPause", () => {
    it("returns empty when under budget", () => {
      expect(budget.getAgentsToPause()).toEqual([]);
    });

    it("pauses low priority agents at 90%+", () => {
      queries.updateBudgetConfig(1.0, 200.0);
      queries.insertAgent({ ...agentBase, id: "ag_lo", priority: "low" as const, state: "running" as const });
      queries.insertAgent({ ...agentBase, id: "ag_hi", priority: "high" as const, state: "running" as const });
      queries.insertTokenUsage("ag_lo", 10000, 5000, 0, 0, 0.91);

      const toPause = budget.getAgentsToPause();
      expect(toPause).toContain("ag_lo");
      expect(toPause).not.toContain("ag_hi");
    });

    it("pauses low + medium at 100%+", () => {
      queries.updateBudgetConfig(1.0, 200.0);
      queries.insertAgent({ ...agentBase, id: "ag_lo2", priority: "low" as const, state: "running" as const });
      queries.insertAgent({ ...agentBase, id: "ag_md", priority: "medium" as const, state: "running" as const });
      queries.insertAgent({ ...agentBase, id: "ag_hi2", priority: "high" as const, state: "running" as const });
      queries.insertTokenUsage("ag_lo2", 10000, 5000, 0, 0, 1.01);

      const toPause = budget.getAgentsToPause();
      expect(toPause).toContain("ag_lo2");
      expect(toPause).toContain("ag_md");
      expect(toPause).not.toContain("ag_hi2");
    });

    it("pauses ALL at 110%+ (emergency)", () => {
      queries.updateBudgetConfig(1.0, 200.0);
      queries.insertAgent({ ...agentBase, id: "ag_e1", priority: "high" as const, state: "running" as const });
      queries.insertAgent({ ...agentBase, id: "ag_e2", priority: "low" as const, state: "running" as const });
      queries.insertTokenUsage("ag_e1", 10000, 5000, 0, 0, 1.11);

      const toPause = budget.getAgentsToPause();
      expect(toPause).toContain("ag_e1");
      expect(toPause).toContain("ag_e2");
    });
  });

  describe("recordUsage", () => {
    it("records usage and emits events", () => {
      queries.insertAgent({ ...agentBase, id: "ag_rec" });

      const events: unknown[] = [];
      eventBus.on("server-event", (e) => events.push(e));

      budget.recordUsage("ag_rec", 1000, 500, 200, 100, 0.05);

      // Should emit token_usage and budget:updated events
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events.some((e: any) => e.type === "agent:token_usage")).toBe(true);
      expect(events.some((e: any) => e.type === "budget:updated")).toBe(true);

      const tokenEvent = events.find((e: any) => e.type === "agent:token_usage") as any;
      expect(tokenEvent.agentId).toBe("ag_rec");
      expect(tokenEvent.costUsd).toBe(0.05);
    });
  });

  describe("getStatus", () => {
    it("returns correct budget status", () => {
      queries.updateBudgetConfig(10.0, 200.0);
      queries.insertAgent({ ...agentBase, id: "ag_st" });
      queries.insertTokenUsage("ag_st", 1000, 500, 0, 0, 3.50);

      const status = budget.getStatus();
      expect(status.config.daily_budget_usd).toBe(10.0);
      expect(status.daily_spend_usd).toBeCloseTo(3.50);
      expect(status.daily_remaining_usd).toBeCloseTo(6.50);
      expect(status.daily_percent).toBeCloseTo(35.0);
    });
  });
});
