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

    it("inserts and retrieves an agent", async () => {
      const agent = await queries.insertAgent(testAgent);
      expect(agent.id).toBe("ag_test1234");
      expect(agent.name).toBe("test-agent");
      expect(agent.state).toBe("pending");
      expect(agent.created_at).toBeTruthy();

      const fetched = await queries.getAgent("ag_test1234");
      expect(fetched).toBeDefined();
      expect(fetched!.prompt).toBe("Do something useful");
    });

    it("returns undefined for non-existent agent", async () => {
      expect(await queries.getAgent("ag_nonexistent")).toBeUndefined();
    });

    it("persists the branch override + adopted_ref when adopting a PR/branch", async () => {
      await queries.insertAgent({ ...testAgent, id: "ag_adopt", branch: "fix/audit-alerts-gcloud-flags", adopted_ref: "PR #17" });
      const a = await queries.getAgent("ag_adopt");
      expect(a!.branch).toBe("fix/audit-alerts-gcloud-flags");
      expect(a!.adopted_ref).toBe("PR #17");
    });

    it("leaves adopted_ref null for a normal computed-branch agent", async () => {
      await queries.insertAgent({ ...testAgent, id: "ag_normal", branch: "feat/x/task" });
      const a = await queries.getAgent("ag_normal");
      expect(a!.adopted_ref ?? null).toBeNull();
    });

    it("lists all agents", async () => {
      await queries.insertAgent({ ...testAgent, id: "ag_first", name: "first" });
      await queries.insertAgent({ ...testAgent, id: "ag_second", name: "second" });
      const all = await queries.getAllAgents();
      expect(all).toHaveLength(2);
      const ids = all.map((a) => a.id);
      expect(ids).toContain("ag_first");
      expect(ids).toContain("ag_second");
    });

    it("updates agent state", async () => {
      await queries.insertAgent(testAgent);
      await queries.updateAgentState("ag_test1234", "running", {
        sdk_session_id: "sess-123",
        started_at: "2026-03-27T00:00:00Z",
      });

      const agent = await queries.getAgent("ag_test1234")!;
      expect(agent.state).toBe("running");
      expect(agent.sdk_session_id).toBe("sess-123");
      expect(new Date(agent.started_at!).toISOString()).toBe("2026-03-27T00:00:00.000Z");
    });

    it("filters agents by state", async () => {
      await queries.insertAgent({ ...testAgent, id: "ag_1", state: "pending" as const });
      await queries.insertAgent({ ...testAgent, id: "ag_2", state: "pending" as const });
      await queries.insertAgent({ ...testAgent, id: "ag_3", state: "pending" as const });

      await queries.updateAgentState("ag_1", "running");
      await queries.updateAgentState("ag_2", "running");

      const running = await queries.getAgentsByState("running");
      expect(running).toHaveLength(2);

      const pending = await queries.getAgentsByState("pending");
      expect(pending).toHaveLength(1);

      const both = await queries.getAgentsByState("running", "pending");
      expect(both).toHaveLength(3);
    });
  });

  describe("agent events", () => {
    it("inserts and retrieves events", async () => {
      await queries.insertAgent({
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

      await queries.insertAgentEvent("ag_ev", "state_change", { from: "pending", to: "running" });
      await queries.insertAgentEvent("ag_ev", "message", { role: "assistant", content: "hello" });
      await queries.insertAgentEvent("ag_ev", "error", { error: "something broke" });

      const events = await queries.getAgentEvents("ag_ev", 10);
      expect(events).toHaveLength(3);
      // Most recent first
      expect(events[0].type).toBe("error");
      expect(JSON.parse(events[0].data)).toEqual({ error: "something broke" });
    });

    it("supports pagination with beforeId", async () => {
      await queries.insertAgent({
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
        await queries.insertAgentEvent("ag_pg", "message", { index: i });
      }

      const page1 = await queries.getAgentEvents("ag_pg", 2);
      expect(page1).toHaveLength(2);

      const page2 = await queries.getAgentEvents("ag_pg", 2, page1[page1.length - 1].id);
      expect(page2).toHaveLength(2);
      expect(page2[0].id).toBeLessThan(page1[page1.length - 1].id);
    });

    it("gets latest event time", async () => {
      await queries.insertAgent({
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

      expect(await queries.getLatestEventTime("ag_lt")).toBeNull();

      await queries.insertAgentEvent("ag_lt", "message", { content: "test" });
      const time = await queries.getLatestEventTime("ag_lt");
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

    it("records and sums token usage", async () => {
      await queries.insertAgent({ ...agentBase, id: "ag_tok" });

      await queries.insertTokenUsage("ag_tok", 1000, 500, 200, 100, 0.05);
      await queries.insertTokenUsage("ag_tok", 2000, 800, 300, 150, 0.08);

      const total = await queries.getAgentTotalCost("ag_tok");
      expect(total).toBeCloseTo(0.13);
    });

    it("tracks daily spend", async () => {
      await queries.insertAgent({ ...agentBase, id: "ag_day" });
      await queries.insertTokenUsage("ag_day", 1000, 500, 0, 0, 0.10);
      await queries.insertTokenUsage("ag_day", 2000, 1000, 0, 0, 0.20);

      const daily = await queries.getDailySpend();
      expect(daily).toBeCloseTo(0.30);
    });

    it("tracks monthly spend", async () => {
      await queries.insertAgent({ ...agentBase, id: "ag_mon" });
      await queries.insertTokenUsage("ag_mon", 1000, 500, 0, 0, 1.50);

      const monthly = await queries.getMonthlySpend();
      expect(monthly).toBeCloseTo(1.50);
    });

    it("returns token summaries per agent", async () => {
      await queries.insertAgent({ ...agentBase, id: "ag_s1" });
      await queries.insertAgent({ ...agentBase, id: "ag_s2" });

      await queries.insertTokenUsage("ag_s1", 1000, 500, 0, 0, 0.05);
      await queries.insertTokenUsage("ag_s1", 2000, 800, 0, 0, 0.08);
      await queries.insertTokenUsage("ag_s2", 500, 200, 0, 0, 0.02);

      const summaries = await queries.getAgentTokenSummaries();
      expect(summaries).toHaveLength(2);

      const s1 = summaries.find((s) => s.agent_id === "ag_s1")!;
      expect(s1.total_input_tokens).toBe(3000);
      expect(s1.total_output_tokens).toBe(1300);
      expect(s1.total_cost_usd).toBeCloseTo(0.13);
    });
  });

  describe("permissions", () => {
    it("inserts and retrieves permission requests", async () => {
      await queries.insertAgent({
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

      const req = await queries.insertPermissionRequest(
        "ag_perm",
        "Bash",
        { command: "rm -rf /tmp/test" },
        "tu_123"
      );

      expect(req.id).toBeGreaterThan(0);
      expect(req.tool_name).toBe("Bash");
      expect(req.status).toBe("pending");

      const pending = await queries.getPendingPermissions();
      expect(pending).toHaveLength(1);
      expect(pending[0].agent_id).toBe("ag_perm");
    });

    it("resolves permission requests", async () => {
      await queries.insertAgent({
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

      const req = await queries.insertPermissionRequest(
        "ag_res",
        "Edit",
        { file_path: "/tmp/test.ts" },
        "tu_456"
      );

      await queries.resolvePermission(req.id, "approved");

      const perm = await queries.getPermission(req.id)!;
      expect(perm.status).toBe("approved");
      expect(perm.resolved_at).toBeTruthy();

      const pending = await queries.getPendingPermissions();
      expect(pending).toHaveLength(0);
    });
  });

  describe("budget config", () => {
    it("returns default budget config", async () => {
      const config = await queries.getBudgetConfig();
      expect(config.daily_budget_usd).toBe(10.0);
      expect(config.monthly_budget_usd).toBe(200.0);
    });

    it("updates budget config", async () => {
      await queries.updateBudgetConfig(25.0, 500.0);
      const config = await queries.getBudgetConfig();
      expect(config.daily_budget_usd).toBe(25.0);
      expect(config.monthly_budget_usd).toBe(500.0);
    });
  });

  describe("supervisor runs", () => {
    it("inserts and completes a supervisor run", async () => {
      const id = await queries.insertSupervisorRun();
      expect(id).toBeGreaterThan(0);

      await queries.completeSupervisorRun(
        id,
        [{ agentId: "ag_1", type: "stuck", message: "no activity" }],
        [{ agentId: "ag_1", type: "notify", detail: "sent notification" }]
      );
    });
  });

  describe("sidecar C2", () => {
    const agentBase = {
      name: "a", prompt: "p", cwd: "/tmp", state: "running" as const,
      priority: "medium" as const, permission_mode: "default" as const,
      sdk_session_id: null, model: "claude-sonnet-4-6", max_turns: null,
      max_budget_usd: null, error_message: null, supervisor_instructions: "",
      permission_policy: "auto" as const,
    };

    it("delivers commands via the durable log (catch-up read)", async () => {
      await queries.insertAgent({ ...agentBase, id: "ag_cmd" });
      const cmd = await queries.insertAgentCommand("ag_cmd", "snapshot", { why: "test" });
      expect(cmd.status).toBe("pending");

      const pending = await queries.getPendingCommands("ag_cmd");
      expect(pending.map((c) => c.command)).toEqual(["snapshot"]);

      await queries.completeCommand(cmd.id, "done");
      expect(await queries.getPendingCommands("ag_cmd")).toHaveLength(0);
    });

    it("flags a running agent whose heartbeat went stale", async () => {
      await queries.insertAgent({ ...agentBase, id: "ag_beat" });
      await queries.insertAgent({ ...agentBase, id: "ag_nobeat" }); // never beat → not flagged
      await queries.updateAgentHeartbeat("ag_beat");

      // nothing stale as of now
      expect(await queries.getStaleHeartbeatAgents(new Date(Date.now() - 60_000).toISOString())).toHaveLength(0);
      // everything that beat is stale relative to the far future
      const stale = await queries.getStaleHeartbeatAgents(new Date(Date.now() + 60_000).toISOString());
      expect(stale.map((a) => a.id)).toEqual(["ag_beat"]);
    });
  });

  describe("freeze-leases", () => {
    const base = {
      name: "a", prompt: "p", cwd: "/tmp", state: "running" as const,
      priority: "medium" as const, permission_mode: "default" as const,
      sdk_session_id: null, model: "claude-sonnet-4-6", max_turns: null,
      max_budget_usd: null, error_message: null, supervisor_instructions: "",
      permission_policy: "auto" as const,
    };
    const REPO = "https://github.com/o/r";

    it("acquires (idempotently) and reports a conflict with another agent", async () => {
      await queries.insertAgent({ ...base, id: "ag_jimmy" });
      await queries.insertAgent({ ...base, id: "ag_johnny" });

      await queries.acquireLeases("ag_jimmy", REPO, ["apply", "helper"]);
      await queries.acquireLeases("ag_jimmy", REPO, ["apply"]); // idempotent
      expect(await queries.getActiveLeasesForAgent("ag_jimmy")).toEqual([`${REPO}#apply`, `${REPO}#helper`]);

      // Johnny wants apply (conflict) + newthing (free)
      const conflicts = await queries.getLeaseConflicts(REPO, ["apply", "newthing"], "ag_johnny");
      expect(conflicts.map((c) => c.resource_ref)).toEqual([`${REPO}#apply`]);
      // ...but Jimmy checking his own held symbol sees no conflict
      expect(await queries.getLeaseConflicts(REPO, ["apply"], "ag_jimmy")).toHaveLength(0);
    });

    it("release frees the territory", async () => {
      await queries.insertAgent({ ...base, id: "ag_j2" });
      await queries.insertAgent({ ...base, id: "ag_k2" });
      await queries.acquireLeases("ag_j2", REPO, ["apply"]);
      await queries.releaseLeases("ag_j2");
      expect(await queries.getActiveLeasesForAgent("ag_j2")).toHaveLength(0);
      expect(await queries.getLeaseConflicts(REPO, ["apply"], "ag_k2")).toHaveLength(0);
    });

    it("reclaims leases from a stale (dead) holder", async () => {
      await queries.insertAgent({ ...base, id: "ag_dead" });
      await queries.acquireLeases("ag_dead", REPO, ["apply"]);
      // nothing stale as of an hour ago; everything stale relative to the far future
      expect(await queries.reclaimStaleLeases(new Date(Date.now() - 3_600_000).toISOString())).toHaveLength(0);
      const reclaimed = await queries.reclaimStaleLeases(new Date(Date.now() + 60_000).toISOString());
      expect(reclaimed.map((r) => r.resource_ref)).toEqual([`${REPO}#apply`]);
      expect(await queries.getActiveLeasesForAgent("ag_dead")).toHaveLength(0);
    });
  });

  describe("user offboarding", () => {
    const agentBase = {
      name: "a", prompt: "p", cwd: "/tmp", state: "pending" as const,
      priority: "medium" as const, permission_mode: "default" as const,
      sdk_session_id: null, model: "claude-sonnet-4-6", max_turns: null,
      max_budget_usd: null, error_message: null, supervisor_instructions: "",
      permission_policy: "auto" as const,
    };

    it("lists users with their agent counts", async () => {
      await queries.createUser({ id: "usr_a", email: "a@x.io", role: "admin" });
      await queries.createUser({ id: "usr_b", email: "b@x.io" });
      await queries.insertAgent({ ...agentBase, id: "ag_a1", created_by_user_id: "usr_a" });
      await queries.insertAgent({ ...agentBase, id: "ag_a2", created_by_user_id: "usr_a" });

      const rows = await queries.listUsersWithAgentCounts();
      const a = rows.find((r) => r.id === "usr_a");
      const b = rows.find((r) => r.id === "usr_b");
      expect(a?.agent_count).toBe(2);
      expect(a?.role).toBe("admin");
      expect(b?.agent_count).toBe(0);
    });

    it("getAgentsByUser returns only that user's agents", async () => {
      await queries.createUser({ id: "usr_a", email: "a@x.io" });
      await queries.createUser({ id: "usr_b", email: "b@x.io" });
      await queries.insertAgent({ ...agentBase, id: "ag_a1", created_by_user_id: "usr_a" });
      await queries.insertAgent({ ...agentBase, id: "ag_b1", created_by_user_id: "usr_b" });

      const mine = await queries.getAgentsByUser("usr_a");
      expect(mine.map((a) => a.id)).toEqual(["ag_a1"]);
    });

    it("deleteUser removes creds + user but preserves audit history (nulled linkage)", async () => {
      await queries.createUser({ id: "usr_a", email: "a@x.io" });
      await queries.upsertUserCredential("usr_a", "anthropic_api_key", {
        ciphertext: "c", nonce: "n", keyRef: "local:v1",
      });
      await queries.upsertUserGitCredential("usr_a", { ciphertext: "c", nonce: "n", keyRef: "local:v1" });
      await queries.insertAuditLog(null, "agent.create", "agent", "ag_x", "n", "usr_a");

      // Must not throw: an audit row references usr_a via FK; deleteUser nulls
      // that linkage first so the history survives instead of blocking the delete.
      await queries.deleteUser("usr_a");

      expect(await queries.getUserById("usr_a")).toBeUndefined();
      expect(await queries.getUserCredential("usr_a")).toBeUndefined();
      expect(await queries.getUserGitCredential("usr_a")).toBeUndefined();
    });
  });
});
