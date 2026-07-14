import { describe, it, expect } from "vitest";
import * as queries from "../src/db/queries.js";
import { getPool } from "../src/db/index.js";
import { applyReviewResult } from "../src/pipeline/review-agent.js";

// getActiveDeployRun is the dedup guard behind auto-proposing a deploy on land:
// it must find an in-flight deploy for the same repo+ref (ignoring a `.git`
// suffix) so a busy main doesn't stack duplicate deploy cards, and must ignore
// finished runs / other phases / other refs.
describe("getActiveDeployRun", () => {
  const REPO = "https://github.com/example/app";

  it("matches an active deploy regardless of a .git suffix", async () => {
    await queries.insertPipelineRun({
      id: "run_a", repoUrl: `${REPO}.git`, ref: "main", phase: "deploy", status: "pending_approval",
    });
    // queried without .git → still found
    expect((await queries.getActiveDeployRun(REPO, "main"))?.id).toBe("run_a");
    // queried with .git → still found
    expect((await queries.getActiveDeployRun(`${REPO}.git`, "main"))?.id).toBe("run_a");
  });

  it("ignores finished deploys, other phases, and other refs", async () => {
    await queries.insertPipelineRun({ id: "done", repoUrl: REPO, ref: "main", phase: "deploy", status: "passed" });
    await queries.insertPipelineRun({ id: "failed", repoUrl: REPO, ref: "main", phase: "deploy", status: "failed" });
    await queries.insertPipelineRun({ id: "test", repoUrl: REPO, ref: "main", phase: "test", status: "running" });
    await queries.insertPipelineRun({ id: "otherref", repoUrl: REPO, ref: "release", phase: "deploy", status: "running" });
    expect(await queries.getActiveDeployRun(REPO, "main")).toBeUndefined();
  });

  it("finds a deploy in any active status", async () => {
    for (const status of ["pending", "pending_review", "pending_approval", "running"]) {
      await queries.insertPipelineRun({ id: `r_${status}`, repoUrl: REPO, ref: "main", phase: "deploy", status });
      const hit = await queries.getActiveDeployRun(REPO, "main");
      expect(hit?.status).toBe(status);
      await queries.updatePipelineRun(`r_${status}`, { status: "passed", completed: true });
    }
  });
});

// Deploy-manager tracking now runs through the recorder pipeline (deploy writes
// /work/.daboss/exit → recorder sidecar → run status), so there's no marker/
// reconcile band-aid to test here. setAgentPipelineRun links the run for the pod.
describe("setAgentPipelineRun", () => {
  it("links a deploy run to the executor agent", async () => {
    await getPool().query("INSERT INTO agents (id, name, prompt, cwd, state) VALUES ('ag_dl','n','p','/work','pending')");
    await queries.setAgentPipelineRun("ag_dl", "run_dl");
    const a = await queries.getAgent("ag_dl");
    expect(a?.pipeline_run_id).toBe("run_dl");
  });
});

// applyReviewResult parses a review AGENT's final RECOMMENDATION onto the agent
// it reviewed (a real agent digs into the code, then reports a verdict).
describe("applyReviewResult", () => {
  async function mkAgent(id: string) {
    await getPool().query("INSERT INTO agents (id, name, prompt, cwd, state) VALUES ($1,$1,'p','/work','completed')", [id]);
  }
  it("applies the reviewer's merge/fix/hold onto the reviewed agent", async () => {
    await mkAgent("ag_reviewed"); await mkAgent("ag_reviewer");
    await queries.setAgentReviewOf("ag_reviewer", "ag_reviewed");
    await queries.insertAgentEvent("ag_reviewer", "message", { role: "assistant", content: "Looked at it.\nRECOMMENDATION: fix\nASSESSMENT: audit write still swallows errors.\nCONCERNS: none" });
    await applyReviewResult("ag_reviewer");
    const r = await queries.getAgent("ag_reviewed");
    expect(r?.recommendation).toBe("fix");
    expect(r?.review).toMatch(/audit write still swallows/);
  });
  it("marks hold if the review agent finished without a RECOMMENDATION", async () => {
    await mkAgent("ag_reviewed2"); await mkAgent("ag_reviewer2");
    await queries.setAgentReviewOf("ag_reviewer2", "ag_reviewed2");
    await queries.insertAgentEvent("ag_reviewer2", "message", { role: "assistant", content: "I ran out of ideas." });
    await applyReviewResult("ag_reviewer2");
    expect((await queries.getAgent("ag_reviewed2"))?.recommendation).toBe("hold");
  });
  it("no-ops for an agent that isn't a reviewer", async () => {
    await mkAgent("ag_plain");
    await applyReviewResult("ag_plain"); // no review_of_agent_id → nothing happens
    expect((await queries.getAgent("ag_plain"))?.recommendation ?? null).toBeNull();
  });
});

