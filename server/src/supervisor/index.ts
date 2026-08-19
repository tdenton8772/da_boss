import cron from "node-cron";
import type { AgentManager } from "../agent/manager.js";
import { runChecks, type SupervisorDeps } from "./checks.js";
import { runTestPhasesForAgent } from "../pipeline/service.js";
import * as queries from "../db/queries.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

let task: cron.ScheduledTask | null = null;

/** Full deps from the in-process boss manager (includes Claude-powered actions). */
export function depsFromManager(manager: AgentManager): SupervisorDeps {
  return {
    getAgentsToPause: () => manager.budgetManager.getAgentsToPause(),
    pauseAgent: (id) => manager.pauseAgent(id),
    resolvePermission: (id, decision, answer) => manager.resolvePermission(id, decision, answer, "supervisor"),
    sendInput: (id, message) => manager.sendInput(id, message),
    queueTestCycle: async (id) => {
      const agent = await queries.getAgent(id);
      if (!agent) return false;
      try {
        const started = await runTestPhasesForAgent(agent); // throws {status:404} if no test phase
        return started.length > 0;
      } catch {
        return false; // no test phase / no repo — nothing to queue
      }
    },
  };
}

export function startSupervisor(manager: AgentManager): void {
  const schedule = `*/${config.supervisorIntervalMinutes} * * * *`;

  task = cron.schedule(schedule, async () => {
    logger.info("Supervisor run starting");
    const runId = await queries.insertSupervisorRun();

    try {
      const { findings, actions } = await runChecks(depsFromManager(manager));
      await queries.completeSupervisorRun(runId, findings, actions);

      if (findings.length > 0 || actions.length > 0) {
        logger.info(
          { findings: findings.length, actions: actions.length },
          "Supervisor run completed with findings"
        );
      }
    } catch (err) {
      logger.error({ err }, "Supervisor run failed");
      await queries.completeSupervisorRun(runId, [], [{ error: String(err) }]);
    }
  });

  logger.info(
    { schedule },
    "Supervisor started"
  );
}

export function stopSupervisor(): void {
  if (task) {
    task.stop();
    task = null;
  }
}

export async function runSupervisorOnce(manager: AgentManager): Promise<{
  findings: unknown[];
  actions: unknown[];
}> {
  const runId = await queries.insertSupervisorRun();
  const { findings, actions } = await runChecks(depsFromManager(manager));
  await queries.completeSupervisorRun(runId, findings, actions);
  return { findings, actions };
}
