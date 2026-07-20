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

// Parse the plan the same way the /plan endpoint does.
function parsePlan(raw: string | null) {
  if (!raw) return null;
  const ev = JSON.parse(raw) as { content?: string };
  const body = (ev.content || "").replace(/^\*\*TodoWrite\*\*:\s*/, "");
  return (JSON.parse(body) as { todos?: unknown[] }).todos ?? null;
}

describe("agent plan — latest TodoWrite", () => {
  it("finds the latest TodoWrite and parses its todos", async () => {
    await mkAgent("ag_plan");
    await queries.insertAgentEvent("ag_plan", "message", { role: "assistant", content: "thinking…" });
    await queries.insertAgentEvent("ag_plan", "message", { role: "tool", content: '**TodoWrite**: {"todos":[{"content":"old","status":"completed"}]}' });
    await queries.insertAgentEvent("ag_plan", "message", { role: "tool", content: '**TodoWrite**: {"todos":[{"content":"do X","status":"completed"},{"content":"do Y","status":"in_progress","activeForm":"Doing Y"}]}' });

    const todos = parsePlan(await queries.getLatestPlanEvent("ag_plan")) as Array<{ content: string; status: string }>;
    expect(todos).toHaveLength(2); // the LATEST TodoWrite, not the older one
    expect(todos[0]).toMatchObject({ content: "do X", status: "completed" });
    expect(todos[1].status).toBe("in_progress");
  });

  it("returns null when the agent never wrote a plan", async () => {
    await mkAgent("ag_noplan");
    await queries.insertAgentEvent("ag_noplan", "message", { role: "assistant", content: "no plan here" });
    expect(await queries.getLatestPlanEvent("ag_noplan")).toBeNull();
  });
});