// claimDeployManifest links merged changes to the deploy that ships them.
describe("claimDeployManifest", () => {
  const REPO = "https://github.com/example/app";
  async function mkAgent(id: string, opts: { state?: string; pr?: number | null; repo?: string | null; reviewOf?: string } = {}) {
    await getPool().query(
      "INSERT INTO agents (id, name, prompt, cwd, state, repo_url, pr_number, review_of_agent_id) VALUES ($1,$1,'p','/work',$2,$3,$4,$5)",
      [id, opts.state ?? "verified", opts.repo === undefined ? REPO : opts.repo, opts.pr ?? null, opts.reviewOf ?? null]
    );
  }
  it("claims verified merged changes for the repo, excludes reviews/unmerged, is one-shot", async () => {
    await mkAgent("dep_A"); // the deploy agent (verified, but excluded via id<>self and no pr)
    await getPool().query("update agents set pr_number=null, repo_url=$2 where id=$1", ["dep_A", REPO]);
    await mkAgent("chg_1", { pr: 9 });
    await mkAgent("chg_2", { pr: 10, repo: `${REPO}.git` }); // .git suffix still matches
    await mkAgent("rev_1", { pr: null, reviewOf: "chg_1" }); // a review agent — excluded
    await mkAgent("wip_1", { state: "running", pr: 11 }); // not verified — excluded
    const shipped = await queries.claimDeployManifest("dep_A", REPO);
    expect(shipped.map((s) => s.pr_number).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([9, 10]);
    // reverse lookup
    const back = await queries.getShippedAgents("dep_A");
    expect(back.length).toBe(2);
    // one-shot: a second deploy claims nothing (already linked)
    expect(await queries.claimDeployManifest("dep_B", REPO)).toEqual([]);
  });
});

// claimTestBatch is the atomic guard behind the multi-phase gate: exactly one
// completion drives the outcome when several test phases finish together.
describe("claimTestBatch", () => {
  const REPO = "https://github.com/example/app";
  async function mkAgent(id: string) {
    await getPool().query("INSERT INTO agents (id, name, prompt, cwd, state) VALUES ($1,$1,'p','/work','running')", [id]);
  }

  it("claims the whole batch once, then returns [] for a concurrent caller", async () => {
    await mkAgent("ag_b1");
    for (const phase of ["test", "test-elixir"]) {
      await queries.insertPipelineRun({ id: `${phase}_b1`, repoUrl: REPO, ref: "feat", phase, status: "passed", agentId: "ag_b1" });
    }
    const first = await queries.claimTestBatch("ag_b1", ["test", "test-elixir"], false);
    expect(first.sort()).toEqual(["test-elixir_b1", "test_b1"].sort());
    const second = await queries.claimTestBatch("ag_b1", ["test", "test-elixir"], false);
    expect(second).toEqual([]); // already claimed
  });

  it("ignores the other mode (land vs gate) and non-terminal runs", async () => {
    await mkAgent("ag_b2");
    await queries.insertPipelineRun({ id: "gate_b2", repoUrl: REPO, ref: "feat", phase: "test", status: "passed", agentId: "ag_b2", landOnPass: false });
    await queries.insertPipelineRun({ id: "land_b2", repoUrl: REPO, ref: "feat", phase: "test", status: "passed", agentId: "ag_b2", landOnPass: true });
    await queries.insertPipelineRun({ id: "run_b2", repoUrl: REPO, ref: "feat", phase: "test-elixir", status: "running", agentId: "ag_b2", landOnPass: false });
    // Gate-mode claim gets only the passed gate run, not the land run nor the running one.
    const claimed = await queries.claimTestBatch("ag_b2", ["test", "test-elixir"], false);
    expect(claimed).toEqual(["gate_b2"]);
  });
});
