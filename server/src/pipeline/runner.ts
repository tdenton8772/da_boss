/**
 * Pipeline runner — a generic, DUMB automation pod. It clones the repo (if any),
 * then runs a SINGLE resolved phase command with the env the boss injected
 * (decrypted required secrets + params + DABOSS_ARTIFACT), captures stdout and
 * the artifact file, and records the exit code. It knows nothing about
 * terraform/ansible/mix — it runs whatever command it was given. The contract is
 * the universal one: env in, exit code + $DABOSS_ARTIFACT out.
 *
 * The runner never has the cipher key or other users' secrets — the boss resolves
 * the phase + decrypts only the required secrets into this pod's ephemeral Secret.
 *
 * Entrypoint: `node dist/pipeline/runner.js` with env RUN_ID, PIPELINE_COMMAND,
 * PIPELINE_REPO_URL?, PIPELINE_REF?, GIT_TOKEN?, WORK_DIR (+ DATABASE_URL and the
 * injected secret/param env vars).
 */
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { initDb, closeDb } from "../db/index.js";
import * as queries from "../db/queries.js";
import { normalizeGitUrl, authedUrl as authedUrlWithToken } from "../utils/git.js";
import { logger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);

const RUN_ID = process.env.RUN_ID;
const COMMAND = process.env.PIPELINE_COMMAND || "";
const REPO_URL = process.env.PIPELINE_REPO_URL || "";
const REF = process.env.PIPELINE_REF || "";
const GIT_TOKEN = process.env.GIT_TOKEN || "";
const WORK_DIR = process.env.WORK_DIR || "/work";
const ARTIFACT_PATH = `${WORK_DIR}/.daboss-artifact`;
const MAX_LOG = 200_000; // cap what we persist

async function main(): Promise<void> {
  if (!RUN_ID) throw new Error("RUN_ID is required");
  if (!COMMAND) throw new Error("PIPELINE_COMMAND is required");
  await initDb();
  await queries.updatePipelineRun(RUN_ID, { status: "running" });

  await mkdir(WORK_DIR, { recursive: true });
  if (REPO_URL) {
    try {
      await execFileAsync(
        "git",
        ["clone", "--depth", "1", ...(REF ? ["--branch", REF] : []), authedUrlWithToken(normalizeGitUrl(REPO_URL), GIT_TOKEN), WORK_DIR],
        { timeout: 300_000, maxBuffer: 32 * 1024 * 1024 }
      );
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      const detail = (e.stderr && e.stderr.trim()) || e.message || String(err);
      await queries.updatePipelineRun(RUN_ID, { status: "failed", log: `git clone failed: ${detail.slice(0, 2000)}`, completed: true });
      await closeDb();
      process.exit(1);
    }
  }

  // Run the phase command. Its inputs are already in process.env (secrets/params
  // the boss injected). DABOSS_ARTIFACT points the script at where to write the
  // human-review artifact.
  logger.info({ runId: RUN_ID, cwd: WORK_DIR }, "Running pipeline phase");
  let log = "";
  const exitCode: number = await new Promise((resolve) => {
    const child = spawn("sh", ["-c", COMMAND], {
      cwd: WORK_DIR,
      env: { ...process.env, DABOSS_ARTIFACT: ARTIFACT_PATH },
    });
    const append = (b: Buffer) => { if (log.length < MAX_LOG) log += b.toString(); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (e) => { log += `\n[spawn error] ${e.message}`; resolve(1); });
    child.on("close", (code) => resolve(code ?? 1));
  });

  // Artifact: the file the script wrote, else the captured output.
  let artifact = "";
  if (existsSync(ARTIFACT_PATH)) {
    artifact = (await readFile(ARTIFACT_PATH, "utf8").catch(() => "")).slice(0, MAX_LOG);
  }
  if (!artifact) artifact = log.slice(-8000);

  await queries.updatePipelineRun(RUN_ID, {
    status: exitCode === 0 ? "passed" : "failed",
    exit_code: exitCode,
    artifact,
    log: log.slice(-MAX_LOG),
    completed: true,
  });
  logger.info({ runId: RUN_ID, exitCode }, "Pipeline phase complete");
  await closeDb();
  process.exit(exitCode === 0 ? 0 : 1);
}

main().catch(async (err) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err: message }, "Pipeline runner fatal error");
  try {
    if (RUN_ID) await queries.updatePipelineRun(RUN_ID, { status: "failed", log: message, completed: true });
    await closeDb();
  } catch { /* best effort */ }
  process.exit(1);
});
