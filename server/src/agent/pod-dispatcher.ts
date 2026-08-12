/**
 * Pod dispatcher — the boss creates/deletes ONE k8s pod per agent via the k8s
 * API (in-cluster ServiceAccount). Each agent runs on the CREDENTIAL OF THE USER
 * WHO DISPATCHED IT: the boss decrypts that user's stored token and mounts it in
 * a short-lived per-agent Secret, deleted when the pod is reaped. No shared/
 * standing token — usage bills to the dispatching user.
 */
import * as k8s from "@kubernetes/client-node";
import * as queries from "../db/queries.js";
import { getCipher } from "../crypto/cipher.js";
import { deleteRemoteBranch, normalizeGitUrl, authedUrl } from "../utils/git.js";
import type { AgentRecord } from "../types/agent.js";
import { config } from "../config.js";
import { resolvePresetConfigured, normalizeSize } from "./sizing.js";
import { resolveAgentImage } from "./agent-image.js";
import { logger } from "../utils/logger.js";

const NAMESPACE = process.env.POD_NAMESPACE || "daboss";
const WORKER_IMAGE = process.env.WORKER_IMAGE || "da-boss:local";
const APP_SECRET = process.env.APP_SECRET_NAME || "daboss-app";

let coreApi: k8s.CoreV1Api | null = null;

function api(): k8s.CoreV1Api {
  if (!coreApi) {
    const kc = new k8s.KubeConfig();
    kc.loadFromCluster();
    coreApi = kc.makeApiClient(k8s.CoreV1Api);
  }
  return coreApi;
}

const WORKSPACE_SIZE = process.env.WORKSPACE_PVC_SIZE || "20Gi";

/** RFC1123 segment: lowercase alphanumeric + '-', NO leading/trailing '-'
 *  (a nanoid can end in '-'/'_', which would otherwise make an invalid name). */
function rfc1123(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

export function agentPodName(agentId: string): string {
  return `daboss-agent-${rfc1123(agentId)}`;
}
function agentSecretName(agentId: string): string {
  return `${agentPodName(agentId)}-cred`;
}
function userWorkspacePvcName(userId: string): string {
  return `daboss-ws-${rfc1123(userId)}`;
}

/** Per-tenant shard: an RWO PVC per user, provisioned on first dispatch. The
 *  user's repo mirror + clones live here; their agents co-locate on its node
 *  (WaitForFirstConsumer). Persists across agents; never shared across users. */
async function ensureUserWorkspacePvc(userId: string): Promise<string> {
  const name = userWorkspacePvcName(userId);
  try {
    await api().readNamespacedPersistentVolumeClaim({ name, namespace: NAMESPACE });
    return name; // already exists
  } catch (err: unknown) {
    const e = err as { code?: number; statusCode?: number };
    if (e.code !== 404 && e.statusCode !== 404) throw err;
  }
  const pvc: k8s.V1PersistentVolumeClaim = {
    // user id → label must be sanitized (a nanoid can end in '-'/'_', which k8s
    // rejects as a label value); keep the exact id in an annotation.
    metadata: {
      name, namespace: NAMESPACE,
      labels: { app: "daboss-workspace", "daboss.user-id": rfc1123(userId) },
      annotations: { "daboss.user-id-raw": userId },
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: WORKSPACE_SIZE } },
    },
  };
  try {
    await api().createNamespacedPersistentVolumeClaim({ namespace: NAMESPACE, body: pvc });
    logger.info({ userId, pvc: name }, "Created per-user workspace PVC");
  } catch (err: unknown) {
    const e = err as { code?: number; statusCode?: number };
    if (e.code !== 409 && e.statusCode !== 409) throw err;
  }
  return name;
}

function envKeyForKind(kind: string): "ANTHROPIC_API_KEY" | "CLAUDE_CODE_OAUTH_TOKEN" {
  return kind === "anthropic_api_key" ? "ANTHROPIC_API_KEY" : "CLAUDE_CODE_OAUTH_TOKEN";
}

async function upsertAgentCredSecret(name: string, data: Record<string, string>): Promise<void> {
  const body: k8s.V1Secret = {
    metadata: { name, namespace: NAMESPACE, labels: { app: "daboss-agent" } },
    type: "Opaque",
    stringData: data,
  };
  try {
    await api().createNamespacedSecret({ namespace: NAMESPACE, body });
  } catch (err: unknown) {
    const e = err as { code?: number; statusCode?: number };
    if (e.code === 409 || e.statusCode === 409) {
      // Already exists (a re-dispatch). We hold only get/create/delete on secrets
      // — NOT update/patch — so replace() 403s. Delete + recreate instead: it works
      // within minimal RBAC AND guarantees a fresh credential (replace would have
      // risked leaving a stale secret in place if the token had rotated).
      await api().deleteNamespacedSecret({ name, namespace: NAMESPACE });
      await api().createNamespacedSecret({ namespace: NAMESPACE, body });
    } else {
      throw err;
    }
  }
}

