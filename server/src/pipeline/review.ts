/**
 * Pre-audited deploy review — the reviewing agent. Before a human is asked to
 * approve a gated (gate: human) run, this assesses the change and produces a
 * RECOMMENDATION, so the human decides with a packet in front of them, not blind.
 *
 * Inputs: the original task (from the linked agent), the branch diff (forge
 * compare), and the test-agent result. Runs on the supervisor credential (a
 * system assessment). Moves the run pending_review → pending_approval.
 */
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import * as queries from "../db/queries.js";
import { getCipher } from "../crypto/cipher.js";
import { getDiffSummary } from "../forge/github.js";
import { resolveSupervisorCredentialEnv } from "../supervisor/credential.js";
import { sendNotification } from "../notifications/ntfy.js";
import { withClaudeLock } from "../utils/claude-lock.js";
import { logger } from "../utils/logger.js";

// Reviewer model — a capable model for judgment. (The stale `claude-sonnet-4-6`
// silently returned empty results → "hold / no assessment".)
const REVIEW_MODEL = "claude-sonnet-5";
const REVIEW_MAX_USD = 1.0;
// NOTE: the agent CHANGE review is now an in-depth review AGENT (review-agent.ts).
// reviewAgentChange() below is superseded and unused; produceReview() (the deploy
// gate) is still boss-side — a candidate to convert to a review agent next.

/**
 * Report-back review of an AGENT's change (not a deploy run). Produced after
 * tests so the agent "comes back to you": task + diff + test result → a
 * RECOMMENDATION (merge/fix/hold) + assessment, stored on the agent, surfaced on
 * its page + a notification. Idempotent (skips if already reviewed).
 */
