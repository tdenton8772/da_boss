import { describe, it, expect } from "vitest";
import * as queries from "../src/db/queries.js";

async function mkAgent(id: string) {
  await queries.createUser({ id: "usr_p", email: "p@t.co", role: "bot" }).catch(() => {});
  await queries.insertAgent({
    id, name: id, prompt: "p", cwd: "/work", state: "running" as never, priority: "medium",
    permission_mode: "default", sdk_session_id: null, model: "claude-sonnet-5", max_turns: null,
    max_budget_usd: null, error_message: null, supervisor_instructions: "", permission_policy: "auto",
    created_by_user_id: "usr_p", repo_url: null, repo_ref: null, branch: null, service_account: null,
    worker_image: null, adopted_ref: null, size: null,
  });
}

describe("agent plan — the real persisted TodoWrite", () => {
  it("stores + reads the FULL plan (no truncation), latest write wins", async () => {
    await mkAgent("ag_plan");
    // a long plan that would blow past the 300-char trace truncation
    const longContent = "Make Reports section header always visible + collapsible in the sidebar with role-based visibility for every report type";
    await queries.setAgentPlan("ag_plan", JSON.stringify([{ content: "old", status: "completed" }]));
    await queries.setAgentPlan("ag_plan", JSON.stringify([
      { content: "do X", status: "completed", activeForm: "Doing X" },
      { content: longContent, status: "in_progress", activeForm: "Making reports collapsible" },
    ]));

    const todos = JSON.parse((await queries.getAgentPlan("ag_plan"))!) as Array<{ content: string; status: string }>;
    expect(todos).toHaveLength(2);
    expect(todos[0]).toMatchObject({ content: "do X", status: "completed" });
    expect(todos[1].content).toBe(longContent); // full, untruncated
    expect(todos[1].status).toBe("in_progress");
  });

  it("returns null when the agent never wrote a plan", async () => {
    await mkAgent("ag_noplan");
    expect(await queries.getAgentPlan("ag_noplan")).toBeNull();
  });
});
