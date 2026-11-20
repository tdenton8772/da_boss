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
 *  - `DABOSS_KANIKO_IMAGE` — kaniko executor image. Default: the last upstream release,
 *    pinned by digest (the upstream project is archived; point this at a maintained
 *    build or fork you trust).
 *  - `DABOSS_REGISTRY_SECRET` — a dockerconfigjson Secret: kaniko pulls bases and pushes
 *    with it, and the existence check authenticates with it (see pod-spec.ts).
 *  - existence check auth is best-effort; when it can't tell, we BUILD (safe).
 */
import { createHash } from "node:crypto";
import * as k8s from "@kubernetes/client-node";
import type { ImageBuild } from "../pipeline/config.js";
import { normalizeGitUrl } from "../utils/git.js";
import { logger } from "../utils/logger.js";
import { podDefaults, workloadPodSpec } from "./pod-spec.js";

const NAMESPACE = process.env.POD_NAMESPACE || "daboss";
// v1.24.0, the final upstream release (multi-arch index digest). Never a moving tag:
// the executor runs with the registry push credential.
export const DEFAULT_KANIKO_IMAGE =
  "gcr.io/kaniko-project/executor:v1.24.0@sha256:4e7a52dd1f14872430652bb3b027405b8dfd17c4538751c620ac005741ef9698";
const KANIKO_IMAGE = process.env.DABOSS_KANIKO_IMAGE || DEFAULT_KANIKO_IMAGE;
const BUILD_SA = process.env.DABOSS_BUILD_SERVICE_ACCOUNT || "";
const KANIKO_MEMORY = process.env.DABOSS_KANIKO_MEMORY || "4Gi";
// Dep-baking images (warm mix/pip caches) legitimately take 30-40 min to build
// and want real CPU — both configurable, with defaults sized for them.
const KANIKO_CPU = process.env.DABOSS_KANIKO_CPU || "4";
const BUILD_TIMEOUT_MS = Number(process.env.DABOSS_BUILD_TIMEOUT_MS) || 45 * 60 * 1000;
// The registry existence check must never outlive the phase waiting on it. An
// unbounded HEAD left the manifest probe hanging and the pipeline run sat at
// `pending` forever — no pod, no error, no log (2026-09-23: it stalled PR #145's
// land gate indefinitely). On timeout we fall through to "can't tell" → BUILD,
// which is the safe direction.
const REGISTRY_CHECK_TIMEOUT_MS = Number(process.env.DABOSS_REGISTRY_CHECK_TIMEOUT_MS) || 15 * 1000;

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

const MANIFEST_ACCEPT = "application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.index.v1+json";

/** True if `ref`'s tag already exists. Best-effort Docker Registry v2 manifest
 *  check, authenticated with the ambient cloud token (GKE workload identity) or the
 *  `DABOSS_REGISTRY_SECRET` credentials. Returns false when it can't tell — so we
 *  build rather than skip (safe). */
export async function imageExists(ref: string): Promise<boolean> {
  const { registry, repository, tag } = parseImageRef(ref);
  if (!registry) return false;
  try {
    const res = await registryFetch(registry, repository, tag, "HEAD");
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    logger.warn({ ref, status: res.status }, "Image existence check inconclusive — will build");
    return false;
  } catch (err) {
    logger.warn({ ref, err: err instanceof Error ? err.message : String(err) }, "Image existence check failed — will build");
    return false;
  }
}

// ── Registry auth ─────────────────────────────────────────────────────────────

export interface RegistryCredential { username: string; password: string }

/** Docker Hub is addressed as docker.io in refs but served from registry-1.docker.io. */
export function registryApiHost(registry: string): string {
  return registry === "docker.io" || registry === "index.docker.io" ? "registry-1.docker.io" : registry;
}

/** The `auths` of a dockerconfigjson, as host → credential (`auth` = base64 user:pass,
 *  or explicit username/password). Keys are normalized to bare hosts. */
export function parseDockerConfig(json: string): Record<string, RegistryCredential> {
  const out: Record<string, RegistryCredential> = {};
  let cfg: { auths?: Record<string, { auth?: string; username?: string; password?: string }> };
  try { cfg = JSON.parse(json); } catch { return out; }
  for (const [key, a] of Object.entries(cfg.auths || {})) {
    let username = a.username || "", password = a.password || "";
    if (a.auth && !(username && password)) {
      const dec = Buffer.from(a.auth, "base64").toString("utf8");
      const i = dec.indexOf(":");
      if (i > 0) { username = dec.slice(0, i); password = dec.slice(i + 1); }
    }
    if (!username || !password) continue;
    const host = key.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    out[host] = { username, password };
  }
  return out;
}

/** The credential for `registry` from parsed auths (Docker Hub's aliases are one registry). */
export function credentialFor(auths: Record<string, RegistryCredential>, registry: string): RegistryCredential | null {
  const hub = ["docker.io", "index.docker.io", "registry-1.docker.io"];
  const names = hub.includes(registry) ? hub : [registry];
  for (const n of names) if (auths[n]) return auths[n];
  return null;
}

