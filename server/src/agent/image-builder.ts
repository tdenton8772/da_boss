/**
 * On-demand toolchain image builds for pipeline phases.
 *
 * A repo's pipeline can declare `build:` on a phase (or a service) — a Dockerfile
 * context in the repo. When the phase is about to run, da_boss checks whether the
 * phase's `image` already exists in the registry; if it doesn't, it builds it from
 * the repo with **kaniko** (in-cluster, no Docker daemon, registry-agnostic) and
 * pushes it under that exact tag, then reuses it forever after (the tag is the cache
 * key). This keeps image DEFINITIONS in the repo (neutral — da_boss bakes in no
 * toolchain) and makes the pipeline self-bootstrapping: a fresh registry just works.
 *
 * Neutral seams:
 *  - `DABOSS_BUILD_SERVICE_ACCOUNT` — KSA the kaniko pod runs as (needs registry
 *    push). Empty → the namespace default SA (fine only if it can push).
 *  - `DABOSS_KANIKO_IMAGE` — kaniko executor image (default the upstream one).
 *  - existence check auth is best-effort; when it can't tell, we BUILD (safe).
 */
import * as k8s from "@kubernetes/client-node";
import type { ImageBuild } from "../pipeline/config.js";
import { normalizeGitUrl } from "../utils/git.js";
import { logger } from "../utils/logger.js";

const NAMESPACE = process.env.POD_NAMESPACE || "daboss";
const KANIKO_IMAGE = process.env.DABOSS_KANIKO_IMAGE || "gcr.io/kaniko-project/executor:latest";
const BUILD_SA = process.env.DABOSS_BUILD_SERVICE_ACCOUNT || "";
const KANIKO_MEMORY = process.env.DABOSS_KANIKO_MEMORY || "4Gi";
// Dep-baking images (warm mix/pip caches) legitimately take 30-40 min to build
// and want real CPU — both configurable, with defaults sized for them.
const KANIKO_CPU = process.env.DABOSS_KANIKO_CPU || "4";
const BUILD_TIMEOUT_MS = Number(process.env.DABOSS_BUILD_TIMEOUT_MS) || 45 * 60 * 1000;

let coreApi: k8s.CoreV1Api | null = null;
function api(): k8s.CoreV1Api {
  if (!coreApi) {
    const kc = new k8s.KubeConfig();
    kc.loadFromCluster();
    coreApi = kc.makeApiClient(k8s.CoreV1Api);
  }
  return coreApi;
}

// ── Pure helpers (unit-tested) ────────────────────────────────────────────────

export interface ImageRef {
  registry: string; // host[:port]
  repository: string; // path after the host, before the tag
  tag: string;
}

/** Split `REGION-docker.pkg.dev/proj/repo/name:tag` into parts. Defaults tag to
 *  `latest`. A ref with no registry host (e.g. `python:3.12`) is a Docker Hub ref —
 *  we never build those (no `build:` would point at them), so registry is "". */
export function parseImageRef(ref: string): ImageRef {
  const [namePart, tag = "latest"] = ref.split(":").length > 1 && !ref.includes("/")
    ? ref.split(":")
    : splitTag(ref);
  const slash = namePart.indexOf("/");
  const host = slash > 0 && namePart.slice(0, slash).includes(".") ? namePart.slice(0, slash) : "";
  return { registry: host, repository: host ? namePart.slice(slash + 1) : namePart, tag };
}
function splitTag(ref: string): [string, string] {
  const at = ref.lastIndexOf(":");
  const lastSlash = ref.lastIndexOf("/");
  return at > lastSlash ? [ref.slice(0, at), ref.slice(at + 1)] : [ref, "latest"];
}

/** Kaniko layer cache repo alongside the image (same registry+project, `/cache`). */
export function cacheRepoFor(ref: string): string {
  const { registry, repository } = parseImageRef(ref);
  if (!registry) return "";
  const base = repository.includes("/") ? repository.slice(0, repository.lastIndexOf("/")) : repository;
  return `${registry}/${base}/cache`;
}

/** The (image, build) pairs a phase needs built: the phase image itself plus any
 *  service image that declares a `build`. Only pairs with a real image+build. */
