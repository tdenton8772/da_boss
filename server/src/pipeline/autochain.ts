/**
 * Auto-chain: move work between stations without a human clicking each one.
 * When an agent completes with a PR AND the repo declares a `test` phase, run it
 * automatically. The test completion listener then gates the PR and triggers the
 * report-back review — so the agent "comes back to you" with a recommendation.
 *
 * The repo's pipeline config IS the opt-in: no `test` phase → no auto-test.
 */
import * as queries from "../db/queries.js";
import { runTestPhasesForAgent } from "./service.js";
import { isTestPhase } from "./config.js";
import { logger } from "../utils/logger.js";

export async function maybeAutoTest(agentId: string): Promise<void> {
  try {
    const agent = await queries.getAgent(agentId);
    if (!agent || agent.state !== "completed") return;
    if (!agent.repo_url || !agent.branch || !agent.pr_number || !agent.created_by_user_id) return;
    // Re-test on each NEW completion (e.g. after "request changes" → the agent
    // fixed + re-pushed). Skip only if the latest gate test already covers THIS
    // completion (its run is newer than completed_at).
    const lastTest = (await queries.getPipelineRunsForAgent(agentId)).find((r) => isTestPhase(r.phase) && !r.land_on_pass);
    if (lastTest && agent.completed_at && new Date(lastTest.created_at) >= new Date(agent.completed_at)) return;
    const started = await runTestPhasesForAgent(agent); // throws {status:404} if no test phase → skip
    logger.info({ agentId, phases: started.map((s) => s.phase) }, "Auto-chained: running test phases on completed agent");
  } catch (err) {
    const e = err as { status?: number; message?: string };
    if (e.status) logger.info({ agentId, reason: e.message }, "Auto-test skipped");
    else logger.warn({ agentId, err: err instanceof Error ? err.message : String(err) }, "Auto-test failed");
  }
}
