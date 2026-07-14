/**
 * Pipeline completion → PR gate. When a test run linked to an agent finishes, the
 * boss (which owns the forge integration — the runner stays domain-neutral) posts
 * the result to that agent's PR and, on green, flips the draft to ready-for-review.
 * That's the "verify before it's reviewable" gate.
 *
 * Boss-side listener on daboss_pipeline_done (mirrors the live-relay pattern).
 */
import pg from "pg";
import * as queries from "../db/queries.js";
import { getCipher } from "../crypto/cipher.js";
import { postPrComment, markReadyForReview, mergePr } from "../forge/github.js";
import { dispatchReviewAgent } from "./review-agent.js";
import { runPhase, listTestPhases, runDeployGateTests } from "./service.js";
import { produceReview } from "./review.js";
import { isTestPhase } from "./config.js";
import type { PipelineRun } from "../db/queries.js";
import type { AgentManager } from "../agent/manager.js";
import { logger } from "../utils/logger.js";

const CHANNEL = "daboss_pipeline_done";
const DEPLOY_PHASE = "deploy";
// Set by startPipelineCompletionListener — needed to dispatch the review agent.
let mgr: AgentManager | null = null;

/** After a PR lands on a deployable ref, auto-propose the repo's `deploy` phase
 *  as a GATED (pending-approval) run — so a deploy card pops up in Reviews for a
 *  human to approve. No-op if the repo has no `deploy` phase, its `only_ref`
 *  doesn't match the merged ref, or a deploy is already queued for this repo+ref
 *  (so a busy main doesn't stack duplicate cards). Deploy stays gate:human — this
 *  proposes, it never ships on its own. */
export async function maybeProposeDeploy(agent: { id: string; repo_url: string | null; repo_ref: string | null; created_by_user_id: string | null }): Promise<void> {
  try {
    if (!agent.repo_url || !agent.created_by_user_id) return;
    const ref = agent.repo_ref || "main";
    const existing = await queries.getActiveDeployRun(agent.repo_url, ref);
    if (existing) {
      logger.info({ repo: agent.repo_url, ref, existing: existing.id }, "Deploy already proposed — skipping");
      return;
    }
    // runPhase resolves the repo's pipeline config; it throws {status:404} when
    // there's no deploy phase and {status:400} when only_ref doesn't match this
    // ref — both mean "nothing to propose", so we just skip. Defer the review:
    // first run the repo's tests on `main` (the pre-deploy gate), then the deploy
    // review runs with those results in hand (see maybeGateDeployReview).
    const { runId, gated } = await runPhase({
      userId: agent.created_by_user_id, repoUrl: agent.repo_url, ref, phaseName: DEPLOY_PHASE, agentId: agent.id,
      deferReview: true,
    });
    if (!gated) {
      await queries.insertAgentEvent(agent.id, "message", { role: "system", content: `🚀 Deploy started for \`${ref}\`.` });
      logger.info({ runId, repo: agent.repo_url, ref, gated }, "Auto-proposed deploy after land");
      return;
    }
    const gateTests = await runDeployGateTests(agent.created_by_user_id, agent.repo_url, runId).catch(() => [] as string[]);
    if (gateTests.length === 0) {
      // No test phase to gate on → review immediately (prior behaviour).
      await produceReview(runId).catch(() => {});
      await queries.insertAgentEvent(agent.id, "message", { role: "system", content: `🚀 Deploy proposed for \`${ref}\` — awaiting approval in Reviews.` });
    } else {
      await queries.insertAgentEvent(agent.id, "message", {
        role: "system",
        content: `🚀 Deploy proposed for \`${ref}\` — running ${gateTests.map((p) => `\`${p}\``).join(", ")} on \`main\` first; the deploy review runs once they're green.`,
      });
    }
    logger.info({ runId, repo: agent.repo_url, ref, gated, gateTests }, "Auto-proposed deploy after land (pre-deploy test gate)");
  } catch (err) {
    const e = err as { status?: number; message?: string };
    if (e.status) logger.info({ agentId: agent.id, reason: e.message }, "No deploy to propose after land");
    else logger.warn({ agentId: agent.id, err: err instanceof Error ? err.message : String(err) }, "Deploy proposal failed");
  }
}

/** A pre-deploy gate test finished. Once EVERY gate test for the deploy is
 *  terminal, run the deploy review with the results in hand. Idempotent —
 *  produceReview only acts while the deploy run is pending_review. */
