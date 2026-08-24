import { describe, it, expect } from "vitest";
import * as queries from "../src/db/queries.js";
import {
  resolveReviewTarget, buildReviewConfig, gatherAssessment, gatherDecisionTrail, extractVerdictFromText,
} from "../src/pipeline/review-logic.js";
import { dispatchReviewAgent, applyReviewResult, type ReviewDispatcher } from "../src/pipeline/review-agent.js";
import type { AgentRecord, CreateAgentRequest } from "../src/types/agent.js";

// A reviewed-agent row. created_by_user_id is an FK → users, so make the user first.
async function seedReviewed(over: Partial<AgentRecord> = {}): Promise<AgentRecord> {
  await queries.createUser({ id: "usr_x", email: "x@test.co" }).catch(() => {});
  const id = over.id ?? "ag_src";
  await queries.insertAgent({
    id, name: over.name ?? "add feature", prompt: over.prompt ?? "do the thing",
    cwd: "/work", state: "completed", priority: "medium", permission_mode: "default",
    sdk_session_id: null, model: "claude-sonnet-5", max_turns: null, max_budget_usd: null,
    error_message: null, supervisor_instructions: "", permission_policy: "auto",
    created_by_user_id: "usr_x", repo_url: over.repo_url ?? "https://github.com/o/r.git",
    repo_ref: over.repo_ref ?? "main", branch: over.branch ?? "feat/x/task",
    service_account: null, worker_image: null, adopted_ref: over.adopted_ref ?? null,
  });
  return (await queries.getAgent(id))!;
}

// Fake seam: records the create request + which agents were started, and inserts
// a real reviewer row (so setAgentReviewOf's FK is satisfied) — no manager, no pod.
function makeFakeDispatcher() {
  const state = { started: [] as string[], lastReq: null as CreateAgentRequest | null };
  const dispatcher: ReviewDispatcher = {
    async createAgent(req, userId) {
      state.lastReq = req;
      const id = `ag_rev_${state.started.length}_${req.repo_ref?.length ?? 0}`;
      await queries.insertAgent({
        id, name: req.name, prompt: req.prompt, cwd: req.cwd ?? "/work", state: "pending",
        priority: "medium", permission_mode: req.permission_mode ?? "default", sdk_session_id: null,
        model: req.model ?? "claude-sonnet-5", max_turns: null, max_budget_usd: req.max_budget_usd ?? null,
        error_message: null, supervisor_instructions: "", permission_policy: req.permission_policy ?? "auto",
        created_by_user_id: userId ?? null, repo_url: req.repo_url ?? null, repo_ref: req.repo_ref ?? null,
        branch: "chore/review", service_account: null, worker_image: null, adopted_ref: null,
      });
      return (await queries.getAgent(id))!;
    },
    async startAgent(id) { state.started.push(id); },
  };
  return { dispatcher, state };
}

describe("review-logic (pure)", () => {
  it("adopted PR → refs/pull/N/head + untrusted", () => {
    expect(resolveReviewTarget({ adopted_ref: "PR #6", branch: "patch-1" }))
      .toEqual({ repoRef: "refs/pull/6/head", untrusted: true, prNumber: "6" });
  });

  it("normal branch → the branch itself + trusted", () => {
    expect(resolveReviewTarget({ adopted_ref: null, branch: "feat/x/task" }))
      .toEqual({ repoRef: "feat/x/task", untrusted: false, prNumber: null });
  });

  it("untrusted config: PR head, no bypassPermissions, injection preamble", async () => {
    const cfg = buildReviewConfig(await seedReviewed({ adopted_ref: "PR #6", branch: "patch-1" }), "(no test result)");
    expect(cfg.repo_ref).toBe("refs/pull/6/head");
    expect(cfg.permission_mode).toBe("default");
    expect(cfg.branch_type).toBe("chore");
    expect(cfg.prompt).toContain("UNTRUSTED");
  });

  it("trusted internal config: branch, bypassPermissions, no preamble", async () => {
    const cfg = buildReviewConfig(await seedReviewed({ adopted_ref: null, branch: "feat/x" }), "test passed");
    expect(cfg.repo_ref).toBe("feat/x");
    expect(cfg.permission_mode).toBe("bypassPermissions");
    expect(cfg.prompt).not.toContain("UNTRUSTED");
  });

  it("review pods are at least M — S (512Mi) OOMs under a repo's in-pod MCP servers", async () => {
    const cfg = buildReviewConfig(await seedReviewed(), "test passed");
    expect(cfg.size).toBe("m");
  });

  it("decision trail: user messages amend the task in the review prompt", async () => {
    const trail = "Owner ruling: the write tool IS intended scope.\n---\nAlso expose Slack.";
    const cfg = buildReviewConfig(await seedReviewed(), "test passed", trail);
    expect(cfg.prompt).toContain("OWNER DECISIONS SINCE");
    expect(cfg.prompt).toContain("the write tool IS intended scope");
    expect(cfg.prompt).toContain("as amended");
    // and without a trail the section is absent entirely
    const bare = buildReviewConfig(await seedReviewed(), "test passed");
    expect(bare.prompt).not.toContain("OWNER DECISIONS SINCE");
  });

  it("gatherDecisionTrail keeps only user messages, oldest-first, capped", () => {
    const events = [
      // stored newest-first, like getAgentEvents returns
      { type: "message", data: JSON.stringify({ role: "user", content: "third ruling" }) },
      { type: "message", data: JSON.stringify({ role: "assistant", content: "agent chatter" }) },
      { type: "message", data: JSON.stringify({ role: "system", content: "↩️ requested changes" }) },
      { type: "message", data: JSON.stringify({ role: "user", content: "second ruling" }) },
      { type: "tool_use", data: JSON.stringify({ role: "user", content: "not a message" }) },
      { type: "message", data: JSON.stringify({ role: "user", content: "first ruling" }) },
    ];
    const trail = gatherDecisionTrail(events);
    expect(trail).toBe("first ruling\n---\nsecond ruling\n---\nthird ruling");
    expect(trail).not.toContain("agent chatter");
    expect(trail).not.toContain("requested changes");
  });

  it("verdict survives a long assessment (no 4000-char clip) and parses at the end", () => {
    const long = "X".repeat(9000) + "\nRECOMMENDATION: hold";
    const a = gatherAssessment([{ type: "message", data: JSON.stringify({ role: "assistant", content: long }) }]);
    expect(a.length).toBeGreaterThan(4000);          // the old cap would have dropped the verdict
    expect(extractVerdictFromText(a)).toBe("hold");
  });

  it("no RECOMMENDATION line → null (caller falls back)", () => {
    expect(extractVerdictFromText("prose only, no verdict block")).toBeNull();
  });
});

