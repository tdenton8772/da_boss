/**
 * Orchestrator — runs the supervisor/monitoring loop in its OWN pod, separate
 * from the boss. Watches the fleet via shared Postgres: budget enforcement
 * (pod-aware pause), stuck/idle/stale-permission detection, notifications,
 * supervisor_runs. Claude-powered evaluation runs on a DESIGNATED admin's vault
 * credential (loaded fresh each cycle); if none is configured it degrades to
 * rules + "notify a human" and says so, rather than failing silently.
 *
 * Entrypoint: `node dist/orchestrator/index.js` (same image as the boss).
 */
import { EventEmitter } from "node:events";
import pg from "pg";
import { initDb, closeDb } from "../db/index.js";
import * as queries from "../db/queries.js";
import { runChecks, type SupervisorDeps } from "../supervisor/checks.js";
import { loadSupervisorCredentialIntoEnv } from "../supervisor/credential.js";
import { TokenBudgetManager } from "../tokens/budget.js";
import { createAgentPod, deleteAgentPod } from "../agent/pod-dispatcher.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

// One cycle at a time: a slow/hung Claude call must not let interval + listener
// timers stack concurrent cycles (each would insert a supervisor_runs row and
// queue on the Claude lock). Skipped ticks are fine — the next one catches up.
let cycleInFlight = false;
async function runGuarded(deps: SupervisorDeps): Promise<void> {
  if (cycleInFlight) return;
  cycleInFlight = true;
  try {
    await runOnce(deps);
  } finally {
    cycleInFlight = false;
  }
}

async function runOnce(deps: SupervisorDeps): Promise<void> {
  // Borrow the designated admin's Claude credential for this cycle (fresh, so
  // rotation/offboarding take effect). Loud, not silent, when it's missing.
  const cred = await loadSupervisorCredentialIntoEnv();
  if (!cred.ok) {
    logger.warn({ reason: cred.reason }, "Supervisor running WITHOUT a Claude credential — rules only, no auto-evaluation");
  }

  const runId = await queries.insertSupervisorRun();
  try {
    const { findings, actions } = await runChecks(deps);
    await queries.completeSupervisorRun(runId, findings, actions);
    if (findings.length > 0 || actions.length > 0) {
      logger.info({ findings: findings.length, actions: actions.length }, "Orchestrator run: findings/actions");
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "Orchestrator run failed");
    await queries.completeSupervisorRun(runId, [], [{ error: String(err) }]);
  }
}

async function main(): Promise<void> {
  await initDb();

  const budget = new TokenBudgetManager(new EventEmitter());
  const deps: SupervisorDeps = {
    getAgentsToPause: () => budget.getAgentsToPause(),
    // pod-aware pause: stop the agent's pod (+ its cred secret) and mark it paused
    pauseAgent: async (agentId) => {
      await deleteAgentPod(agentId);
      await queries.updateAgentState(agentId, "paused", {
        error_message: "Paused by orchestrator (budget threshold)",
      });
    },
    // Supervisor "continue" → resume the agent with the next instruction. In pod
    // mode that's a fresh pod carrying the message as its turn prompt (the same
    // path the boss uses for user input). Only fires when a credential loaded and
    // the agent has supervisor_instructions.
    sendInput: async (agentId, message) => {
      if (config.agentExecution === "pod") {
        await createAgentPod(agentId, message);
      }
    },
    // The requesting agent can't approve its own tool calls — the supervisor is
    // the second set of eyes that can (gated in checks.ts on the agent having
    // supervisor_instructions + a loaded credential). Resolution is just the DB
    // row update: the blocked worker polls the row and continues within seconds.
    resolvePermission: async (id, decision, answer) => {
      await queries.resolvePermission(id, decision, answer, "supervisor");
      return true;
    },

    // Block a misbehaving agent: stop its pod and mark it paused (recoverable) so
    // a human can review. Same pod-delete authority as the budget pause.
    blockAgent: async (agentId, reason) => {
      await deleteAgentPod(agentId);
      await queries.updateAgentState(agentId, "paused", { error_message: reason });
      await queries.insertAgentEvent(agentId, "state_change", { from: "running", to: "paused" });
      await queries.insertAgentEvent(agentId, "message", { role: "system", content: `⛔ ${reason}` });
    },

    // Redirect a running agent mid-turn (the worker interrupts + resumes the same
    // session with this message) — course-correct without killing the work.
    steerAgent: async (agentId, message) => {
      await queries.insertAgentCommand(agentId, "steer", { message });
    },
  };

  const intervalMs = Math.max(1, config.supervisorIntervalMinutes) * 60_000;
  logger.info(
    { pod: process.env.HOSTNAME, intervalMinutes: config.supervisorIntervalMinutes },
    "Orchestrator started"
  );

  await runGuarded(deps); // run once immediately on boot
  const timer = setInterval(() => void runGuarded(deps), intervalMs);

  // Permission SLA: judge a stale request at ~5:00 pending, not "5 min + wherever
  // the cron happens to be" (worst case was ~10). LISTEN for each new permission
  // request and schedule a focused cycle exactly at its staleness deadline; the
  // interval loop stays as the backstop if the listener connection drops.
  const STALENESS_MS = 5 * 60_000 + 5_000; // checks.ts requires minutes > 5
  const listener = new pg.Client({
    connectionString: process.env.DATABASE_URL || "postgres://daboss:daboss@localhost:5432/daboss",
  });
  listener.on("error", (e) => logger.warn({ err: e.message }, "Permission listener connection error — interval loop remains the backstop"));
  listener.on("notification", () => {
    setTimeout(() => void runGuarded(deps), STALENESS_MS);
  });
  try {
    await listener.connect();
    await listener.query("LISTEN daboss_permission");
    logger.info("Permission-deadline listener up (stale requests judged at ~5 min)");
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Permission listener failed to start — interval loop remains the backstop");
  }

  const shutdown = async () => {
    clearInterval(timer);
    await listener.end().catch(() => {});
    await closeDb();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, "Orchestrator fatal error");
  process.exit(1);
});
