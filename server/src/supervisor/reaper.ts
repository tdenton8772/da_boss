/**
 * The heartbeat reaper — the missing consumer of the sidecar heartbeat.
 *
 * The pod's sidecar writes `agents.last_heartbeat_at` every SIDECAR_HEARTBEAT_SECONDS.
 * When a pod dies mid-turn (crash, eviction, or a control-plane restart that drops
 * the turn-end signal), the heartbeat stops but the agent stays `running` forever —
 * the DB state lies, and every view built on it is consistently wrong. This is the
 * generic fix: reconcile any agent whose heartbeat has gone stale to `paused`
 * (resumable), so DB state can never drift from pod reality. Runs on a short interval
 * (independent of the 5-min supervisor) and once on startup.
 */
import { config } from "../config.js";
import * as queries from "../db/queries.js";
import { logger } from "../utils/logger.js";

/** Reconcile agents that claim to be alive but whose pod stopped beating. Returns
 *  the reconciled agent ids. Idempotent — safe to call as often as you like. */
export async function reconcileOrphanedAgents(): Promise<string[]> {
  const cutoff = new Date(Date.now() - config.reaperStaleSeconds * 1000).toISOString();
  const stale = await queries.getStaleHeartbeatAgents(cutoff);
  for (const a of stale) {
    const ageSec = a.last_heartbeat_at ? Math.round((Date.now() - new Date(a.last_heartbeat_at).getTime()) / 1000) : -1;
    logger.warn({ agentId: a.id, state: a.state, heartbeatAgeSec: ageSec }, "Reaper: pod heartbeat stale — reconciling to paused");
    await queries.updateAgentState(a.id, "paused", {
      error_message: `Heartbeat monitor: no pod heartbeat for ${ageSec}s — the pod is gone. Reconciled to paused; resume to continue.`,
    });
    await queries.insertAgentEvent(a.id, "state_change", { from: a.state, to: "paused" }).catch(() => {});
    await queries.insertAgentEvent(a.id, "message", {
      role: "system",
      content: `⚠ Heartbeat monitor: no pod heartbeat for ${ageSec}s — the pod is gone, so this agent was stuck showing "${a.state}". Reconciled to **paused**. Resume to continue.`,
    }).catch(() => {});
  }
  return stale.map((a) => a.id);
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic reaper. No-op if already running or if not in pod mode (there
 *  are no pods to go stale in-process). */
export function startAgentReaper(): void {
  if (timer || config.agentExecution !== "pod") return;
  timer = setInterval(() => {
    reconcileOrphanedAgents().catch((err) =>
      logger.error({ err: err instanceof Error ? err.message : String(err) }, "Reaper cycle failed")
    );
  }, config.reaperIntervalSeconds * 1000);
  logger.info(
    { intervalSeconds: config.reaperIntervalSeconds, staleSeconds: config.reaperStaleSeconds },
    "Agent heartbeat reaper started"
  );
}

export function stopAgentReaper(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
