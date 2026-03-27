import { describe, it, expect } from "vitest";
import * as queries from "../src/db/queries.js";

describe("database queries", () => {
  describe("agents", () => {
    const testAgent = {
      id: "ag_test1234",
      name: "test-agent",
      prompt: "Do something useful",
      cwd: "/tmp/test-repo",
      state: "pending" as const,
      priority: "medium" as const,
      permission_mode: "default" as const,
      sdk_session_id: null,
      model: "claude-sonnet-4-6",
      max_turns: 10,
      max_budget_usd: 5.0,
      error_message: null,
      supervisor_instructions: "",
      permission_policy: "auto" as const,
    };

    it("inserts and retrieves an agent", () => {
      const agent = queries.insertAgent(testAgent);
      expect(agent.id).toBe("ag_test1234");
      expect(agent.name).toBe("test-agent");
      expect(agent.state).toBe("pending");
      expect(agent.created_at).toBeTruthy();

      const fetched = queries.getAgent("ag_test1234");
      expect(fetched).toBeDefined();
      expect(fetched!.prompt).toBe("Do something useful");
    });

    it("returns undefined for non-existent agent", () => {
      expect(queries.getAgent("ag_nonexistent")).toBeUndefined();
    });

    it("lists all agents", () => {
      queries.insertAgent({ ...testAgent, id: "ag_first", name: "first" });
      queries.insertAgent({ ...testAgent, id: "ag_second", name: "second" });
      const all = queries.getAllAgents();
      expect(all).toHaveLength(2);
      const ids = all.map((a) => a.id);
      expect(ids).toContain("ag_first");
      expect(ids).toContain("ag_second");
    });

    it("updates agent state", () => {
      queries.insertAgent(testAgent);
      queries.updateAgentState("ag_test1234", "running", {
        sdk_session_id: "sess-123",
        started_at: "2026-03-27T00:00:00Z",
      });

      const agent = queries.getAgent("ag_test1234")!;
      expect(agent.state).toBe("running");
      expect(agent.sdk_session_id).toBe("sess-123");
      expect(agent.started_at).toBe("2026-03-27T00:00:00Z");
    });

    it("filters agents by state", () => {
      queries.insertAgent({ ...testAgent, id: "ag_1", state: "pending" as const });
      queries.insertAgent({ ...testAgent, id: "ag_2", state: "pending" as const });
      queries.insertAgent({ ...testAgent, id: "ag_3", state: "pending" as const });

      queries.updateAgentState("ag_1", "running");
      queries.updateAgentState("ag_2", "running");

      const running = queries.getAgentsByState("running");
      expect(running).toHaveLength(2);

      const pending = queries.getAgentsByState("pending");
      expect(pending).toHaveLength(1);

      const both = queries.getAgentsByState("running", "pending");
      expect(both).toHaveLength(3);
    });
  });

  describe("agent events", () => {
    it("inserts and retrieves events", () => {
      queries.insertAgent({
        id: "ag_ev",
        name: "events-test",
        prompt: "test",
        cwd: "/tmp",
        state: "pending" as const,
        priority: "medium" as const,
        permission_mode: "default" as const,
        sdk_session_id: null,
        model: "claude-sonnet-4-6",
        max_turns: null,
        max_budget_usd: null,
        error_message: null,
      supervisor_instructions: "",
      permission_policy: "auto" as const,
      });

      queries.insertAgentEvent("ag_ev", "state_change", { from: "pending", to: "running" });
      queries.insertAgentEvent("ag_ev", "message", { role: "assistant", content: "hello" });
      queries.insertAgentEvent("ag_ev", "error", { error: "something broke" });

      const events = queries.getAgentEvents("ag_ev", 10);
      expect(events).toHaveLength(3);
      // Most recent first
      expect(events[0].type).toBe("error");
      expect(JSON.parse(events[0].data)).toEqual({ error: "something broke" });
    });

    it("supports pagination with beforeId", () => {
      queries.insertAgent({
        id: "ag_pg",
        name: "page-test",
        prompt: "test",
        cwd: "/tmp",
        state: "pending" as const,
        priority: "medium" as const,
        permission_mode: "default" as const,
        sdk_session_id: null,
        model: "claude-sonnet-4-6",
        max_turns: null,
        max_budget_usd: null,
        error_message: null,
      supervisor_instructions: "",
      permission_policy: "auto" as const,
      });

      for (let i = 0; i < 5; i++) {
        queries.insertAgentEvent("ag_pg", "message", { index: i });
      }

      const page1 = queries.getAgentEvents("ag_pg", 2);
      expect(page1).toHaveLength(2);

      const page2 = queries.getAgentEvents("ag_pg", 2, page1[page1.length - 1].id);
      expect(page2).toHaveLength(2);
      expect(page2[0].id).toBeLessThan(page1[page1.length - 1].id);
    });

    it("gets latest event time", () => {
      queries.insertAgent({
        id: "ag_lt",
        name: "latest-test",
        prompt: "test",
        cwd: "/tmp",
        state: "pending" as const,
        priority: "medium" as const,
        permission_mode: "default" as const,
        sdk_session_id: null,
        model: "claude-sonnet-4-6",
        max_turns: null,
        max_budget_usd: null,
        error_message: null,
      supervisor_instructions: "",
      permission_policy: "auto" as const,
      });

      expect(queries.getLatestEventTime("ag_lt")).toBeNull();

      queries.insertAgentEvent("ag_lt", "message", { content: "test" });
      const time = queries.getLatestEventTime("ag_lt");
      expect(time).toBeTruthy();
    });
  });

  describe("token usage", () => {
    const agentBase = {
      name: "token-test",
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

    it("records and sums token usage", () => {
      queries.insertAgent({ ...agentBase, id: "ag_tok" });

      queries.insertTokenUsage("ag_tok", 1000, 500, 200, 100, 0.05);
      queries.insertTokenUsage("ag_tok", 2000, 800, 300, 150, 0.08);

      const total = queries.getAgentTotalCost("ag_tok");
      expect(total).toBeCloseTo(0.13);
    });

    it("tracks daily spend", () => {
      queries.insertAgent({ ...agentBase, id: "ag_day" });
      queries.insertTokenUsage("ag_day", 1000, 500, 0, 0, 0.10);
      queries.insertTokenUsage("ag_day", 2000, 1000, 0, 0, 0.20);

      const daily = queries.getDailySpend();
      expect(daily).toBeCloseTo(0.30);
    });

    it("tracks monthly spend", () => {
      queries.insertAgent({ ...agentBase, id: "ag_mon" });
      queries.insertTokenUsage("ag_mon", 1000, 500, 0, 0, 1.50);

      const monthly = queries.getMonthlySpend();
      expect(monthly).toBeCloseTo(1.50);
    });

    it("returns token summaries per agent", () => {
      queries.insertAgent({ ...agentBase, id: "ag_s1" });
      queries.insertAgent({ ...agentBase, id: "ag_s2" });

      queries.insertTokenUsage("ag_s1", 1000, 500, 0, 0, 0.05);
      queries.insertTokenUsage("ag_s1", 2000, 800, 0, 0, 0.08);
      queries.insertTokenUsage("ag_s2", 500, 200, 0, 0, 0.02);

      const summaries = queries.getAgentTokenSummaries();
      expect(summaries).toHaveLength(2);

      const s1 = summaries.find((s) => s.agent_id === "ag_s1")!;
      expect(s1.total_input_tokens).toBe(3000);
      expect(s1.total_output_tokens).toBe(1300);
      expect(s1.total_cost_usd).toBeCloseTo(0.13);
    });
  });

  describe("permissions", () => {
    it("inserts and retrieves permission requests", () => {
      queries.insertAgent({
        id: "ag_perm",
        name: "perm-test",
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
      });

      const req = queries.insertPermissionRequest(
        "ag_perm",
        "Bash",
        { command: "rm -rf /tmp/test" },
        "tu_123"
      );

      expect(req.id).toBeGreaterThan(0);
      expect(req.tool_name).toBe("Bash");
      expect(req.status).toBe("pending");

      const pending = queries.getPendingPermissions();
      expect(pending).toHaveLength(1);
      expect(pending[0].agent_id).toBe("ag_perm");
    });

    it("resolves permission requests", () => {
      queries.insertAgent({
        id: "ag_res",
        name: "resolve-test",
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
      });

      const req = queries.insertPermissionRequest(
        "ag_res",
        "Edit",
        { file_path: "/tmp/test.ts" },
        "tu_456"
      );

      queries.resolvePermission(req.id, "approved");

      const perm = queries.getPermission(req.id)!;
      expect(perm.status).toBe("approved");
      expect(perm.resolved_at).toBeTruthy();

      const pending = queries.getPendingPermissions();
      expect(pending).toHaveLength(0);
    });
  });

  describe("budget config", () => {
    it("returns default budget config", () => {
      const config = queries.getBudgetConfig();
      expect(config.daily_budget_usd).toBe(10.0);
      expect(config.monthly_budget_usd).toBe(200.0);
    });

    it("updates budget config", () => {
      queries.updateBudgetConfig(25.0, 500.0);
      const config = queries.getBudgetConfig();
      expect(config.daily_budget_usd).toBe(25.0);
      expect(config.monthly_budget_usd).toBe(500.0);
    });
  });

  describe("supervisor runs", () => {
    it("inserts and completes a supervisor run", () => {
      const id = queries.insertSupervisorRun();
      expect(id).toBeGreaterThan(0);

      queries.completeSupervisorRun(
        id,
        [{ agentId: "ag_1", type: "stuck", message: "no activity" }],
        [{ agentId: "ag_1", type: "notify", detail: "sent notification" }]
      );
    });
  });
});
