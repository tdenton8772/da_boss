import { describe, it, expect, vi, afterEach } from "vitest";
import { parseRepo, ensurePullRequest, updateBranch, getPullRequest } from "../src/forge/github.js";

describe("forge/github", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("parses owner/repo from https, ssh, and .git URLs", () => {
    expect(parseRepo("https://github.com/example/app.git")).toEqual({ owner: "example", repo: "app" });
    expect(parseRepo("git@github.com:example/app.git")).toEqual({ owner: "example", repo: "app" });
    expect(parseRepo("https://github.com/org/repo")).toEqual({ owner: "org", repo: "repo" });
    expect(parseRepo("https://gitlab.com/x/y.git")).toBeNull();
  });

  const res = (status: number, body: unknown) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

  it("flags a fork PR as cross-repo (untrusted head) — PR #6 shape", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(res(200, {
      number: 6, state: "open", title: "SRE-1436-Expose app-api:5432", html_url: "https://gh/pr/6",
      head: { ref: "patch-1", repo: { full_name: "forkuser/app" } },
      base: { repo: { full_name: "example/app" } },
    })));
    const pr = await getPullRequest("https://github.com/example/app.git", 6, "t");
    expect(pr).toMatchObject({ number: 6, head: "patch-1", crossRepo: true, headRepo: "forkuser/app" });
  });

  it("treats a same-repo PR head as trusted (not cross-repo)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(res(200, {
      number: 13, state: "open", title: "rename stages", html_url: "https://gh/pr/13",
      head: { ref: "feat/x/rename", repo: { full_name: "example/app" } },
      base: { repo: { full_name: "example/app" } },
    })));
    const pr = await getPullRequest("https://github.com/example/app.git", 13, "t");
    expect(pr).toMatchObject({ head: "feat/x/rename", crossRepo: false });
  });

  it("fails safe: a deleted-fork head (no head repo) is treated as cross-repo", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(res(200, {
      number: 99, state: "open", title: "orphan", html_url: "https://gh/pr/99",
      head: { ref: "patch-1" }, base: { repo: { full_name: "example/app" } },
    })));
    const pr = await getPullRequest("https://github.com/example/app.git", 99, "t");
    expect(pr!.crossRepo).toBe(true);
  });

  it("returns the existing PR without creating a duplicate (idempotent)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(res(200, [{ html_url: "https://gh/pr/7", number: 7 }]));
    vi.stubGlobal("fetch", fetchMock);

    const pr = await ensurePullRequest({
      repoUrl: "https://github.com/o/r.git", token: "t", branch: "feat/x", title: "T", body: "B",
    });
    expect(pr).toEqual({ url: "https://gh/pr/7", number: 7, created: false });
    expect(fetchMock).toHaveBeenCalledTimes(1); // found → no create
  });

  it("creates a draft PR against the default branch when none exists", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(res(200, []))                              // find: none
      .mockResolvedValueOnce(res(200, { default_branch: "master" }))    // repo meta
      .mockResolvedValueOnce(res(201, { html_url: "https://gh/pr/9", number: 9 })); // create
    vi.stubGlobal("fetch", fetchMock);

    const pr = await ensurePullRequest({
      repoUrl: "https://github.com/o/r.git", token: "t", branch: "feat/x", title: "T", body: "B", draft: true,
    });
    expect(pr).toEqual({ url: "https://gh/pr/9", number: 9, created: true });
    const createCall = fetchMock.mock.calls[2];
    const sentBody = JSON.parse((createCall[1] as RequestInit).body as string);
    expect(sentBody).toMatchObject({ head: "feat/x", base: "master", draft: true });
  });

  it("treats 'no commits between' as no-PR (null), not an error", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(res(200, []))
      .mockResolvedValueOnce(res(200, { default_branch: "main" }))
      .mockResolvedValueOnce(res(422, { message: "No commits between main and feat/x" }));
    vi.stubGlobal("fetch", fetchMock);

    const pr = await ensurePullRequest({
      repoUrl: "https://github.com/o/r.git", token: "t", branch: "feat/x", title: "T", body: "B",
    });
    expect(pr).toBeNull();
  });

  it("updateBranch: 202 → ok, no conflict (land gate rebase)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(res(202, { message: "Updating" })));
    expect(await updateBranch("https://github.com/o/r", 3, "t")).toEqual({ ok: true, conflict: false });
  });

  it("updateBranch: 422 merge conflict → conflict (agent must resolve)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(res(422, { message: "merge conflict between base and head" })));
    const r = await updateBranch("https://github.com/o/r", 3, "t");
    expect(r.ok).toBe(false);
    expect(r.conflict).toBe(true);
  });

  it("updateBranch: 422 already up to date → ok (no-op, not a conflict)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(res(422, { message: "This branch has no new commits with the base branch." })));
    expect(await updateBranch("https://github.com/o/r", 3, "t")).toMatchObject({ ok: true, conflict: false });
  });
});
