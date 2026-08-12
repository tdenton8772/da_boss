/**
 * Phase scheduler — runs repo phases that declare `schedule:` with no human
 * trigger. The repo owns WHAT runs (a snapshot script, a drift check — commands
 * da_boss never interprets); the boss owns WHEN. Nightly = roughly every 24h,
 * tracked per repo+phase in app_settings so restarts never double-run.
 *
 * Credential seam (v1): a scheduled run executes as the repo's most recent
 * credentialed agent owner — same heuristic as the main watcher. A dedicated
 * per-repo service credential can replace this without touching the flow.
 */
import * as queries from "../db/queries.js";
import { getCipher } from "../crypto/cipher.js";
import { getFileContents } from "../forge/github.js";
import { parsePipeline, PIPELINE_PATH } from "./config.js";
import { runPhase } from "./service.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

/** Interval semantics with slack: due when never run, or ≥22h since the last
 *  launch. The 2h slack keeps a "nightly" from drifting later every day (a sweep
 *  at 03:05 after yesterday's 03:00 launch still counts as tonight's). Pure. */
export function isNightlyDue(lastRunAtIso: string | null, now: Date): boolean {
  if (!lastRunAtIso) return true;
  const last = new Date(lastRunAtIso).getTime();
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= 22 * 3600 * 1000;
}

const stateKey = (repoUrl: string, phase: string) => `schedule:${repoUrl}:${phase}`;

async function sweepRepo(repoUrl: string, userId: string, now: Date): Promise<void> {
  const cred = await queries.getUserGitCredential(userId);
  if (!cred) return;
  const token = await getCipher().decrypt({ ciphertext: cred.ciphertext, nonce: cred.nonce, keyRef: cred.key_ref });
  const yamlText = await getFileContents(repoUrl, PIPELINE_PATH, "main", token);
  if (!yamlText) return;
  const pipeline = parsePipeline(yamlText);

  for (const [phaseName, ph] of Object.entries(pipeline.phases)) {
    if (ph.schedule !== "nightly") continue;
    const raw = await queries.getAppSetting(stateKey(repoUrl, phaseName));
    const lastRunAt = raw ? (JSON.parse(raw) as { lastRunAt?: string }).lastRunAt ?? null : null;
    if (!isNightlyDue(lastRunAt, now)) continue;
    // Record the launch BEFORE it runs: a crash mid-launch must not turn into a
    // run-storm on restart; worst case we skip a night, alarming nobody wrongly.
    await queries.setAppSetting(stateKey(repoUrl, phaseName), JSON.stringify({ lastRunAt: now.toISOString() }));
    try {
      const { runId } = await runPhase({ userId, repoUrl, ref: "main", phaseName });
      logger.info({ repoUrl, phaseName, runId }, "Scheduled phase launched");
    } catch (err) {
      const msg = (err as { message?: string }).message || String(err);
      logger.warn({ repoUrl, phaseName, err: msg }, "Scheduled phase launch failed");
    }
  }
}

/** One sweep over every watched repo. Exported for tests and manual runs. */
export async function sweepSchedules(now = new Date()): Promise<void> {
  const repos = await queries.getWatchedRepos();
  for (const { repo_url, user_id } of repos) {
    try {
      await sweepRepo(repo_url, user_id, now);
    } catch (err) {
      logger.warn({ repoUrl: repo_url, err: err instanceof Error ? err.message : String(err) }, "schedule sweep failed for repo");
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic scheduler. Pod mode only — phases run as pods. */
export function startScheduler(): void {
  if (timer || config.agentExecution !== "pod") return;
  timer = setInterval(() => { void sweepSchedules(); }, config.scheduleSweepIntervalSeconds * 1000);
  logger.info({ intervalSeconds: config.scheduleSweepIntervalSeconds }, "Phase scheduler started");
}

export function stopScheduler(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
