/**
 * Dispatch a MANAGED DEPLOY AGENT to execute an approved deploy phase — instead of
 * a dumb pipeline pod. The agent runs the repo's deploy command from its own pod
 * (on the phase's ServiceAccount + da_boss's deploy-agent image), streaming every
 * step to the UI and interpreting the result so it can roll back on failure.
 *
 * Tracking runs through the SAME recorder pipeline as every normal pipeline run:
 * the deploy writes its exit code to /work/.daboss/exit, and a recorder sidecar in
 * the agent's pod (added by createAgentPod when the agent has a pipeline_run_id)
 * records exit → run status → NOTIFY → completion listener. So the DEPLOY's real
 * exit code drives the run — never the agent's (unreliable) Claude-process exit.
 *
 * The approval gate is upstream (Reviews): this only runs after a human approves.
 * Domain-neutral — the command + identity come from the repo's pipeline.yaml; the
 * agent-capable image is da_boss config (config.deployAgentImage).
 */
import { config } from "../config.js";
import * as queries from "../db/queries.js";
import type { AgentManager } from "../agent/manager.js";
import type { PipelinePhase } from "./config.js";
import type { PipelineRun } from "../db/queries.js";

/** Build the deploy-manager prompt: run the command DETACHED, writing to the
 *  recorder's files (/work/.daboss/{log,exit}) so the run is tracked by exit code;
 *  tail the log so the run streams live; interpret the outcome; roll back on
 *  failure. The recorder — not this agent's own exit — decides the run's status. */
function deployPrompt(command: string, ref: string): string {
  return [
    `You are the DEPLOY MANAGER. A human has approved this deploy of \`${ref}\`. Run it, stream your progress to the UI as you go, and NEVER leave the system broken.`,
    "",
    "The deploy command to run:",
    "```",
    command,
    "```",
    "",
    "1. Run it DETACHED, writing to the recorder's files so da_boss captures the real exit code. Run EXACTLY this (do not run the command any other way):",
    "     mkdir -p /work/.daboss",
    `     ( ${command} > /work/.daboss/log 2>&1; echo $? > /work/.daboss/exit ) &`,
    "   da_boss watches /work/.daboss/exit and records the run's pass/fail from that exit code — you do NOT report the result to da_boss yourself.",
    "2. Poll the log in SHORT, separate steps so each surfaces to the UI. Loop until /work/.daboss/exit exists:",
    "     sleep 20; tail -n 60 /work/.daboss/log; [ -f /work/.daboss/exit ] && echo \"EXIT=$(cat /work/.daboss/exit)\" || echo \"[running]\"",
    "   After each poll, briefly narrate the stage (build / migrate / rollout / smoke).",
    "   CRITICAL: only ever inspect the log with `tail`, `grep`, or `grep -c`. NEVER use the Read tool on /work/.daboss/log — it can be 50k+ tokens and will exceed the file-read limit.",
    "3. When /work/.daboss/exit exists: if it's 0 and the smoke test reported 0 failures, post a short success summary (image/SHA, deployments rolled, routes checked) and STOP.",
    "4. If the exit code is non-zero OR the smoke test failed: DO NOT leave things broken. Roll back the deployments that rolled (`kubectl rollout undo deployment/<name> -n <ns>`), confirm they're healthy, report exactly what failed and that you rolled back, then STOP.",
    "5. Never modify any repo files.",
  ].join("\n");
}

/** Create + start a deploy-manager agent for an approved run. Returns the agent id.
 *  Throws {status,message} if da_boss has no agent image configured. */
export async function dispatchDeployAgent(
  manager: AgentManager,
  run: PipelineRun,
  phase: PipelinePhase
): Promise<string> {
  if (!config.deployAgentImage) {
    throw { status: 400, message: "No deploy-agent image configured (DABOSS_DEPLOY_AGENT_IMAGE) — can't run this phase as a managed agent." };
  }
  if (!run.repo_url || !run.created_by_user_id) {
    throw { status: 400, message: "Run missing repo/owner — can't dispatch a deploy agent." };
  }
  const ref = run.git_ref || "main";
  const agent = await manager.createAgent(
    {
      name: `deploy ${ref}`,
      prompt: deployPrompt(phase.command, ref),
      cwd: "/work",
      repo_url: run.repo_url,
      repo_ref: ref,
      branch_type: "chore", // no code change; the empty-branch push is skipped
      model: "claude-sonnet-5",
      max_budget_usd: 5,
      permission_mode: "bypassPermissions",
      permission_policy: "auto",
      service_account: phase.service_account || undefined,
      worker_image: config.deployAgentImage,
    },
    run.created_by_user_id,
    null
  );
  // Link the run BOTH ways before starting: agent_id on the run (so gatePr knows
  // its owner and early-returns for the deploy phase), and pipeline_run_id on the
  // agent — createAgentPod reads that to attach a recorder sidecar tied to this run.
  await queries.setPipelineRunAgent(run.id, agent.id);
  await queries.setAgentPipelineRun(agent.id, run.id);
  await queries.updatePipelineRun(run.id, { status: "running", log: `Deploy-manager agent ${agent.id} (recorder-tracked)` });
  // Manifest: claim the merged changes currently on this repo's main — so the
  // deploy shows what it ships and each change links back to this deploy.
  const shipped = await queries.claimDeployManifest(agent.id, run.repo_url);
  if (shipped.length) {
    const list = shipped.map((s) => (s.pr_number ? `#${s.pr_number}` : s.name)).join(", ");
    await queries.insertAgentEvent(agent.id, "message", { role: "system", content: `📦 This deploy ships ${shipped.length} change(s): ${list}.` });
    for (const s of shipped) {
      await queries.insertAgentEvent(s.id, "message", { role: "system", content: `🚀 Shipping in this deploy — [deploy agent](/agent/${agent.id}).` }).catch(() => {});
    }
  }
  await manager.startAgent(agent.id);
  return agent.id;
}
