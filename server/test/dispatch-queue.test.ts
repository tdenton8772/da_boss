import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// The pod build is the slow part (it waits on agent-image builds); fake it so
// one agent's dispatch can be held open while others proceed.
const pods = vi.hoisted(() => ({
  started: [] as string[],
  hold: new Map<string, Promise<void>>(),
  fail: new Set<string>(),
}));
vi.mock("../src/agent/pod-dispatcher.js", () => ({
  createAgentPod: async (id: string) => {
    pods.started.push(id);
    await pods.hold.get(id);
    if (pods.fail.has(id)) throw new Error("image build failed");
  },
}));

import * as queries from "../src/db/queries.js";
import { config } from "../src/config.js";
import { processQueue, drainDispatches } from "../src/supervisor/dispatcher.js";

async function queue(id: string) {
  await queries.insertAgent({
    id, name: id, prompt: "p", cwd: "/work", state: "queued", priority: "medium", permission_mode: "default",
    sdk_session_id: null, model: "opus", max_turns: null, max_budget_usd: null, error_message: null,
    supervisor_instructions: "", permission_policy: "auto", created_by_user_id: null, repo_url: null, repo_ref: null,
    branch: null, service_account: null, worker_image: null, adopted_ref: null, size: "m", toolchain: null,
  });
}

describe("dispatch queue — concurrent, slot-limited", () => {
  const originalCap = config.maxConcurrentAgents;
  afterAll(() => { config.maxConcurrentAgents = originalCap; });
  beforeEach(() => {
    pods.started = [];
    pods.hold.clear();
    pods.fail.clear();
    config.maxConcurrentAgents = 3;
  });

  it("an agent stuck on its image build doesn't block the agents behind it", async () => {
    let release!: () => void;
    pods.hold.set("ag_slow", new Promise<void>((r) => { release = r; }));
    await queue("ag_slow");
    await queue("ag_fast");
    await processQueue();
    await vi.waitFor(() => expect(pods.started).toEqual(expect.arrayContaining(["ag_slow", "ag_fast"])));
    release();
    await drainDispatches();
  });

  it("counts in-flight dispatches against the cap and never double-dispatches", async () => {
    config.maxConcurrentAgents = 1;
    let release!: () => void;
    pods.hold.set("ag_a", new Promise<void>((r) => { release = r; }));
    await queue("ag_a");
    await queue("ag_b");
    await processQueue();
    await processQueue(); // a second sweep while ag_a is still dispatching
    await vi.waitFor(() => expect(pods.started).toHaveLength(1));
    expect(pods.started.filter((id) => id === "ag_a")).toHaveLength(1);
    // ag_a goes active once its pod exists; the next sweep has no free slot.
    await queries.updateAgentState("ag_a", "running");
    release();
    await drainDispatches();
    expect(pods.started).toEqual(["ag_a"]);
  });

  it("a failed dispatch marks only that agent failed and frees its slot", async () => {
    config.maxConcurrentAgents = 1;
    pods.fail.add("ag_bad");
    await queue("ag_bad");
    await queue("ag_next");
    await processQueue();
    await vi.waitFor(() => expect(pods.started).toContain("ag_next")); // picked up after the failure
    await drainDispatches();
    expect((await queries.getAgent("ag_bad"))?.state).toBe("failed");
    expect((await queries.getAgent("ag_bad"))?.error_message).toMatch(/image build failed/);
  });
});
