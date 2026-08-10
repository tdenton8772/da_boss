/**
 * Main watcher — catch a broken main AT MERGE TIME, not at the next victim's
 * branch. PRs merged manually on GitHub bypass da_boss entirely (the #81/#82
 * incident: main sat red on test-elixir for five days and every branch cut from
 * it inherited the failures, blamed on their authors). This watcher polls each
 * active repo's main HEAD; when it moves, it runs the repo's test phases on
 * main and notifies loudly if they fail. State lives in app_settings
 * (`main_watch:<repo>`), so it survives restarts and never double-launches.
 */
import { nanoid } from "nanoid";
import * as queries from "../db/queries.js";
import { getCipher } from "../crypto/cipher.js";
import { getBranchHead } from "../forge/github.js";
import { resolvePhase, launchResolved, listTestPhases } from "./service.js";
import { sendNotification } from "../notifications/ntfy.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

export interface WatchState {
  sha: string;
  status: "testing" | "green" | "red" | "no-tests";
  runIds: string[];
}

/** What a sweep should do for one repo — pure, so the launch/wait/notify
 *  transitions are assertable without GitHub or a cluster. */
export function nextWatchAction(
  head: string,
  state: WatchState | null,
  runs: Array<{ status: string }>
): "launch" | "wait" | "conclude" | "nothing" {
  if (!state || state.sha !== head) return "launch"; // main moved (or first sight)
  if (state.status !== "testing") return "nothing"; // already concluded for this sha
  const done = runs.every((r) => ["passed", "failed", "error", "aborted"].includes(r.status));
  return done ? "conclude" : "wait";
}

const stateKey = (repoUrl: string) => `main_watch:${repoUrl}`;

async function getState(repoUrl: string): Promise<WatchState | null> {
  const raw = await queries.getAppSetting(stateKey(repoUrl));
  if (!raw) return null;
  try { return JSON.parse(raw) as WatchState; } catch { return null; }
}

/** One repo, one sweep. Separated so a repo that throws (bad credential, GitHub
 *  down) can't take out the other repos' sweep. */
async function sweepRepo(repoUrl: string, userId: string): Promise<void> {
  const cred = await queries.getUserGitCredential(userId);
  if (!cred) return;
  const token = await getCipher().decrypt({ ciphertext: cred.ciphertext, nonce: cred.nonce, keyRef: cred.key_ref });
  const head = await getBranchHead(repoUrl, "main", token);
  if (!head) return; // repo unreachable / no main — nothing to conclude

  const state = await getState(repoUrl);
  const runs = state?.status === "testing"
    ? (await Promise.all(state.runIds.map((id) => queries.getPipelineRun(id)))).flatMap((r) => (r ? [r] : []))
    : [];

  switch (nextWatchAction(head, state, runs)) {
    case "launch": {
      const phases = await listTestPhases(userId, repoUrl, "main");
      if (phases.length === 0) {
        await queries.setAppSetting(stateKey(repoUrl), JSON.stringify({ sha: head, status: "no-tests", runIds: [] }));
        return;
      }
      const runIds: string[] = [];
      for (const phase of phases) {
        const r = await resolvePhase(userId, repoUrl, "main", phase);
        const runId = `run_${nanoid(12)}`;
        await queries.insertPipelineRun({
          id: runId, repoUrl, ref: "main", phase, status: "pending",
          createdByUserId: userId, agentId: null,
        });
        await launchResolved(runId, repoUrl, "main", r);
        runIds.push(runId);
      }
      await queries.setAppSetting(stateKey(repoUrl), JSON.stringify({ sha: head, status: "testing", runIds }));
      logger.info({ repoUrl, head: head.slice(0, 7), phases }, "Main moved — testing it");
      return;
    }
    case "conclude": {
      const failed = runs.filter((r) => r.status !== "passed");
      const status = failed.length ? "red" : "green";
      await queries.setAppSetting(stateKey(repoUrl), JSON.stringify({ sha: head, status, runIds: state!.runIds }));
      logger.info({ repoUrl, head: head.slice(0, 7), status }, "Main test concluded");
      if (failed.length) {
        await sendNotification(
          `🔴 main is RED: ${repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "")}`,
          `${failed.map((f) => f.phase).join(", ")} failed on main @ ${head.slice(0, 7)} — a merge broke it. Branches cut from main will inherit these failures.`,
          "high"
        ).catch(() => {});
      }
      return;
    }
    case "wait":
    case "nothing":
      return;
  }
}

/** Repos worth watching: any repo an agent has worked in, attributed to its most
 *  recent owner that still has a git credential (their token reads the repo). */
export async function sweepAllRepos(): Promise<void> {
  const repos = await queries.getWatchedRepos();
  for (const { repo_url, user_id } of repos) {
    try {
      await sweepRepo(repo_url, user_id);
    } catch (err) {
      logger.warn({ repoUrl: repo_url, err: err instanceof Error ? err.message : String(err) }, "main-watch sweep failed for repo");
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic watcher. Pod mode only — pipeline runners are pods. */
export function startMainWatch(): void {
  if (timer || config.agentExecution !== "pod") return;
  timer = setInterval(() => { void sweepAllRepos(); }, config.mainWatchIntervalSeconds * 1000);
  logger.info({ intervalSeconds: config.mainWatchIntervalSeconds }, "Main watcher started");
}

export function stopMainWatch(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
