/**
 * .daboss/dev.yaml — the domain-neutral contract for a repo's DEV ENVIRONMENT: a
 * short-lived pod that runs the app from a change's branch so a human (and their
 * local Claude) can iterate against it through a port-forward, then hand the
 * change back to da_boss for testing + review.
 *
 * da_boss knows nothing about the app: the repo declares where the pod runs, what
 * it mounts, and the commands that set it up and start it — strings, like
 * pipeline.yaml's phases. da_boss supplies the lifecycle (create, clone the
 * branch, setup, start, sync, expire, tear down) and the commands a human needs.
 *
 * The file is ALWAYS read from the repo's default branch, never from the branch
 * being developed: it names a namespace, a service account and secrets, so an
 * unreviewed branch must not be able to change what da_boss applies.
 */
import { parse as parseYaml } from "yaml";

export const DEV_CONFIG_PATH = ".daboss/dev.yaml";

/** An env var sourced from a k8s Secret in the dev namespace. */
export interface DevSecretEnv {
  name: string;
  secret: string;
  key: string;
}

/** A whole ConfigMap or Secret exposed as env vars. */
export type DevEnvFrom = { config_map: string } | { secret: string };

export interface DevConfig {
  /** Namespace the dev pod runs in — where the app's secrets/config/SA live. Must
   *  also be allowed by the deployment (DABOSS_DEV_NAMESPACES). */
  namespace: string;
  /** Port the app listens on inside the pod; the human port-forwards to it. */
  port: number;
  /** Image for the dev container. "agent" (default) = the repo's agent toolchain
   *  image (built from .daboss/agent.Dockerfile — warm deps), else an image ref. */
  image: string;
  /** Repo subdirectory the setup/start/sync commands run in (default "."). */
  workdir: string;
  /** Run once after the branch is cloned (deps, compile, asset binaries, …). */
  setup: string[];
  /** Long-running command that serves the app (backgrounded; log at /workspace/dev.log). */
  start: string;
  /** Run after each sync pulls new commits (e.g. a migration-free recompile). */
  sync: string[];
  /** Restart `start` after a sync (for apps without hot reload). */
  restart_on_sync: boolean;
  /** Polled until it exits 0 to mark the env ready (e.g. `curl -sf localhost:4000`).
   *  Unset → ready as soon as `start` is launched. */
  ready_check?: string;
  /** Seconds to wait for ready_check (default 600). */
  ready_timeout_seconds: number;
  /** Lifetime in hours; every sync / extend pushes the expiry out again (default 8). */
  ttl_hours: number;
  service_account?: string;
  pod_annotations: Record<string, string>;
  node_selector: Record<string, string>;
  tolerations: Array<Record<string, unknown>>;
  /** Plain env vars. Values may use ${user.email}, ${user.name}, ${branch}, ${repo}. */
  env: Record<string, string>;
  secret_env: DevSecretEnv[];
  env_from: DevEnvFrom[];
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
  /** Extra containers (k8s container specs, passed through) — e.g. a DB proxy. */
  sidecars: Array<Record<string, unknown>>;
  /** Paths (relative to the repo root) a local `kubectl cp`/tar sync should skip —
   *  build output, editor state. Used only to render the human's sync command. */
  sync_exclude: string[];
}

const K8S_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function str(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) throw new Error(`dev.yaml: '${field}' must be a non-empty string`);
  return v.trim();
}
function strList(v: unknown, field: string): string[] {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  if (!arr.every((x) => typeof x === "string" && x.trim())) throw new Error(`dev.yaml: '${field}' must be a string or a list of strings`);
  return arr.map((x) => (x as string).trim());
}
function strMap(v: unknown, field: string): Record<string, string> {
  if (v == null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new Error(`dev.yaml: '${field}' must be a map`);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val == null || typeof val === "object") throw new Error(`dev.yaml: '${field}.${k}' must be a scalar`);
    out[k] = String(val);
  }
  return out;
}
function objList(v: unknown, field: string): Array<Record<string, unknown>> {
  if (v == null) return [];
  if (!Array.isArray(v) || !v.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
    throw new Error(`dev.yaml: '${field}' must be a list of maps`);
  }
  return v as Array<Record<string, unknown>>;
}

