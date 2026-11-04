/**
 * Live relay — bridges agent events from worker pods to the UI. Workers write to
 * Postgres and `NOTIFY daboss_agent_event`; the boss LISTENs on a dedicated
 * connection, fetches each event, and re-emits it on the in-process eventBus,
 * which the existing WebSocket server already broadcasts to browsers. This is how
 * the live view works once agents run out-of-process.
 */
import { listenWithReconnect } from "../db/listen.js";
import type { EventEmitter } from "node:events";
import * as queries from "../db/queries.js";
import { maybeAutoTest } from "../pipeline/autochain.js";
import { config } from "../config.js";
import { applyReviewResult } from "../pipeline/review-agent.js";
import { reconcileDeployRun } from "../pipeline/deploy-agent.js";
import { logger } from "../utils/logger.js";

const TERMINAL_STATES = new Set(["completed", "verified", "failed", "aborted"]);

const CHANNEL = "daboss_agent_event";
const PERMISSION_CHANNEL = "daboss_permission";

export function startLiveRelay(eventBus: EventEmitter): void {
  // A worker pod raised a permission request — surface the dialog to the UI. The
  // resolution round-trips back through the normal /permissions/:id/resolve path
  // (which updates the DB row the worker is polling).
  const handlePermission = async (payload?: string) => {
    if (!payload) return;
    try {
      const request = await queries.getPermission(Number(payload));
      if (!request || request.status !== "pending") return;
      eventBus.emit("server-event", { type: "permission:requested", request });
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Permission relay failed");
    }
  };

  const handle = async (payload?: string) => {
    if (!payload) return;
    try {
      const ev = await queries.getAgentEventById(Number(payload));
      if (!ev) return;
      const data = JSON.parse(ev.data) as Record<string, unknown>;
      if (ev.type === "message") {
        eventBus.emit("server-event", {
          type: "agent:message",
          agentId: ev.agent_id,
          role: data.role,
          content: data.content,
          timestamp: ev.created_at,
        });
      } else if (ev.type === "state_change") {
        eventBus.emit("server-event", {
          type: "agent:state_changed",
          agentId: ev.agent_id,
          state: data.to,
          previousState: data.from,
        });
        const toState = String(data.to ?? "");
        // Auto-chain: a completed agent → run tests. OFF by default (config) — agents
        // iterate without building/testing until someone (agent/human/supervisor) asks.
        if (toState === "completed" && config.autoTestOnComplete) void maybeAutoTest(ev.agent_id);
        // If a REVIEW agent just finished, parse its recommendation onto the PR.
        if (TERMINAL_STATES.has(toState)) void applyReviewResult(ev.agent_id).catch(() => {});
        // If a DEPLOY-MANAGER agent finished, make sure its deploy run is
        // reconciled (recorder normally does this; catches a pod that died).
        if (TERMINAL_STATES.has(toState)) void reconcileDeployRun(ev.agent_id).catch(() => {});
      } else if (ev.type === "error") {
        eventBus.emit("server-event", { type: "agent:error", agentId: ev.agent_id, error: data.error });
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Live relay handler failed");
    }
  };

  listenWithReconnect({
    label: "live-relay",
    channels: [CHANNEL, PERMISSION_CHANNEL],
    onNotification: (msg) => {
      if (msg.channel === PERMISSION_CHANNEL) void handlePermission(msg.payload);
      else void handle(msg.payload);
    },
  });
}
