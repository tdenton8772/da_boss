/**
 * Hand a change back to da_boss after working on it outside an agent run (locally,
 * against its dev environment): make sure the branch has a PR, then run the repo's
 * test gates and queue the review agent — the same land path an agent's own change
 * takes. The dev env is left running (the human may still be clicking around); it
 * expires on its own or is stopped explicitly.
 */
import * as queries from "../db/queries.js";
import type { AgentRecord } from "../types/agent.js";
import { getCipher } from "../crypto/cipher.js";
import { ensurePullRequest, getBranchHead } from "../forge/github.js";
import { runTestPhasesForAgent } from "../pipeline/service.js";
import { dispatchReviewAgent, type ReviewDispatcher } from "../pipeline/review-agent.js";
import { DevEnvError } from "./dev-env.js";

export interface HandbackResult {
  pr: { number: number; url: string } | null;
  runs: Array<{ phase: string; runId: string }>;
  review_agent_id: string | null;
  notes: string[];
}

export async function handbackChange(manager: ReviewDispatcher, agent: AgentRecord, actor: { userId: string; label: string }): Promise<HandbackResult> {
  if (!agent.repo_url || !agent.branch) throw new DevEnvError(400, "This change has no repo/branch.");
  const cred = await queries.getUserGitCredential(actor.userId);
  if (!cred) throw new DevEnvError(400, "Add a GitHub token in Settings first.");
  const token = await getCipher().decrypt({ ciphertext: cred.ciphertext, nonce: cred.nonce, keyRef: cred.key_ref });
  if (!(await getBranchHead(agent.repo_url, agent.branch, token))) {
    throw new DevEnvError(400, `Branch '${agent.branch}' isn't on the remote — push your work first.`);
  }
  const notes: string[] = [];

  // 1. A PR for the branch (find or open). No commits vs base → nothing to hand back.
  const pr = await ensurePullRequest({
    repoUrl: agent.repo_url,
    token,
    branch: agent.branch,
    base: agent.repo_ref || undefined,
    title: agent.name,
    body: `Developed outside an agent run (local work against a da_boss dev environment) and handed back by ${actor.label} for testing + review.\n\nda_boss change: \`${agent.id}\``,
    draft: (process.env.DABOSS_PR_DRAFT || "true") !== "false",
  });
  if (!pr) throw new DevEnvError(400, `No PR could be opened for '${agent.branch}' — does it have commits ahead of the base branch?`);
  if (agent.pr_number !== pr.number) await queries.setAgentPullRequest(agent.id, pr.url, pr.number);

  // 2. The change is done from da_boss's point of view: a never-run (local-dev) or
  //    paused change becomes completed, which is what the review/land path expects.
  if (["pending", "paused", "queued"].includes(agent.state)) {
    await queries.updateAgentState(agent.id, "completed", { completed_at: new Date().toISOString() });
  }
  const current = (await queries.getAgent(agent.id))!;

  // 3. Gates + review.
  let runs: HandbackResult["runs"] = [];
  try {
    runs = await runTestPhasesForAgent(current);
  } catch (err) {
    notes.push((err as { message?: string }).message || String(err));
  }
  let reviewAgentId: string | null = null;
  if (await queries.hasActiveReviewAgent(agent.id)) notes.push("A review is already in progress.");
  else reviewAgentId = await dispatchReviewAgent(manager, current, actor.userId);

  await queries.insertAgentEvent(agent.id, "message", {
    role: "system",
    content: `↩️ **${actor.label}** handed this change back — PR #${pr.number}${runs.length ? `, ${runs.length} check(s) running` : ""}${reviewAgentId ? ", review queued" : ""}.`,
  });
  return { pr: { number: pr.number, url: pr.url }, runs, review_agent_id: reviewAgentId, notes };
}
