/**
 * Pre-build repo agent images before anyone needs them.
 *
 * A repo's toolchain image (agent-image.ts) is built the first time an agent for
 * that repo dispatches — so the first agent after a change waits out the build
 * (~10 min for a toolchain like Odyssey's). Two kinds of change make a new image:
 *  - da_boss's OS base moved (a deploy that touched the Dockerfile `os` stage);
 *  - the repo's declaration moved (its agent.Dockerfile, or a lockfile it bakes).
 * So we build eagerly at both moments: on boss startup (every deploy) and when the
 * main watcher sees a repo's main move. Building an image that already exists is
 * a registry HEAD and nothing more, and the build itself is single-flight with
 * real dispatches (same process), so an agent arriving mid-build just joins it.
 */
import * as queries from "../db/queries.js";
import { getCipher } from "../crypto/cipher.js";
import { config } from "../config.js";
import { resolveAgentImage } from "./agent-image.js";
import { logger } from "../utils/logger.js";

/** Ensure one repo's toolchain image exists, using `userId`'s git token (someone
 *  who has run agents in it, so the token can read it). Never throws. */
export async function prewarmRepoImage(repoUrl: string, userId: string): Promise<void> {
  if (!config.agentBaseImage || config.agentExecution !== "pod") return; // combined layout rebuilds per deploy anyway
  try {
    const cred = await queries.getUserGitCredential(userId);
    if (!cred) return;
    const gitToken = await getCipher().decrypt({ ciphertext: cred.ciphertext, nonce: cred.nonce, keyRef: cred.key_ref });
    const t0 = Date.now();
    const { image, mountApp } = await resolveAgentImage({
      repoUrl,
      gitToken,
      baseImage: config.workerImage,
      toolchainBase: config.agentBaseImage,
      onProgress: (msg) => logger.info({ repoUrl, msg }, "Agent image pre-build"),
    });
    if (mountApp) logger.info({ repoUrl, image, seconds: Math.round((Date.now() - t0) / 1000) }, "Agent image ready");
  } catch (err) {
    logger.warn({ repoUrl, err: err instanceof Error ? err.message : String(err) }, "Agent image pre-build failed — the next dispatch will build it");
  }
}

/** Pre-build every active repo's toolchain image, one at a time (each build is a
 *  4-CPU kaniko pod; repos rarely change together). Never throws. */
export async function prewarmAllRepoImages(): Promise<void> {
  if (!config.agentBaseImage || config.agentExecution !== "pod") return;
  const repos = await queries.getWatchedRepos().catch(() => []);
  for (const { repo_url, user_id } of repos) await prewarmRepoImage(repo_url, user_id);
}
