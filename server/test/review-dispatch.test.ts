import { describe, it, expect } from "vitest";
import * as queries from "../src/db/queries.js";

// A COMPLETED review must not block a fresh one — else a re-worked + re-tested change
// never gets re-reviewed and sits stuck with no verdict (the ag_U-UOQwgz case).

const base = {
  name: "x", prompt: "p", cwd: "/w", priority: "medium" as const,
  permission_mode: "default" as const, sdk_session_id: null, model: "claude-sonnet-5",
  max_turns: 10, max_budget_usd: 5, error_message: null, supervisor_instructions: "",
  permission_policy: "auto" as const,
};

describe("hasActiveReviewAgent — only in-flight reviews block a re-review", () => {
  it("is false when the only review agent has completed", async () => {
    await queries.insertAgent({ ...base, id: "ag_change", state: "completed" });
    await queries.insertAgent({ ...base, id: "ag_rev", state: "completed" });
    await queries.setAgentReviewOf("ag_rev", "ag_change");
    expect(await queries.hasActiveReviewAgent("ag_change")).toBe(false);
  });

  it("is true while a review agent is still running", async () => {
    await queries.insertAgent({ ...base, id: "ag_change2", state: "completed" });
    await queries.insertAgent({ ...base, id: "ag_rev2", state: "running" });
    await queries.setAgentReviewOf("ag_rev2", "ag_change2");
    expect(await queries.hasActiveReviewAgent("ag_change2")).toBe(true);
  });

  it("does not count failed/aborted review agents", async () => {
    await queries.insertAgent({ ...base, id: "ag_change3", state: "completed" });
    await queries.insertAgent({ ...base, id: "ag_rev3", state: "failed" });
    await queries.setAgentReviewOf("ag_rev3", "ag_change3");
    expect(await queries.hasActiveReviewAgent("ag_change3")).toBe(false);
  });

  it("is false when there is no review agent at all", async () => {
    await queries.insertAgent({ ...base, id: "ag_change4", state: "completed" });
    expect(await queries.hasActiveReviewAgent("ag_change4")).toBe(false);
  });
});
