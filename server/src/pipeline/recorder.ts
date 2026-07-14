/**
 * Pipeline recorder — the da_boss half of a split-container pipeline pod. The
 * PHASE runs in its own toolchain image (gcloud/terraform/elixir/…) which has no
 * node or da_boss; this container (da_boss image) shares /work and records the
 * result to Postgres once the toolchain container finishes.
 *
 * Contract with the toolchain container (a plain shell wrapper, no da_boss dep):
 *   /work/.daboss/exit      — the command's exit code (written last → our signal)
 *   /work/.daboss/log       — combined stdout/stderr
 *   /work/.daboss/artifact  — $DABOSS_ARTIFACT (the human-review artifact)
 *
 * Entrypoint: `node dist/pipeline/recorder.js` with env RUN_ID, WORK_DIR (+ DATABASE_URL).
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { initDb, closeDb } from "../db/index.js";
import * as queries from "../db/queries.js";
import { logger } from "../utils/logger.js";

const RUN_ID = process.env.RUN_ID;
const WORK_DIR = process.env.WORK_DIR || "/work";
const DIR = `${WORK_DIR}/.daboss`;
const MAX = 200_000;
const TIMEOUT_MS = (Number(process.env.PIPELINE_TIMEOUT_MINUTES) || 60) * 60_000;

async function main(): Promise<void> {
  if (!RUN_ID) throw new Error("RUN_ID is required");
  await initDb();
  await queries.updatePipelineRun(RUN_ID, { status: "running" });

  // Wait for the toolchain container to write its exit file.
  const start = Date.now();
  while (!existsSync(`${DIR}/exit`)) {
    if (Date.now() - start > TIMEOUT_MS) {
      await queries.updatePipelineRun(RUN_ID, { status: "failed", log: "phase timed out", completed: true });
      await closeDb();
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  const exitCode = Number((await readFile(`${DIR}/exit`, "utf8").catch(() => "1")).trim()) || 0;
  const log = existsSync(`${DIR}/log`) ? (await readFile(`${DIR}/log`, "utf8").catch(() => "")).slice(-MAX) : "";
  let artifact = existsSync(`${DIR}/artifact`) ? (await readFile(`${DIR}/artifact`, "utf8").catch(() => "")).slice(0, MAX) : "";
  if (!artifact) artifact = log.slice(-8000);

  await queries.updatePipelineRun(RUN_ID, {
    status: exitCode === 0 ? "passed" : "failed",
    exit_code: exitCode,
    artifact,
    log,
    completed: true,
  });
  logger.info({ runId: RUN_ID, exitCode }, "Pipeline phase recorded (split runner)");
  await closeDb();
  process.exit(0);
}

main().catch(async (err) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, "Recorder fatal error");
  try {
    if (RUN_ID) await queries.updatePipelineRun(RUN_ID, { status: "failed", log: String(err), completed: true });
    await closeDb();
  } catch { /* best effort */ }
  process.exit(1);
});