/** `WWW-Authenticate: Bearer realm="…",service="…",scope="…"` → scheme + params. */
export function parseWwwAuthenticate(header: string | null): { scheme: string; params: Record<string, string> } | null {
  if (!header) return null;
  const m = /^\s*(\w+)\s*(.*)$/.exec(header);
  if (!m) return null;
  const params: Record<string, string> = {};
  for (const p of m[2].matchAll(/(\w+)="([^"]*)"/g)) params[p[1].toLowerCase()] = p[2];
  return { scheme: m[1].toLowerCase(), params };
}

const CRED_CACHE_MS = 5 * 60 * 1000;
let credCache: { at: number; secret: string; auths: Record<string, RegistryCredential> } | null = null;

/** Credentials from the DABOSS_REGISTRY_SECRET Secret (read via the API, cached briefly). */
async function registryCredential(registry: string): Promise<RegistryCredential | null> {
  const { registrySecret } = podDefaults();
  if (!registrySecret) return null;
  if (!credCache || credCache.secret !== registrySecret || Date.now() - credCache.at > CRED_CACHE_MS) {
    try {
      const sec = await api().readNamespacedSecret({ name: registrySecret, namespace: NAMESPACE }) as { data?: Record<string, string> };
      const raw = sec.data?.[".dockerconfigjson"];
      credCache = { at: Date.now(), secret: registrySecret, auths: raw ? parseDockerConfig(Buffer.from(raw, "base64").toString("utf8")) : {} };
    } catch (err) {
      logger.warn({ secret: registrySecret, err: err instanceof Error ? err.message : String(err) }, "Couldn't read the registry secret — registry checks run anonymously");
      credCache = { at: Date.now(), secret: registrySecret, auths: {} };
    }
  }
  return credentialFor(credCache.auths, registry);
}

/** GET/HEAD a manifest: with the ambient cloud token if there is one, else anonymously,
 *  answering a 401 challenge with the registry secret's credentials (Basic, or the
 *  Bearer token exchange that Docker Hub, GHCR and most registries use). */
async function registryFetch(registry: string, repository: string, reference: string, method: "GET" | "HEAD"): Promise<Response> {
  const url = `https://${registryApiHost(registry)}/v2/${repository}/manifests/${encodeURIComponent(reference)}`;
  const go = (auth?: string) => fetch(url, {
    method,
    headers: { Accept: MANIFEST_ACCEPT, ...(auth ? { Authorization: auth } : {}) },
    signal: AbortSignal.timeout(REGISTRY_CHECK_TIMEOUT_MS),
  });
  // The ambient cloud token only goes to that cloud's own registries: the image ref
  // comes from a repo's pipeline.yaml, and any other host must never receive it.
  const cloud = isGoogleRegistry(registry) ? await gcpAccessToken() : null;
  if (cloud) return go(`Bearer ${cloud}`);
  const res = await go();
  if (res.status !== 401) return res;
  const cred = await registryCredential(registry);
  if (!cred) return res;
  const basic = `Basic ${Buffer.from(`${cred.username}:${cred.password}`).toString("base64")}`;
  const challenge = parseWwwAuthenticate(res.headers.get("www-authenticate"));
  if (challenge?.scheme === "bearer" && challenge.params.realm) {
    const q = new URLSearchParams();
    if (challenge.params.service) q.set("service", challenge.params.service);
    q.set("scope", challenge.params.scope || `repository:${repository}:pull`);
    const tr = await fetch(`${challenge.params.realm}?${q}`, { headers: { Authorization: basic }, signal: AbortSignal.timeout(REGISTRY_CHECK_TIMEOUT_MS) });
    if (!tr.ok) return res;
    const body = (await tr.json()) as { token?: string; access_token?: string };
    const token = body.token || body.access_token;
    return token ? go(`Bearer ${token}`) : res;
  }
  return go(basic);
}

/** One entry of an image index (multi-platform list, or buildx's image + attestation). */
export interface IndexEntry {
  digest: string;
  platform?: { os?: string; architecture?: string };
  annotations?: Record<string, string>;
}

/** The image manifest to read from an index: linux/amd64 (the cluster's nodes),
 *  else the first real image entry. Attestation entries (buildx provenance) are
 *  skipped — they carry platform unknown/unknown. */
export function pickPlatformManifest(entries: IndexEntry[]): IndexEntry | undefined {
  const images = entries.filter((e) =>
    e.annotations?.["vnd.docker.reference.type"] !== "attestation-manifest" && e.platform?.os !== "unknown");
  return images.find((e) => e.platform?.os === "linux" && e.platform?.architecture === "amd64") ?? images[0];
}

