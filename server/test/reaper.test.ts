import { describe, it, expect } from "vitest";
import { getPool } from "../src/db/index.js";
import * as queries from "../src/db/queries.js";
import { reconcileOrphanedAgents } from "../src/supervisor/reaper.js";

async function mkAgent(id: string, state: string) {
  await queries.createUser({ id: "usr_x", email: "x@t.co", role: "bot" }).catch(() => {});
  return queries.insertAgent({
    id, name: id, prompt: "p", cwd: "/work", state: state as never, priority: "medium",
    permission_mode: "default", sdk_session_id: null, model: "claude-sonnet-5", max_turns: null,
    max_budget_usd: null, error_message: null, supervisor_instructions: "", permission_policy: "auto",
    created_by_user_id: "usr_x", repo_url: null, repo_ref: null, branch: null, service_account: null,
    worker_image: null, adopted_ref: null, size: null,
  });
}
const setHeartbeat = (id: string, iso: string | null) =>
  getPool().query("UPDATE agents SET last_heartbeat_at = $1 WHERE id = $2", [iso, id]);

describe("heartbeat reaper — reconciles dead-pod agents by their sidecar heartbeat", () => {
  it("reconciles a running agent whose heartbeat went stale → paused", async () => {
    await mkAgent("ag_dead", "running");
    await setHeartbeat("ag_dead", new Date(Date.now() - 10 * 60 * 1000).toISOString()); // 10 min ago
    const reaped = await reconcileOrphanedAgents();
    expect(reaped).toContain("ag_dead");
    expect((await queries.getAgent("ag_dead"))!.state).toBe("paused");
  });

  it("also reconciles a waiting_permission agent with a stale heartbeat (dead pod)", async () => {
    await mkAgent("ag_wait", "waiting_permission");
    await setHeartbeat("ag_wait", new Date(Date.now() - 5 * 60 * 1000).toISOString());
    const reaped = await reconcileOrphanedAgents();
    expect(reaped).toContain("ag_wait");
    expect((await queries.getAgent("ag_wait"))!.state).toBe("paused");
  });

  it("leaves a running agent with a FRESH heartbeat alone (pod alive)", async () => {
    await mkAgent("ag_live", "running");
    await setHeartbeat("ag_live", new Date().toISOString());
    const reaped = await reconcileOrphanedAgents();
    expect(reaped).not.toContain("ag_live");
    expect((await queries.getAgent("ag_live"))!.state).toBe("running");
  });

  it("never reaps an agent that hasn't beat yet (null heartbeat — pod still booting)", async () => {
    await mkAgent("ag_boot", "running"); // last_heartbeat_at stays null
    const reaped = await reconcileOrphanedAgents();
    expect(reaped).not.toContain("ag_boot");
    expect((await queries.getAgent("ag_boot"))!.state).toBe("running");
  });

  it("does not touch a completed agent even with an old heartbeat", async () => {
    await mkAgent("ag_done", "completed");
    await setHeartbeat("ag_done", new Date(Date.now() - 60 * 60 * 1000).toISOString());
    const reaped = await reconcileOrphanedAgents();
    expect(reaped).not.toContain("ag_done");
    expect((await queries.getAgent("ag_done"))!.state).toBe("completed");
  });
});
