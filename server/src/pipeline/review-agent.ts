/**
 * Review-as-agent: after tests pass, dispatch a real da_boss AGENT to review the
 * change — the PR branch checked out, full tools, UNCAPPED turns — so it reads the
 * actual code (not just a pasted diff) and is as in-depth as it wants. On the
 * review agent's completion, its final RECOMMENDATION is parsed onto the reviewed
 * agent/PR. The review agent makes no edits, so it opens no PR of its own.
 */
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import * as queries from "../db/queries.js";
import type { AgentRecord, CreateAgentRequest } from "../types/agent.js";
import { resolveSupervisorCredentialEnv } from "../supervisor/credential.js";
import { logger } from "../utils/logger.js";
import { sendNotification } from "../notifications/ntfy.js";
import { buildReviewConfig, gatherAssessment, gatherDecisionTrail, extractVerdictFromText, type Verdict } from "./review-logic.js";

const REVIEW_MODEL = "claude-sonnet-5";

/** The subset of AgentManager a review dispatch needs — the SEAM. Production
 *  passes the real manager (pods); tests pass a fake, so the orchestration
 *  (idempotency, config, review-of linkage) is assertable without a cluster. */
export interface ReviewDispatcher {
  createAgent(req: CreateAgentRequest, userId?: string | null, username?: string | null): Promise<AgentRecord>;
  startAgent(id: string): Promise<void>;
}

/** Deterministically classify a completed review into merge/fix/hold. The review
 *  AGENT does the deep, free-form review; this turns its assessment into a verdict
 *  so a review ALWAYS ends in a clean recommendation — never "no recommendation".
 *  Prefers the review's own RECOMMENDATION line; else a single-shot classification. */
async function extractVerdict(assessment: string): Promise<Verdict> {
  const explicit = extractVerdictFromText(assessment);
  if (explicit) return explicit;
  const cred = await resolveSupervisorCredentialEnv();
  if (!cred.ok) return "hold";
  try {
    let r = "";
    for await (const msg of sdkQuery({
      prompt: `A senior engineer wrote this review of a PR whose tests already passed:\n\n${assessment.slice(0, 12000)}\n\nClassify it into ONE verdict for the human:\n- merge = looks good, ready to merge\n- fix = needs changes, send back to the agent\n- hold = a human should look closely\nReply with EXACTLY one word: merge, fix, or hold.`,
      options: { maxTurns: 2, allowedTools: [], systemPrompt: "You output exactly one word: merge, fix, or hold.", maxBudgetUsd: 0.5, model: REVIEW_MODEL, env: cred.env },
    })) {
      if ("type" in msg && msg.type === "result" && "result" in msg) r = (msg as { result: string }).result || "";
    }
    const v = r.toLowerCase();
    if (/\bfix\b/.test(v)) return "fix";
    if (/\bhold\b/.test(v)) return "hold";
    if (/\bmerge\b/.test(v)) return "merge";
    return "hold";
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "verdict extraction failed");
    return "hold";
  }
}

/** Dispatch a review agent for a reviewed agent's change. Idempotent per reviewed
 *  agent (won't stack reviewers). Returns the review agent id, or null if skipped.
 *  `dispatcher` is the seam (real manager in prod, fake in tests). */
