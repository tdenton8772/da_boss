/**
 * Pipeline service — resolve a phase (config + secrets + guardrails) and launch a
 * run. Shared by the API, the auto-chain, and the approval flow so there's one
 * path. Throws { status, message } for HTTP callers.
 */
import { nanoid } from "nanoid";
import * as queries from "../db/queries.js";
import { getCipher } from "../crypto/cipher.js";
import { getFileContents, getRepoAccess } from "../forge/github.js";
import { launchPipelineRunner } from "../agent/pod-dispatcher.js";
import { parsePipeline, PIPELINE_PATH, isTestPhase, type PipelinePhase } from "./config.js";
import { produceReview } from "./review.js";
import type { AgentRecord } from "../types/agent.js";

export const secretEnvName = (n: string): string => n.toUpperCase().replace(/[^A-Z0-9]/g, "_");

export interface ResolvedPhase {
  ph: PipelinePhase;
  secrets: Record<string, string>;
  gitToken: string;
}

export async function resolvePhase(
  userId: string,
  repoUrl: string,
  ref: string | undefined,
  phaseName: string
): Promise<ResolvedPhase> {
  const gitCred = await queries.getUserGitCredential(userId);
  if (!gitCred) throw { status: 400, message: "Add a git credential first (needed to read the repo)." };
  const gitToken = await getCipher().decrypt({ ciphertext: gitCred.ciphertext, nonce: gitCred.nonce, keyRef: gitCred.key_ref });
  const yamlText = await getFileContents(repoUrl, PIPELINE_PATH, ref, gitToken);
  if (!yamlText) {
    // A 404 on the file read is ambiguous — the repo may just not have the file,
    // OR the token can't see the repo (GitHub 404s private repos you lack access
    // to) or the call failed transiently. Probe repo access to say which.
    const access = await getRepoAccess(repoUrl, gitToken);
    if (!access.ok) {
      throw { status: 400, message: access.status === 404 || access.status === 401 || access.status === 403
        ? `Can't read ${repoUrl} with your git credential (HTTP ${access.status}) — check the token has access to this repo, then retry.`
        : `Couldn't reach GitHub for ${repoUrl} (HTTP ${access.status || "network error"}) — transient; retry.` };
    }
    throw { status: 400, message: `No ${PIPELINE_PATH} at '${ref ?? "default"}' in ${repoUrl}. Add the pipeline file on that ref.` };
  }
  const pipeline = parsePipeline(yamlText);
  const ph = pipeline.phases[phaseName];
  if (!ph) throw { status: 404, message: `No phase '${phaseName}'. Available: ${Object.keys(pipeline.phases).join(", ")}` };
  if (ph.only_ref && ref !== ph.only_ref) {
    throw { status: 400, message: `Phase '${phaseName}' may only run on '${ph.only_ref}' (got '${ref ?? "default"}'). Deploy from the trusted ref, not a PR branch.` };
  }
  const secrets: Record<string, string> = {};
  for (const nm of ph.requires || []) {
    const s = await queries.getUserSecret(userId, nm);
    if (!s) throw { status: 400, message: `Missing required secret '${nm}' — add it in Settings.` };
    secrets[secretEnvName(nm)] = await getCipher().decrypt({ ciphertext: s.ciphertext, nonce: s.nonce, keyRef: s.key_ref });
  }
  return { ph, secrets, gitToken };
}

export async function launchResolved(runId: string, repoUrl: string, ref: string | undefined, r: ResolvedPhase): Promise<void> {
  await launchPipelineRunner({
    runId, repoUrl, ref, command: r.ph.command, image: r.ph.image ?? null,
    params: r.ph.params || {}, secrets: r.secrets, gitToken: r.gitToken,
    services: r.ph.services, serviceAccount: r.ph.service_account,
  });
}

/** Resolve + create the run + launch (or, for gate:human, produce a review and
 *  wait for approval). Returns the runId and whether it's gated. */
export async function runPhase(opts: {
  userId: string;
  repoUrl: string;
  ref?: string;
  phaseName: string;
  agentId?: string | null;
  landOnPass?: boolean;
  /** For a gated (deploy) run: skip the immediate review. The caller runs the
   *  pre-deploy test gate first and triggers produceReview when it's done. */
  deferReview?: boolean;
}): Promise<{ runId: string; gated: boolean }> {
  const r = await resolvePhase(opts.userId, opts.repoUrl, opts.ref, opts.phaseName);
  const gated = r.ph.gate === "human";
  // Dedup a human-gated deploy: if one is already open for this repo+ref, return
  // it instead of stacking a second card (only the auto-propose path guarded before,
  // so a manual trigger could create a duplicate). Idempotent for all callers.
  if (gated) {
    const existing = await queries.getActiveDeployRun(opts.repoUrl, opts.ref || "main");
    if (existing) return { runId: existing.id, gated: true };
  }
  const runId = `run_${nanoid(12)}`;
  await queries.insertPipelineRun({
    id: runId, repoUrl: opts.repoUrl, ref: opts.ref || null, phase: opts.phaseName,
    status: gated ? "pending_review" : "pending", createdByUserId: opts.userId, agentId: opts.agentId ?? null,
    landOnPass: opts.landOnPass ?? false,
  });
  if (gated) { if (!opts.deferReview) void produceReview(runId).catch(() => {}); }
  else await launchResolved(runId, opts.repoUrl, opts.ref, r);
  return { runId, gated };
}

