import { describe, it, expect } from "vitest";
import * as queries from "../src/db/queries.js";

const agentBase = {
  name: "a", prompt: "p", cwd: "/work", state: "failed" as const,
  priority: "medium" as const, permission_mode: "default" as const,
  sdk_session_id: "sess_1", model: "claude-sonnet-5", max_turns: null,
  max_budget_usd: null, error_message: null, supervisor_instructions: "",
  permission_policy: "auto" as const, repo_url: "https://github.com/o/r.git",
  repo_ref: "main", branch: "feat/x", service_account: null, worker_image: null,
  adopted_ref: null,
};

describe("agent ownership transfer", () => {
  it("moves the agent to the new owner — credential/billing/workspace follow created_by_user_id", async () => {
    await queries.createUser({ id: "usr_paul", email: "paul@x.io" });
    await queries.createUser({ id: "usr_tyler", email: "tyler@x.io" });
    await queries.insertAgent({ ...agentBase, id: "ag_t", created_by_user_id: "usr_paul" });

    await queries.updateAgentOwner("ag_t", "usr_tyler");

    const after = await queries.getAgent("ag_t");
    expect(after!.created_by_user_id).toBe("usr_tyler");
    // Billing attribution follows: the spend-by-user rollup now counts this
    // agent's usage against the NEW owner.
    await queries.insertTokenUsage("ag_t", 100, 50, 0, 0, 1.25);
    const spend = await queries.getSpendByUser();
    expect(spend.find((s) => s.user_id === "usr_tyler")?.daily).toBeCloseTo(1.25);
    expect(spend.find((s) => s.user_id === "usr_paul")).toBeUndefined();
  });
});