export async function dispatchReviewAgent(
  dispatcher: ReviewDispatcher,
  reviewed: AgentRecord,
  requestedBy?: string | null
): Promise<string | null> {
  if (!reviewed.repo_url || !reviewed.branch || !reviewed.created_by_user_id) return null;
  if (await queries.hasActiveReviewAgent(reviewed.id)) return null;

  const t = await queries.getLatestTestRunForAgent(reviewed.id);
  const testInfo = t ? `${t.phase} ${t.status}${t.exit_code !== null ? ` (exit ${t.exit_code})` : ""}` : "(no test result)";

  // The owner's amendment history (request-changes feedback, scope rulings) —
  // fed to the reviewer so a re-review judges the task AS AMENDED instead of
  // re-holding scope the owner already blessed against the day-one prompt.
  const decisionTrail = gatherDecisionTrail(await queries.getAgentEvents(reviewed.id, 200));

  const agent = await dispatcher.createAgent(buildReviewConfig(reviewed, testInfo, decisionTrail), reviewed.created_by_user_id, null);
  // Set review-of BEFORE starting the pod: the worker reads it at runtime to gate
  // itself read-only (never push). Ordering matters — do not reorder past start.
  await queries.setAgentReviewOf(agent.id, reviewed.id);
  // First-class review record (best-effort; the legacy review_of_agent_id linkage
  // above still drives the UI + the worker's no-push gate during the transition).
  await queries.createReview({
    reviewed_agent_id: reviewed.id,
    review_agent_id: agent.id,
    requested_by: requestedBy ?? reviewed.created_by_user_id,
    runner: "pod",
    status: "running",
  }).catch((e) => logger.warn({ err: e instanceof Error ? e.message : String(e) }, "createReview failed"));
  await queries.insertAgentEvent(reviewed.id, "message", {
    role: "system",
    content: `🔍 Review agent dispatched — reading the code in depth. Recommendation will land here when it finishes.`,
  });
  await dispatcher.startAgent(agent.id);
  logger.info({ reviewAgent: agent.id, reviewed: reviewed.id }, "Dispatched review agent");
  return agent.id;
}

/** When a review agent terminates, parse its final RECOMMENDATION and apply it to
 *  the agent/PR it reviewed. No-op unless this agent is a reviewer. */
export async function applyReviewResult(reviewAgentId: string): Promise<void> {
  const reviewer = await queries.getAgent(reviewAgentId);
  if (!reviewer?.review_of_agent_id) return;
  const reviewedId = reviewer.review_of_agent_id;
  // Guard: only act once (the reviewed agent keeps its review after we set it).
  const already = await queries.getAgent(reviewedId);
  // (re-review after request-changes clears the recommendation, so this is safe)

  // The review agent's assessment = its last few substantive assistant messages.
  const events = await queries.getAgentEvents(reviewAgentId, 40); // newest-first
  const assessment = gatherAssessment(events);

  if (!assessment) {
    // The agent genuinely produced nothing (crash) — the only real "no verdict" case.
    await queries.setAgentReview(reviewedId, `⚠️ The review agent produced no output (it may have errored) — review the diff manually.`, "hold");
    await queries.insertAgentEvent(reviewedId, "message", { role: "system", content: `📋 Review couldn't complete — please review PR${already?.pr_number ? ` #${already.pr_number}` : ""} manually.` });
    await closeReviewRecord(reviewAgentId, "hold", "The review agent produced no output.", "error");
    return;
  }

  // A review ALWAYS resolves to a clean verdict — extracted deterministically.
  const rec = await extractVerdict(assessment);
  await queries.setAgentReview(reviewedId, assessment.slice(0, 20_000), rec);
  await closeReviewRecord(reviewAgentId, rec, assessment, "done");
  await queries.insertAgentEvent(reviewedId, "message", {
    role: "system",
    content: `📋 Reviewer recommendation: **${rec.toUpperCase()}** — see the verdict card for the in-depth assessment.`,
  });
  await sendNotification(`Agent "${already?.name}" reviewed → ${rec}`, assessment.replace(/RECOMMENDATION:.*\n?/i, "").slice(0, 250), rec === "merge" ? "default" : "high").catch(() => {});
  logger.info({ reviewAgentId, reviewedId, rec }, "Applied review agent recommendation");
}

/** Close the first-class review row for a reviewer agent (best-effort — the
 *  legacy agents.review linkage is the source of truth during transition). */
async function closeReviewRecord(
  reviewAgentId: string,
  rec: Verdict,
  rationale: string,
  status: "done" | "error"
): Promise<void> {
  try {
    const review = await queries.getReviewByReviewAgent(reviewAgentId);
    if (review) await queries.completeReview(review.id, rec, rationale, status);
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, "completeReview failed");
  }
}
