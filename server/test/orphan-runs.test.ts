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

// Regression: the first cut of the sweep looked only for daboss-pipeline pods, so an
// agent-managed deploy (`agent: true`) — which runs in a daboss-agent pod and carries
// no daboss.run-id — looked pod-less and would have been aborted mid-deploy.
describe("getAgentDrivenRunIds", () => {
  it("reports the run a live agent is driving, so the sweep leaves it alone", async () => {
    await queries.insertAgent({
      id: "ag_deployer", name: "deploy main", prompt: "deploy", cwd: "/work",
      state: "running", priority: "medium", permission_mode: "bypassPermissions",
      sdk_session_id: null, model: "claude-sonnet-5", max_turns: 10, max_budget_usd: 5,
      error_message: null, supervisor_instructions: "", permission_policy: "auto",
    });
    await queries.insertPipelineRun({ id: "run_deploy", repoUrl: "https://github.com/x/y", ref: "main", phase: "deploy", status: "running" });
    await queries.setAgentPipelineRun("ag_deployer", "run_deploy");

    // Stale by age, and no pipeline pod would ever carry its id.
    expect((await queries.getStalePipelineRuns(future())).map((r) => r.id)).toContain("run_deploy");
    // But the live agent claims it — that is what keeps the sweep off it.
    expect(await queries.getAgentDrivenRunIds(["ag_deployer"])).toEqual(["run_deploy"]);
  });

  it("returns nothing when no agent is live", async () => {
    expect(await queries.getAgentDrivenRunIds([])).toEqual([]);
  });
});
