/**
 * Pure builders for a dev environment: the Deployment da_boss applies, and the
 * commands a human (or their local Claude) runs against it. No cluster access —
 * everything here is unit-testable.
 */
import type * as k8s from "@kubernetes/client-node";
import { renderTemplate, type DevConfig, type DevTemplateVars } from "./config.js";

/** Where the branch is checked out inside the dev container. */
export const SRC_DIR = "/workspace/src";
/** The app's (start command's) log inside the dev container. */
export const LOG_FILE = "/workspace/dev.log";
export const DEV_CONTAINER = "dev";
export const DEV_LABEL = "daboss.io/dev-env";

function slug(s: string, max: number): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");
}

/** Deployment name: `dev-<user>-<agent>` — readable in `kubectl get deploy`, unique
 *  per change, and a valid DNS-1123 label (≤63). */
export function devEnvName(agentId: string, userEmail: string | null): string {
  const user = slug((userEmail || "user").split("@")[0], 20) || "user";
  const agent = slug(agentId, 30) || "change";
  return `dev-${user}-${agent}`.slice(0, 63).replace(/-+$/, "");
}

export interface DevDeploymentInput {
  name: string;
  image: string;
  config: DevConfig;
  vars: DevTemplateVars;
  envId: string;
  agentId: string;
}

/** The dev Deployment. The `dev` container idles (`sleep infinity`) — da_boss execs
 *  in to clone, set up and start the app, so a failed setup leaves a pod you can
 *  still get into and debug. */
export function buildDevDeployment(i: DevDeploymentInput): k8s.V1Deployment {
  const c = i.config;
  const env: k8s.V1EnvVar[] = [
    ...Object.entries(c.env).map(([name, value]) => ({ name, value: renderTemplate(value, i.vars) })),
    ...c.secret_env.map((s) => ({ name: s.name, valueFrom: { secretKeyRef: { name: s.secret, key: s.key } } })),
  ];
  const envFrom: k8s.V1EnvFromSource[] = c.env_from.map((e) =>
    "config_map" in e ? { configMapRef: { name: e.config_map } } : { secretRef: { name: e.secret } }
  );
  const labels = { app: i.name, [DEV_LABEL]: "true" };
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: i.name,
      namespace: c.namespace,
      labels,
      annotations: { "daboss.io/dev-env-id": i.envId, "daboss.io/agent-id": i.agentId, "daboss.io/branch": i.vars.branch },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: i.name } },
      strategy: { type: "Recreate" },
      template: {
        metadata: { labels, annotations: { ...c.pod_annotations } },
        spec: {
          ...(c.service_account ? { serviceAccountName: c.service_account } : {}),
          ...(Object.keys(c.node_selector).length ? { nodeSelector: c.node_selector } : {}),
          ...(c.tolerations.length ? { tolerations: c.tolerations as k8s.V1Toleration[] } : {}),
          containers: [
            {
              name: DEV_CONTAINER,
              image: i.image,
              imagePullPolicy: "IfNotPresent",
              command: ["sleep", "infinity"],
              workingDir: "/workspace",
              ports: [{ containerPort: c.port }],
              env,
              ...(envFrom.length ? { envFrom } : {}),
              ...(c.resources ? { resources: c.resources } : {}),
            },
            ...(c.sidecars as unknown as k8s.V1Container[]),
          ],
        },
      },
    },
  };
}

// ── In-pod scripts (run via exec; the git token arrives on stdin, never argv) ──

/** Shell-quote a value for a POSIX `sh -c` script. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A credential helper that reads the token from $DABOSS_GIT_TOKEN (set from
 *  stdin by the script) — so the token never lands on disk or in a process argv. */
const GIT_AUTH = `git -c credential.helper= -c 'credential.helper=!f(){ echo username=x-access-token; echo "password=$DABOSS_GIT_TOKEN"; }; f'`;

/** Clone the branch, run setup, launch the app in its own process group. */
export function bootstrapScript(repoUrl: string, branch: string, c: DevConfig): string {
  const workdir = c.workdir === "." ? SRC_DIR : `${SRC_DIR}/${c.workdir}`;
  return [
    "set -e",
    "IFS= read -r DABOSS_GIT_TOKEN; export DABOSS_GIT_TOKEN",
    `mkdir -p /workspace`,
    `if [ -d ${SRC_DIR}/.git ]; then cd ${SRC_DIR} && ${GIT_AUTH} fetch --quiet origin ${shq(branch)} && git reset --quiet --hard FETCH_HEAD; ` +
      `else ${GIT_AUTH} clone --quiet --branch ${shq(branch)} ${shq(repoUrl)} ${SRC_DIR}; fi`,
    "unset DABOSS_GIT_TOKEN",
    `cd ${shq(workdir)}`,
    ...c.setup.map((cmd) => `echo "▶ ${cmd.replace(/["\\$`]/g, "\\$&")}"; ${cmd}`),
    startLine(c, workdir),
  ].join("\n");
}

/** Launch `start` detached in its own session (setsid → its pid is the process
 *  group id), logging to LOG_FILE; the pid lets a sync restart the whole group. */
function startLine(c: DevConfig, workdir: string): string {
  // `&` without job control doesn't make a new process group, so setsid runs
  // in-place (no fork) and $! is the session leader's pid. Images without setsid
  // fall back to nohup (a restart then kills only the top process).
  const launch = `${shq(c.start)} > ${LOG_FILE} 2>&1 < /dev/null &`;
  return [
    `cd ${shq(workdir)}`,
    `if command -v setsid >/dev/null 2>&1; then setsid sh -c ${launch} else nohup sh -c ${launch} fi`,
    "echo $! > /workspace/.dev.pid",
  ].join("\n");
}