async function maybeGateDeployReview(deployRunId: string): Promise<void> {
  const run = await queries.getPipelineRun(deployRunId);
  if (!run || run.status !== "pending_review") return; // not awaiting the gate (or already reviewed)
  const tests = await queries.getDeployGateTests(deployRunId);
  if (tests.length === 0) return;
  if (tests.some((t) => t.status !== "passed" && t.status !== "failed")) return; // still running
  await produceReview(deployRunId).catch((e) =>
    logger.warn({ deployRunId, err: e instanceof Error ? e.message : String(e) }, "Deploy review after gate tests failed"));
  // Close the loop in the trace: the "running tests on main first" message had no
  // follow-up, so the deploy card just appeared with no explanation.
  if (run.agent_id) {
    const reviewed = await queries.getPipelineRun(deployRunId);
    const anyFailed = tests.some((t) => t.status === "failed");
    const summary = tests.map((t) => `${t.status === "passed" ? "✅" : "❌"} \`${t.phase}\``).join("  ");
    await queries.insertAgentEvent(run.agent_id, "message", {
      role: "system",
      content: anyFailed
        ? `⛔ Pre-deploy tests on \`main\` FAILED (${summary}) — deploy blocked; the review is REJECT. See the deploy card in Reviews.`
        : `✅ Pre-deploy tests on \`main\` passed (${summary}) — deploy review: **${(reviewed?.recommendation || "hold").toUpperCase()}**. It's now in Reviews for your approval.`,
    }).catch(() => {});
  }
}

async function gatePr(runId: string): Promise<void> {
  const run = await queries.getPipelineRun(runId);
  // A pre-deploy gate test (run on `main`, not tied to a PR): when the batch is
  // done, it triggers the deploy review — never a PR gate.
  if (run?.deploy_gate_run_id) { await maybeGateDeployReview(run.deploy_gate_run_id); return; }
  if (!run || !run.agent_id) return;
  // A deploy run may be linked to an agent for review context, but it must never
  // comment on / gate that agent's (already-merged) PR.
  if (run.phase === DEPLOY_PHASE) return;
  // Only test phases (test, test-*) gate a PR. A repo can split suites by toolchain
  // into several phases; the PR is gated / landed only when ALL of them pass.
  if (!isTestPhase(run.phase)) return;
  await gateTestBatch(run);
}

/** Aggregate a completed test run over the repo's full set of test phases. Acts
 *  only when EVERY test phase has a terminal run in this cycle (land vs PR-gate,
 *  keyed by land_on_pass), and claims the batch atomically so exactly one
 *  completion drives the outcome. */
