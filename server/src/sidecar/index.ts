/**
 * Agent sidecar — a live command-and-control process that runs in the SAME pod
 * as the agent, sharing its volumes (/work, /ws). It is the local "nervous
 * system" the central supervisor reaches while the agent is ALIVE; it dies with
 * the agent (a dead agent has nothing to control) and owns no durable state —
 * everything it observes/receives is persisted to Postgres, the system of record.
 *
 * Slice 1 is deterministic and additive (no worker cooperation, no k8s API):
 *  - heartbeat  → PG, so a running agent with a stale beat = hung/dead pod
 *  - telemetry  → live `git` working-tree state into agent_events (real progress,
 *                 not the truncated chat the orchestrator otherwise sees)
 *  - commands   → a held Postgres LISTEN on daboss_agent_cmd (PUSH, not poll) with
 *                 a catch-up read on connect so a dropped NOTIFY is never lost.
 *
 * Entrypoint: `node dist/sidecar/index.js` with env AGENT_ID, WORK_DIR
 * (+ DATABASE_URL). Same image as the boss/worker. Runs as a native sidecar
 * (initContainer, restartPolicy: Always) so the pod still completes on agent exit.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import pg from "pg";
import { initDb, closeDb } from "../db/index.js";
import * as queries from "../db/queries.js";
import { computeFreezeSet, isNameVariant } from "../leasing/freeze-set.js";
import { normalizeGitUrl } from "../utils/git.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);

const AGENT_ID = process.env.AGENT_ID;
const WORK_DIR = process.env.WORK_DIR || "/work";
const CMD_CHANNEL = "daboss_agent_cmd";

let lastTelemetry = ""; // dedupe: only emit when the working tree actually changes

/** Compact live view of the agent's working tree — deterministic, no Claude. */
async function gitTelemetry(): Promise<string | null> {
  if (!existsSync(`${WORK_DIR}/.git`)) return null;
  try {
    const branch = (await execFileAsync("git", ["-C", WORK_DIR, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 15_000 })).stdout.trim();
    const stat = (await execFileAsync("git", ["-C", WORK_DIR, "diff", "--stat", "--no-color"], { timeout: 15_000 })).stdout.trim();
    const untracked = (await execFileAsync("git", ["-C", WORK_DIR, "ls-files", "--others", "--exclude-standard"], { timeout: 15_000 })).stdout.trim();
    const nUntracked = untracked ? untracked.split("\n").length : 0;
    if (!stat && !nUntracked) return `On \`${branch}\` — no changes yet.`;
    const tail = stat.split("\n").slice(-1)[0] || "";
    return `On \`${branch}\` — ${tail}${nUntracked ? `, ${nUntracked} new file(s)` : ""}`;
  } catch (err) {
    logger.warn({ agentId: AGENT_ID, err: err instanceof Error ? err.message : String(err) }, "git telemetry failed");
    return null;
  }
}

async function emitTelemetry(force = false): Promise<void> {
  const snapshot = await gitTelemetry();
  if (!snapshot) return;
  if (!force && snapshot === lastTelemetry) return; // unchanged — don't spam the stream
  lastTelemetry = snapshot;
  await queries.insertAgentEvent(AGENT_ID!, "message", { role: "system", content: `📊 ${snapshot}` });
}

async function handleCommand(cmd: queries.AgentCommand): Promise<void> {
  // The sidecar owns 'snapshot'; other commands (e.g. 'steer' → the worker) are
  // left pending for their owner to handle + complete.
  if (cmd.command !== "snapshot") return;
  try {
    await emitTelemetry(true);
    await queries.completeCommand(cmd.id, "done");
  } catch (err) {
    logger.warn({ agentId: AGENT_ID, cmd: cmd.command, err: String(err) }, "Command failed");
    await queries.completeCommand(cmd.id, "failed").catch(() => {});
  }
}

async function drainCommands(): Promise<void> {
  for (const cmd of await queries.getPendingCommands(AGENT_ID!)) {
    await handleCommand(cmd);
  }
}

let lastConflictKey = ""; // dedupe conflict warnings across cycles
let lastEvasionKey = ""; // dedupe evasion warnings across cycles

/**
 * Recompute the 1-hop freeze set from the live diff, refresh this agent's leases,
 * and flag (advisory) any symbol also held by another agent. Best-effort.
 */