async function deleteAgentCredSecret(agentId: string): Promise<void> {
  try {
    await api().deleteNamespacedSecret({ name: agentSecretName(agentId), namespace: NAMESPACE });
  } catch (err: unknown) {
    const e = err as { code?: number; statusCode?: number };
    if (e.code !== 404 && e.statusCode !== 404) {
      logger.warn({ agentId, err: e }, "Failed to delete agent cred secret");
    }
  }
}

/** Current phase of a pod, or null if it doesn't exist. */
async function getPodPhase(name: string): Promise<string | null> {
  try {
    const res = (await api().readNamespacedPod({ name, namespace: NAMESPACE })) as { status?: { phase?: string } };
    return res.status?.phase ?? null;
  } catch (err: unknown) {
    const e = err as { code?: number; statusCode?: number };
    if (e.code === 404 || e.statusCode === 404) return null;
    throw err;
  }
}

/** Poll until a pod is fully gone (its name is released) so a fresh create won't
 *  409. Bounded; returns after the timeout regardless (the create will surface any
 *  lingering conflict). */
async function waitForPodGone(name: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await getPodPhase(name)) === null) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function createAgentPod(agentId: string, turnPrompt?: string): Promise<void> {
  const agent = await queries.getAgent(agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);
  if (!agent.created_by_user_id) {
    throw new Error("Agent has no owner — cannot resolve a Claude credential");
  }
  // T-shirt size → pod resources (admin-configured presets; defaults to M when unset).
  const agentPreset = await resolvePresetConfigured(agent.size);
  const cred = await queries.getUserCredential(agent.created_by_user_id);
  if (!cred) {
    throw new Error("No Claude credential on file for you — add one in Settings before running an agent");
  }
  const token = await getCipher().decrypt({ ciphertext: cred.ciphertext, nonce: cred.nonce, keyRef: cred.key_ref });
  const envKey = envKeyForKind(cred.kind);

  // ephemeral per-agent secret carrying the dispatcher's decrypted token(s)
  const secretData: Record<string, string> = { [envKey]: token };

  // the dispatcher's git PAT too, if they have one — so their agent clones/pushes
  // private repos as them
  const gitCred = await queries.getUserGitCredential(agent.created_by_user_id);
  let hasGit = false;
  if (gitCred) {
    secretData.GIT_TOKEN = await getCipher().decrypt({
      ciphertext: gitCred.ciphertext,
      nonce: gitCred.nonce,
      keyRef: gitCred.key_ref,
    });
    hasGit = true;
  }

  // Self-provisioning agent image: if the repo declares `.daboss/agent.Dockerfile`,
  // build it once (kaniko, keyed by base+Dockerfile) and run the agent in it; else the
  // generic base. A deploy/custom agent (worker_image already set) keeps its image.
  let agentImage = agent.worker_image || WORKER_IMAGE;
  if (!agent.worker_image && agent.repo_url && hasGit) {
    agentImage = await resolveAgentImage({
      repoUrl: agent.repo_url,
      ref: agent.repo_ref || undefined,
      gitToken: secretData.GIT_TOKEN,
      baseImage: WORKER_IMAGE,
      target: agent.toolchain || undefined,
      onProgress: (msg) => { void queries.insertAgentEvent(agentId, "message", { role: "system", content: `🧱 ${msg}` }).catch(() => {}); },
    });
  }

  const secretName = agentSecretName(agentId);
  await upsertAgentCredSecret(secretName, secretData);

  // per-user shard (RWO PVC) — holds the repo mirror + clones for this user
  const wsPvc = await ensureUserWorkspacePvc(agent.created_by_user_id);

  const name = agentPodName(agentId);
  // Replace a leftover pod from a prior run. Agent pods use restartPolicy:Never,
  // so after they exit they linger in a terminal phase (Succeeded/Failed). Reusing
  // one on resume would run its ORIGINAL (now-stale) image AND never process the
  // new turn — the "resume starts with the old image / does nothing" bug. Delete a
  // terminal pod and wait for its name to clear so the create below makes a FRESH
  // pod on the current image with this turn's prompt. Leave a genuinely-running
  // pod alone (don't double-dispatch).
  const existingPhase = await getPodPhase(name);
  if (existingPhase === "Running" || existingPhase === "Pending") {
    logger.warn({ agentId, pod: name, phase: existingPhase }, "Agent pod already active — not re-dispatching");
    return;
  }
  if (existingPhase) {
    logger.info({ agentId, pod: name, phase: existingPhase }, "Replacing terminal agent pod for resume");
    try {
      await api().deleteNamespacedPod({ name, namespace: NAMESPACE });
    } catch (err: unknown) {
      const e = err as { code?: number; statusCode?: number };
      if (e.code !== 404 && e.statusCode !== 404) throw err;
    }
    await waitForPodGone(name);
  }
  const pod: k8s.V1Pod = {
    metadata: {
      name,
      namespace: NAMESPACE,
      labels: { app: "daboss-agent" },
      // agent id in an annotation — labels reject arbitrary values (e.g. a nanoid
      // ending in '-'/'_'); annotations don't
      annotations: { "daboss.agent-id": agentId },
    },
    spec: {
      restartPolicy: "Never",
      // Opt-in identity: a deploy-manager agent runs as the Workload-Identity deploy
      // SA so its gcloud/kubectl can drive a real deploy. Default agents omit this
      // (namespace default SA — no privileged k8s access from agent code).
      ...(agent.service_account ? { serviceAccountName: agent.service_account } : {}),
      // Native sidecar (initContainer with restartPolicy: Always) — starts before
      // the agent, shares its volumes for live C2, and is auto-terminated by k8s
      // when the agent (main container) exits, so the pod still completes. No k8s
      // API access, so the SA token isn't needed here (agent code can't reach it).
      ...(config.agentSidecar
        ? {
            initContainers: [
              {
                name: "sidecar",
                image: WORKER_IMAGE,
                imagePullPolicy: "IfNotPresent" as const,
                restartPolicy: "Always" as const,
                command: ["node", "dist/sidecar/index.js"],
                env: [
                  { name: "AGENT_ID", value: agentId },
                  { name: "WORK_DIR", value: "/work" },
                  { name: "POD_NAMESPACE", value: NAMESPACE },
                  { name: "DATABASE_URL", valueFrom: { secretKeyRef: { name: APP_SECRET, key: "DATABASE_URL" } } },
                ],
                volumeMounts: [
                  { name: "work", mountPath: "/work" },
                  { name: "workspace", mountPath: "/ws" },
                ],
                resources: { requests: { cpu: "25m", memory: "64Mi" }, limits: { memory: "128Mi" } },
              },
            ],
          }
        : {}),
      containers: [
        {
          name: "agent",
          // The self-provisioned repo image (or a custom worker_image, e.g. a
          // gcloud/kubectl image for a deploy-manager agent), else the generic base.
          image: agentImage,
          imagePullPolicy: "IfNotPresent",
          command: ["node", "dist/worker/index.js"],
          env: [
            { name: "AGENT_ID", value: agentId },
            { name: "WORK_DIR", value: "/work" },
            { name: "WORKSPACE_DIR", value: "/ws" }, // per-user shard mount
            { name: "LEASE_MODE", value: config.leaseMode }, // edit-time freeze-lease hook
            ...(turnPrompt ? [{ name: "TURN_PROMPT", value: turnPrompt }] : []),
            { name: "DATABASE_URL", valueFrom: { secretKeyRef: { name: APP_SECRET, key: "DATABASE_URL" } } },
            // the dispatching user's own token(s) (from the ephemeral per-agent secret)
            { name: envKey, valueFrom: { secretKeyRef: { name: secretName, key: envKey } } },
            ...(hasGit
              ? [{ name: "GIT_TOKEN", valueFrom: { secretKeyRef: { name: secretName, key: "GIT_TOKEN" } } }]
              : []),
          ],
          volumeMounts: [
            { name: "work", mountPath: "/work" },
            { name: "workspace", mountPath: "/ws" },
          ],
          resources: { requests: agentPreset.requests, limits: agentPreset.limits },
        },
        // Deploy-manager agents execute a pipeline_run: a recorder co-container
        // watches /work/.daboss/exit (the deploy's real exit code, written by the
        // agent) and records the run's pass/fail through the normal recorder →
        // NOTIFY → completion path. So the DEPLOY's exit code drives the run — the
        // agent's own (unreliable) exit is irrelevant to tracking. Pod restartPolicy
        // is Never, so the recorder exits cleanly after recording.
        ...(agent.pipeline_run_id
          ? [{
              name: "recorder",
              image: WORKER_IMAGE,
              imagePullPolicy: "IfNotPresent" as const,
              command: ["node", "dist/pipeline/recorder.js"],
              env: [
                { name: "RUN_ID", value: agent.pipeline_run_id },
                { name: "WORK_DIR", value: "/work" },
                { name: "DATABASE_URL", valueFrom: { secretKeyRef: { name: APP_SECRET, key: "DATABASE_URL" } } },
              ],
              volumeMounts: [{ name: "work", mountPath: "/work" }],
              resources: { requests: { cpu: "50m", memory: "128Mi" }, limits: { memory: "256Mi" } },
            }]
          : []),
      ],
      volumes: [
        { name: "work", emptyDir: {} },
        { name: "workspace", persistentVolumeClaim: { claimName: wsPvc } },
      ],
    },
  };

  try {
    await api().createNamespacedPod({ namespace: NAMESPACE, body: pod });
    logger.info({ agentId, pod: name, credKind: cred.kind }, "Created agent pod with dispatcher's credential");
  } catch (err: unknown) {
    const e = err as { code?: number; statusCode?: number };
    if (e.code === 409 || e.statusCode === 409) {
      logger.warn({ agentId, pod: name }, "Agent pod already exists — leaving it");
      return;
    }
    // don't leak the secret if the pod couldn't be created
    await deleteAgentCredSecret(agentId);
    throw err;
  }
}

