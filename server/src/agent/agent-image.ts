/**
 * Self-provisioning agent images.
 *
 * An agent runs in the generic da_boss base by default. If the repo it's about to
 * work on declares `.daboss/agent.Dockerfile` (`FROM ${DABOSS_BASE}` + whatever that
 * repo's agent needs — a python + fastembed stack, graphics libs, …), da_boss builds
 * THAT image once (kaniko), reuses it thereafter, and runs the repo's agents in it.
 *
 * Fully declarative + neutral: da_boss bakes in no toolchain; the repo declares what
 * it needs and the agent assembles itself from that, one time. Content-addressed:
 * the tag is a hash of the base image + the repo's Dockerfile, so the image rebuilds
 * when EITHER da_boss's worker base or the repo's declaration changes — never running
 * stale worker code — and is reused otherwise (kaniko's layer cache keeps the
 * toolchain install a one-time cost).
 */
import { createHash } from "node:crypto";
import { getFileContents } from "../forge/github.js";
import { ensureImage } from "./image-builder.js";
import { normalizeGitUrl } from "../utils/git.js";
import { logger } from "../utils/logger.js";

export const AGENT_DOCKERFILE = ".daboss/agent.Dockerfile";

/** org-repo slug for the agent image name (sanitized, bounded). */
export function repoSlug(repoUrl: string): string {
  const path = normalizeGitUrl(repoUrl).replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "");
  return path.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "repo";
}

/** Content key: hash(base image + the repo's agent Dockerfile). Changing either the
 *  da_boss base (a deploy) or the repo's declaration yields a new key → a rebuild. */
export function configKey(baseImage: string, dockerfile: string): string {
  return createHash("sha256").update(`${baseImage}\n${dockerfile}`).digest("hex").slice(0, 16);
}

/** The agent image ref for a repo's declaration — same registry/project as the base. */
export function agentImageRef(baseImage: string, repoUrl: string, dockerfile: string): string {
  const slash = baseImage.lastIndexOf("/");
  const project = slash > 0 ? baseImage.slice(0, slash) : baseImage; // strip `/da-boss:tag`
  return `${project}/agent-${repoSlug(repoUrl)}:${configKey(baseImage, dockerfile)}`;
}

/** Resolve the image an agent for this repo should run in. No `.daboss/agent.Dockerfile`
 *  → the generic base. Otherwise build it once (keyed by base + Dockerfile) and reuse.
 *  Best-effort: on any failure, falls back to the base so the agent still runs. */
export async function resolveAgentImage(opts: {
  repoUrl: string;
  ref?: string;
  gitToken: string;
  baseImage: string;
  onProgress?: (msg: string) => void;
}): Promise<string> {
  try {
    const dockerfile = await getFileContents(opts.repoUrl, AGENT_DOCKERFILE, opts.ref, opts.gitToken).catch(() => null);
    if (!dockerfile?.trim()) return opts.baseImage;
    const image = agentImageRef(opts.baseImage, opts.repoUrl, dockerfile);
    await ensureImage(
      image,
      { context: ".", dockerfile: AGENT_DOCKERFILE, buildArgs: { DABOSS_BASE: opts.baseImage } },
      { repoUrl: opts.repoUrl, ref: opts.ref, gitToken: opts.gitToken, onProgress: opts.onProgress }
    );
    return image;
  } catch (err) {
    logger.warn({ repoUrl: opts.repoUrl, err: err instanceof Error ? err.message : String(err) }, "Agent image resolve failed — falling back to the base image");
    return opts.baseImage;
  }
}
