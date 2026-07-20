/**
 * Forge adapter (GitHub) — opens/finds the pull request for an agent's branch.
 * This is the ONLY place GitHub/PR vocabulary lives (the dev_delta_materialization
 * seam); a GitLab/Bitbucket adapter would implement the same ensurePullRequest
 * shape. Uses the REST API over fetch — no `gh` binary needed in the image.
 */
import { normalizeGitUrl } from "../utils/git.js";

const API = "https://api.github.com";

export interface PullRequestParams {
  repoUrl: string;
  token: string;
  branch: string;
  base?: string; // defaults to the repo's default branch
  title: string;
  body: string;
  draft?: boolean;
}

export interface PullRequestResult {
  url: string;
  number: number;
  created: boolean; // false = already existed (idempotent re-run)
}

/** A capped diff summary between two refs (base...head), for the reviewer. */
export async function getDiffSummary(
  repoUrl: string,
  base: string,
  head: string,
  token: string,
  maxChars = 40_000
): Promise<string | null> {
  const gh = parseRepo(repoUrl);
  if (!gh) return null;
  const res = await ghFetch(`${API}/repos/${gh.owner}/${gh.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, token);
  if (!res.ok) return null;
  const body = (await res.json()) as {
    files?: Array<{ filename: string; status: string; additions: number; deletions: number; patch?: string }>;
  };
  const files = body.files || [];
  const header = files.map((f) => `${f.status} ${f.filename} (+${f.additions}/-${f.deletions})`).join("\n");
  let out = `Files changed (${files.length}):\n${header}\n\n`;
  for (const f of files) {
    if (!f.patch) continue;
    const next = `--- ${f.filename} ---\n${f.patch}\n\n`;
    if (out.length + next.length > maxChars) { out += "…(diff truncated)"; break; }
    out += next;
  }
  return out;
}

/** Merge a PR (squash). Returns whether it merged + any message. */
export async function mergePr(repoUrl: string, prNumber: number, token: string): Promise<{ merged: boolean; message?: string }> {
  const gh = parseRepo(repoUrl);
  if (!gh) return { merged: false, message: "unsupported host" };
  const res = await ghFetch(`${API}/repos/${gh.owner}/${gh.repo}/pulls/${prNumber}/merge`, token, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ merge_method: "squash" }),
  });
  if (res.ok) return { merged: true };
  return { merged: false, message: `${res.status}: ${(await res.text()).slice(0, 200)}` };
}

/**
 * Update a PR branch with its base (GitHub merges base→head server-side). The
 * land gate's "rebase on main" step. Returns:
 *  - {ok:true}                  branch updated (or already current)
 *  - {ok:false, conflict:true}  base can't be auto-merged → the agent must resolve
 *  - {ok:false, conflict:false} some other failure (message set)
 */
export async function updateBranch(
  repoUrl: string,
  prNumber: number,
  token: string
): Promise<{ ok: boolean; conflict: boolean; message?: string }> {
  const gh = parseRepo(repoUrl);
  if (!gh) return { ok: false, conflict: false, message: "unsupported host" };
  const res = await ghFetch(`${API}/repos/${gh.owner}/${gh.repo}/pulls/${prNumber}/update-branch`, token, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (res.ok) return { ok: true, conflict: false }; // 202 accepted
  const text = await res.text();
  // 422 "merge conflict" → real conflict; 422 "up to date"/"not ahead" → no-op, fine.
  if (res.status === 422) {
    if (/conflict|cannot be (?:auto|automatically) merged/i.test(text)) return { ok: false, conflict: true, message: text.slice(0, 200) };
    return { ok: true, conflict: false, message: "already current" };
  }
  return { ok: false, conflict: false, message: `${res.status}: ${text.slice(0, 200)}` };
}

/** Post a comment on a PR (issues endpoint — PRs are issues). Best-effort. */
export async function postPrComment(repoUrl: string, prNumber: number, body: string, token: string): Promise<void> {
  const gh = parseRepo(repoUrl);
  if (!gh) return;
  await ghFetch(`${API}/repos/${gh.owner}/${gh.repo}/issues/${prNumber}/comments`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
}

/** Convert a draft PR to ready-for-review (GraphQL — no REST equivalent). The
 *  "tests passed → this is reviewable" gate. Best-effort. */
export async function markReadyForReview(repoUrl: string, prNumber: number, token: string): Promise<void> {
  const gh = parseRepo(repoUrl);
  if (!gh) return;
  const meta = await ghFetch(`${API}/repos/${gh.owner}/${gh.repo}/pulls/${prNumber}`, token);
  if (!meta.ok) return;
  const nodeId = ((await meta.json()) as { node_id?: string }).node_id;
  if (!nodeId) return;
  await ghFetch(`${API}/graphql`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id}}}",
      variables: { id: nodeId },
    }),
  });
}

/** Can this token read the repo at all? Used to disambiguate a 404 on a file
 *  read: GitHub returns 404 both for "file absent" AND "repo you can't see", so
 *  probe the repo root to tell an access/credential problem from a missing file.
 *  Returns the HTTP status of GET /repos/owner/repo (0 if the URL is unparseable). */
export async function getRepoAccess(repoUrl: string, token: string): Promise<{ ok: boolean; status: number }> {
  const gh = parseRepo(repoUrl);
  if (!gh) return { ok: false, status: 0 };
  const res = await ghFetch(`${API}/repos/${gh.owner}/${gh.repo}`, token);
  return { ok: res.ok, status: res.status };
}

/** Fetch a single file's contents at a ref (for reading .daboss/pipeline.yaml
 *  without a full clone). Returns null if absent / unsupported host. */
export async function getFileContents(
  repoUrl: string,
  path: string,
  ref: string | undefined,
  token: string
): Promise<string | null> {
  const gh = parseRepo(repoUrl);
  if (!gh) return null;
  const url = `${API}/repos/${gh.owner}/${gh.repo}/contents/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
  const res = await ghFetch(url, token);
  if (!res.ok) return null;
  const body = (await res.json()) as { content?: string; encoding?: string };
  if (!body.content) return null;
  return Buffer.from(body.content, (body.encoding as BufferEncoding) || "base64").toString("utf8");
}

/** File contents + blob sha at a ref (sha needed to update the file). */
export async function getFileMeta(
  repoUrl: string,
  path: string,
  ref: string | undefined,
  token: string
): Promise<{ sha: string; content: string } | null> {
  const gh = parseRepo(repoUrl);
  if (!gh) return null;
  const url = `${API}/repos/${gh.owner}/${gh.repo}/contents/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
  const res = await ghFetch(url, token);
  if (!res.ok) return null;
  const body = (await res.json()) as { content?: string; encoding?: string; sha?: string };
  if (!body.content || !body.sha) return null;
  return { sha: body.sha, content: Buffer.from(body.content, (body.encoding as BufferEncoding) || "base64").toString("utf8") };
}

/** Head commit sha of a branch. */
/** Look up a PR by number to resolve the head branch it targets (for "adopt an
 *  existing PR" — the agent pushes onto that head). Returns null if not found. */
export async function getPullRequest(
  repoUrl: string,
  prNumber: number,
  token: string
): Promise<{
  number: number;
  state: string;
  head: string;
  url: string;
  title: string;
  crossRepo: boolean; // head lives on a fork, not the base repo — untrusted
  headRepo: string; // full_name of the head repo (fork owner/name), for the error
} | null> {
  const gh = parseRepo(repoUrl);
  if (!gh) return null;
  const res = await ghFetch(`${API}/repos/${gh.owner}/${gh.repo}/pulls/${prNumber}`, token);
  if (!res.ok) return null;
  const pr = (await res.json()) as {
    number: number;
    state: string;
    head?: { ref?: string; repo?: { full_name?: string } };
    base?: { repo?: { full_name?: string } };
    html_url?: string;
    title?: string;
  };
  if (!pr.head?.ref) return null;
  const headRepo = pr.head.repo?.full_name || "";
  const baseRepo = pr.base?.repo?.full_name || `${gh.owner}/${gh.repo}`;
  // A deleted-fork head has no repo; treat unknown/mismatched head repo as cross-repo (fail safe).
  const crossRepo = !headRepo || headRepo.toLowerCase() !== baseRepo.toLowerCase();
  return {
    number: pr.number,
    state: pr.state,
    head: pr.head.ref,
    url: pr.html_url || "",
    title: pr.title || "",
    crossRepo,
    headRepo,
  };
}

export async function getBranchHead(repoUrl: string, branch: string, token: string): Promise<string | null> {
  const gh = parseRepo(repoUrl);
  if (!gh) return null;
  const res = await ghFetch(`${API}/repos/${gh.owner}/${gh.repo}/git/ref/heads/${encodeURIComponent(branch)}`, token);
  if (!res.ok) return null;
  return ((await res.json()) as { object?: { sha?: string } }).object?.sha ?? null;
}

/** Create a branch ref at a commit sha. */
export async function createBranch(repoUrl: string, branch: string, fromSha: string, token: string): Promise<boolean> {
  const gh = parseRepo(repoUrl);
  if (!gh) return false;
  const res = await ghFetch(`${API}/repos/${gh.owner}/${gh.repo}/git/refs`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: fromSha }),
  });
  return res.ok;
}

/** Create/update a file on a branch (Contents API). sha = the blob being replaced. */
export async function putFile(
  repoUrl: string,
  path: string,
  content: string,
  branch: string,
  message: string,
  sha: string,
  token: string
): Promise<boolean> {
  const gh = parseRepo(repoUrl);
  if (!gh) return false;
  const res = await ghFetch(`${API}/repos/${gh.owner}/${gh.repo}/contents/${path}`, token, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: Buffer.from(content, "utf8").toString("base64"), branch, sha }),
  });
  return res.ok;
}

/** Close a PR + delete its branch. Best-effort cleanup for test scaffolding. */
export async function closePrAndBranch(repoUrl: string, prNumber: number, branch: string, token: string): Promise<void> {
  const gh = parseRepo(repoUrl);
  if (!gh) return;
  try {
    await ghFetch(`${API}/repos/${gh.owner}/${gh.repo}/pulls/${prNumber}`, token, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: "closed" }),
    });
    await ghFetch(`${API}/repos/${gh.owner}/${gh.repo}/git/refs/heads/${encodeURIComponent(branch)}`, token, { method: "DELETE" });
  } catch { /* best-effort */ }
}

export function parseRepo(repoUrl: string): { owner: string; repo: string } | null {
  const u = normalizeGitUrl(repoUrl).replace(/\.git$/, "");
  const m = u.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\/|$)/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "da_boss",
  };
}

async function ghFetch(url: string, token: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 20_000);
  try {
    return await fetch(url, { ...init, headers: { ...ghHeaders(token), ...(init?.headers || {}) }, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function findOpenPr(owner: string, repo: string, branch: string, token: string): Promise<PullRequestResult | null> {
  const res = await ghFetch(
    `${API}/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(branch)}&state=open`,
    token
  );
  if (!res.ok) return null;
  const arr = (await res.json()) as Array<{ html_url: string; number: number }>;
  return arr.length ? { url: arr[0].html_url, number: arr[0].number, created: false } : null;
}

/**
 * Resolve the OPEN PR for a branch (by head ref), if one exists — WITHOUT creating
 * anything. Used to backfill pr_number/pr_url for an ADOPTED PR/branch that da_boss
 * recorded with only an adopted_ref (adoption doesn't open a PR, so pr_number was
 * never set — which broke Merge/deploy on adopted PRs). Returns null when no open PR
 * matches (or the host isn't recognized). Same-repo heads only (matches findOpenPr).
 */
export async function resolveOpenPrByBranch(
  repoUrl: string,
  branch: string,
  token: string
): Promise<{ number: number; url: string } | null> {
  const gh = parseRepo(repoUrl);
  if (!gh) return null;
  const pr = await findOpenPr(gh.owner, gh.repo, branch, token);
  return pr ? { number: pr.number, url: pr.url } : null;
}

/**
 * Find the open PR for this branch, or create one. Returns null when there's
 * nothing to PR (no commits vs. base) or the host isn't recognized — callers
 * treat null as "branch pushed, no PR" rather than an error.
 */
export async function ensurePullRequest(p: PullRequestParams): Promise<PullRequestResult | null> {
  const gh = parseRepo(p.repoUrl);
  if (!gh) return null;
  const { owner, repo } = gh;

  const existing = await findOpenPr(owner, repo, p.branch, p.token);
  if (existing) return existing;

  let base = p.base;
  if (!base) {
    const repoRes = await ghFetch(`${API}/repos/${owner}/${repo}`, p.token);
    base = repoRes.ok ? ((await repoRes.json()) as { default_branch?: string }).default_branch || "main" : "main";
  }

  const res = await ghFetch(`${API}/repos/${owner}/${repo}/pulls`, p.token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: p.title, head: p.branch, base, body: p.body, draft: p.draft ?? true }),
  });
  if (res.ok) {
    const pr = (await res.json()) as { html_url: string; number: number };
    return { url: pr.html_url, number: pr.number, created: true };
  }

  const errText = await res.text();
  // benign: nothing to open a PR for
  if (res.status === 422 && /No commits between/i.test(errText)) return null;
  // race / re-run: a PR already exists — find and return it
  if (res.status === 422 && /already exists/i.test(errText)) {
    const again = await findOpenPr(owner, repo, p.branch, p.token);
    if (again) return again;
  }
  throw new Error(`GitHub PR create failed (${res.status}): ${errText.slice(0, 300)}`);
}