export async function deleteAgentPod(agentId: string): Promise<void> {
  const name = agentPodName(agentId);
  try {
    await api().deleteNamespacedPod({ name, namespace: NAMESPACE });
    logger.info({ agentId, pod: name }, "Deleted agent pod");
  } catch (err: unknown) {
    const e = err as { code?: number; statusCode?: number };
    if (e.code !== 404 && e.statusCode !== 404) throw err;
  }
  await deleteAgentCredSecret(agentId);
}

/**
 * Best-effort remote-branch cleanup when an agent is deleted, so a finished
 * agent's branch doesn't linger in the shared repo. Uses the agent OWNER's git
 * token (branches are pushed as them). Skipped — never fatal — when there's no
 * repo/branch/token, or when a SIBLING agent still targets the same branch (the
 * per-work branch is shared across runs). Returns what happened for the UI.
 */
export async function deleteAgentRemoteBranch(
  agent: AgentRecord
): Promise<{ deleted: boolean; branch?: string; reason?: string }> {
  const { repo_url: repoUrl, branch, created_by_user_id: ownerId } = agent;
  if (!repoUrl || !branch) return { deleted: false, reason: "no repo/branch" };
  if (!ownerId) return { deleted: false, reason: "no owner" };

  const others = await queries.countOtherAgentsOnBranch(repoUrl, branch, agent.id);
  if (others > 0) return { deleted: false, branch, reason: `shared with ${others} other agent(s)` };

  const gitCred = await queries.getUserGitCredential(ownerId);
  if (!gitCred) return { deleted: false, branch, reason: "owner has no git credential" };

  try {
    const token = await getCipher().decrypt({
      ciphertext: gitCred.ciphertext,
      nonce: gitCred.nonce,
      keyRef: gitCred.key_ref,
    });
    await deleteRemoteBranch(repoUrl, branch, token);
    logger.info({ agentId: agent.id, branch }, "Deleted agent's remote branch");
    return { deleted: true, branch };
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    const detail = (e.stderr && e.stderr.trim()) || e.message || String(err);
    logger.warn({ agentId: agent.id, branch, err: detail }, "Remote branch delete failed");
    return { deleted: false, branch, reason: detail.slice(0, 200) };
  }
}

