/**
 * Dev environments — the lifecycle. A repo that ships `.daboss/dev.yaml` (see
 * config.ts) gets a "dev environment" per change: da_boss creates the declared
 * Deployment in the declared namespace, clones the change's branch into it, runs
 * the repo's setup + start commands, and hands the human the exact port-forward
 * command. Local work flows in by `kubectl` tar-copy (instant) or push + sync
 * (git); the env expires on its own (ttl, extended by every sync).
 *
 * Neutral: every app-specific choice lives in the repo's dev.yaml. The deployment
 * decides only WHERE dev pods may go (DABOSS_DEV_NAMESPACES) and grants da_boss
 * RBAC there (Deployments + pods/exec — see k8s/gke/RUNBOOK.md).
 */
import * as k8s from "@kubernetes/client-node";
import { Writable, Readable } from "node:stream";
import { nanoid } from "nanoid";
import * as queries from "../db/queries.js";
import type { DevEnvRecord } from "../db/queries.js";
import type { AgentRecord } from "../types/agent.js";
import { getCipher } from "../crypto/cipher.js";
import { createBranch, getBranchHead, getFileContents } from "../forge/github.js";
import { resolveAgentImage } from "../agent/agent-image.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { DEV_CONFIG_PATH, parseDevConfig, type DevConfig } from "./config.js";
import {
  buildDevDeployment, bootstrapScript, syncScript, readyScript, devCommands, localClaudePrompt, devEnvName,
  DEV_CONTAINER, LOG_FILE, type DevCommands,
} from "./manifest.js";

/** A user-facing failure with an HTTP status (the API/MCP layers relay it). */
export class DevEnvError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// ── Kubernetes access ────────────────────────────────────────────────────────

let kc: k8s.KubeConfig | null = null;
function kube(): { apps: k8s.AppsV1Api; core: k8s.CoreV1Api; exec: k8s.Exec } {
  if (!kc) {
    kc = new k8s.KubeConfig();
    kc.loadFromCluster();
  }
  return { apps: kc.makeApiClient(k8s.AppsV1Api), core: kc.makeApiClient(k8s.CoreV1Api), exec: new k8s.Exec(kc) };
}

const statusOf = (err: unknown): number | undefined => {
  const e = err as { code?: number; statusCode?: number };
  return e.code ?? e.statusCode;
};

/** The running pod behind a dev Deployment, if one is up. */
async function findPod(ns: string, name: string): Promise<k8s.V1Pod | undefined> {
  const pods = await kube().core.listNamespacedPod({ namespace: ns, labelSelector: `app=${name}` });
  return pods.items.find((p) => !p.metadata?.deletionTimestamp && p.status?.phase === "Running")
    ?? pods.items.find((p) => !p.metadata?.deletionTimestamp);
}

/** Run a shell script in the dev container. `stdin` (e.g. the git token) never
 *  touches argv. Resolves with the exit code and combined output (tail-capped). */
async function podExec(ns: string, pod: string, script: string, stdin: string | null, timeoutMs: number): Promise<{ code: number; out: string }> {
  let out = "";
  const sink = new Writable({
    write(chunk, _enc, cb) { out = (out + chunk.toString()).slice(-64_000); cb(); },
  });
  const input = stdin == null ? null : Readable.from([`${stdin}\n`]);
  return new Promise((resolve, reject) => {
    let settled = false;
    let code = -1;
    const done = (r: { code: number; out: string } | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (r instanceof Error) reject(r); else resolve(r);
    };
    const timer = setTimeout(() => {
      done({ code: 124, out: `${out}\n(timed out after ${Math.round(timeoutMs / 1000)}s)` });
    }, timeoutMs);
    kube().exec.exec(ns, pod, DEV_CONTAINER, ["sh", "-c", script], sink, sink, input, false, (status) => {
      if (status.status === "Success") code = 0;
      else {
        const exit = status.details?.causes?.find((c) => c.reason === "ExitCode")?.message;
        code = exit ? Number(exit) : 1;
      }
    }).then((ws) => {
      ws.on("close", () => done({ code, out }));
      ws.on("error", (e: Error) => done(e));
    }).catch((e) => done(e instanceof Error ? e : new Error(String(e))));
  });
}