async function leaseCycle(repoKey: string): Promise<void> {
  try {
    const fs = await computeFreezeSet(WORK_DIR);
    await queries.heartbeatLeases(AGENT_ID!); // keep existing leases alive regardless
    if (!fs.frozen.length) return;

    const conflicts = await queries.getLeaseConflicts(repoKey, fs.frozen, AGENT_ID!);
    await queries.acquireLeases(AGENT_ID!, repoKey, fs.frozen);

    // Evasion: is the agent editing a FORK of a symbol frozen by someone else
    // (block `apply` → writes `apply_v2`)? Compare edited names against others'
    // leased symbols in this repo. A hit is a strike (the supervisor may block).
    const others = (await queries.getActiveLeases())
      .filter((l) => l.holder_agent_id !== AGENT_ID && l.resource_ref.startsWith(repoKey + "#"))
      .map((l) => ({ holder: l.holder_agent_id, sym: l.resource_ref.slice(repoKey.length + 1) }));
    const evasions: string[] = [];
    for (const e of fs.edited) {
      for (const o of others) {
        if (isNameVariant(e, o.sym)) evasions.push(`\`${e}\` looks like a fork of frozen \`${o.sym}\` (agent ${o.holder})`);
      }
    }
    if (evasions.length && evasions.join("|") !== lastEvasionKey) {
      lastEvasionKey = evasions.join("|");
      const strikes = await queries.bumpAdvisoryStrikes(AGENT_ID!);
      await queries.insertAgentEvent(AGENT_ID!, "message", {
        role: "system",
        content: `🚩 Possible lease evasion (strike ${strikes}): ${evasions.join("; ")}. Don't fork frozen code — coordinate.`,
      });
    }

    const key = conflicts.map((c) => c.resource_ref).sort().join(",");
    if (conflicts.length && key !== lastConflictKey) {
      lastConflictKey = key;
      const detail = conflicts
        .map((c) => `\`${c.resource_ref.split("#").pop()}\` (agent ${c.holder_agent_id})`)
        .join(", ");
      await queries.insertAgentEvent(AGENT_ID!, "message", {
        role: "system",
        content: `⚠️ Lease conflict — another agent already holds: ${detail}. Coordinate before merging. (advisory)`,
      });
    } else if (!conflicts.length) {
      lastConflictKey = "";
    }
  } catch (err) {
    logger.warn({ agentId: AGENT_ID, err: err instanceof Error ? err.message : String(err) }, "lease cycle failed");
  }
}

/** Dedicated LISTEN connection (a pooled one would get recycled). Reconnects on
 *  error and re-drains any commands missed while disconnected. */
function startCommandListener(): void {
  let client: pg.Client | null = null;
  const reconnect = () => {
    try { client?.removeAllListeners(); void client?.end(); } catch { /* ignore */ }
    client = null;
    setTimeout(connect, 2000);
  };
  const connect = async () => {
    try {
      client = new pg.Client({ connectionString: process.env.DATABASE_URL });
      client.on("error", () => reconnect());
      client.on("notification", (msg) => {
        if (msg.payload === AGENT_ID) void drainCommands();
      });
      await client.connect();
      await client.query(`LISTEN ${CMD_CHANNEL}`);
      await drainCommands(); // catch-up: anything issued while we were away
      logger.info({ agentId: AGENT_ID, channel: CMD_CHANNEL }, "Sidecar command listener ready");
    } catch (err) {
      logger.warn({ agentId: AGENT_ID, err: err instanceof Error ? err.message : String(err) }, "Command listener connect failed — retrying");
      reconnect();
    }
  };
  void connect();
}

/** Connect to PG, retrying — a sidecar must never crash-loop and never block its
 *  agent (which is running independently in the main container). */
async function initDbWithRetry(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await initDb();
      return;
    } catch (err) {
      logger.warn({ agentId: AGENT_ID, attempt, err: err instanceof Error ? err.message : String(err) }, "Sidecar DB connect failed — retrying");
      await new Promise((r) => setTimeout(r, Math.min(30_000, attempt * 2000)));
    }
  }
}

async function main(): Promise<void> {
  if (!AGENT_ID) throw new Error("AGENT_ID env var is required");
  await initDbWithRetry();
  logger.info({ agentId: AGENT_ID, pod: process.env.HOSTNAME }, "Sidecar starting");

  startCommandListener();

  // Repo the agent is editing → the key its symbol leases are scoped by.
  const agent = await queries.getAgent(AGENT_ID).catch(() => null);
  const repoKey = agent?.repo_url ? normalizeGitUrl(agent.repo_url) : null;

  // Heartbeat + telemetry loops. Heartbeat is the liveness signal the orchestrator
  // watches; telemetry emits only on change.
  await queries.updateAgentHeartbeat(AGENT_ID).catch(() => {});
  const hb = setInterval(() => void queries.updateAgentHeartbeat(AGENT_ID!).catch(() => {}), config.sidecarHeartbeatSeconds * 1000);
  const tel = setInterval(() => void emitTelemetry().catch(() => {}), config.sidecarTelemetrySeconds * 1000);
  // Semantic freeze-leases: only when the agent has a repo (nothing to lease otherwise).
  const lease = repoKey
    ? setInterval(() => void leaseCycle(repoKey), config.sidecarLeaseSeconds * 1000)
    : null;

  const shutdown = async () => {
    clearInterval(hb);
    clearInterval(tel);
    if (lease) clearInterval(lease);
    // Clean turn end → release leases now (a crash instead leaves them to be
    // reclaimed when the heartbeat goes stale).
    await queries.releaseLeases(AGENT_ID!).catch(() => {});
    await closeDb().catch(() => {});
    process.exit(0);
  };
  // Native sidecar: k8s SIGTERMs us once the agent (main container) exits.
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, "Sidecar fatal error");
  process.exit(1);
});
