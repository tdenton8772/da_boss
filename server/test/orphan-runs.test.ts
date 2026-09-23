import { describe, it, expect } from "vitest";
import * as queries from "../src/db/queries.js";

// getStalePipelineRuns backs the orphaned-run sweep. A pipeline run row is written
// BEFORE its pod exists, and the pod writes its own terminal status from inside
// (pipeline/runner.ts + recorder.ts) — so "non-terminal" is normal while a pod is
// alive. The query's whole job is to narrow to rows that COULD be orphaned:
// non-terminal, and old enough that something should have picked them up.
//
// Why this matters: hasLandInFlight counts pending/running land runs, so a run that
// never got a pod wedges that PR's merge permanently — the Merge button greys out and
// POST /api/agents/:id/merge 409s, with no in-product way to clear it (PR #145,
// 2026-09-23: an unbounded registry existence check hung before pod creation).

const future = (): string => new Date(Date.now() + 60_000).toISOString();
const past = (): string => new Date(Date.now() - 60_000).toISOString();

async function seed(id: string, status: string): Promise<void> {
  await queries.insertPipelineRun({ id, repoUrl: "https://github.com/x/y", ref: "main", phase: "test", status });
}

describe("getStalePipelineRuns", () => {
  it("returns only non-terminal runs", async () => {
    await seed("run_pending", "pending");
    await seed("run_running", "running");
    await seed("run_passed", "passed");
    await seed("run_failed", "failed");
    await seed("run_aborted", "aborted");

    const stale = await queries.getStalePipelineRuns(future());
    expect(stale.map((r) => r.id).sort()).toEqual(["run_pending", "run_running"]);
  });

  it("excludes runs younger than the cutoff, so a just-created run is never reaped", async () => {
    // The row is inserted before the pod is created; reaping on that gap would
    // kill healthy launches. A cutoff in the past must match nothing.
    await seed("run_fresh", "pending");
    expect(await queries.getStalePipelineRuns(past())).toEqual([]);
  });

  it("returns an aborted run to nobody — terminalizing is what releases the land gate", async () => {
    await seed("run_orphan", "pending");
    expect((await queries.getStalePipelineRuns(future())).map((r) => r.id)).toEqual(["run_orphan"]);

    // What the sweep does to it. 'aborted' is deliberate: gateTestBatch acts only on
    // passed/failed, so releasing the gate never fabricates a test verdict.
    await queries.updatePipelineRun("run_orphan", { status: "aborted", completed: true });

    expect(await queries.getStalePipelineRuns(future())).toEqual([]);
    const run = await queries.getPipelineRun("run_orphan");
    expect(run?.status).toBe("aborted");
    expect(run?.completed_at).toBeTruthy();
  });
});
