/**
 * State-cleanup pod entrypoint. The boss launches ONE of these when an agent is
 * deleted: the boss can't reach into the user's shard (RWO, node-affine) to
 * remove the agent's persisted transcript, so a short-lived pod that mounts the
 * shard does it — then writes an audit record and deletes its own pod.
 *
 * It prunes the deleted agent's own transcript AND sweeps any other orphans for
 * the same user (defense in depth). Reconciliation on the next worker start is
 * the backstop if this pod never runs.
 *
 * Entrypoint: `node dist/worker/cleanup.js` with env AGENT_ID, CLEANUP_SESSION_ID,
 * CLEANUP_USER_ID, WORKSPACE_DIR (+ DATABASE_URL). Same image as the boss/worker.
 */
import { unlink, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as k8s from "@kubernetes/client-node";
import { initDb, closeDb } from "../db/index.js";
import * as queries from "../db/queries.js";
import { logger } from "../utils/logger.js";

const AGENT_ID = process.env.AGENT_ID || "";
const SESSION_ID = process.env.CLEANUP_SESSION_ID || "";
const USER_ID = process.env.CLEANUP_USER_ID || "";
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/ws";
const NAMESPACE = process.env.POD_NAMESPACE || "daboss";
const SESSIONS_DIR = `${WORKSPACE_DIR}/sessions`;

/** Remove this pod once its work is done. Best-effort — the reaper collects any
 *  cleanup pod that outlives its process. */
async function selfDelete(): Promise<void> {
  const name = process.env.HOSTNAME;
  if (!name) return;
  try {
    const kc = new k8s.KubeConfig();
    kc.loadFromCluster();
    await kc.makeApiClient(k8s.CoreV1Api).deleteNamespacedPod({ name, namespace: NAMESPACE });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Cleanup self-delete failed (reaper will collect)");
  }
}

async function main(): Promise<void> {
  await initDb();
  const removed: string[] = [];

  // 1) the deleted agent's own transcript (its id passed in — the DB row is gone)
  if (SESSION_ID) {
    const f = `${SESSIONS_DIR}/${SESSION_ID}.jsonl`;
    if (existsSync(f)) { await unlink(f); removed.push(SESSION_ID); }
  }

  // 2) sweep any other orphans for this user (files not referenced by a live agent)
  if (USER_ID && existsSync(SESSIONS_DIR)) {
    try {
      const referenced = new Set(await queries.getSessionIdsForUser(USER_ID));
      for (const file of await readdir(SESSIONS_DIR)) {
        if (!file.endsWith(".jsonl")) continue;
        const id = file.slice(0, -".jsonl".length);
        if (id === SESSION_ID || referenced.has(id)) continue;
        await unlink(`${SESSIONS_DIR}/${file}`);
        removed.push(id);
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Orphan sweep failed");
    }
  }

  await queries.insertAuditLog(
    null,
    "agent.state_cleanup",
    "agent",
    AGENT_ID,
    `pruned ${removed.length} orphaned transcript(s) from shard`,
    USER_ID || null
  );
  logger.info({ agentId: AGENT_ID, removed: removed.length }, "State cleanup complete");

  await closeDb();
  await selfDelete();
  process.exit(0);
}

main().catch(async (err) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, "Cleanup pod fatal error");
  try { await closeDb(); } catch { /* best effort */ }
  await selfDelete();
  process.exit(1);
});
