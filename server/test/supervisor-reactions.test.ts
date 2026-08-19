import { describe, it, expect, vi } from "vitest";
import { runChecks, minutesSince, type SupervisorDeps } from "../src/supervisor/checks.js";
import * as queries from "../src/db/queries.js";
import { getPool } from "../src/db/index.js";

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

  it("flags a running agent with no events past the stuck threshold", async () => {
    await queries.insertAgent({ ...agentBase, id: "ag_stuck" });
    const evId = await queries.insertAgentEvent("ag_stuck", "message", { role: "assistant", content: "hi" });
    await getPool().query("UPDATE agent_events SET created_at = $1 WHERE id = $2", [
      new Date(Date.now() - 20 * 60_000).toISOString(), // 20 min > 15 min threshold
      evId,
    ]);

    const { findings } = await runChecks(deps());
    const stuck = findings.find((f) => f.type === "stuck" && f.agentId === "ag_stuck");
    expect(stuck).toBeDefined();
    expect(stuck!.message).toMatch(/No activity for 20 minutes/);
  });

  it("does NOT flag a running agent with recent events", async () => {
    await queries.insertAgent({ ...agentBase, id: "ag_busy" });
    await queries.insertAgentEvent("ag_busy", "message", { role: "assistant", content: "working" });

    const { findings } = await runChecks(deps());
    expect(findings.find((f) => f.type === "stuck" && f.agentId === "ag_busy")).toBeUndefined();
  });

  it("flags a non-interactive permission pending past the timeout", async () => {
    await queries.insertAgent({ ...agentBase, id: "ag_perm" });
    const perm = await queries.insertPermissionRequest("ag_perm", "Bash", { command: "ls" }, "tu_1");
    await getPool().query("UPDATE permission_requests SET created_at = $1 WHERE id = $2", [
      new Date(Date.now() - 45 * 60_000).toISOString(), // 45 min > 30 min timeout
      perm.id,
    ]);

    const { findings } = await runChecks(deps());
    const timedOut = findings.find((f) => f.type === "permission_timeout" && f.agentId === "ag_perm");
    expect(timedOut).toBeDefined();
    expect(timedOut!.message).toMatch(/pending 45 min/);
  });
});

describe("minutesSince (timestamp shapes)", () => {
  const now = Date.parse("2026-08-19T14:30:00.000Z");

  it("handles the pg type parser's ISO strings ending in Z (the live shape)", () => {
    // Regression: `+ "Z"` on this shape made "…ZZ" → Invalid Date → NaN,
    // silently disabling stuck/stale-permission/idle checks in production.
    expect(minutesSince("2026-08-19T14:00:00.000Z", now)).toBe(30);
  });

  it("handles offset-suffixed strings", () => {
    expect(minutesSince("2026-08-19T10:00:00.000-04:00", now)).toBe(30);
    expect(minutesSince("2026-08-19 14:00:00+00", now)).toBe(30);
  });

  it("handles Date objects", () => {
    expect(minutesSince(new Date("2026-08-19T14:00:00.000Z"), now)).toBe(30);
  });

  it("treats zone-less strings (legacy SQLite shape) as UTC", () => {
    expect(minutesSince("2026-08-19 14:00:00", now)).toBe(30);
  });

  it("never returns NaN for any of those shapes", () => {
    for (const ts of ["2026-08-19T14:00:00.000Z", "2026-08-19 14:00:00+00", "2026-08-19 14:00:00", new Date()]) {
      expect(Number.isNaN(minutesSince(ts as string | Date, now))).toBe(false);
    }
  });
});
