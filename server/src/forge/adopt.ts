/**
 * Adopting an existing PR or branch — shared by the UI (GET /api/forge/resolve-ref
 * + POST /api/agents) and MCP (create_agent `adopt`, adopt_change). Adoption is a
 * branch override on the agent record (agents.branch = the adopted head) plus an
 * `adopted_ref`; this module resolves what the caller typed into that head branch
 * and validates it against the remote.
 */
import * as queries from "../db/queries.js";
import { getCipher } from "../crypto/cipher.js";
import { getPullRequest, getBranchHead, resolveOpenPrByBranch } from "./github.js";

export class AdoptError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface ResolvedAdoptRef {
  kind: "pr" | "branch";
  branch: string;
  adoptedRef: string;
  prNumber?: number;
  prState?: string;
  prUrl?: string;
  prTitle?: string;
  /** The branch the PR targets (PR adoption only). */
  prBase?: string;
  /** Head lives on a fork — untrusted, and da_boss can't push to it. */
  fork: boolean;
  headRepo?: string;
}

/** A user's decrypted git token, or an AdoptError saying how to fix it. */
export async function userGitToken(userId: string): Promise<string> {
  const gc = await queries.getUserGitCredential(userId);
  if (!gc) throw new AdoptError(400, "Set a git credential first (Settings) so we can look up the branch/PR.");
  try {
    return await getCipher().decrypt({ ciphertext: gc.ciphertext, nonce: gc.nonce, keyRef: gc.key_ref });
  } catch {
    throw new AdoptError(400, "Could not decrypt your git credential.");
  }
}

/** Resolve a branch name, a PR number (`17` / `#17`), or a PR URL into the head
 *  branch to adopt. Throws AdoptError (404 not found, 400 closed PR, 502 forge). */
export async function resolveAdoptRef(repoUrl: string, ref: string, token: string): Promise<ResolvedAdoptRef> {
  ref = ref.trim();
  const urlMatch = ref.match(/\/pull\/(\d+)/);
  const numMatch = ref.match(/^#?(\d+)$/);
  const prNumber = urlMatch ? Number(urlMatch[1]) : numMatch ? Number(numMatch[1]) : null;
  try {
    if (prNumber !== null) {
      const pr = await getPullRequest(repoUrl, prNumber, token);
      if (!pr) throw new AdoptError(404, `PR #${prNumber} not found in ${repoUrl}.`);
      if (pr.state !== "open") throw new AdoptError(400, `PR #${prNumber} is ${pr.state}, not open — can't adopt a closed/merged PR.`);
      return {
        kind: "pr", branch: pr.head, adoptedRef: `PR #${pr.number}`,
        prNumber: pr.number, prState: pr.state, prUrl: pr.url, prTitle: pr.title, prBase: pr.base || undefined,
        fork: pr.crossRepo, headRepo: pr.headRepo,
      };
    }
    const head = await getBranchHead(repoUrl, ref, token);
    if (!head) throw new AdoptError(404, `Branch '${ref}' not found on the remote — push it first.`);
    return { kind: "branch", branch: ref, adoptedRef: ref, fork: false };
  } catch (err) {
    if (err instanceof AdoptError) throw err;
    throw new AdoptError(502, `Forge lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Adopted PRs/branches are recorded with an `adopted_ref` but NO `pr_number`
 *  (adoption never opens a PR, so it was never set) — which broke Merge, the deploy
 *  proposal, and the sync-main fast path for any adopted change. Resolve the OPEN PR
 *  by head branch and persist it, so those all work. Best-effort; returns the
 *  resolved {number,url}, the already-set PR, or null when there's no open PR. */
export async function ensureAdoptedPrNumber(agent: {
  id: string; pr_number: number | null; pr_url: string | null;
  repo_url: string | null; branch: string | null; created_by_user_id: string | null;
}): Promise<{ number: number; url: string } | null> {
  if (agent.pr_number) return { number: agent.pr_number, url: agent.pr_url || "" };
  if (!agent.repo_url || !agent.branch || !agent.created_by_user_id) return null;
  const gc = await queries.getUserGitCredential(agent.created_by_user_id);
  if (!gc) return null;
  const token = await getCipher().decrypt({ ciphertext: gc.ciphertext, nonce: gc.nonce, keyRef: gc.key_ref });
  const pr = await resolveOpenPrByBranch(agent.repo_url, agent.branch, token);
  if (pr) await queries.setAgentPullRequest(agent.id, pr.url, pr.number);
  return pr;
}