/** Pull the branch's latest commits (discarding uncommitted copies — they were
 *  pushed), run the sync hooks, optionally restart the app. */
export function syncScript(branch: string, c: DevConfig): string {
  const workdir = c.workdir === "." ? SRC_DIR : `${SRC_DIR}/${c.workdir}`;
  return [
    "set -e",
    "IFS= read -r DABOSS_GIT_TOKEN; export DABOSS_GIT_TOKEN",
    `cd ${SRC_DIR}`,
    `${GIT_AUTH} fetch --quiet origin ${shq(branch)}`,
    "git reset --quiet --hard FETCH_HEAD",
    "unset DABOSS_GIT_TOKEN",
    'echo "at $(git log --oneline -1)"',
    `cd ${shq(workdir)}`,
    ...c.sync.map((cmd) => `echo "▶ ${cmd.replace(/["\\$`]/g, "\\$&")}"; ${cmd}`),
    ...(c.restart_on_sync
      ? ['if [ -f /workspace/.dev.pid ]; then P=$(cat /workspace/.dev.pid); kill -TERM -- "-$P" 2>/dev/null || kill -TERM "$P" 2>/dev/null || true; sleep 2; fi', startLine(c, workdir)]
      : []),
  ].join("\n");
}

/** Poll the repo's ready_check until it passes or the timeout runs out. */
export function readyScript(c: DevConfig): string {
  const workdir = c.workdir === "." ? SRC_DIR : `${SRC_DIR}/${c.workdir}`;
  const tries = Math.max(1, Math.ceil(c.ready_timeout_seconds / 5));
  return [
    `cd ${shq(workdir)}`,
    `i=0; while [ $i -lt ${tries} ]; do if sh -c ${shq(c.ready_check || "true")} >/dev/null 2>&1; then exit 0; fi; i=$((i+1)); sleep 5; done`,
    `echo "not ready after ${c.ready_timeout_seconds}s — last log lines:"; tail -n 30 ${LOG_FILE} 2>/dev/null; exit 1`,
  ].join("\n");
}

// ── Commands for the human / their local Claude ───────────────────────────────

export interface DevCommands {
  /** Exact kubectl context name, or "$CTX" when the deployment doesn't name one. */
  context: string;
  context_hint?: string;
  port_forward: string;
  url: string;
  /** Copy the local working tree in (uncommitted, instant). Run from the repo root. */
  copy_tree: string;
  /** Copy specific files in: append paths. Run from the repo root. */
  copy_files: string;
  logs: string;
  shell: string;
  checkout: string;
}

export function devCommands(o: {
  name: string;
  namespace: string;
  port: number;
  branch: string;
  context?: string;
  syncExclude: string[];
}): DevCommands {
  const ctx = o.context || "$CTX";
  const k = `kubectl --context ${ctx} -n ${o.namespace}`;
  const excludes = [".git", ...o.syncExclude].map((p) => `--exclude=${shq(p)}`).join(" ");
  const untar = `${k} exec -i deploy/${o.name} -c ${DEV_CONTAINER} -- tar -xzf - -C ${SRC_DIR}`;
  return {
    context: ctx,
    ...(o.context ? {} : { context_hint: "Set CTX to your kubectl context for this cluster first (kubectl config get-contexts)." }),
    port_forward: `${k} port-forward deploy/${o.name} ${o.port}:${o.port}`,
    url: `http://localhost:${o.port}`,
    copy_tree: `COPYFILE_DISABLE=1 tar -cz ${excludes} . | ${untar}`,
    copy_files: `COPYFILE_DISABLE=1 tar -cz <paths…> | ${untar}`,
    logs: `${k} exec deploy/${o.name} -c ${DEV_CONTAINER} -- tail -n 100 -f ${LOG_FILE}`,
    shell: `${k} exec -it deploy/${o.name} -c ${DEV_CONTAINER} -- sh -c 'cd ${SRC_DIR} && exec bash || exec sh'`,
    checkout: `git fetch origin ${o.branch} && git checkout ${o.branch}`,
  };
}

/** A prompt to paste into a local Claude Code session so it can adopt the change. */
export function localClaudePrompt(o: {
  agentId: string;
  agentName: string;
  repoUrl: string;
  branch: string;
  cmds: DevCommands;
}): string {
  return [
    `You're picking up a da_boss change to work on locally against its dev environment.`,
    ``,
    `- Change: ${o.agentName} (da_boss agent ${o.agentId})`,
    `- Repo: ${o.repoUrl}`,
    `- Branch: ${o.branch} — check it out: \`${o.cmds.checkout}\``,
    `- The app runs in a dev pod. I'll keep this port-forward open in another terminal:`,
    `  \`${o.cmds.port_forward}\` → ${o.cmds.url}`,
    ...(o.cmds.context_hint ? [`  (${o.cmds.context_hint})`] : []),
    ``,
    `How to iterate:`,
    `- Fast, uncommitted: copy changed files into the pod from the repo root:`,
    `  \`${o.cmds.copy_files}\` (or the whole tree: \`${o.cmds.copy_tree}\`). Then I refresh the browser.`,
    `- Committed: commit + push to ${o.branch}, then call the da_boss MCP tool \`sync_dev_env\` (agent_id ${o.agentId}) — the pod pulls and runs its sync steps.`,
    `- App log: \`${o.cmds.logs}\``,
    ``,
    `When the change is done: commit and push everything to ${o.branch}, then call the da_boss MCP tool`,
    `\`handback_change\` (agent_id ${o.agentId}). da_boss opens/updates the PR, runs the repo's checks, and`,
    `queues its review. When I say we're finished with the environment, call \`stop_dev_env\` (agent_id ${o.agentId}).`,
  ].join("\n");
}
