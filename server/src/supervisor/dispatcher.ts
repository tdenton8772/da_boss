/**
 * Supervisor dispatch control loop. The supervisor — not the API/manager — owns
 * building agent pods. An agent is created/started into the `queued` state; this
 * loop picks it up (on NOTIFY, and via the cron as a fallback), assesses a t-shirt
 * SIZE if the caller didn't specify one, then builds the pod. Concentrating
 * dispatch here is what lets the supervisor later assess MORE than size.
 */
import pg from "pg";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import * as queries from "../db/queries.js";
import type { AgentRecord, AgentState } from "../types/agent.js";
import { createAgentPod } from "../agent/pod-dispatcher.js";
import { normalizeSize, nextSizeUp, resolvePreset, DEFAULT_SIZE, type TShirtSize } from "../agent/sizing.js";
import { resolveSupervisorCredentialEnv } from "./credential.js";
import { withClaudeLock } from "../utils/claude-lock.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

const QUEUE_CHANNEL = "daboss_agent_queued";
const ACTIVE_STATES: AgentState[] = ["running", "waiting_permission", "waiting_input"];
const RESOURCE_FAILURE = /OOMKilled|Evicted|out of memory|no space left|exit code 137/i;

let processing = false;

/** Assess a task's t-shirt size. A resource-failure resume bumps the previous
 *  size; otherwise a single serialized boss-side Claude call classifies the task.
 *  Falls back to the default size if there's no supervisor credential or it errors. */
export async function assessSize(agent: AgentRecord): Promise<TShirtSize> {
  if (agent.size && RESOURCE_FAILURE.test(agent.error_message || "")) {
    return nextSizeUp(agent.size); // it outgrew its size — bump one up
  }
  const cred = await resolveSupervisorCredentialEnv();
  if (!cred.ok) return DEFAULT_SIZE;
  try {
    return await withClaudeLock(async () => {
      let r = "";
      for await (const msg of sdkQuery({
        prompt:
          `Size a container for a coding agent's task.\n` +
          `- s: review, docs, tiny edits (no build)\n` +
          `- m: normal code change + running tests\n` +
          `- l: builds, dependency compiles, apt/package installs\n` +
          `- xl: heavy builds or very large test suites\n\n` +
          `TASK:\n${(agent.prompt || "").slice(0, 2000)}\n\n` +
          `Reply with EXACTLY one of: s, m, l, xl.`,
        options: {
          maxTurns: 1,
          allowedTools: [],
          systemPrompt: "You reply with exactly one of: s, m, l, xl.",
          maxBudgetUsd: 0.2,
          model: "claude-sonnet-5",
          env: cred.env,
        },
      })) {
        if ("type" in msg && msg.type === "result" && "result" in msg) r = (msg as { result: string }).result || "";
      }
      return normalizeSize(r) ?? DEFAULT_SIZE;
    });
  } catch (err) {
    logger.warn({ agentId: agent.id, err: err instanceof Error ? err.message : String(err) }, "size assessment failed — defaulting");
    return DEFAULT_SIZE;
  }
}

async function dispatchQueued(agent: AgentRecord): Promise<void> {
  let size = normalizeSize(agent.size);
  if (!size) {
    size = await assessSize(agent);
    await queries.setAgentSize(agent.id, size);
    const p = resolvePreset(size);
    await queries.insertAgentEvent(agent.id, "message", {
      role: "system",
      content: `📏 Supervisor sized this **${size.toUpperCase()}** — ${p.limits.memory} mem, ${p.limits["ephemeral-storage"]} disk.`,
    });
  }
  await createAgentPod(agent.id); // the pod build — owned by the supervisor
}

/** Dispatch queued agents up to the concurrency cap. Mutex-guarded so overlapping
 *  NOTIFY + cron sweeps don't double-dispatch. Never throws. */
export async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    const active = (await queries.getAgentsByState(...ACTIVE_STATES)).length;
    let slots = config.maxConcurrentAgents - active;
    if (slots <= 0) return;
    const queued = await queries.getAgentsByState("queued");
    for (const agent of queued) {
      if (slots <= 0) break;
      try {
        await dispatchQueued(agent);
        slots--;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ agentId: agent.id, err: msg }, "queue dispatch failed");
        await queries.updateAgentState(agent.id, "failed", { error_message: msg }).catch(() => {});
        await queries.insertAgentEvent(agent.id, "error", { error: `Dispatch failed: ${msg}` }).catch(() => {});
      }
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "processQueue failed");
  } finally {
    processing = false;
  }
}

/** LISTEN for queued agents and sweep on connect (catch-up for a missed NOTIFY). */
export function startQueueListener(): void {
  let client: pg.Client | null = null;
  const reconnect = () => {
    try { client?.removeAllListeners(); void client?.end(); } catch { /* ignore */ }
    client = null;
    setTimeout(() => void connect(), 2000);
  };
  const connect = async () => {
    try {
      client = new pg.Client({ connectionString: process.env.DATABASE_URL });
      client.on("error", () => reconnect());
      client.on("notification", () => void processQueue());
      await client.connect();
      await client.query(`LISTEN ${QUEUE_CHANNEL}`);
      logger.info({ channel: QUEUE_CHANNEL }, "Agent queue listener ready");
      void processQueue(); // catch-up sweep on (re)connect
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "queue listener connect failed — retrying");
      reconnect();
    }
  };
  void connect();
}