/** Pre-deploy test gate: run the repo's test phase(s) on `main` itself, each tagged
 *  with the deploy run id, so the completion listener triggers the deploy review
 *  once they all finish (with the results in hand). This catches breakage from
 *  interactions with anything merged since a change's land retest. Returns the
 *  phases started — empty if the repo declares no test phase (review runs now). */
export async function runDeployGateTests(userId: string, repoUrl: string, deployRunId: string): Promise<string[]> {
  const phases = await listTestPhases(userId, repoUrl, "main");
  const started: string[] = [];
  for (const phase of phases) {
    const r = await resolvePhase(userId, repoUrl, "main", phase);
    const runId = `run_${nanoid(12)}`;
    await queries.insertPipelineRun({
      id: runId, repoUrl, ref: "main", phase, status: "pending",
      createdByUserId: userId, agentId: null, deployGateRunId: deployRunId,
    });
    await launchResolved(runId, repoUrl, "main", r);
    started.push(phase);
  }
  return started;
}

/** Run a repo phase (default 'test') for an agent's branch, linked to it so the
 *  completion listener gates its PR + triggers the report-back review. With
 *  landOnPass, the completion listener merges the PR on green instead (land gate). */
export async function runPhaseForAgent(
  agent: AgentRecord,
  phaseName: string,
  opts?: { landOnPass?: boolean }
): Promise<string> {
  if (!agent.repo_url || !agent.branch) throw { status: 400, message: "Agent has no repo/branch to test" };
  if (!agent.created_by_user_id) throw { status: 400, message: "Agent has no owner" };
  const landOnPass = opts?.landOnPass ?? false;
  const { runId, gated } = await runPhase({
    userId: agent.created_by_user_id, repoUrl: agent.repo_url, ref: agent.branch, phaseName, agentId: agent.id,
    landOnPass,
  });
  await queries.insertAgentEvent(agent.id, "message", {
    role: "system",
    content: landOnPass
      ? `⏳ Landing PR${agent.pr_number ? ` #${agent.pr_number}` : ""}: rebased on main, re-running \`${phaseName}\` before merge…`
      : `🧪 Running \`${phaseName}\` phase on \`${agent.branch}\`${gated ? " (awaiting approval)" : ""} — result will gate PR${agent.pr_number ? ` #${agent.pr_number}` : ""}.`,
  });
  return runId;
}

/** The repo's PR-gating test phases (test, test-*) on a given ref. Empty if the
 *  repo has no pipeline / no test phases. Reads the config once. */
export async function listTestPhases(userId: string, repoUrl: string, ref: string | undefined): Promise<string[]> {
  const gitCred = await queries.getUserGitCredential(userId);
  if (!gitCred) return [];
  const gitToken = await getCipher().decrypt({ ciphertext: gitCred.ciphertext, nonce: gitCred.nonce, keyRef: gitCred.key_ref });
  const yamlText = await getFileContents(repoUrl, PIPELINE_PATH, ref, gitToken);
  if (!yamlText) return [];
  const pipeline = parsePipeline(yamlText);
  return Object.keys(pipeline.phases).filter(isTestPhase);
}

/** Run ALL of the repo's test phases for an agent's branch (each a linked run) so
 *  every suite gates the PR. The completion listener aggregates: the PR is gated
 *  green / landed only when every test phase passed. Throws {status:404} if the
 *  repo declares no test phase. Returns the runs it started. */
export async function runTestPhasesForAgent(
  agent: AgentRecord,
  opts?: { landOnPass?: boolean }
): Promise<Array<{ phase: string; runId: string }>> {
  if (!agent.repo_url || !agent.branch) throw { status: 400, message: "Agent has no repo/branch to test" };
  if (!agent.created_by_user_id) throw { status: 400, message: "Agent has no owner" };
  const phases = await listTestPhases(agent.created_by_user_id, agent.repo_url, agent.branch);
  if (phases.length === 0) throw { status: 404, message: "The repo declares no test phase." };
  const out: Array<{ phase: string; runId: string }> = [];
  for (const phase of phases) {
    out.push({ phase, runId: await runPhaseForAgent(agent, phase, opts) });
  }
  return out;
}
