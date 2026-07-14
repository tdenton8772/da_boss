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
import { getDiffSummary, getFileContents } from "../forge/github.js";
import { parsePipeline, PIPELINE_PATH } from "./config.js";
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

  let diff = "";
  let deployCommand = "";

  // A git token from the run's owner (or the linked agent's owner).
  const ownerId = run.created_by_user_id || (run.agent_id ? (await queries.getAgent(run.agent_id))?.created_by_user_id : null) || null;
  let token: string | null = null;
  if (ownerId) {
    const gc = await queries.getUserGitCredential(ownerId);
    if (gc) token = await getCipher().decrypt({ ciphertext: gc.ciphertext, nonce: gc.nonce, keyRef: gc.key_ref });
  }

  // THE DEPLOY COMMAND — what the deploy actually does. This is the axis the review
  // must reason on: a changed file the command doesn't build/apply/run is inert.
  if (token && run.repo_url && run.git_ref) {
    try {
      const yaml = await getFileContents(run.repo_url, PIPELINE_PATH, run.git_ref, token);
      if (yaml) deployCommand = parsePipeline(yaml).phases[run.phase]?.command || "";
    } catch { /* command unknown → the prompt handles it */ }
  }

  // The changes being shipped (the linked change's diff vs its base).
  if (run.agent_id && token) {
    const agent = await queries.getAgent(run.agent_id);
    if (agent?.repo_url && agent.branch) {
      diff = (await getDiffSummary(agent.repo_url, agent.repo_ref || "main", agent.branch, token).catch(() => null)) || "";
    }
  }

  const prompt = `You are gating a PRODUCTION DEPLOY. Your ONLY job is to catch what will ACTUALLY BREAK — not code style, not test coverage, not speculative "this wasn't verified" worries.

THE DEPLOY COMMAND (this is ALL the deploy does):
${deployCommand || "(command unknown — assume it applies k8s manifests and rolls deployments using already-built images)"}

Reason strictly from that command. Ask: which of the changed files does this command actually build, apply, run, or reference? A change to a file the command does NOT touch — e.g. a Dockerfile that isn't built by this deploy, application code not exercised by it, a lockfile no build here consumes — is INERT and CANNOT break this deploy. Do NOT hold on inert changes; call them out as inert and move on.

Recommend HOLD/REJECT ONLY for a KNOWN break in the deploy's execution path: a malformed manifest it applies, a missing image/secret/env it needs, a broken DB migration it runs, a Service/Ingress/port/exposure change it ships, or a command/script it invokes that will fail. If nothing in the changes is in the deploy's execution path, APPROVE.

CHANGES BEING SHIPPED (diff — generated lockfiles/hashes are noise; judge by which FILES changed and how the deploy uses them):
${diff.slice(0, 18_000) || "(diff unavailable — flag that you couldn't see the changes)"}

Respond EXACTLY in this format:
RECOMMENDATION: <approve|hold|reject>
ASSESSMENT: <what the deploy command does, and which (if any) changed files are actually in its path>
CONCERNS: <specific KNOWN breaks in the deploy path, or "none — remaining changes are inert for this deploy">`;

  try {
    const result = await withClaudeLock(async () => {
      let r = "";
      let meta: { subtype?: string; is_error?: boolean; total_cost_usd?: number } | null = null;
      for await (const msg of sdkQuery({
        prompt,
        // No tools: the review is a pure text verdict from the prompt (the diff is
        // in it). With tools available the model tries to explore + hits maxTurns
        // (there's no repo checkout in the boss pod) → error_max_turns → empty.
        options: { maxTurns: 6, allowedTools: [], maxBudgetUsd: REVIEW_MAX_USD, model: REVIEW_MODEL, env: cred.env },
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