const tail = (s: string, n = 25) => s.trim().split("\n").slice(-n).join("\n");

// ── Inputs ───────────────────────────────────────────────────────────────────

async function gitTokenFor(userId: string | null | undefined): Promise<string> {
  if (!userId) throw new DevEnvError(400, "No user to act as.");
  const cred = await queries.getUserGitCredential(userId);
  if (!cred) throw new DevEnvError(400, "Add a GitHub token in Settings first — the dev pod clones the branch with it.");
  return getCipher().decrypt({ ciphertext: cred.ciphertext, nonce: cred.nonce, keyRef: cred.key_ref });
}

/** The repo's dev.yaml, from its DEFAULT branch (trusted), validated against what
 *  this deployment allows. */
export async function loadDevConfig(repoUrl: string, token: string): Promise<DevConfig> {
  if (!config.devNamespaces.length) {
    throw new DevEnvError(400, "Dev environments aren't enabled on this da_boss (DABOSS_DEV_NAMESPACES is empty).");
  }
  const text = await getFileContents(repoUrl, DEV_CONFIG_PATH, undefined, token).catch(() => null);
  if (!text?.trim()) {
    throw new DevEnvError(404,
      `This repo has no ${DEV_CONFIG_PATH} on its default branch, so it doesn't declare a dev environment. ` +
      `It's read from the default branch only — never from a change's branch, since it picks the namespace, ` +
      `service account and secrets da_boss runs with — so adding or changing it takes effect once merged.`);
  }
  let cfg: DevConfig;
  try {
    cfg = parseDevConfig(text);
  } catch (err) {
    throw new DevEnvError(400, err instanceof Error ? err.message : String(err));
  }
  if (!config.devNamespaces.includes(cfg.namespace)) {
    throw new DevEnvError(403, `dev.yaml targets namespace '${cfg.namespace}', which this da_boss doesn't allow (DABOSS_DEV_NAMESPACES: ${config.devNamespaces.join(", ")}).`);
  }
  return cfg;
}

/** Make sure a change's branch exists on the remote — a local-dev change starts
 *  from a branch nobody has pushed yet. Cut it from the base ref's HEAD. */
export async function ensureRemoteBranch(agent: AgentRecord, userId: string): Promise<void> {
  if (!agent.repo_url || !agent.branch) throw new DevEnvError(400, "This change has no repo/branch.");
  const token = await gitTokenFor(userId);
  if (await getBranchHead(agent.repo_url, agent.branch, token)) return;
  const base = agent.repo_ref || "main";
  const baseSha = await getBranchHead(agent.repo_url, base, token);
  if (!baseSha) throw new DevEnvError(400, `Base branch '${base}' not found on the remote.`);
  if (!(await createBranch(agent.repo_url, agent.branch, baseSha, token))) {
    throw new DevEnvError(500, `Couldn't create branch '${agent.branch}' on the remote.`);
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/** Envs whose provisioning is running in THIS process (a restart orphans them). */
const provisioning = new Set<string>();

async function note(env: DevEnvRecord, msg: string, status?: queries.DevEnvStatus): Promise<void> {
  await queries.updateDevEnv(env.id, { detail: msg, ...(status ? { status } : {}) }).catch(() => {});
  await queries.insertAgentEvent(env.agent_id, "message", { role: "system", content: `🧪 Dev env: ${msg}` }).catch(() => {});
}

/** Has the env been stopped (or replaced) since provisioning began? */
async function cancelled(envId: string): Promise<boolean> {
  const cur = await queries.getDevEnv(envId);
  return !cur || cur.status === "stopping" || cur.status === "stopped";
}

/**
 * Start (or return the live) dev environment for a change. Returns immediately
 * with status `starting`; provisioning — image, Deployment, clone, setup, start,
 * ready check — continues in the background and narrates into the agent's trace.
 */
export async function startDevEnv(agent: AgentRecord, actor: { userId: string; email: string | null; name: string | null }): Promise<DevEnvRecord> {
  if (!agent.repo_url || !agent.branch) throw new DevEnvError(400, "This change has no repo/branch.");
  const live = await queries.getLiveDevEnvForAgent(agent.id);
  if (live && live.status !== "failed") return live;
  if (live) await stopDevEnv(live, "replaced by a restart");

  const token = await gitTokenFor(actor.userId);
  const cfg = await loadDevConfig(agent.repo_url, token);
  if (!(await getBranchHead(agent.repo_url, agent.branch, token))) {
    throw new DevEnvError(400, `Branch '${agent.branch}' isn't on the remote yet — push it first.`);
  }

  const env = await queries.insertDevEnv({
    id: `dev_${nanoid(10)}`,
    agent_id: agent.id,
    user_id: actor.userId,
    repo_url: agent.repo_url,
    branch: agent.branch,
    namespace: cfg.namespace,
    name: devEnvName(agent.id, actor.email),
    image: cfg.image === "agent" ? null : cfg.image,
    port: cfg.port,
    ttl_hours: cfg.ttl_hours,
    expires_at: new Date(Date.now() + cfg.ttl_hours * 3600_000),
  });
  provisioning.add(env.id);
  void provision(env, cfg, token, actor)
    .catch(async (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ envId: env.id, err: msg }, "Dev env provisioning failed");
      if (!(await cancelled(env.id))) await note(env, `failed — ${msg}`, "failed");
    })
    .finally(() => provisioning.delete(env.id));
  return env;
}