/**
 * Launch a short-lived pod that removes a deleted agent's persisted state from
 * the user's shard, audit-logs it, and deletes itself. The boss can't do this
 * directly — the shard is RWO + node-affine, so only a pod scheduled onto its
 * node can mount it. No-op (returns false) if the agent has no owner or the
 * user's shard doesn't exist. Best-effort: reconciliation on the next worker
 * start is the backstop.
 */
export async function launchStateCleanupPod(agent: AgentRecord): Promise<boolean> {
  const ownerId = agent.created_by_user_id;
  if (!ownerId) return false;
  const pvc = userWorkspacePvcName(ownerId);
  try {
    await api().readNamespacedPersistentVolumeClaim({ name: pvc, namespace: NAMESPACE });
  } catch {
    return false; // no shard → nothing persisted to clean
  }

  const name = `daboss-cleanup-${rfc1123(agent.id)}`;
  const pod: k8s.V1Pod = {
    metadata: {
      name,
      namespace: NAMESPACE,
      labels: { app: "daboss-cleanup" },
      annotations: { "daboss.agent-id": agent.id },
    },
    spec: {
      restartPolicy: "Never",
      serviceAccountName: "daboss", // needs pods-delete RBAC to remove itself
      containers: [
        {
          name: "cleanup",
          image: WORKER_IMAGE,
          imagePullPolicy: "IfNotPresent",
          command: ["node", "dist/worker/cleanup.js"],
          env: [
            { name: "AGENT_ID", value: agent.id },
            { name: "CLEANUP_SESSION_ID", value: agent.sdk_session_id || "" },
            { name: "CLEANUP_USER_ID", value: ownerId },
            { name: "WORKSPACE_DIR", value: "/ws" },
            { name: "POD_NAMESPACE", value: NAMESPACE },
            { name: "DATABASE_URL", valueFrom: { secretKeyRef: { name: APP_SECRET, key: "DATABASE_URL" } } },
          ],
          volumeMounts: [{ name: "workspace", mountPath: "/ws" }],
          resources: { requests: { cpu: "50m", memory: "128Mi" }, limits: { memory: "256Mi" } },
        },
      ],
      volumes: [{ name: "workspace", persistentVolumeClaim: { claimName: pvc } }],
    },
  };

  try {
    await api().createNamespacedPod({ namespace: NAMESPACE, body: pod });
    logger.info({ agentId: agent.id, pod: name }, "Launched state-cleanup pod");
    return true;
  } catch (err: unknown) {
    const e = err as { code?: number; statusCode?: number };
    if (e.code === 409 || e.statusCode === 409) return true; // one already running
    logger.warn({ agentId: agent.id, err: e }, "Failed to launch cleanup pod");
    return false;
  }
}

