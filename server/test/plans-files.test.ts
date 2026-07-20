import { describe, it, expect } from "vitest";
import * as queries from "../src/db/queries.js";

async function mkAgent(id: string) {
  await queries.createUser({ id: "usr_pf", email: "pf@t.co", role: "bot" }).catch(() => {});
  await queries.insertAgent({
    id, name: id, prompt: "p", cwd: "/work", state: "running" as never, priority: "medium",
    permission_mode: "default", sdk_session_id: null, model: "claude-sonnet-5", max_turns: null,
    max_budget_usd: null, error_message: null, supervisor_instructions: "", permission_policy: "auto",
    created_by_user_id: "usr_pf", repo_url: null, repo_ref: null, branch: null, service_account: null,
    worker_image: null, adopted_ref: null, size: null,
  });
}

describe("agent plans — from ExitPlanMode permission requests", () => {
  it("returns ExitPlanMode plans with content, excludes other tools", async () => {
    await mkAgent("ag_pl");
    await queries.insertPermissionRequest("ag_pl", "Bash", { command: "ls" }, "tu0");
    await queries.insertPermissionRequest("ag_pl", "ExitPlanMode", { plan: "# My Plan\n\n- step one\n- step two" }, "tu1");
    const plans = await queries.getAgentPlans("ag_pl");
    expect(plans).toHaveLength(1);
    expect(plans[0].plan).toContain("# My Plan");
    expect(plans[0].status).toBe("pending");
  });

  it("skips ExitPlanMode requests with no plan text", async () => {
    await mkAgent("ag_pl2");
    await queries.insertPermissionRequest("ag_pl2", "ExitPlanMode", {}, "tu2"); // empty
    expect(await queries.getAgentPlans("ag_pl2")).toHaveLength(0);
  });
});

describe("agent files — user uploads for the pod", () => {
  it("stores + lists a file and returns its bytes for the worker", async () => {
    await mkAgent("ag_fi");
    const bytes = Buffer.from("hello screenshot bytes");
    await queries.insertAgentFile({ id: "af_1", agent_id: "ag_fi", name: "shot.png", mime: "image/png", size: bytes.length, bytes });
    const list = await queries.listAgentFiles("ag_fi");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "shot.png", size: bytes.length });
    const withBytes = await queries.getAgentFilesWithBytes("ag_fi");
    expect(withBytes[0].name).toBe("shot.png");
    expect(Buffer.from(withBytes[0].bytes).toString()).toBe("hello screenshot bytes");
    await queries.deleteAgentFile("af_1", "ag_fi");
    expect(await queries.listAgentFiles("ag_fi")).toHaveLength(0);
  });
});
