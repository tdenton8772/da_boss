/**
 * Git URL helpers + credentialed remote operations, shared by the pod worker
 * (clone/push) and the boss (branch cleanup on delete). Kept dependency-light so
 * either process can use it.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Normalize an SSH git URL to HTTPS so token auth applies (there's no SSH key
 *  in the pod). Passes through https and local paths unchanged. */
export function normalizeGitUrl(url: string): string {
  // git@github.com:org/repo.git → https://github.com/org/repo.git
  const scp = url.match(/^[^@]+@([^:]+):(.+)$/);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  // ssh://git@github.com/org/repo.git → https://github.com/org/repo.git
  const ssh = url.match(/^ssh:\/\/[^@]+@([^/]+)\/(.+)$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return url;
}

/** Normalize to HTTPS, then embed a token for private clone/push/delete. Local
 *  paths (shard mirror) aren't URLs and pass through unchanged. */
export function authedUrl(src: string, token: string): string {
  const url = normalizeGitUrl(src);
  if (!token) return url;
  try {
    const u = new URL(url);
    if (u.protocol === "https:") {
      u.username = "x-access-token";
      u.password = token;
      return u.toString();
    }
  } catch {
    /* not a URL (local mirror path) */
  }
  return url;
}

/** Delete a branch on the remote with no working tree — a bare credentialed
 *  push. Throws with git's stderr on failure so callers can log it. */
export async function deleteRemoteBranch(repoUrl: string, branch: string, token: string): Promise<void> {
  await execFileAsync("git", ["push", authedUrl(repoUrl, token), "--delete", branch], {
    timeout: 60_000,
  });
}