/**
 * Launch a generic pipeline-runner pod for one phase. The boss has already
 * resolved the command + decrypted the required secrets (keyed by env-var name),
 * so we inject them via an ephemeral Secret + params as plain env. The runner
 * never sees the cipher key or other secrets.
 */
// Poll each declared service port until all accept a connection (readiness), so
// the task doesn't run `mix ecto.create` before Postgres is up. Runs in WORKER_IMAGE (node).
const WAIT_SERVICES_SCRIPT =
  "const net=require('net');const ports=(process.env.WAIT_PORTS||'').split(',').filter(Boolean).map(Number);const start=Date.now();" +
  "const check=p=>new Promise(r=>{const s=net.connect(p,'127.0.0.1');s.on('connect',()=>{s.destroy();r(true)});s.on('error',()=>r(false));s.setTimeout(1000,()=>{s.destroy();r(false)})});" +
  "(async function loop(){const res=await Promise.all(ports.map(check));if(res.every(Boolean)){console.log('services ready');process.exit(0)}if(Date.now()-start>180000){console.error('timeout waiting for services');process.exit(1)}setTimeout(loop,1500)})();";

export async function launchPipelineRunner(opts: {
  runId: string;
  repoUrl?: string | null;
  ref?: string | null;
  command: string;
  image?: string | null; // toolchain image; when set → split-container pod
  params: Record<string, string>;
  secrets: Record<string, string>; // env-var name → plaintext
  gitToken?: string;
  services?: Array<{ image: string; name?: string; port?: number; env?: Record<string, string> }>;
  serviceAccount?: string; // KSA the pod runs as (Workload Identity for deploy phases)
  // Bytes for the $DABOSS_SEED file (an upstream phase's artifact — e.g. a data
  // snapshot). Rides in the pod Secret, surfaced as a mounted file, never env.
  seedArtifact?: string;
}): Promise<void> {
  const name = `daboss-pl-${rfc1123(opts.runId)}`;
  const secretName = `${name}-cred`;
  const secretData: Record<string, string> = { ...opts.secrets };
  if (opts.gitToken) secretData.GIT_TOKEN = opts.gitToken;
  // authed clone URL is a secret (carries the token) — used by the split init container
  if (opts.image && opts.repoUrl) secretData.CLONE_URL = authedUrl(normalizeGitUrl(opts.repoUrl), opts.gitToken || "");
  if (opts.seedArtifact) secretData.DABOSS_SEED = opts.seedArtifact;
  const hasSecret = Object.keys(secretData).length > 0;
  if (hasSecret) await upsertAgentCredSecret(secretName, secretData);

  // Seed file mount: the secret key surfaces at /daboss-seed/seed; the command
  // reads it via $DABOSS_SEED. (A file, not env — seeds can approach 1MiB.)
  const seedVolume = opts.seedArtifact
    ? [{ name: "seed", secret: { secretName, items: [{ key: "DABOSS_SEED", path: "seed" }] } }]
    : [];
  const seedMount = opts.seedArtifact ? [{ name: "seed", mountPath: "/daboss-seed", readOnly: true }] : [];
  const seedEnv = opts.seedArtifact ? [{ name: "DABOSS_SEED", value: "/daboss-seed/seed" }] : [];

  const dbEnv = { name: "DATABASE_URL", valueFrom: { secretKeyRef: { name: APP_SECRET, key: "DATABASE_URL" } } };
  const paramEnv = Object.entries(opts.params).map(([k, v]) => ({ name: k, value: v }));
  const secretEnv = Object.keys(opts.secrets).map((k) => ({ name: k, valueFrom: { secretKeyRef: { name: secretName, key: k } } }));

  let pod: k8s.V1Pod;
  if (opts.image) {
    // Split-container: the phase runs in its OWN toolchain image (no da_boss/node).
    // da_boss init clones; the toolchain runs the wrapped command; a da_boss
    // recorder shares /work and records the exit/log/artifact.
    const wrapped = `mkdir -p /work/.daboss; { ${opts.command} ; } > /work/.daboss/log 2>&1; echo $? > /work/.daboss/exit`;
    const services = opts.services || [];
    // Backing services (e.g. a test Postgres) run as NATIVE sidecars — initContainers
    // with restartPolicy: Always start before the task and keep running, and k8s
    // terminates them once the task+recorder finish, so the Job pod still completes.
    const serviceSidecars = services.map((s, i) => ({
      name: (s.name || `svc-${i}`).toLowerCase().replace(/[^a-z0-9-]/g, "-"),
      image: s.image,
      imagePullPolicy: "IfNotPresent" as const,
      restartPolicy: "Always" as const,
      env: Object.entries(s.env || {}).map(([k, v]) => ({ name: k, value: v })),
      resources: { requests: { cpu: "100m", memory: "256Mi" }, limits: { memory: "1Gi" } },
    }));
    const waitPorts = services.map((s) => s.port).filter((p): p is number => typeof p === "number");
    const waitInit = waitPorts.length
      ? [{
          name: "wait-services",
          image: WORKER_IMAGE,
          imagePullPolicy: "IfNotPresent" as const,
          command: ["node", "-e", WAIT_SERVICES_SCRIPT],
          env: [{ name: "WAIT_PORTS", value: waitPorts.join(",") }],
        }]
      : [];
    pod = {
      metadata: { name, namespace: NAMESPACE, labels: { app: "daboss-pipeline" }, annotations: { "daboss.run-id": opts.runId } },
      spec: {
        restartPolicy: "Never",
        ...(opts.serviceAccount ? { serviceAccountName: opts.serviceAccount } : {}),
        initContainers: [
          ...serviceSidecars,
          {
            name: "clone",
            image: WORKER_IMAGE,
            imagePullPolicy: "IfNotPresent",
            command: ["sh", "-c", opts.repoUrl
              ? `git clone --depth 1 ${opts.ref ? `--branch "$PIPELINE_REF"` : ""} "$CLONE_URL" /work && mkdir -p /work/.daboss`
              : `mkdir -p /work/.daboss`],
            env: [
              ...(opts.ref ? [{ name: "PIPELINE_REF", value: opts.ref }] : []),
              ...(opts.repoUrl ? [{ name: "CLONE_URL", valueFrom: { secretKeyRef: { name: secretName, key: "CLONE_URL" } } }] : []),
            ],
            volumeMounts: [{ name: "work", mountPath: "/work" }],
          },
          ...waitInit,
        ],
        containers: [
          {
            name: "task",
            image: opts.image,
            // IfNotPresent so a locally-built toolchain image (e.g. a prebaked
            // elixir-test image in the kind node store) is used without a registry;
            // pinned public tags are also cached rather than re-pulled.
            imagePullPolicy: "IfNotPresent",
            workingDir: "/work",
            command: ["sh", "-c", wrapped],
            env: [
              { name: "DABOSS_ARTIFACT", value: "/work/.daboss/artifact" },
              ...seedEnv,
              ...paramEnv,
              ...secretEnv,
            ],
            volumeMounts: [{ name: "work", mountPath: "/work" }, ...seedMount],
            resources: { requests: { cpu: "250m", memory: "512Mi" }, limits: { memory: "2Gi" } },
          },
          {
            name: "recorder",
            image: WORKER_IMAGE,
            imagePullPolicy: "IfNotPresent",
            command: ["node", "dist/pipeline/recorder.js"],
            env: [{ name: "RUN_ID", value: opts.runId }, { name: "WORK_DIR", value: "/work" }, dbEnv],
            volumeMounts: [{ name: "work", mountPath: "/work" }],
            resources: { requests: { cpu: "50m", memory: "128Mi" }, limits: { memory: "256Mi" } },
          },
        ],
        volumes: [{ name: "work", emptyDir: {} }, ...seedVolume],
      },
    };
  } else {
    // Single-container: default da_boss image handles clone + run + record itself.
    pod = {
      metadata: { name, namespace: NAMESPACE, labels: { app: "daboss-pipeline" }, annotations: { "daboss.run-id": opts.runId } },
      spec: {
        restartPolicy: "Never",
        ...(opts.serviceAccount ? { serviceAccountName: opts.serviceAccount } : {}),
        containers: [
          {
            name: "runner",
            image: WORKER_IMAGE,
            imagePullPolicy: "IfNotPresent",
            command: ["node", "dist/pipeline/runner.js"],
            env: [
              { name: "RUN_ID", value: opts.runId },
              { name: "PIPELINE_COMMAND", value: opts.command },
              { name: "WORK_DIR", value: "/work" },
              ...(opts.repoUrl ? [{ name: "PIPELINE_REPO_URL", value: opts.repoUrl }] : []),
              ...(opts.ref ? [{ name: "PIPELINE_REF", value: opts.ref }] : []),
              dbEnv,
              ...seedEnv,
              ...paramEnv,
              ...secretEnv,
              ...(opts.gitToken ? [{ name: "GIT_TOKEN", valueFrom: { secretKeyRef: { name: secretName, key: "GIT_TOKEN" } } }] : []),
            ],
            volumeMounts: [{ name: "work", mountPath: "/work" }, ...seedMount],
            resources: { requests: { cpu: "100m", memory: "256Mi" }, limits: { memory: "1Gi" } },
          },
        ],
        volumes: [{ name: "work", emptyDir: {} }, ...seedVolume],
      },
    };
  }

  try {
    await api().createNamespacedPod({ namespace: NAMESPACE, body: pod });
    logger.info({ runId: opts.runId, pod: name, image: opts.image || WORKER_IMAGE }, "Launched pipeline runner");
  } catch (err) {
    if (hasSecret) await deleteNamespacedSecretSafe(secretName);
    throw err;
  }
}

