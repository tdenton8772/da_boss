/**
 * Self-provisioning agent images.
 *
 * An agent runs in the generic da_boss base by default. If the repo it's about to
 * work on declares `.daboss/agent.Dockerfile` (`FROM ${DABOSS_BASE}` + whatever that
 * repo's agent needs — a python + fastembed stack, graphics libs, …), da_boss builds
 * THAT image once (kaniko), reuses it thereafter, and runs the repo's agents in it.
 *
 * Fully declarative + neutral: da_boss bakes in no toolchain; the repo declares what
 * it needs and the agent assembles itself from that, one time.
 *
 * Two layouts:
 *  - **Split (DABOSS_AGENT_BASE_IMAGE set — GKE).** DABOSS_BASE is da_boss's OS-only
 *    base (node, git, ctags — no da_boss code). The repo's image is just its
 *    TOOLCHAIN, keyed by the base's layer digests + the repo's declaration, so a
 *    da_boss deploy (same OS layers) reuses it. da_boss's own code reaches the pod
 *    as a read-only image volume of WORKER_IMAGE at /app — always exactly the
 *    deployed worker, with no rebuild per deploy.
 *  - **Combined (unset — local kind).** DABOSS_BASE is the full worker image and
 *    the key includes its tag, so every da_boss deploy rebuilds the repo image.
 */
import { createHash } from "node:crypto";
import { getFileContents } from "../forge/github.js";
import { ensureImage, imageLayersKey } from "./image-builder.js";
import { normalizeGitUrl } from "../utils/git.js";
import { logger } from "../utils/logger.js";

export const AGENT_DOCKERFILE = ".daboss/agent.Dockerfile";

/** Extra repo files the Dockerfile folds into the image cache key, declared as
 *  `# daboss-hash-include: path [path…]` comment lines. Lets an image that BAKES
 *  from repo files (dep caches from mix.lock / pyproject.toml) rebuild when those
 *  files change — not just when the Dockerfile itself does. */
export function hashIncludePaths(dockerfile: string): string[] {
  const out: string[] = [];
  for (const m of dockerfile.matchAll(/^#\s*daboss-hash-include:\s*(.+)$/gm)) {
    out.push(...m[1].trim().split(/\s+/).filter(Boolean));
  }
  return [...new Set(out)].slice(0, 20); // bounded; dedup keeps the key stable
}

/** org-repo slug for the agent image name (sanitized, bounded). */
export function repoSlug(repoUrl: string): string {
  const path = normalizeGitUrl(repoUrl).replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "");
  return path.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "repo";
}

/** Content key: hash(base image + the repo's agent Dockerfile [+ build target]).
 *  Changing the da_boss base (a deploy), the repo's declaration, or the requested
 *  stage yields a new key → a rebuild. */
export function configKey(baseImage: string, dockerfile: string, target?: string): string {
  return createHash("sha256").update(`${baseImage}\n${dockerfile}${target ? `\n@${target}` : ""}`).digest("hex").slice(0, 16);
}

/** The agent image ref for a repo's declaration — same registry/project as the
 *  base. `baseIdentity` (default: the base ref) is what the tag is keyed on. */
export function agentImageRef(baseImage: string, repoUrl: string, dockerfile: string, target?: string, baseIdentity = baseImage): string {
  const slash = baseImage.lastIndexOf("/");
  const project = slash > 0 ? baseImage.slice(0, slash) : baseImage; // strip `/da-boss:tag`
  return `${project}/agent-${repoSlug(repoUrl)}:${configKey(baseIdentity, dockerfile, target)}`;
}

/** Where an agent runs: the image, and whether da_boss's /app must be mounted
 *  into it (split layout — the image holds only the repo's toolchain). */
export interface AgentImage {
  image: string;
  mountApp: boolean;
}

/** Resolve the image an agent for this repo should run in. No `.daboss/agent.Dockerfile`
 *  → the generic base. Otherwise build it once (keyed by base + Dockerfile) and reuse.
 *  Best-effort: on any failure, falls back to the base so the agent still runs. */
export async function resolveAgentImage(opts: {
  repoUrl: string;
  ref?: string;
  gitToken: string;
  /** The full worker image (WORKER_IMAGE) — the fallback, and the combined-layout base. */
  baseImage: string;
  /** da_boss's OS-only base (DABOSS_AGENT_BASE_IMAGE). Set → split layout. */
  toolchainBase?: string;
  /** Optional Dockerfile stage (multi-stage target) — lets one repo declare several
   *  toolchain flavors (e.g. `minimal`, `elixir`) and agents pick per-task. */
  target?: string;
  onProgress?: (msg: string) => void;
}): Promise<AgentImage> {
  const fallback: AgentImage = { image: opts.baseImage, mountApp: false };
  try {
    const dockerfile = await getFileContents(opts.repoUrl, AGENT_DOCKERFILE, opts.ref, opts.gitToken).catch(() => null);
    if (!dockerfile?.trim()) return fallback;
    // Fold declared extra files (dep lockfiles the image bakes from) into the
    // cache key so the image rebuilds when THEY change. A missing/unreadable
    // file hashes as empty — stable, and the build itself will surface real
    // problems.
    let keyInput = dockerfile;
    for (const path of hashIncludePaths(dockerfile)) {
      const content = await getFileContents(opts.repoUrl, path, opts.ref, opts.gitToken).catch(() => "");
      keyInput += `\n--- ${path} ---\n${content ?? ""}`;
    }
    // Split layout keys on the OS base's CONTENT (layer digests), not its tag:
    // every deploy pushes a new tag, but unchanged OS layers keep the key — and
    // the toolchain image — the same. Unreadable layers → key on the ref (a
    // rebuild per deploy, the safe direction).
    const base = opts.toolchainBase || opts.baseImage;
    const identity = opts.toolchainBase
      ? `toolchain:${(await imageLayersKey(opts.toolchainBase)) ?? opts.toolchainBase}`
      : opts.baseImage;
    const image = agentImageRef(base, opts.repoUrl, keyInput, opts.target, identity);
    await ensureImage(
      image,
      { context: ".", dockerfile: AGENT_DOCKERFILE, target: opts.target, buildArgs: { DABOSS_BASE: base } },
      { repoUrl: opts.repoUrl, ref: opts.ref, gitToken: opts.gitToken, onProgress: opts.onProgress }
    );
    return { image, mountApp: !!opts.toolchainBase };
  } catch (err) {
    logger.warn({ repoUrl: opts.repoUrl, err: err instanceof Error ? err.message : String(err) }, "Agent image resolve failed — falling back to the base image");
    return fallback;
  }
}