/** Parse + validate .daboss/dev.yaml. Throws a readable Error on anything malformed. */
export function parseDevConfig(text: string): DevConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new Error(`dev.yaml: not valid YAML (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("dev.yaml: expected a map at the top level");
  const r = raw as Record<string, unknown>;

  const namespace = str(r.namespace, "namespace");
  if (!K8S_NAME.test(namespace)) throw new Error(`dev.yaml: namespace '${namespace}' isn't a valid Kubernetes name`);
  const port = Number(r.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("dev.yaml: 'port' must be an integer port number");

  const workdir = r.workdir == null ? "." : str(r.workdir, "workdir");
  if (workdir.startsWith("/") || workdir.split("/").includes("..")) throw new Error("dev.yaml: 'workdir' must be a path inside the repo");

  const env = strMap(r.env, "env");
  for (const k of Object.keys(env)) if (!ENV_NAME.test(k)) throw new Error(`dev.yaml: env name '${k}' is invalid`);

  const secret_env = objList(r.secret_env, "secret_env").map((e, i) => ({
    name: str(e.name, `secret_env[${i}].name`),
    secret: str(e.secret, `secret_env[${i}].secret`),
    key: str(e.key, `secret_env[${i}].key`),
  }));
  const env_from: DevEnvFrom[] = objList(r.env_from, "env_from").map((e, i) => {
    if (typeof e.config_map === "string") return { config_map: e.config_map };
    if (typeof e.secret === "string") return { secret: e.secret };
    throw new Error(`dev.yaml: env_from[${i}] needs 'config_map' or 'secret'`);
  });

  const sidecars = objList(r.sidecars, "sidecars");
  sidecars.forEach((c, i) => {
    str(c.name, `sidecars[${i}].name`);
    str(c.image, `sidecars[${i}].image`);
    if (c.name === "dev") throw new Error("dev.yaml: a sidecar can't be named 'dev' (that's the app container)");
  });

  const ttl = r.ttl_hours == null ? 8 : Number(r.ttl_hours);
  if (!(ttl > 0 && ttl <= 72)) throw new Error("dev.yaml: 'ttl_hours' must be between 0 and 72");
  const readyTimeout = r.ready_timeout_seconds == null ? 600 : Number(r.ready_timeout_seconds);
  if (!(readyTimeout > 0 && readyTimeout <= 3600)) throw new Error("dev.yaml: 'ready_timeout_seconds' must be between 1 and 3600");

  const resources = r.resources == null ? undefined : (r.resources as DevConfig["resources"]);

  return {
    namespace,
    port,
    image: r.image == null ? "agent" : str(r.image, "image"),
    workdir,
    setup: strList(r.setup, "setup"),
    start: str(r.start, "start"),
    sync: strList(r.sync, "sync"),
    restart_on_sync: r.restart_on_sync === true,
    ready_check: r.ready_check == null ? undefined : str(r.ready_check, "ready_check"),
    ready_timeout_seconds: readyTimeout,
    ttl_hours: ttl,
    service_account: r.service_account == null ? undefined : str(r.service_account, "service_account"),
    pod_annotations: strMap(r.pod_annotations, "pod_annotations"),
    node_selector: strMap(r.node_selector, "node_selector"),
    tolerations: objList(r.tolerations, "tolerations"),
    env,
    secret_env,
    env_from,
    resources,
    sidecars,
    sync_exclude: strList(r.sync_exclude, "sync_exclude"),
  };
}

/** Values a dev.yaml env string may reference. */
export interface DevTemplateVars {
  "user.email": string;
  "user.name": string;
  branch: string;
  repo: string;
}

/** Substitute ${user.email} etc. Unknown placeholders are left as-is. */
export function renderTemplate(s: string, vars: DevTemplateVars): string {
  return s.replace(/\$\{([a-z.]+)\}/g, (m, key: string) => (key in vars ? vars[key as keyof DevTemplateVars] : m));
}