async function deleteNamespacedSecretSafe(name: string): Promise<void> {
  try {
    await api().deleteNamespacedSecret({ name, namespace: NAMESPACE });
  } catch (err: unknown) {
    const e = err as { code?: number; statusCode?: number };
    if (e.code !== 404 && e.statusCode !== 404) logger.warn({ name, err: e }, "Failed to delete pipeline secret");
  }
}

/** Reclaim a user's workspace shard. NOT called on agent-delete — the PVC is
 *  per-USER and shared by all their agents; this is for user offboarding. */
export async function deleteUserWorkspacePvc(userId: string): Promise<void> {
  const name = userWorkspacePvcName(userId);
  try {
    await api().deleteNamespacedPersistentVolumeClaim({ name, namespace: NAMESPACE });
    logger.info({ userId, pvc: name }, "Deleted user workspace PVC");
  } catch (err: unknown) {
    const e = err as { code?: number; statusCode?: number };
    if (e.code !== 404 && e.statusCode !== 404) throw err;
  }
}

/** Delete pods whose worker has exited (Succeeded/Failed) and their cred secrets.
 *  Also backstops cleanup pods that outlived their self-delete. */
export async function reapFinishedAgentPods(): Promise<void> {
  try {
    const res = await api().listNamespacedPod({
      namespace: NAMESPACE,
      labelSelector: "app in (daboss-agent,daboss-cleanup,daboss-pipeline)",
    });
    for (const pod of res.items) {
      const phase = pod.status?.phase;
      const name = pod.metadata?.name;
      const app = pod.metadata?.labels?.app;
      const agentId = pod.metadata?.annotations?.["daboss.agent-id"];
      if (name && (phase === "Succeeded" || phase === "Failed")) {
        await api().deleteNamespacedPod({ name, namespace: NAMESPACE });
        // agent pods carry an ephemeral cred secret; pipeline pods carry <name>-cred
        if (app === "daboss-agent" && agentId) await deleteAgentCredSecret(agentId);
        if (app === "daboss-pipeline") await deleteNamespacedSecretSafe(`${name}-cred`);
        logger.info({ pod: name, phase, app }, "Reaped finished pod");
        // A FAILED agent pod means the worker died before recording a terminal
        // state — reconcile the agent NOW, with the pod's actual death reason
        // (OOMKilled etc.), instead of waiting for the heartbeat reaper to write
        // a generic "no heartbeat" message that loses the cause.
        if (phase === "Failed" && app === "daboss-agent" && agentId) {
          await reconcileFailedAgentPod(agentId, podFailureReason(pod)).catch((err) =>
            logger.warn({ agentId, err: err instanceof Error ? err.message : String(err) }, "Failed-pod reconcile failed"));
        }
        continue;
      }
      // Self-heal a pod wedged on VOLUME ATTACH: if a per-user workspace disk gets
      // deleted out from under its PVC (e.g. a cost-cleanup sweep of "unattached"
      // disks), every pod stalls in Pending on AttachVolume.Attach failed — forever.
      // Detect it, delete the broken PVC (da_boss recreates a fresh one), drop the
      // pod, and re-queue → fresh workspace + a graceful fresh-session resume.
      if (name && phase === "Pending" && app === "daboss-agent" && agentId) {
        const created = pod.metadata?.creationTimestamp ? new Date(pod.metadata.creationTimestamp).getTime() : Date.now();
        if ((Date.now() - created) / 1000 > 180) { // stuck Pending > 3 min
          const evs = await api().listNamespacedEvent({ namespace: NAMESPACE, fieldSelector: `involvedObject.name=${name}` }).catch(() => null);
          const volFail = (evs?.items || []).some((e) => e.reason === "FailedAttachVolume" || /AttachVolume\.Attach failed|Could not find disk|was not found/i.test(e.message || ""));
          if (volFail) {
            logger.warn({ pod: name, agentId }, "Agent pod wedged on volume attach — recovering: recreate PVC + re-dispatch");
            const agent = await queries.getAgent(agentId).catch(() => null);
            if (agent?.created_by_user_id) {
              await api().deleteNamespacedPersistentVolumeClaim({ name: userWorkspacePvcName(agent.created_by_user_id), namespace: NAMESPACE }).catch(() => {});
            }
            await api().deleteNamespacedPod({ name, namespace: NAMESPACE, gracePeriodSeconds: 0 }).catch(() => {});
            await deleteAgentCredSecret(agentId).catch(() => {});
            await queries.insertAgentEvent(agentId, "message", { role: "system", content: "⚠ Workspace volume was lost (its disk is gone) — recreating a fresh workspace and re-dispatching. Session history is lost; committed work on the branch is safe." }).catch(() => {});
            await queries.updateAgentState(agentId, "queued", {}).catch(() => {});
            await queries.notifyAgentQueued(agentId).catch(() => {});
          }
        }
      }
    }
  } catch (err: unknown) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Pod reap failed");
  }
}

