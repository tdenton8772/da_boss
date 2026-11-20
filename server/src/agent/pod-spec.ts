/**
 * Cluster-level pod settings shared by every pod da_boss launches in its namespace
 * (agent, pipeline, image-build and state-cleanup pods). Provider-neutral: plain
 * Kubernetes fields, configured by env.
 *
 *  - `DABOSS_POD_NODE_SELECTOR` — JSON object, e.g. `{"pool":"agents"}`: where these
 *    pods run (a dedicated or autoscaled node pool). Empty → the scheduler decides.
 *  - `DABOSS_POD_TOLERATIONS` — JSON array of tolerations, e.g.
 *    `[{"key":"pool","value":"agents","effect":"NoSchedule"}]`, for a tainted pool.
 *  - `DABOSS_REGISTRY_SECRET` — name of a `kubernetes.io/dockerconfigjson` Secret in
 *    the namespace: pods pull with it (`imagePullSecrets`), kaniko pushes with it, and
 *    the "already built?" registry check authenticates with it. Empty → anonymous
 *    pulls / ambient credentials (e.g. a cloud's workload identity).
 *
 * Service-account tokens: a pod gets the Kubernetes API token only when it runs as a
 * named service account that needs the API (a phase's or agent's `service_account`, or
 * the cleanup pod, which deletes itself). Everything else — including image builds, which
 * run the repo's Dockerfile `RUN` steps — sets `automountServiceAccountToken: false`, so
 * agent code never holds the namespace default SA's token, whatever that SA may be
 * granted later.
 */
import type * as k8s from "@kubernetes/client-node";

export interface PodDefaults {
  nodeSelector: Record<string, string>;
  tolerations: k8s.V1Toleration[];
  registrySecret: string;
}

const TOLERATION_KEYS = new Set(["key", "operator", "value", "effect", "tolerationSeconds"]);

/** `DABOSS_POD_NODE_SELECTOR`: a JSON object of string → string. Throws on anything else
 *  (a silently ignored selector would put agents on the wrong nodes). */
export function parseNodeSelector(raw: string | undefined): Record<string, string> {
  if (!raw || !raw.trim()) return {};
  let v: unknown;
  try { v = JSON.parse(raw); } catch { throw new Error("DABOSS_POD_NODE_SELECTOR must be a JSON object, e.g. {\"pool\":\"agents\"}"); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("DABOSS_POD_NODE_SELECTOR must be a JSON object");
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== "string") throw new Error(`DABOSS_POD_NODE_SELECTOR: value for "${k}" must be a string`);
    out[k] = val;
  }
  return out;
}

/** `DABOSS_POD_TOLERATIONS`: a JSON array of Kubernetes tolerations. Throws on anything else. */
export function parseTolerations(raw: string | undefined): k8s.V1Toleration[] {
  if (!raw || !raw.trim()) return [];
  let v: unknown;
  try { v = JSON.parse(raw); } catch { throw new Error("DABOSS_POD_TOLERATIONS must be a JSON array of tolerations"); }
  if (!Array.isArray(v)) throw new Error("DABOSS_POD_TOLERATIONS must be a JSON array of tolerations");
  return v.map((t, i) => {
    if (!t || typeof t !== "object" || Array.isArray(t)) throw new Error(`DABOSS_POD_TOLERATIONS[${i}] must be an object`);
    const unknownKeys = Object.keys(t).filter((k) => !TOLERATION_KEYS.has(k));
    if (unknownKeys.length) throw new Error(`DABOSS_POD_TOLERATIONS[${i}]: unknown field(s) ${unknownKeys.join(", ")}`);
    const tol = t as k8s.V1Toleration;
    if (tol.operator && tol.operator !== "Equal" && tol.operator !== "Exists") {
      throw new Error(`DABOSS_POD_TOLERATIONS[${i}]: operator must be Equal or Exists`);
    }
    if (tol.effect && !["NoSchedule", "PreferNoSchedule", "NoExecute"].includes(tol.effect)) {
      throw new Error(`DABOSS_POD_TOLERATIONS[${i}]: effect must be NoSchedule, PreferNoSchedule or NoExecute`);
    }
    return tol;
  });
}

/** The configured defaults (read from env; validated — throws on a malformed value). */
export function podDefaults(env: NodeJS.ProcessEnv = process.env): PodDefaults {
  return {
    nodeSelector: parseNodeSelector(env.DABOSS_POD_NODE_SELECTOR),
    tolerations: parseTolerations(env.DABOSS_POD_TOLERATIONS),
    registrySecret: (env.DABOSS_REGISTRY_SECRET || "").trim(),
  };
}

/** Placement, pull credentials and token mounting for one da_boss-launched pod.
 *  `serviceAccount` set → the pod runs as it and gets its token, unless `apiToken: false`
 *  (an identity used for something other than the Kubernetes API, e.g. a cloud
 *  workload-identity binding for registry push); unset → no token. */
export function workloadPodSpec(
  opts: { serviceAccount?: string | null; apiToken?: boolean },
  d: PodDefaults = podDefaults(),
): Pick<k8s.V1PodSpec, "nodeSelector" | "tolerations" | "imagePullSecrets" | "serviceAccountName" | "automountServiceAccountToken"> {
  return {
    ...(Object.keys(d.nodeSelector).length ? { nodeSelector: { ...d.nodeSelector } } : {}),
    ...(d.tolerations.length ? { tolerations: d.tolerations.map((t) => ({ ...t })) } : {}),
    ...(d.registrySecret ? { imagePullSecrets: [{ name: d.registrySecret }] } : {}),
    ...(opts.serviceAccount ? { serviceAccountName: opts.serviceAccount } : {}),
    automountServiceAccountToken: Boolean(opts.serviceAccount) && opts.apiToken !== false,
  };
}