/** A short content identity for an image's filesystem: a hash over its layer
 *  digests. Two pushes of the same (cached) layers share it even though their
 *  config timestamps — and so their manifest digests — differ. */
export function layersKey(layerDigests: string[]): string {
  return createHash("sha256").update(layerDigests.join("\n")).digest("hex").slice(0, 16);
}

/** layersKey() of a registry image, or null when its manifest can't be read (no
 *  registry, auth, timeout) — callers fall back to keying on the ref itself. */
export async function imageLayersKey(ref: string): Promise<string | null> {
  const { registry, repository, tag } = parseImageRef(ref);
  if (!registry) return null;
  try {
    const get = async (reference: string) => {
      const res = await registryFetch(registry, repository, reference, "GET");
      if (!res.ok) throw new Error(`manifest ${reference}: HTTP ${res.status}`);
      return (await res.json()) as { manifests?: IndexEntry[]; layers?: Array<{ digest: string }> };
    };
    let manifest = await get(tag);
    if (manifest.manifests) {
      const entry = pickPlatformManifest(manifest.manifests);
      if (!entry) return null;
      manifest = await get(entry.digest);
    }
    return manifest.layers?.length ? layersKey(manifest.layers.map((l) => l.digest)) : null;
  } catch (err) {
    logger.warn({ ref, err: err instanceof Error ? err.message : String(err) }, "Couldn't read image layers — keying on the ref instead");
    return null;
  }
}

/** Artifact Registry / Container Registry hosts — the only ones a GCP token is for. */
export function isGoogleRegistry(registry: string): boolean {
  return /(^|\.)gcr\.io$/.test(registry) || /-docker\.pkg\.dev$/.test(registry);
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
  const { registrySecret } = podDefaults();
  const gitSecret = `${name}-git`;
  await upsertGitSecret(gitSecret, gitToken);
  const pod: k8s.V1Pod = {
    metadata: { name, namespace: NAMESPACE, labels: { app: "daboss-build" } },
    spec: {
      restartPolicy: "Never",
      // BUILD_SA is for registry identity (e.g. cloud workload identity), never the
      // k8s API: the build runs the repo's Dockerfile RUN steps, so no token.
      ...workloadPodSpec({ serviceAccount: BUILD_SA || undefined, apiToken: false }),
      ...(registrySecret
        ? { volumes: [{ name: "registry-auth", secret: { secretName: registrySecret, items: [{ key: ".dockerconfigjson", path: "config.json" }] } }] }
        : {}),
      containers: [{
        name: "kaniko",
        image: KANIKO_IMAGE,
        args,
        // kaniko reads /kaniko/.docker/config.json for pulls (private bases) and the push.
        ...(registrySecret ? { volumeMounts: [{ name: "registry-auth", mountPath: "/kaniko/.docker", readOnly: true }] } : {}),
        // Explicit resources — a namespace LimitRanger otherwise caps this at its
        // default (~512Mi), and kaniko snapshotting a multi-GB toolchain image
        // OOMKills there. Configurable for very large images.
        resources: {
          requests: { cpu: "500m", memory: "2Gi", "ephemeral-storage": "6Gi" },
          limits: { cpu: KANIKO_CPU, memory: KANIKO_MEMORY, "ephemeral-storage": "16Gi" },
        },
        // Kaniko clones the git context using these creds (GitHub PAT / installation
        // token) — from the per-build Secret, never a literal in the pod spec (anyone
        // who can read pods would otherwise read the token).
        env: [
          { name: "GIT_USERNAME", value: "x-access-token" },
          { name: "GIT_PASSWORD", valueFrom: { secretKeyRef: { name: gitSecret, key: "GIT_PASSWORD" } } },
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
    await api().createNamespacedPod({ namespace: NAMESPACE, body: pod }).catch(async (err2: unknown) => {
      await api().deleteNamespacedSecret({ name: gitSecret, namespace: NAMESPACE }).catch(() => {});
      throw err2;
    });
    void e;
  });
  try {
    await waitForPod(name, BUILD_TIMEOUT_MS);
  } finally {
    await api().deleteNamespacedPod({ name, namespace: NAMESPACE }).catch(() => {});
    await api().deleteNamespacedSecret({ name: gitSecret, namespace: NAMESPACE }).catch(() => {});
  }
}

/** The build's git credential as its own short-lived Secret (deleted with the pod). */
async function upsertGitSecret(name: string, gitToken: string): Promise<void> {
  const body: k8s.V1Secret = {
    metadata: { name, namespace: NAMESPACE, labels: { app: "daboss-build" } },
    type: "Opaque",
    stringData: { GIT_PASSWORD: gitToken },
  };
  try {
    await api().createNamespacedSecret({ namespace: NAMESPACE, body });
  } catch (err: unknown) {
    const e = err as { code?: number; statusCode?: number };
    if (e.code !== 409 && e.statusCode !== 409) throw err;
    await api().replaceNamespacedSecret({ name, namespace: NAMESPACE, body });
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