describe("dispatchReviewAgent (orchestration via the seam)", () => {
  it("creates the reviewer, links review_of, checks out the PR head, starts it", async () => {
    const reviewed = await seedReviewed({ adopted_ref: "PR #6", branch: "patch-1" });
    const { dispatcher, state } = makeFakeDispatcher();
    const id = await dispatchReviewAgent(dispatcher, reviewed);
    expect(id).toBeTruthy();
    expect(state.started).toContain(id);
    expect(state.lastReq!.repo_ref).toBe("refs/pull/6/head");
    expect(state.lastReq!.permission_mode).toBe("default");
    const rev = await queries.getAgent(id!);
    expect(rev!.review_of_agent_id).toBe(reviewed.id); // worker gates on this to stay read-only
  });

  it("is idempotent — won't stack a second reviewer while one is active", async () => {
    const reviewed = await seedReviewed();
    const { dispatcher } = makeFakeDispatcher();
    expect(await dispatchReviewAgent(dispatcher, reviewed)).toBeTruthy();
    expect(await dispatchReviewAgent(dispatcher, reviewed)).toBeNull();
  });

  it("skips when the reviewed agent has no repo / branch / owner", async () => {
    const reviewed = await seedReviewed();
    const { dispatcher } = makeFakeDispatcher();
    expect(await dispatchReviewAgent(dispatcher, { ...reviewed, branch: null })).toBeNull();
    expect(await dispatchReviewAgent(dispatcher, { ...reviewed, repo_url: null })).toBeNull();
    expect(await dispatchReviewAgent(dispatcher, { ...reviewed, created_by_user_id: null })).toBeNull();
  });
});

describe("applyReviewResult", () => {
  it("writes the reviewer's verdict + assessment onto the reviewed agent", async () => {
    const reviewed = await seedReviewed({ id: "ag_src" });
    const { dispatcher } = makeFakeDispatcher();
    const revId = await dispatchReviewAgent(dispatcher, reviewed);
    await queries.insertAgentEvent(revId!, "message", {
      role: "assistant", content: "Deep review of the change.\nRECOMMENDATION: hold\nASSESSMENT: exposes the DB",
    });
    await applyReviewResult(revId!);
    const after = await queries.getAgent("ag_src");
    expect(after!.recommendation).toBe("hold");
    expect(after!.review).toContain("exposes the DB");
  });

  it("reviewer produced nothing → hold (the only real 'no verdict' case)", async () => {
    const reviewed = await seedReviewed({ id: "ag_src" });
    const { dispatcher } = makeFakeDispatcher();
    const revId = await dispatchReviewAgent(dispatcher, reviewed);
    await applyReviewResult(revId!); // reviewer has no assistant events
    const after = await queries.getAgent("ag_src");
    expect(after!.recommendation).toBe("hold");
  });
});