async function provision(env: DevEnvRecord, cfg: DevConfig, token: string, actor: { email: string | null; name: string | null }): Promise<void> {
  const { apps } = kube();

  // 1. Image: the repo's agent toolchain image (warm deps), unless dev.yaml names one.
  let image = env.image;
  if (!image) {
    await note(env, "resolving the repo's toolchain image (a first build can take several minutes)…");
    image = (await resolveAgentImage({
      repoUrl: env.repo_url,
      gitToken: token,
      baseImage: config.workerImage,
      toolchainBase: config.agentBaseImage || undefined,
      onProgress: (m) => void note(env, m),
    })).image;
    await queries.updateDevEnv(env.id, { image });
  }
  if (await cancelled(env.id)) return;

  // 2. The Deployment (replacing any leftover of the same name).
  const body = buildDevDeployment({
    name: env.name, image, config: cfg, envId: env.id, agentId: env.agent_id,
    vars: { "user.email": actor.email || "", "user.name": actor.name || "", branch: env.branch, repo: env.repo_url },
  });
  try {
    await apps.createNamespacedDeployment({ namespace: env.namespace, body });
  } catch (err) {
    if (statusOf(err) !== 409) throw err;
    await apps.replaceNamespacedDeployment({ name: env.name, namespace: env.namespace, body });
  }
  await note(env, `created \`deploy/${env.name}\` in \`${env.namespace}\` — waiting for the pod…`);

  // 3. Wait for the pod's dev container to run; surface why when it can't.
  const pod = await waitForPod(env);
  if (!pod) {
    // Stopped while we were creating it — the stop may have run before the
    // Deployment existed, so make sure it's gone.
    await apps.deleteNamespacedDeployment({ name: env.name, namespace: env.namespace }).catch(() => {});
    return;
  }

  // 4. Clone + setup + start, inside the pod. Token on stdin only.
  await note(env, `cloning \`${env.branch}\` and running setup…`);
  const boot = await podExec(env.namespace, pod, bootstrapScript(env.repo_url, env.branch, cfg), token, 30 * 60_000);
  if (boot.code !== 0) throw new Error(`setup exited ${boot.code}:\n${tail(boot.out)}`);
  if (await cancelled(env.id)) return;

  // 5. Ready check (the repo's own probe), else ready once started.
  if (cfg.ready_check) {
    await note(env, "app started — waiting for it to answer…");
    const ready = await podExec(env.namespace, pod, readyScript(cfg), null, (cfg.ready_timeout_seconds + 60) * 1000);
    if (ready.code !== 0) throw new Error(`the app didn't come up:\n${tail(ready.out)}`);
  }
  if (await cancelled(env.id)) return;
  const cmds = commandsFor(env, cfg.sync_exclude);
  await note(env, `ready — port-forward with \`${cmds.port_forward}\`, then open ${cmds.url}`, "ready");
}

