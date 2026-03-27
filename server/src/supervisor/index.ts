import cron from "node-cron";
import type { AgentManager } from "../agent/manager.js";
import { runChecks } from "./checks.js";
import * as queries from "../db/queries.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

let task: cron.ScheduledTask | null = null;

export function startSupervisor(manager: AgentManager): void {
  const schedule = `*/${config.supervisorIntervalMinutes} * * * *`;

  task = cron.schedule(schedule, async () => {
    logger.info("Supervisor run starting");
    const runId = queries.insertSupervisorRun();

    try {
      const { findings, actions } = await runChecks(manager);
      queries.completeSupervisorRun(runId, findings, actions);

      if (findings.length > 0 || actions.length > 0) {
        logger.info(
          { findings: findings.length, actions: actions.length },
          "Supervisor run completed with findings"
        );
      }
    } catch (err) {
      logger.error({ err }, "Supervisor run failed");
      queries.completeSupervisorRun(runId, [], [{ error: String(err) }]);
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
  const runId = queries.insertSupervisorRun();
  const { findings, actions } = await runChecks(manager);
  queries.completeSupervisorRun(runId, findings, actions);
  return { findings, actions };
}
