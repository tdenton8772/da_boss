/**
 * Bring the base branch (main) INTO an agent's feature branch — for a branch cut
 * from an older main that has since diverged. Shared by the REST endpoint and the
 * MCP tool so both take the exact same path.
 *
 * Two outcomes:
 *  • Clean fast-merge AND the branch has a PR → GitHub merges base→head server-side
 *    (updateBranch — a merge commit, NOT a rebase, so the branch history the agent
 *    has checked out is never rewritten / force-pushed). The agent picks it up on
 *    its next resume ({clean:true}).
 *  • Conflicts, or no PR yet → hand it to the agent: it merges origin/<base>
 *    locally, resolves conflicts with its knowledge of the code, and stops; da_boss
 *    pushes the branch on turn-end exactly as after any normal turn ({dispatched:true}).
 *    This is the common case for a truly diverged branch.
 */
import * as queries from "../db/queries.js";
import { getCipher } from "../crypto/cipher.js";
import { updateBranch } from "./github.js";
import type { AgentManager } from "../agent/manager.js";
import type { AgentRecord } from "../types/agent.js";

/** The turn we hand the agent when the base must be merged locally (conflicts, or no
 *  PR to do it server-side). It merges origin/<base>, resolves conflicts, and STOPS —
 *  da_boss pushes the branch, exactly as it does after any normal turn. */
export function syncMainPrompt(baseRef: string): string {
  return [
    `Your branch was created from an older \`${baseRef}\` and the two have since diverged. Bring the latest \`${baseRef}\` into this branch and resolve any conflicts.`,
    "",
    `1. Fetch the latest base:      git fetch origin ${baseRef}`,
    `2. Merge it into your branch:  git merge origin/${baseRef}`,
    "3. If git reports conflicts, resolve them PROPERLY — keep BOTH your feature work AND the incoming changes from the base. Read each conflict and understand it; do not blindly pick one side. Then finish the merge:  git add -A && git commit --no-edit",
    "4. If it merges cleanly (no conflicts), the merge commit is already made — nothing more to do for the merge itself.",
    "5. Sanity-check that the merged tree still builds/compiles if you have the tools for it (e.g. `mix compile`), and fix anything the merge broke.",
    "6. Then STOP. Do NOT `git push` and do NOT touch the PR — da_boss pushes your branch automatically when you finish.",
  ].join("\n");
}

/** Merge the base branch into the agent's feature branch. Returns which path ran +
 *  the resolved base ref (for the caller's user-facing message). Throws {status,message}. */
export async function syncMainIntoBranch(
  manager: AgentManager,
  agent: AgentRecord
): Promise<{ clean: boolean; dispatched: boolean; baseRef: string }> {
  if (!agent.repo_url || !agent.branch || !agent.created_by_user_id) {
    throw { status: 400, message: "Agent has no repo/branch to sync" };
  }
  const baseRef = agent.repo_ref || "main";
  // Fast path: a clean server-side merge of base→branch (needs an open PR).
  if (agent.pr_number) {
    const gc = await queries.getUserGitCredential(agent.created_by_user_id);
    if (!gc) throw { status: 400, message: "Owner has no git credential" };
    const token = await getCipher().decrypt({ ciphertext: gc.ciphertext, nonce: gc.nonce, keyRef: gc.key_ref });
    const upd = await updateBranch(agent.repo_url, agent.pr_number, token);
    if (upd.ok) return { clean: true, dispatched: false, baseRef };
    if (!upd.conflict) throw { status: 400, message: `Couldn't merge ${baseRef} into the branch: ${upd.message}` };
    // Conflict → fall through to the agent-resolve path.
  }
  // Conflicts, or no PR yet: the agent merges + resolves locally, then da_boss pushes.
  await manager.sendInput(agent.id, syncMainPrompt(baseRef));
  return { clean: false, dispatched: true, baseRef };
}