/** Why a finished pod died, from its container statuses. Keeps the literal
 *  "OOMKilled"/"exit code N" tokens the dispatcher's resource-failure regex
 *  keys on, so a requeue auto-bumps the size. */
export function podFailureReason(pod: k8s.V1Pod): string {
  const statuses = [...(pod.status?.containerStatuses ?? []), ...(pod.status?.initContainerStatuses ?? [])];
  for (const cs of statuses) {
    const t = cs.state?.terminated ?? cs.lastState?.terminated;
    if (t && (t.exitCode !== 0 || t.reason === "OOMKilled")) {
      const reason = t.reason && t.reason !== "Error" ? `${t.reason} ` : "";
      return `container ${cs.name} ${reason}(exit code ${t.exitCode})`;
    }
  }
  return pod.status?.reason || "unknown failure";
}

const RESOURCE_DEATH = /OOMKilled|Evicted|out of memory|exit code 137/i;

/** The worker died without recording a terminal state (its pod went Failed).
 *  Resource deaths below XL self-heal: requeue, and the dispatcher bumps the
 *  size one up off the reason we record here. Everything else parks as paused
 *  with the real cause; a dead REVIEWER also closes out its review so the
 *  reviewed agent can't stick on "In review" forever. */
async function reconcileFailedAgentPod(agentId: string, reason: string): Promise<void> {
  const agent = await queries.getAgent(agentId);
  if (!agent || !["running", "waiting_permission", "waiting_input"].includes(agent.state)) return;
  const size = normalizeSize(agent.size);
  if (RESOURCE_DEATH.test(reason) && size && size !== "xl") {
    await queries.updateAgentState(agentId, "queued", { error_message: `Pod failed: ${reason}` });
    await queries.insertAgentEvent(agentId, "state_change", { from: agent.state, to: "queued" });
    await queries.insertAgentEvent(agentId, "message", {
      role: "system",
      content: `⚠ Pod died: ${reason}. Re-dispatching automatically at the next size up.`,
    });
    await queries.notifyAgentQueued(agentId);
    logger.warn({ agentId, reason, size }, "Agent pod died on resources — requeued for a size bump");
  } else {
    await queries.updateAgentState(agentId, "paused", {
      error_message: `Pod failed: ${reason}. Reconciled to paused; resume to continue.`,
    });
    await queries.insertAgentEvent(agentId, "state_change", { from: agent.state, to: "paused" });
    await queries.insertAgentEvent(agentId, "message", {
      role: "system",
      content: `⚠ Pod failed: ${reason} — reconciled to **paused**. Resume to continue.`,
    });
    await queries.interruptReviewForDeadReviewer(agentId, `its pod failed: ${reason}`).catch(() => {});
    logger.warn({ agentId, reason }, "Agent pod failed — reconciled to paused");
  }
}