async function gateTestBatch(run: PipelineRun): Promise<void> {
  const agent = await queries.getAgent(run.agent_id!);
  if (!agent?.pr_number || !agent.repo_url || !agent.created_by_user_id) return;
  const mode = run.land_on_pass; // true = pre-merge land retest, false = PR gate

  // Expected test phases from the repo config (fall back to just this phase).
  let expected = await listTestPhases(agent.created_by_user_id, agent.repo_url, agent.branch ?? undefined).catch(() => [] as string[]);
  if (expected.length === 0) expected = [run.phase];

  // Newest run per expected phase in THIS mode (getPipelineRunsForAgent is newest-first).
  const all = await queries.getPipelineRunsForAgent(agent.id);
  const latest = new Map<string, PipelineRun>();
  for (const r of all) {
    if (r.land_on_pass !== mode || !expected.includes(r.phase)) continue;
    if (!latest.has(r.phase)) latest.set(r.phase, r); // first seen = newest
  }
  // Every phase must have a run, and all must be terminal, before we act.
  if (expected.some((p) => !latest.has(p))) return;
  const batch = expected.map((p) => latest.get(p)!);
  if (batch.some((r) => r.status !== "passed" && r.status !== "failed")) return;

  // Claim atomically — the first completion to find the batch complete wins.
  const claimed = await queries.claimTestBatch(agent.id, expected, mode);
  if (claimed.length === 0) return; // a sibling completion already handled it

  const gitCred = await queries.getUserGitCredential(agent.created_by_user_id);
  if (!gitCred) return;
  const token = await getCipher().decrypt({ ciphertext: gitCred.ciphertext, nonce: gitCred.nonce, keyRef: gitCred.key_ref });

  const failed = batch.filter((r) => r.status !== "passed");
  const allPassed = failed.length === 0;
  const summary = batch.map((r) => `${r.status === "passed" ? "✅" : "❌"} \`${r.phase}\``).join("  ");

  // Land gate: pre-merge retest after rebasing on main. All green → merge; any red → block.
  if (mode) {
    if (!allPassed) {
      await queries.insertAgentEvent(agent.id, "message", {
        role: "system",
        content: `❌ Land blocked — ${failed.map((r) => `\`${r.phase}\``).join(", ")} failed after updating with main. Not merged. (${summary})`,
      });
      logger.info({ prNumber: agent.pr_number, failed: failed.map((r) => r.phase) }, "Land blocked — a retest failed");
      return;
    }
    try {
      // GitHub refuses to merge a DRAFT PR (405). A PR that went straight to land
      // (never through the on-green PR-gate that marks it ready) is still a draft,
      // so un-draft it here before merging.
      await markReadyForReview(agent.repo_url, agent.pr_number, token).catch(() => {});
      const m = await mergePr(agent.repo_url, agent.pr_number, token);
      if (m.merged) {
        await queries.updateAgentState(agent.id, "verified");
        await queries.insertAgentEvent(agent.id, "message", {
          role: "system",
          content: `✅ Landed PR #${agent.pr_number} — rebased on main, all tests green (${summary}), squash-merged.`,
        });
        logger.info({ prNumber: agent.pr_number }, "Landed PR after retest");
        await maybeProposeDeploy(agent);
      } else {
        await queries.insertAgentEvent(agent.id, "message", {
          role: "system",
          content: `❌ Retests passed but the merge failed: ${m.message}. PR #${agent.pr_number} not merged.`,
        });
      }
    } catch (err) {
      logger.warn({ prNumber: agent.pr_number, err: err instanceof Error ? err.message : String(err) }, "Land merge failed");
    }
    return;
  }

  // PR gate: post a combined comment, mark ready only if ALL suites passed.
  const body = [
    `### ${allPassed ? "✅ All tests passed" : "❌ Tests failed"} — da_boss`,
    "",
    ...batch.map((r) => {
      const out = (r.artifact || r.log || "").slice(0, 30_000);
      return `<details><summary>${r.status === "passed" ? "✅" : "❌"} <code>${r.phase}</code> (exit ${r.exit_code ?? "?"})</summary>\n\n\`\`\`\n${out || "(no output)"}\n\`\`\`\n</details>`;
    }),
    "",
    allPassed ? "_Marked ready for review._" : "_Left as draft — fix and re-run._",
  ].join("\n");

  try {
    await postPrComment(agent.repo_url, agent.pr_number, body, token);
    if (allPassed) await markReadyForReview(agent.repo_url, agent.pr_number, token);
    await queries.insertAgentEvent(agent.id, "message", {
      role: "system",
      content: allPassed
        ? `✅ All tests passed (${summary}) — PR #${agent.pr_number} commented + marked ready for review.`
        : `❌ Tests failed (${summary}) — PR #${agent.pr_number} left as draft with the failure comment.`,
    });
    logger.info({ prNumber: agent.pr_number, allPassed, phases: expected }, "Gated PR from test batch");
    // Tests are in → dispatch an in-depth review AGENT (repo + tools, uncapped),
    // once. Its recommendation lands on this agent when it finishes.
    if (mgr) void dispatchReviewAgent(mgr, agent).catch((e) => logger.warn({ agentId: agent.id, err: e instanceof Error ? e.message : String(e) }, "Review agent dispatch failed"));
  } catch (err) {
    logger.warn({ prNumber: agent.pr_number, err: err instanceof Error ? err.message : String(err) }, "PR gate failed");
  }
}

export function startPipelineCompletionListener(manager: AgentManager): void {
  mgr = manager;
  let client: pg.Client | null = null;
  const reconnect = () => {
    try { client?.removeAllListeners(); void client?.end(); } catch { /* ignore */ }
    client = null;
    setTimeout(() => void connect(), 2000);
  };
  const connect = async () => {
    try {
      client = new pg.Client({ connectionString: process.env.DATABASE_URL });
      client.on("error", () => reconnect());
      client.on("notification", (msg) => { if (msg.payload) void gatePr(msg.payload); });
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      logger.info({ channel: CHANNEL }, "Pipeline completion listener ready");
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Pipeline listener connect failed — retrying");
      reconnect();
    }
  };
  void connect();
}