async function waitForPod(env: DevEnvRecord): Promise<string | null> {
  const deadline = Date.now() + 15 * 60_000;
  let lastReason = "";
  while (Date.now() < deadline) {
    if (await cancelled(env.id)) return null;
    const pod = await findPod(env.namespace, env.name).catch(() => undefined);
    const dev = pod?.status?.containerStatuses?.find((c) => c.name === DEV_CONTAINER);
    if (pod?.metadata?.name && dev?.state?.running) return pod.metadata.name;
    const waiting = dev?.state?.waiting?.reason
      || pod?.status?.conditions?.find((c) => c.type === "PodScheduled" && c.status === "False")?.message
      || "";
    if (/ImagePullBackOff|ErrImagePull|CrashLoopBackOff|CreateContainerConfigError|InvalidImageName/.test(waiting)) {
      throw new Error(`the pod can't start: ${waiting}${dev?.state?.waiting?.message ? ` — ${dev.state.waiting.message}` : ""}`);
    }
    if (waiting && waiting !== lastReason) { lastReason = waiting; await note(env, `pod waiting: ${waiting}`); }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("the pod didn't start within 15 minutes");
}

/** Pull the branch's latest commits into the pod and run the repo's sync steps.
 *  Also extends the env's lifetime. */
export async function syncDevEnv(env: DevEnvRecord, actorUserId: string): Promise<{ output: string }> {
  if (env.status !== "ready") throw new DevEnvError(409, `The dev env is ${env.status}, not ready.`);
  const token = await gitTokenFor(actorUserId);
  const cfg = await loadDevConfig(env.repo_url, token);
  const pod = await findPod(env.namespace, env.name);
  if (!pod?.metadata?.name) throw new DevEnvError(409, "The dev pod isn't running.");
  const r = await podExec(env.namespace, pod.metadata.name, syncScript(env.branch, cfg), token, 20 * 60_000);
  await queries.updateDevEnv(env.id, { expires_at: new Date(Date.now() + env.ttl_hours * 3600_000) });
  if (r.code !== 0) {
    await note(env, `sync failed (exit ${r.code})`);
    throw new DevEnvError(500, `Sync failed (exit ${r.code}):\n${tail(r.out)}`);
  }
  await note(env, `synced — ${tail(r.out, 1)}`);
  return { output: tail(r.out) };
}

/** Push the expiry out by one ttl from now. */
export async function extendDevEnv(env: DevEnvRecord): Promise<DevEnvRecord> {
  await queries.updateDevEnv(env.id, { expires_at: new Date(Date.now() + env.ttl_hours * 3600_000) });
  return (await queries.getDevEnv(env.id))!;
}

/** Tear the env down (idempotent — a missing Deployment is fine). */
export async function stopDevEnv(env: DevEnvRecord, reason: string): Promise<void> {
  if (env.status === "stopped") return;
  await queries.updateDevEnv(env.id, { status: "stopping" });
  try {
    await kube().apps.deleteNamespacedDeployment({ name: env.name, namespace: env.namespace });
  } catch (err) {
    if (statusOf(err) !== 404) {
      await queries.updateDevEnv(env.id, { status: env.status, detail: `stop failed: ${err instanceof Error ? err.message : String(err)}` });
      throw err;
    }
  }
  await queries.updateDevEnv(env.id, { status: "stopped", stopped: true, detail: `stopped — ${reason}` });
  await queries.insertAgentEvent(env.agent_id, "message", { role: "system", content: `🧪 Dev env: stopped (${reason}).` }).catch(() => {});
}

/** The app's recent log lines. */
export async function devEnvLogs(env: DevEnvRecord, lines = 200): Promise<string> {
  const pod = await findPod(env.namespace, env.name);
  if (!pod?.metadata?.name) throw new DevEnvError(409, "The dev pod isn't running.");
  const r = await podExec(env.namespace, pod.metadata.name, `tail -n ${Math.min(Math.max(lines, 1), 2000)} ${LOG_FILE} 2>&1 || true`, null, 30_000);
  return r.out;
}

// ── What the human sees ──────────────────────────────────────────────────────

export function commandsFor(env: DevEnvRecord, syncExclude: string[] = []): DevCommands {
  return devCommands({
    name: env.name, namespace: env.namespace, port: env.port, branch: env.branch,
    context: config.devKubeContext || undefined, syncExclude,
  });
}

export interface DevEnvView {
  env: DevEnvRecord;
  commands: DevCommands;
  local_claude_prompt: string;
}

export async function devEnvView(env: DevEnvRecord, agent: AgentRecord): Promise<DevEnvView> {
  // sync_exclude only shapes the copy command — read it best-effort (no token
  // needed for a cached view would be nicer; dev.yaml is small, skip on failure).
  let exclude: string[] = [];
  try {
    if (env.user_id) exclude = (await loadDevConfig(env.repo_url, await gitTokenFor(env.user_id))).sync_exclude;
  } catch { /* commands still work, just without the repo's excludes */ }
  const commands = commandsFor(env, exclude);
  const files = (await queries.listAgentFiles(agent.id).catch(() => [])).map((f) => f.name);
  return {
    env,
    commands,
    local_claude_prompt: localClaudePrompt({ agentId: agent.id, agentName: agent.name, repoUrl: env.repo_url, branch: env.branch, cmds: commands, files }),
  };
}

/** What a change's dev env WILL look like, before it's started — so the panel can
 *  show the real commands up front, or the reason the repo can't have one. */
export type DevEnvPreview =
  | { available: true; namespace: string; name: string; port: number; commands: DevCommands; local_claude_prompt: string }
  | { available: false; reason: string };

export async function previewDevEnv(agent: AgentRecord, viewer: { userId: string; email: string | null }): Promise<DevEnvPreview> {
  if (!agent.repo_url || !agent.branch) return { available: false, reason: "This change has no repo/branch." };
  try {
    const cfg = await loadDevConfig(agent.repo_url, await gitTokenFor(viewer.userId));
    const name = devEnvName(agent.id, viewer.email);
    const commands = devCommands({
      name, namespace: cfg.namespace, port: cfg.port, branch: agent.branch,
      context: config.devKubeContext || undefined, syncExclude: cfg.sync_exclude,
    });
    const files = (await queries.listAgentFiles(agent.id).catch(() => [])).map((f) => f.name);
    return {
      available: true, namespace: cfg.namespace, name, port: cfg.port, commands,
      local_claude_prompt: localClaudePrompt({ agentId: agent.id, agentName: agent.name, repoUrl: agent.repo_url, branch: agent.branch, cmds: commands, files }),
    };
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// ── Reaper ───────────────────────────────────────────────────────────────────

/** Stop expired envs; fail envs whose provisioning died with a previous boss. */
export async function reapDevEnvs(now = Date.now()): Promise<void> {
  for (const env of await queries.getLiveDevEnvs()) {
    try {
      if (Date.parse(env.expires_at) <= now) {
        await stopDevEnv(env, "expired — extend or sync to keep one longer");
      } else if (env.status === "starting" && !provisioning.has(env.id)) {
        await note(env, "setup was interrupted (da_boss restarted) — restart the dev env", "failed");
      } else if (env.status === "stopping") {
        await stopDevEnv(env, "stop retried");
      }
    } catch (err) {
      logger.warn({ envId: env.id, err: err instanceof Error ? err.message : String(err) }, "Dev env reap failed");
    }
  }
}

export function startDevEnvReaper(): void {
  if (config.agentExecution !== "pod" || !config.devNamespaces.length) return;
  setInterval(() => { void reapDevEnvs(); }, 60_000).unref();
  logger.info({ namespaces: config.devNamespaces }, "Dev environments enabled");
}