export async function reviewAgentChange(agentId: string): Promise<void> {
  const agent = await queries.getAgent(agentId);
  if (!agent || agent.recommendation) return;
  if (!agent.repo_url || !agent.branch || !agent.created_by_user_id) return;

  const t = await queries.getLatestTestRunForAgent(agentId);
  const testInfo = t
    ? `Test '${t.phase}': ${t.status}${t.exit_code !== null ? ` (exit ${t.exit_code})` : ""}.\n${(t.artifact || "").slice(0, 3000)}`
    : "(no test result)";

  const cred = await resolveSupervisorCredentialEnv();
  if (!cred.ok) {
    await queries.setAgentReview(agentId, "⚠️ No reviewer credential configured — review manually (set a Supervisor Credential in Settings).", "hold");
    await queries.insertAgentEvent(agentId, "message", { role: "system", content: `📋 Review skipped (no reviewer credential).${t ? ` Tests ${t.status}.` : ""} PR${agent.pr_number ? ` #${agent.pr_number}` : ""} awaits your call.` });
    return;
  }

  let diff = "";
  const gc = await queries.getUserGitCredential(agent.created_by_user_id);
  if (gc) {
    const token = await getCipher().decrypt({ ciphertext: gc.ciphertext, nonce: gc.nonce, keyRef: gc.key_ref });
    diff = (await getDiffSummary(agent.repo_url, agent.repo_ref || "main", agent.branch, token).catch(() => null)) || "";
  }

  const prompt = `You are a senior reviewer. A da_boss agent finished a change and its tests ran. Recommend what the human should do next.

ORIGINAL TASK:
${agent.prompt.slice(0, 2000)}

TEST RESULT:
${testInfo}

DIFF:
${diff.slice(0, 30_000) || "(diff unavailable)"}

Respond EXACTLY:
RECOMMENDATION: <merge|fix|hold>
  (merge = looks good, ready to merge; fix = needs changes, send it back to the agent; hold = a human should look closely)
ASSESSMENT: <2-4 sentences: what it did + your reasoning>
CONCERNS: <bullets, or "none">`;

  try {
    const result = await withClaudeLock(async () => {
      let r = "";
      let meta: { subtype?: string; is_error?: boolean; total_cost_usd?: number; num_turns?: number } | null = null;
      for await (const msg of sdkQuery({ prompt, options: { maxTurns: 2, allowedTools: [], maxBudgetUsd: REVIEW_MAX_USD, model: REVIEW_MODEL, env: cred.env } })) {
        if ("type" in msg && msg.type === "result") { meta = msg as typeof meta; if ("result" in msg) r = (msg as { result: string }).result || ""; }
      }
      if (!r.trim()) logger.warn({ agentId, model: REVIEW_MODEL, subtype: meta?.subtype, isError: meta?.is_error, costUsd: meta?.total_cost_usd, turns: meta?.num_turns }, "Review call empty — subtype tells why");
      return r;
    });
    if (!result.trim()) {
      // Empty result = the model call produced nothing (budget cut-off, bad model,
      // or credential). Don't pretend it's a verdict — say so and log it.
      logger.warn({ agentId, model: REVIEW_MODEL }, "Reviewer returned an empty result");
      await queries.setAgentReview(agentId, "⚠️ The reviewer returned no output (model/credential/budget issue). Tests " + (t?.status ?? "n/a") + " — review the diff yourself.", "hold");
      await queries.insertAgentEvent(agentId, "message", { role: "system", content: `📋 Review inconclusive (reviewer returned nothing)${t ? ` — tests ${t.status}` : ""}. PR${agent.pr_number ? ` #${agent.pr_number}` : ""} awaits your call.` });
      return;
    }
    const rec = (result.match(/RECOMMENDATION:\s*(merge|fix|hold)/i)?.[1] || "hold").toLowerCase();
    await queries.setAgentReview(agentId, result.trim().slice(0, 20_000), rec);
    await queries.insertAgentEvent(agentId, "message", { role: "system", content: `📋 Reviewer recommendation: **${rec.toUpperCase()}**${t ? ` (tests ${t.status})` : ""} — see the verdict card for the assessment + next steps.` });
    await sendNotification(`Agent "${agent.name}" reviewed → ${rec}`, result.replace(/RECOMMENDATION:.*\n?/i, "").slice(0, 250), rec === "merge" ? "default" : "high").catch(() => {});
    logger.info({ agentId, recommendation: rec }, "Produced agent report-back review");
  } catch (err) {
    await queries.setAgentReview(agentId, `Review failed: ${err instanceof Error ? err.message : String(err)}. Decide manually.`, "hold");
  }
}

export async function produceReview(runId: string): Promise<void> {
  const run = await queries.getPipelineRun(runId);
  if (!run || run.status !== "pending_review") return;

  const cred = await resolveSupervisorCredentialEnv();
  if (!cred.ok) {
    await queries.setPipelineReview(runId, "⚠️ No reviewer credential configured — approve on your own judgment (set a Supervisor Credential in Settings for auto-review).", "hold");
    return;
  }

  let task = `Deploy phase '${run.phase}' on ${run.git_ref ?? "the target ref"}.`;
  let diff = "";
  let testInfo = "";

  if (run.agent_id) {
    const agent = await queries.getAgent(run.agent_id);
    if (agent) {
      task = agent.prompt;
      if (agent.repo_url && agent.branch && agent.created_by_user_id) {
        const gc = await queries.getUserGitCredential(agent.created_by_user_id);
        if (gc) {
          const token = await getCipher().decrypt({ ciphertext: gc.ciphertext, nonce: gc.nonce, keyRef: gc.key_ref });
          diff = (await getDiffSummary(agent.repo_url, agent.repo_ref || "main", agent.branch, token).catch(() => null)) || "";
        }
      }
      const t = await queries.getLatestTestRunForAgent(run.agent_id);
      if (t) testInfo = `Test phase '${t.phase}': ${t.status}${t.exit_code !== null ? ` (exit ${t.exit_code})` : ""}.\n${(t.artifact || "").slice(0, 3000)}`;
    }
  }

  const prompt = `You are a senior engineer gating a deploy. Decide whether this change is safe to ship, and give a clear recommendation.

ORIGINAL TASK:
${task.slice(0, 2000)}

TEST RESULTS:
${testInfo || "(no test-agent results found for this change)"}

DIFF:
${diff.slice(0, 30_000) || "(diff unavailable)"}

Respond EXACTLY in this format:
RECOMMENDATION: <approve|hold|reject>
ASSESSMENT: <2-4 sentences: what the change does and its risk>
CONCERNS: <bullet list of specific issues to check, or "none">`;

  try {
    const result = await withClaudeLock(async () => {
      let r = "";
      let meta: { subtype?: string; is_error?: boolean; total_cost_usd?: number } | null = null;
      for await (const msg of sdkQuery({
        prompt,
        // No tools: the review is a pure text verdict from the prompt (the diff is
        // in it). With tools available the model tries to explore + hits maxTurns
        // (there's no repo checkout in the boss pod) → error_max_turns → empty.
        options: { maxTurns: 2, allowedTools: [], maxBudgetUsd: REVIEW_MAX_USD, model: REVIEW_MODEL, env: cred.env },
      })) {
        if ("type" in msg && msg.type === "result") { meta = msg as typeof meta; if ("result" in msg) r = (msg as { result: string }).result || ""; }
      }
      if (!r.trim()) logger.warn({ runId, subtype: meta?.subtype, isError: meta?.is_error, costUsd: meta?.total_cost_usd }, "Deploy review call empty");
      return r;
    });
    const rec = (result.match(/RECOMMENDATION:\s*(approve|hold|reject)/i)?.[1] || "hold").toLowerCase();
    await queries.setPipelineReview(runId, result.trim().slice(0, 20_000) || "⚠️ The reviewer returned no output (model/credential/budget issue) — approve on your own judgment.", rec);
    logger.info({ runId, recommendation: rec }, "Produced deploy review");
  } catch (err) {
    logger.warn({ runId, err: err instanceof Error ? err.message : String(err) }, "Review failed");
    await queries.setPipelineReview(runId, `Review failed: ${err instanceof Error ? err.message : String(err)}. Approve on your own judgment.`, "hold");
  }
}
