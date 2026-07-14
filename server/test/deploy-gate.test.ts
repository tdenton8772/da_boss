import { describe, it, expect } from "vitest";
import * as queries from "../src/db/queries.js";

// The pre-deploy gate rests on two new read queries: getPendingDeployChanges (what
// the deploy will ship + each change's prior review) and getDeployGateTests (the
// test runs launched on main, tagged with the deploy run). These verify the data
// plumbing the comprehensive deploy review depends on.

const REPO = "https://github.com/x/y";

const baseAgent = {
  name: "change", prompt: "do the thing", cwd: "/work",
  state: "verified" as const, priority: "medium" as const,
  permission_mode: "default" as const, sdk_session_id: null,
  model: "claude-sonnet-5", max_turns: 10, max_budget_usd: 5.0,
  error_message: null, supervisor_instructions: "", permission_policy: "auto" as const,
  created_by_user_id: null, repo_url: REPO, repo_ref: "main", branch: "feat/x",
  service_account: null, worker_image: null, adopted_ref: null, size: null,
};

describe("getPendingDeployChanges — the deploy manifest + prior reviews", () => {
  it("returns merged, not-yet-deployed changes with their prior review", async () => {
    await queries.insertAgent({ ...baseAgent, id: "ag_ship" });
    await queries.setAgentPullRequest("ag_ship", `${REPO}/pull/7`, 7);
    await queries.setAgentReview("ag_ship", "Looks correct; pins deps.", "merge");

    const changes = await queries.getPendingDeployChanges(REPO);
    expect(changes).toHaveLength(1);
    expect(changes[0].id).toBe("ag_ship");
    expect(changes[0].pr_number).toBe(7);
    expect(changes[0].recommendation).toBe("merge");
    expect(changes[0].review).toContain("pins deps");
    expect(changes[0].prompt).toBe("do the thing");
  });

  it("excludes changes that are not verified, have no PR, or are review agents", async () => {
    // verified + PR → eligible
    await queries.insertAgent({ ...baseAgent, id: "ag_ok" });
    await queries.setAgentPullRequest("ag_ok", `${REPO}/pull/1`, 1);
    // verified but NO PR → excluded
    await queries.insertAgent({ ...baseAgent, id: "ag_nopr" });
    // pending (not verified) + PR → excluded
    await queries.insertAgent({ ...baseAgent, id: "ag_pending", state: "running" });
    await queries.setAgentPullRequest("ag_pending", `${REPO}/pull/2`, 2);
    // a review agent (review_of set) → excluded
    await queries.insertAgent({ ...baseAgent, id: "ag_review" });
    await queries.setAgentPullRequest("ag_review", `${REPO}/pull/3`, 3);
    await queries.setAgentReviewOf("ag_review", "ag_ok");

    const ids = (await queries.getPendingDeployChanges(REPO)).map((c) => c.id);
    expect(ids).toEqual(["ag_ok"]);
  });

  it("excludes changes already claimed by a deploy", async () => {
    await queries.insertAgent({ ...baseAgent, id: "ag_done" });
    await queries.setAgentPullRequest("ag_done", `${REPO}/pull/9`, 9);
    await queries.claimDeployManifest("ag_deployer", REPO); // marks eligible ones deployed
    expect((await queries.getPendingDeployChanges(REPO)).map((c) => c.id)).not.toContain("ag_done");
  });
});

describe("getDeployGateTests — pre-deploy test runs tagged to a deploy", () => {
  it("returns only the runs tagged with the deploy run id", async () => {
    await queries.insertPipelineRun({ id: "run_t1", repoUrl: REPO, ref: "main", phase: "test", status: "passed", deployGateRunId: "run_dep" });
    await queries.insertPipelineRun({ id: "run_t2", repoUrl: REPO, ref: "main", phase: "test-elixir", status: "failed", deployGateRunId: "run_dep" });
    await queries.insertPipelineRun({ id: "run_other", repoUrl: REPO, ref: "main", phase: "test" }); // untagged
    await queries.insertPipelineRun({ id: "run_dep2t", repoUrl: REPO, ref: "main", phase: "test", deployGateRunId: "run_dep_OTHER" });

    const tests = await queries.getDeployGateTests("run_dep");
    expect(tests.map((t) => t.id).sort()).toEqual(["run_t1", "run_t2"]);
    expect(tests.some((t) => t.status === "failed")).toBe(true);
  });

  it("returns empty when no gate tests were tagged (repo has no test phase)", async () => {
    expect(await queries.getDeployGateTests("run_none")).toEqual([]);
  });
});

describe("hasLandInFlight — keeps the Merge button disabled during a land", () => {
  it("is true while a land_on_pass run is non-terminal, false once it's terminal", async () => {
    await queries.insertAgent({ ...baseAgent, id: "ag_land", state: "completed" });
    await queries.setAgentPullRequest("ag_land", `${REPO}/pull/5`, 5);
    expect(await queries.hasLandInFlight("ag_land")).toBe(false);

    await queries.insertPipelineRun({ id: "run_land", repoUrl: REPO, ref: "feat/x", phase: "test", status: "running", agentId: "ag_land", landOnPass: true });
    expect(await queries.hasLandInFlight("ag_land")).toBe(true);

    await queries.updatePipelineRun("run_land", { status: "failed", completed: true });
    expect(await queries.hasLandInFlight("ag_land")).toBe(false);
  });

  it("a normal (non-land) test run does NOT count as a land in flight", async () => {
    await queries.insertAgent({ ...baseAgent, id: "ag_pr", state: "completed" });
    await queries.insertPipelineRun({ id: "run_prtest", repoUrl: REPO, ref: "feat/x", phase: "test", status: "running", agentId: "ag_pr", landOnPass: false });
    expect(await queries.hasLandInFlight("ag_pr")).toBe(false);
  });

  it("getReviewQueueChanges surfaces the landing flag per change", async () => {
    await queries.insertAgent({ ...baseAgent, id: "ag_q", state: "completed" });
    await queries.setAgentPullRequest("ag_q", `${REPO}/pull/8`, 8);
    await queries.setAgentReview("ag_q", "ok", "merge");
    await queries.insertPipelineRun({ id: "run_qland", repoUrl: REPO, ref: "feat/x", phase: "test", status: "pending", agentId: "ag_q", landOnPass: true });

    const row = (await queries.getReviewQueueChanges()).find((c) => c.id === "ag_q");
    expect(row?.landing).toBe(true);
  });
});
