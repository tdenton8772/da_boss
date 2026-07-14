import { describe, it, expect, vi } from "vitest";
import { runChecks, type SupervisorDeps } from "../src/supervisor/checks.js";
import * as queries from "../src/db/queries.js";

/**
 * Layer-2 "simulated fleet" tests: seed the shared state (agents + leases +
 * strikes) and assert the supervisor's DETERMINISTIC reactions — no real agents,
 * no Claude, no timing. The Claude-judgment paths are skipped here because no
 * credential is loaded (claudeCredentialPresent() === false in test).
 */
const REPO = "https://github.com/o/r";
const agentBase = {
  name: "a", prompt: "p", cwd: "/tmp", state: "running" as const,
  priority: "medium" as const, permission_mode: "default" as const,
  sdk_session_id: null, model: "claude-sonnet-4-6", max_turns: null,
  max_budget_usd: null, error_message: null, supervisor_instructions: "",
  permission_policy: "auto" as const,
};

function deps(over: Partial<SupervisorDeps> = {}): SupervisorDeps {
  return {
    getAgentsToPause: async () => [],
    pauseAgent: async () => {},
    blockAgent: vi.fn(async () => {}),
    steerAgent: vi.fn(async () => {}),
    sendInput: vi.fn(async () => {}),
    ...over,
  };
}

describe("supervisor reactions (simulated fleet)", () => {
  it("flags deep overlap when two agents contest the same functions", async () => {
    await queries.insertAgent({ ...agentBase, id: "ag_jimmy" });
    await queries.insertAgent({ ...agentBase, id: "ag_johnny" });
    for (const s of ["apply", "commit", "replicate"]) {
      await queries.acquireLeases("ag_jimmy", REPO, [s]);
      await queries.acquireLeases("ag_johnny", REPO, [s]); // 3 contested = deep
    }

    const { findings } = await runChecks(deps());
    const overlap = findings.find((f) => f.type === "lease_overlap");
    expect(overlap).toBeDefined();
    expect(overlap!.message).toMatch(/3 function\(s\) contested/);
  });

  it("does NOT flag overlap when territory is disjoint", async () => {
    await queries.insertAgent({ ...agentBase, id: "ag_a" });
    await queries.insertAgent({ ...agentBase, id: "ag_b" });
    await queries.acquireLeases("ag_a", REPO, ["foo"]);
    await queries.acquireLeases("ag_b", REPO, ["bar"]);

    const { findings } = await runChecks(deps());
    expect(findings.find((f) => f.type === "lease_overlap")).toBeUndefined();
  });

  it("blocks a running agent that crossed the advisory-strike threshold", async () => {
    await queries.insertAgent({ ...agentBase, id: "ag_bad" });
    await queries.insertAgent({ ...agentBase, id: "ag_ok" });
    await queries.bumpAdvisoryStrikes("ag_bad");
    await queries.bumpAdvisoryStrikes("ag_bad");
    await queries.bumpAdvisoryStrikes("ag_bad"); // 3 >= threshold

    const blockAgent = vi.fn(async () => {});
    const { findings } = await runChecks(deps({ blockAgent }));

    expect(blockAgent).toHaveBeenCalledTimes(1);
    expect(blockAgent).toHaveBeenCalledWith("ag_bad", expect.stringContaining("3 advisory violations"));
    expect(findings.find((f) => f.type === "blocked" && f.agentId === "ag_bad")).toBeDefined();
  });

  it("leaves a clean fleet alone (no findings, no block)", async () => {
    await queries.insertAgent({ ...agentBase, id: "ag_clean" });
    await queries.acquireLeases("ag_clean", REPO, ["soloFn"]);
    const blockAgent = vi.fn(async () => {});

    const { findings } = await runChecks(deps({ blockAgent }));
    expect(blockAgent).not.toHaveBeenCalled();
    expect(findings.find((f) => f.type === "lease_overlap")).toBeUndefined();
    expect(findings.find((f) => f.type === "blocked")).toBeUndefined();
  });
});
