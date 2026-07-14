/**
 * Deterministic land-conflict test scaffolding. A real merge conflict at land
 * time needs BOTH the PR branch and main to change the SAME line differently —
 * you can't rely on a real agent's (nondeterministic) edit location to collide
 * with main. So we script both sides via the forge API:
 *
 *   1. branch off main, change the `return a + b` line one way    (the "agent")
 *   2. open a PR for that branch
 *   3. change the SAME line on main another way                   (main moved)
 *
 * updateBranch (the land gate's rebase step) then must report a conflict. We also
 * wire a real agent row to the branch/PR so the conflict is testable through the
 * actual UI: open the agent → verdict card → Merge → 409 "resolve via Request
 * changes". Domain-neutral product code never imports this; it's test-only.
 */
import { nanoid } from "nanoid";
import {
  getFileMeta,
  getBranchHead,
  createBranch,
  putFile,
  ensurePullRequest,
  updateBranch,
} from "../forge/github.js";

const FILE = "calc.py";
const PRIOR_MARK = /\s*# daboss-(?:branch|main)-\w+$/;

export interface ArmedConflict {
  branch: string;
  prNumber: number;
  prUrl: string;
  conflict: boolean;
}

/**
 * Arm a guaranteed land conflict on `branch` vs `base` of `repoUrl`. Returns the
 * PR + whether updateBranch confirmed the conflict. Throws on setup failure
 * (missing file, forge rejection). `branch` must not already exist on the remote.
 */
export async function armLandConflict(repoUrl: string, base: string, branch: string, token: string): Promise<ArmedConflict> {
  const meta = await getFileMeta(repoUrl, FILE, base, token);
  if (!meta) throw new Error(`Can't read ${FILE} on ${base} — check the fixture + credential.`);

  // Collide on the last non-empty line (any file, any content). Both sides replace
  // the SAME line with DIFFERENT text → a guaranteed 3-way merge conflict. Strip a
  // prior run's marker first so the line doesn't grow across runs.
  const lines = meta.content.split("\n");
  let idx = lines.length - 1;
  while (idx > 0 && lines[idx].trim() === "") idx--;
  const cleanLine = lines[idx].replace(PRIOR_MARK, "");

  const tag = nanoid(6);
  const render = (side: "branch" | "main") => {
    const out = [...lines];
    out[idx] = `${cleanLine}  # daboss-${side}-${tag}`;
    return out.join("\n");
  };
  const branchContent = render("branch");
  const mainContent = render("main");

  const headSha = await getBranchHead(repoUrl, base, token);
  if (!headSha) throw new Error(`Can't resolve head of ${base}.`);
  if (!(await createBranch(repoUrl, branch, headSha, token))) throw new Error(`Couldn't create branch ${branch}.`);

  // branch-side edit (uses the base blob sha), then open the PR
  if (!(await putFile(repoUrl, FILE, branchContent, branch, `landtest: branch-side edit ${tag}`, meta.sha, token))) {
    throw new Error("Couldn't commit the branch-side edit.");
  }
  const pr = await ensurePullRequest({
    repoUrl, token, branch, base,
    title: `[land-conflict test ${tag}] diverge on ${FILE}`,
    body: "Automated land-gate conflict fixture. Clicking Merge should be blocked by a rebase conflict.",
    draft: true,
  });
  if (!pr) throw new Error("Couldn't open the PR for the conflict branch.");

  // main-side edit on the SAME line (base blob sha is still valid on main) → diverge
  if (!(await putFile(repoUrl, FILE, mainContent, base, `landtest: main-side edit ${tag}`, meta.sha, token))) {
    throw new Error("Couldn't commit the main-side edit.");
  }

  const upd = await updateBranch(repoUrl, pr.number, token);
  return { branch, prNumber: pr.number, prUrl: pr.url, conflict: upd.conflict };
}