export function imagesToEnsure(
  phase: { image?: string; build?: ImageBuild; services?: Array<{ image: string; build?: ImageBuild }> }
): Array<{ image: string; build: ImageBuild }> {
  const out: Array<{ image: string; build: ImageBuild }> = [];
  if (phase.image && phase.build) out.push({ image: phase.image, build: phase.build });
  for (const s of phase.services || []) if (s.image && s.build) out.push({ image: s.image, build: s.build });
  return out;
}

// ── Registry existence check (best-effort) ────────────────────────────────────

/** True if `ref`'s tag already exists. Best-effort Docker Registry v2 manifest
 *  check; on GKE it authenticates to Artifact Registry with the workload-identity
 *  token. Returns false when it can't tell — so we build rather than skip (safe). */
export async function imageExists(ref: string): Promise<boolean> {
  const { registry, repository, tag } = parseImageRef(ref);
  if (!registry) return false;
  try {
    const token = await gcpAccessToken();
    const headers: Record<string, string> = {
      Accept: "application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.index.v1+json",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`https://${registry}/v2/${repository}/manifests/${encodeURIComponent(tag)}`, { method: "HEAD", headers });
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    logger.warn({ ref, status: res.status }, "Image existence check inconclusive — will build");
    return false;
  } catch (err) {
    logger.warn({ ref, err: err instanceof Error ? err.message : String(err) }, "Image existence check failed — will build");
    return false;
  }
}

/** GKE workload-identity access token from the metadata server, or null off-GCP. */
async function gcpAccessToken(): Promise<string | null> {
  try {
    const res = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(2000) }
    );
    if (!res.ok) return null;
    return (await res.json() as { access_token?: string }).access_token || null;
  } catch {
    return null;
  }
}

// ── Build (kaniko pod) ────────────────────────────────────────────────────────

const podName = (image: string): string =>
  `daboss-build-${image.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(-40).toLowerCase()}-${Math.abs(hash(image)).toString(36)}`;
