import { describe, it, expect } from "vitest";
import * as queries from "../src/db/queries.js";
import { reconcileDeployRun } from "../src/pipeline/deploy-agent.js";

// The recorder sidecar normally flips a deploy run running → passed/failed from the
// deploy's exit code. reconcileDeployRun is the safety net for when the agent's pod
// dies before that happens, so a deploy run never sticks `running` forever.

const deployAgent = {
  id: "ag_deploy1",
  name: "deploy main",
  prompt: "run the deploy",
  cwd: "/work",
  state: "completed" as const,
  priority: "medium" as const,
  permission_mode: "bypassPermissions" as const,
  sdk_session_id: null,
  model: "claude-sonnet-5",
  max_turns: 10,
  max_budget_usd: 5.0,
  error_message: null,
  supervisor_instructions: "",
  permission_policy: "auto" as const,
};

async function setup(runStatus: string, exitCode?: number): Promise<void> {
  await queries.insertAgent(deployAgent);
  await queries.insertPipelineRun({ id: "run_d1", repoUrl: "https://github.com/x/y", ref: "main", phase: "deploy", status: runStatus });
  if (exitCode !== undefined) await queries.updatePipelineRun("run_d1", { exit_code: exitCode });
  await queries.setAgentPipelineRun("ag_deploy1", "run_d1");
}

describe("reconcileDeployRun — deploy-run safety net", () => {
  it("flips a running deploy run to passed when exit code is 0", async () => {
    await setup("running", 0);
    await reconcileDeployRun("ag_deploy1");
    expect((await queries.getPipelineRun("run_d1"))?.status).toBe("passed");
  });

  it("flips a running deploy run to failed when exit code is non-zero", async () => {
    await setup("running", 1);
    await reconcileDeployRun("ag_deploy1");
    expect((await queries.getPipelineRun("run_d1"))?.status).toBe("failed");
  });

  it("fails a running deploy run that has NO recorded exit code (pod died)", async () => {
    await setup("running");
    await reconcileDeployRun("ag_deploy1");
    expect((await queries.getPipelineRun("run_d1"))?.status).toBe("failed");
  });

  it("leaves an already-terminal run untouched (recorder already reconciled)", async () => {
    await setup("passed", 0);
    await reconcileDeployRun("ag_deploy1");
    expect((await queries.getPipelineRun("run_d1"))?.status).toBe("passed");
  });

  it("does not touch a run still in the approval gate (not yet dispatched)", async () => {
    await setup("pending_approval");
    await reconcileDeployRun("ag_deploy1");
    expect((await queries.getPipelineRun("run_d1"))?.status).toBe("pending_approval");
  });

  it("is a no-op for an agent with no linked deploy run", async () => {
    await queries.insertAgent({ ...deployAgent, id: "ag_plain" });
    await reconcileDeployRun("ag_plain"); // must not throw
    expect((await queries.getAgent("ag_plain"))?.state).toBe("completed");
  });

  it("routes a FAILED branch deploy's outcome back onto the ORIGIN change agent's trace", async () => {
    // origin change agent that owns the branch
    await queries.insertAgent({ ...deployAgent, id: "ag_origin", name: "extract forecast", repo_url: "https://github.com/x/y", branch: "feat/x" } as never);
    // the deploy agent running that branch deploy (run's agent_id = deploy agent)
    await queries.insertAgent({ ...deployAgent, id: "ag_dep2", name: "deploy feat/x", repo_url: "https://github.com/x/y" } as never);
    await queries.insertPipelineRun({ id: "run_bd", repoUrl: "https://github.com/x/y", ref: "feat/x", phase: "deploy", status: "failed" });
    await queries.updatePipelineRun("run_bd", { exit_code: 1 });
    await queries.setAgentPipelineRun("ag_dep2", "run_bd");

    await reconcileDeployRun("ag_dep2");

    // the origin — NOT the deploy agent — gets the failure feedback on its trace
    const originEvents = await queries.getAgentEvents("ag_origin", 10);
    expect(JSON.stringify(originEvents)).toContain("FAILED");
    expect(JSON.stringify(originEvents)).toContain("ag_dep2"); // links to the deploy agent
  });

  it("isDeployAgent: true for a deploy executor, false for a change agent", async () => {
    // deploy agent — ran a deploy phase
    await queries.insertAgent({ ...deployAgent, id: "ag_isdep" });
    await queries.insertPipelineRun({ id: "run_id1", repoUrl: "https://github.com/x/y", ref: "chore/agent/deploy-x", phase: "deploy", status: "running", agentId: "ag_isdep" });
    expect(await queries.isDeployAgent("ag_isdep")).toBe(true);

    // change agent — only test phases
    await queries.insertAgent({ ...deployAgent, id: "ag_ischange" });
    await queries.insertPipelineRun({ id: "run_id2", repoUrl: "https://github.com/x/y", ref: "feat/x", phase: "test", status: "passed", agentId: "ag_ischange" });
    await queries.insertPipelineRun({ id: "run_id3", repoUrl: "https://github.com/x/y", ref: "feat/x", phase: "test-elixir", status: "passed", agentId: "ag_ischange" });
    expect(await queries.isDeployAgent("ag_ischange")).toBe(false);

    // no runs at all
    await queries.insertAgent({ ...deployAgent, id: "ag_norun" });
    expect(await queries.isDeployAgent("ag_norun")).toBe(false);
  });

  it("routes a SUCCEEDED branch deploy back to the origin too", async () => {
    await queries.insertAgent({ ...deployAgent, id: "ag_o2", name: "some change", repo_url: "https://github.com/x/y", branch: "feat/z" } as never);
    await queries.insertAgent({ ...deployAgent, id: "ag_dep3", name: "deploy feat/z", repo_url: "https://github.com/x/y" } as never);
    await queries.insertPipelineRun({ id: "run_bz", repoUrl: "https://github.com/x/y", ref: "feat/z", phase: "deploy", status: "passed" });
    await queries.updatePipelineRun("run_bz", { exit_code: 0 });
    await queries.setAgentPipelineRun("ag_dep3", "run_bz");

    await reconcileDeployRun("ag_dep3");

    const originEvents = await queries.getAgentEvents("ag_o2", 10);
    expect(JSON.stringify(originEvents)).toContain("succeeded");
  });
});
