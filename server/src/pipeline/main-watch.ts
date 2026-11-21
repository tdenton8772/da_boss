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
import { getBranchHead, setCommitStatus, type CommitState } from "../forge/github.js";
import { resolvePhase, launchResolved, listTestPhases } from "./service.js";
import { sendNotification } from "../notifications/ntfy.js";
import { prewarmRepoImage } from "../agent/image-prewarm.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

export interface WatchState {
  sha: string;
  status: "testing" | "green" | "red" | "no-tests";
  runIds: string[];
  /** Phases of `sha` not launched yet (max-parallel cap). */
  queued?: string[];
  /** A newer head seen while `sha` was testing or settling, and when first seen. */
  nextSha?: string;
  nextSeenAt?: number;
}

export interface WatchOptions {
  /** A new head is launched only after staying put this long. 0 = at first sight. */
  settleSeconds?: number;
  /** At most this many of one head's phases at once. 0 = all at once. */
  maxParallel?: number;
  now?: number;
}

const TERMINAL = ["passed", "failed", "error", "aborted"];
const isTerminal = (r: { status: string }) => TERMINAL.includes(r.status);

/** What a sweep should do for one repo — pure, so the launch/wait/notify
 *  transitions are assertable without GitHub or a cluster.
 *  - launch:   test `head` (main moved, or first sight)
 *  - settle:   main moved, but wait for it to stay put (remember it as nextSha)
 *  - fill:     start queued phases of the head under test (a slot freed)
 *  - wait:     the head under test is still going
 *  - conclude: every run of the head under test is terminal
 *  With coalescing (settle or a parallel cap), a head under test is always
 *  concluded before a newer one launches; without it, a move re-launches at once. */
export function nextWatchAction(
  head: string,
  state: WatchState | null,
  runs: Array<{ status: string }>,
  opts: WatchOptions = {}
): "launch" | "settle" | "fill" | "wait" | "conclude" | "nothing" {
  const settleMs = (opts.settleSeconds ?? 0) * 1000;
  const cap = opts.maxParallel ?? 0;
  const coalesce = settleMs > 0 || cap > 0;
  const now = opts.now ?? Date.now();
  if (state?.status === "testing") {
    if (state.sha !== head && !coalesce) return "launch"; // test the NEW head
    const queued = state.queued?.length ?? 0;
    if (queued === 0 && runs.every(isTerminal)) return "conclude";
    if (queued > 0 && runs.filter((r) => !isTerminal(r)).length < (cap > 0 ? cap : Infinity)) return "fill";
    return "wait";
  }
  if (!state || state.sha !== head) {
    if (settleMs > 0 && !(state?.nextSha === head && now - (state.nextSeenAt ?? now) >= settleMs)) return "settle";
    return "launch";
  }
  return "nothing"; // already concluded for this sha
}

const stateKey = (repoUrl: string) => `main_watch:${repoUrl}`;

async function getState(repoUrl: string): Promise<WatchState | null> {
  const raw = await queries.getAppSetting(stateKey(repoUrl));
  if (!raw) return null;
  try { return JSON.parse(raw) as WatchState; } catch { return null; }
}

const saveState = (repoUrl: string, st: WatchState) => queries.setAppSetting(stateKey(repoUrl), JSON.stringify(st));

const COMMIT_STATE: Record<string, CommitState> = { passed: "success", failed: "failure", error: "error", aborted: "error" };

/** Post one phase's state on the commit (DABOSS_COMMIT_STATUS=on). Never throws;
 *  a refusal (token can't write statuses) is logged once per sweep, not retried. */
async function postStatus(repoUrl: string, sha: string, token: string, phase: string, state: CommitState, description: string, runId?: string): Promise<void> {
  if (!config.commitStatus) return;
  const targetUrl = config.publicUrl ? (runId ? `${config.publicUrl}/api/pipeline/runs/${runId}` : config.publicUrl) : undefined;
  const code = await setCommitStatus(repoUrl, sha, token, { state, context: `daboss/${phase}`, description, targetUrl });
  if (code < 200 || code >= 300) logger.warn({ repoUrl, sha: sha.slice(0, 7), phase, httpStatus: code }, "main-watch: commit status not set");
}

/** Start one phase of `sha` on main. A phase that can't be resolved/launched is
 *  recorded as an `error` run, so the head still concludes (red) instead of
 *  re-launching every sweep. */
