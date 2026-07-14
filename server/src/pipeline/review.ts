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

  // PRE-DEPLOY TEST GATE — the repo's tests run on `main` itself (the merged
  // result). A red here is a hard block (enforced below), not just advice.
  const gateTests = await queries.getDeployGateTests(runId);
  const anyTestFailed = gateTests.some((t) => t.status === "failed");
  const testSummary = gateTests.length
    ? gateTests.map((t) => `${t.status === "passed" ? "✅" : "❌"} ${t.phase} (exit ${t.exit_code ?? "?"})${t.status === "failed" ? `\n${(t.artifact || t.log || "").slice(-1500)}` : ""}`).join("\n")
    : "(the repo declares no test phase — no automated test ran on main)";

  // THE CHANGES THIS DEPLOY SHIPS — each with its original task + prior review, so
  // the gate can validate intent and confirm earlier concerns, not just the diff.
  const changes = run.repo_url ? await queries.getPendingDeployChanges(run.repo_url) : [];
  const changeSummary = changes.length
    ? changes.map((c) => `• ${c.pr_number ? `PR #${c.pr_number}` : c.name} — "${c.name}"\n  Task: ${(c.prompt || "").slice(0, 600)}\n  Prior review: ${c.recommendation ? c.recommendation.toUpperCase() : "n/a"}${c.review ? ` — ${c.review.replace(/\n+/g, " ").slice(0, 700)}` : ""}`).join("\n\n")
    : "(no linked change manifest — judge from the diff alone)";

  // The diff of the change that triggered this deploy (vs its base). Other shipped
  // changes are summarised above via their prior reviews.
  if (run.agent_id && token) {
    const agent = await queries.getAgent(run.agent_id);
    if (agent?.repo_url && agent.branch) {
      diff = (await getDiffSummary(agent.repo_url, agent.repo_ref || "main", agent.branch, token).catch(() => null)) || "";
    }
  }

  const prompt = `You are the FINAL GATE before a PRODUCTION DEPLOY. A human approves next — give them a clear-eyed verdict. Judge THREE things:

1) WILL IT BREAK THE DEPLOY? Reason strictly from the deploy command below. A changed file the command does NOT build/apply/run/reference is INERT and cannot break this deploy — call it out as inert, don't hold on it. HOLD/REJECT only for a real break in the execution path: a malformed manifest it applies, a missing image/secret/env it needs, a broken DB migration it runs, a Service/Ingress/port/exposure change it ships, or a script it invokes that will fail.

2) DOES THE CODE DO WHAT IT'S SUPPOSED TO? For each shipped change, check the diff against its stated Task and its prior review. Flag intent drift (it does something other than its task) or prior-review concerns that look unaddressed.

3) ANY OTHER MAJOR PROBLEM in the changed code? Correctness bugs, security issues (exposure, auth, injection, secrets), or breaking changes to shared behaviour. Ignore style/nits.

THE DEPLOY COMMAND (this is ALL the deploy does):
${deployCommand || "(command unknown — assume it applies k8s manifests and rolls deployments using already-built images)"}

PRE-DEPLOY TESTS (run on \`main\` itself — the merged result):
${testSummary}

CHANGES BEING SHIPPED (task + prior review):
${changeSummary}

DIFF of the triggering change (generated lockfiles/hashes are noise; judge by which FILES changed and how):
${diff.slice(0, 16_000) || "(diff unavailable — flag that you couldn't see the changes)"}

Respond EXACTLY in this format:
RECOMMENDATION: <approve|hold|reject>
ASSESSMENT: <what ships, whether it matches intent, and whether the deploy path is safe>
CONCERNS: <specific breaks / intent drift / major code problems, or "none">`;

  try {
    const result = await withClaudeLock(async () => {
      let r = "";
      let meta: { subtype?: string; is_error?: boolean; total_cost_usd?: number } | null = null;
      for await (const msg of sdkQuery({
        prompt,
        // No tools: the review is a pure text verdict from the prompt (diff +
        // tests + prior reviews are in it). With tools the model tries to explore +
        // hits maxTurns (no repo checkout in the boss pod) → error_max_turns → empty.
        options: { maxTurns: 6, allowedTools: [], maxBudgetUsd: REVIEW_MAX_USD, model: REVIEW_MODEL, env: cred.env },
      })) {
        if ("type" in msg && msg.type === "result") { meta = msg as typeof meta; if ("result" in msg) r = (msg as { result: string }).result || ""; }
      }
      if (!r.trim()) logger.warn({ runId, subtype: meta?.subtype, isError: meta?.is_error, costUsd: meta?.total_cost_usd }, "Deploy review call empty");
      return r;
    });
    let rec = (result.match(/RECOMMENDATION:\s*(approve|hold|reject)/i)?.[1] || "hold").toLowerCase();
    let text = result.trim() || "⚠️ The reviewer returned no output (model/credential/budget issue) — decide on your own judgment.";
    // Hard rule: a failing test on main is a block. Never let the deploy show
    // APPROVE past a red pre-deploy test — override to reject with the reason.
    if (anyTestFailed) {
      rec = "reject";
      text = `⛔ A pre-deploy test FAILED on \`main\` — do not deploy until it's green.\n\n${text}`;
    }
    await queries.setPipelineReview(runId, text.slice(0, 20_000), rec);
    logger.info({ runId, recommendation: rec, anyTestFailed, changes: changes.length }, "Produced deploy review");
  } catch (err) {
    logger.warn({ runId, err: err instanceof Error ? err.message : String(err) }, "Review failed");
    await queries.setPipelineReview(runId, `Review failed: ${err instanceof Error ? err.message : String(err)}. Approve on your own judgment.`, "hold");
  }
}