function hash(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

/** Ensure every image a phase declares a build for exists — building the missing
 *  ones with kaniko and reusing the present ones. Best-effort per image; a build
 *  failure throws so the caller can surface it (a phase can't run without its image). */
export async function ensurePipelineImages(
  phase: { image?: string; build?: ImageBuild; services?: Array<{ image: string; build?: ImageBuild }> },
  opts: BuildOpts
): Promise<void> {
  for (const { image, build } of imagesToEnsure(phase)) {
    await ensureImage(image, { context: build.context, dockerfile: build.dockerfile }, opts);
  }
}

export interface BuildSpec {
  context: string; // build context dir in the repo ("." = repo root)
  dockerfile?: string; // Dockerfile path relative to context (default "Dockerfile")
  target?: string; // multi-stage build target (kaniko --target) — toolchain flavors
  buildArgs?: Record<string, string>; // --build-arg K=V (e.g. DABOSS_BASE for agent images)
}
export interface BuildOpts { repoUrl: string; ref?: string; gitToken: string; onProgress?: (msg: string) => void }

/** Ensure `image` exists in the registry — reuse if present, build with kaniko if
 *  missing. Throws if the build fails (the caller can't run without the image). */
export async function ensureImage(image: string, spec: BuildSpec, opts: BuildOpts): Promise<void> {
  if (await imageExists(image)) {
    opts.onProgress?.(`✓ image ${image} already exists — reusing`);
    return;
  }
  // Single-flight per image: concurrent resolves (two agents spawning in the
  // same window) share ONE build instead of racing. Without this, the second
  // caller's create-conflict handling deleted the first caller's healthy
  // in-flight build pod — busy days turned into builds serially murdering
  // each other and every agent falling back to the base image.
  const inflight = inflightBuilds.get(image);
  if (inflight) {
    opts.onProgress?.(`⏳ build for ${image} already in flight — waiting on it`);
    return inflight;
  }
  opts.onProgress?.(`🔨 building ${image} from ${spec.context} (kaniko)…`);
  const p = buildImage(image, spec, opts.repoUrl, opts.ref, opts.gitToken)
    .finally(() => inflightBuilds.delete(image));
  inflightBuilds.set(image, p);
  await p;
  opts.onProgress?.(`✓ built + pushed ${image}`);
}

const inflightBuilds = new Map<string, Promise<void>>();

async function buildImage(image: string, spec: BuildSpec, repoUrl: string, ref: string | undefined, gitToken: string): Promise<void> {
  const gitUrl = normalizeGitUrl(repoUrl).replace(/^https:\/\//, "");
  const name = podName(image);
  const cacheRepo = cacheRepoFor(image);
  const args = [
    `--context=git://${gitUrl}${ref ? `#refs/heads/${ref}` : ""}`,
    `--context-sub-path=${spec.context}`,
    `--dockerfile=${spec.dockerfile || "Dockerfile"}`,
    `--destination=${image}`,
    "--cache=true",
    // Snapshotting a large rootfs is the memory hog; don't also hold compressed
    // layers in RAM. Without this, kaniko OOMs on toolchain images (python + onnx).
    "--compressed-caching=false",
    ...(cacheRepo ? [`--cache-repo=${cacheRepo}`] : []),
    ...(spec.target ? [`--target=${spec.target}`] : []),
    ...Object.entries(spec.buildArgs || {}).map(([k, v]) => `--build-arg=${k}=${v}`),
  ];
  const pod: k8s.V1Pod = {
    metadata: { name, namespace: NAMESPACE, labels: { app: "daboss-build" } },
    spec: {
      restartPolicy: "Never",
      ...(BUILD_SA ? { serviceAccountName: BUILD_SA } : {}),
      containers: [{
        name: "kaniko",
        image: KANIKO_IMAGE,
        args,
        // Explicit resources — a namespace LimitRanger otherwise caps this at its
        // default (~512Mi), and kaniko snapshotting a multi-GB toolchain image
        // OOMKills there. Configurable for very large images.
        resources: {
          requests: { cpu: "500m", memory: "2Gi", "ephemeral-storage": "6Gi" },
          limits: { cpu: KANIKO_CPU, memory: KANIKO_MEMORY, "ephemeral-storage": "16Gi" },
        },
        // Kaniko clones the git context using these creds (GitHub PAT / installation token).
        env: [
          { name: "GIT_USERNAME", value: "x-access-token" },
          { name: "GIT_PASSWORD", value: gitToken },
        ],
      }],
    },
  };
  await api().createNamespacedPod({ namespace: NAMESPACE, body: pod }).catch(async (e: unknown) => {
    // Name conflict: a pod for this exact image already exists. ADOPT it if it's
    // alive (another process/restart started it — killing a healthy in-flight
    // build only wastes its progress); replace it only when it's terminal.
    const existing = (await api().readNamespacedPod({ name, namespace: NAMESPACE }).catch(() => null)) as
      | { status?: { phase?: string } }
      | null;
    const phase = existing?.status?.phase;
    if (phase === "Running" || phase === "Pending") {
      logger.info({ pod: name, phase }, "Build pod already in flight — adopting instead of recreating");
      return;
    }
    await api().deleteNamespacedPod({ name, namespace: NAMESPACE }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));
    await api().createNamespacedPod({ namespace: NAMESPACE, body: pod });
    void e;
  });
  try {
    await waitForPod(name, BUILD_TIMEOUT_MS);
  } finally {
    await api().deleteNamespacedPod({ name, namespace: NAMESPACE }).catch(() => {});
  }
}

async function waitForPod(name: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    const pod = (await api().readNamespacedPod({ name, namespace: NAMESPACE })) as { status?: { phase?: string } };
    const phase = pod.status?.phase;
    if (phase === "Succeeded") return;
    if (phase === "Failed") {
      // Capture the failure BEFORE the caller's finally-delete destroys the evidence.
      // A parse error killed agent-image builds for 11 days invisibly because failed
      // pods lived <20s and were deleted on sight — never again.
      const tail = await podLogTail(name, 2000);
      logger.error({ pod: name, log: tail }, "Image build pod failed");
      throw new Error(`image build pod ${name} failed${tail ? `: ${tail.slice(-500)}` : ""}`);
    }
    if (Date.now() - start > timeoutMs) throw new Error(`image build pod ${name} timed out`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/** Last `maxChars` of the pod's log — best-effort, empty string when unreadable. */
async function podLogTail(name: string, maxChars: number): Promise<string> {
  try {
    const log = await api().readNamespacedPodLog({ name, namespace: NAMESPACE });
    return String(log ?? "").slice(-maxChars);
  } catch {
    return "";
  }
}