async function launchOne(repoUrl: string, userId: string, sha: string, phase: string, token: string): Promise<string> {
  const runId = `run_${nanoid(12)}`;
  await queries.insertPipelineRun({ id: runId, repoUrl, ref: "main", phase, status: "pending", createdByUserId: userId, agentId: null });
  try {
    const r = await resolvePhase(userId, repoUrl, sha, phase);
    await launchResolved(runId, repoUrl, "main", r, sha);
    await postStatus(repoUrl, sha, token, phase, "pending", "running", runId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : (err as { message?: string })?.message ?? String(err);
    await queries.updatePipelineRun(runId, { status: "error", log: `main-watch could not launch ${phase} @ ${sha.slice(0, 7)}: ${msg}`, completed: true });
  }
  return runId;
}

/** One repo, one sweep. Separated so a repo that throws (bad credential, GitHub
 *  down) can't take out the other repos' sweep. */
async function sweepRepo(repoUrl: string, userId: string): Promise<void> {
  const cred = await queries.getUserGitCredential(userId);
  if (!cred) return;
  const token = await getCipher().decrypt({ ciphertext: cred.ciphertext, nonce: cred.nonce, keyRef: cred.key_ref });
  const head = await getBranchHead(repoUrl, "main", token);
  if (!head) return; // repo unreachable / no main — nothing to conclude

  let state = await getState(repoUrl);
  const now = Date.now();
  // Remember a newer head (and when it first showed) — the settle clock.
  if (state && state.sha !== head && state.nextSha !== head) {
    state = { ...state, nextSha: head, nextSeenAt: now };
    await saveState(repoUrl, state);
  }
  const runs = state?.status === "testing"
    ? (await Promise.all(state.runIds.map((id) => queries.getPipelineRun(id)))).flatMap((r) => (r ? [r] : []))
    : [];
  const opts = { settleSeconds: config.mainWatchSettleSeconds, maxParallel: config.mainWatchMaxParallel, now };

  switch (nextWatchAction(head, state, runs, opts)) {
    case "settle":
      if (!state) await saveState(repoUrl, { sha: "", status: "green", runIds: [], nextSha: head, nextSeenAt: now });
      return;
    case "launch": {
      // main moved — maybe the repo's agent.Dockerfile or a lockfile it bakes did
      // too. Build the new toolchain image now, not when the next agent waits on it.
      void prewarmRepoImage(repoUrl, userId);
      const phases = await listTestPhases(userId, repoUrl, head);
      if (phases.length === 0) {
        await saveState(repoUrl, { sha: head, status: "no-tests", runIds: [] });
        return;
      }
      const cap = opts.maxParallel > 0 ? opts.maxParallel : phases.length;
      const first = phases.slice(0, cap), queued = phases.slice(cap);
      for (const phase of queued) await postStatus(repoUrl, head, token, phase, "pending", "queued");
      // Save before launching: a crash mid-launch must not re-launch on the next sweep.
      const st: WatchState = { sha: head, status: "testing", runIds: [], queued: [...first, ...queued] };
      await saveState(repoUrl, st);
      for (const phase of first) {
        st.runIds.push(await launchOne(repoUrl, userId, head, phase, token));
        st.queued = st.queued!.filter((p) => p !== phase);
        await saveState(repoUrl, st);
      }
      logger.info({ repoUrl, head: head.slice(0, 7), phases, queued }, "Main moved — testing it");
      return;
    }
    case "fill": {
      const st = state!;
      const cap = opts.maxParallel > 0 ? opts.maxParallel : Infinity;
      let free = cap - runs.filter((r) => !isTerminal(r)).length;
      while (free-- > 0 && st.queued!.length) {
        const phase = st.queued![0];
        st.queued = st.queued!.slice(1);
        await saveState(repoUrl, st);
        st.runIds.push(await launchOne(repoUrl, userId, st.sha, phase, token));
        await saveState(repoUrl, st);
      }
      return;
    }
    case "conclude": {
      const st = state!;
      const failed = runs.filter((r) => r.status !== "passed");
      const status = failed.length ? "red" : "green";
      for (const r of runs) {
        await postStatus(repoUrl, st.sha, token, r.phase, COMMIT_STATE[r.status] ?? "error", r.status, r.id);
      }
      await saveState(repoUrl, { sha: st.sha, status, runIds: st.runIds, ...(st.nextSha && st.nextSha !== st.sha ? { nextSha: st.nextSha, nextSeenAt: st.nextSeenAt } : {}) });
      logger.info({ repoUrl, head: st.sha.slice(0, 7), status }, "Main test concluded");
      if (failed.length) {
        await sendNotification(
          `🔴 main is RED: ${repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "")}`,
          `${failed.map((f) => f.phase).join(", ")} failed on main @ ${st.sha.slice(0, 7)} — a merge broke it. Branches cut from main will inherit these failures.`,
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
  const repos = await queries.getWatchedRepos(config.mainWatchRepos);
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