describe("reviews entity (first-class record)", () => {
  it("dispatch opens a running review row linked to both agents", async () => {
    const reviewed = await seedReviewed({ id: "ag_src" });
    const { dispatcher } = makeFakeDispatcher();
    const revId = await dispatchReviewAgent(dispatcher, reviewed, "usr_x");
    const rows = await queries.getReviewsForAgent("ag_src");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("running");
    expect(rows[0].review_agent_id).toBe(revId);
    expect(rows[0].requested_by).toBe("usr_x");
    expect(rows[0].recommendation).toBeNull();
  });

  it("applyReviewResult closes the row with the verdict + rationale", async () => {
    const reviewed = await seedReviewed({ id: "ag_src" });
    const { dispatcher } = makeFakeDispatcher();
    const revId = await dispatchReviewAgent(dispatcher, reviewed);
    await queries.insertAgentEvent(revId!, "message", {
      role: "assistant", content: "review body\nRECOMMENDATION: fix\nASSESSMENT: needs a test",
    });
    await applyReviewResult(revId!);
    const row = await queries.getReviewByReviewAgent(revId!);
    expect(row!.status).toBe("done");
    expect(row!.recommendation).toBe("fix");
    expect(row!.rationale).toContain("needs a test");
    expect(row!.completed_at).toBeTruthy();
  });

  it("no reviewer output → the row is closed as error but still holds", async () => {
    const reviewed = await seedReviewed({ id: "ag_src" });
    const { dispatcher } = makeFakeDispatcher();
    const revId = await dispatchReviewAgent(dispatcher, reviewed);
    await applyReviewResult(revId!);
    const row = await queries.getReviewByReviewAgent(revId!);
    expect(row!.status).toBe("error");
    expect(row!.recommendation).toBe("hold");
  });
});

describe("interruptReviewForDeadReviewer — a dead reviewer can't wedge 'In review'", () => {
  it("flips the running review row to error and holds the reviewed agent", async () => {
    const reviewed = await seedReviewed({ id: "ag_src" });
    const { dispatcher } = makeFakeDispatcher();
    const revId = await dispatchReviewAgent(dispatcher, reviewed);

    const out = await queries.interruptReviewForDeadReviewer(revId!, "its pod failed: container agent OOMKilled (exit code 137)");
    expect(out).toBe("ag_src");

    const row = await queries.getReviewByReviewAgent(revId!);
    expect(row!.status).toBe("error");
    expect(row!.rationale).toContain("OOMKilled");
    const after = await queries.getAgent("ag_src");
    expect(after!.recommendation).toBe("hold"); // card reads "Review: hold", not a forever-spinning "In review"
    expect(after!.review).toContain("Review interrupted");
  });

  it("never clobbers a verdict the review already produced", async () => {
    const reviewed = await seedReviewed({ id: "ag_src" });
    const { dispatcher } = makeFakeDispatcher();
    const revId = await dispatchReviewAgent(dispatcher, reviewed);
    await queries.setAgentReview("ag_src", "real assessment", "merge");
    await queries.interruptReviewForDeadReviewer(revId!, "pod gone");
    const after = await queries.getAgent("ag_src");
    expect(after!.recommendation).toBe("merge");
    expect(after!.review).toBe("real assessment");
  });

  it("no-op for an agent that isn't a reviewer", async () => {
    const notReviewer = await seedReviewed({ id: "ag_plain" });
    expect(await queries.interruptReviewForDeadReviewer(notReviewer.id, "pod gone")).toBeNull();
  });

  it("a resumed reviewer's real verdict overwrites the interrupt hold", async () => {
    const reviewed = await seedReviewed({ id: "ag_src" });
    const { dispatcher } = makeFakeDispatcher();
    const revId = await dispatchReviewAgent(dispatcher, reviewed);
    await queries.interruptReviewForDeadReviewer(revId!, "pod gone");
    // reviewer resumes, finishes, and applyReviewResult runs as normal:
    await queries.insertAgentEvent(revId!, "message", {
      role: "assistant", content: "finished after resume\nRECOMMENDATION: merge\nASSESSMENT: all good",
    });
    await applyReviewResult(revId!);
    const after = await queries.getAgent("ag_src");
    expect(after!.recommendation).toBe("merge");
    const row = await queries.getReviewByReviewAgent(revId!);
    expect(row!.status).toBe("done");
  });

  it("a paused reviewer does not block dispatching a fresh review", async () => {
    const reviewed = await seedReviewed({ id: "ag_src" });
    const { dispatcher } = makeFakeDispatcher();
    const revId = await dispatchReviewAgent(dispatcher, reviewed);
    await queries.updateAgentState(revId!, "paused", { error_message: "pod gone" });
    expect(await queries.hasActiveReviewAgent("ag_src")).toBe(false);
    expect(await dispatchReviewAgent(dispatcher, reviewed)).toBeTruthy();
  });
});
