import { describe, it, expect } from "vitest";
import * as queries from "../src/db/queries.js";

// A completed agent has been through review (→ reviews rows) and may have queued
// commands (→ agent_commands) — both FK to agents(id). deleteAgent must clear them,
// or "Remove" fails with a foreign-key violation on exactly the agents you're done with.

const mk = (id: string, over: Partial<Parameters<typeof queries.insertAgent>[0]> = {}) =>
  queries.insertAgent({
    id, name: "a", prompt: "p", cwd: "/w", state: "completed", priority: "medium",
    permission_mode: "default", sdk_session_id: null, model: "claude-sonnet-5",
    max_turns: 10, max_budget_usd: 5, error_message: null, supervisor_instructions: "",
    permission_policy: "auto", ...over,
  } as Parameters<typeof queries.insertAgent>[0]);

describe("deleteAgent — a completed, reviewed agent removes cleanly", () => {
  it("clears reviews (both linkages) + agent_commands, then deletes", async () => {
    await mk("ag_change");
    await mk("ag_reviewer");
    // a completed review of the change, plus a queued command on the change
    await queries.createReview({ reviewed_agent_id: "ag_change", review_agent_id: "ag_reviewer", status: "done" });
    await queries.insertAgentCommand("ag_change", "input", { text: "hi" });

    await expect(queries.deleteAgent("ag_change")).resolves.toBeUndefined();
    expect(await queries.getAgent("ag_change")).toBeUndefined();
  });

  it("removes a review agent whose reviews row references it via review_agent_id", async () => {
    await mk("ag_change2");
    await mk("ag_reviewer2");
    await queries.createReview({ reviewed_agent_id: "ag_change2", review_agent_id: "ag_reviewer2", status: "done" });
    // deleting the REVIEWER must also clear the reviews row (review_agent_id FK)
    await expect(queries.deleteAgent("ag_reviewer2")).resolves.toBeUndefined();
    expect(await queries.getAgent("ag_reviewer2")).toBeUndefined();
  });

  it("still deletes a plain never-reviewed agent", async () => {
    await mk("ag_plain");
    await expect(queries.deleteAgent("ag_plain")).resolves.toBeUndefined();
    expect(await queries.getAgent("ag_plain")).toBeUndefined();
  });
});
