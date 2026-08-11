import { describe, it, expect } from "vitest";
import { nextWatchAction, type WatchState } from "../src/pipeline/main-watch.js";
import * as queries from "../src/db/queries.js";
import { getPool } from "../src/db/index.js";

// The #81/#82 incident: PRs merged manually on GitHub bypass da_boss, main sat
// red for five days, and every branch cut from it inherited the failures. The
// watcher's job: main HEAD moved → test it; concluded → never re-launch for the
// same sha (no run-storms), red → notify.

const state = (over: Partial<WatchState>): WatchState =>
  ({ sha: "aaa", status: "green", runIds: [], ...over });

describe("nextWatchAction — one repo, one sweep (pure)", () => {
  it("launches on first sight (no stored state)", () => {
    expect(nextWatchAction("aaa", null, [])).toBe("launch");
  });

  it("launches when main moved, whatever the previous conclusion", () => {
    expect(nextWatchAction("bbb", state({ sha: "aaa", status: "green" }), [])).toBe("launch");
    expect(nextWatchAction("bbb", state({ sha: "aaa", status: "red" }), [])).toBe("launch");
    expect(nextWatchAction("bbb", state({ sha: "aaa", status: "no-tests" }), [])).toBe("launch");
  });

  it("re-launches even mid-test when main moves again (test the NEW head)", () => {
    expect(nextWatchAction("ccc", state({ sha: "bbb", status: "testing" }), [{ status: "running" }])).toBe("launch");
  });

  it("same sha already concluded → nothing (never re-tests a tested merge)", () => {
    expect(nextWatchAction("aaa", state({ status: "green" }), [])).toBe("nothing");
    expect(nextWatchAction("aaa", state({ status: "red" }), [])).toBe("nothing");
    expect(nextWatchAction("aaa", state({ status: "no-tests" }), [])).toBe("nothing");
  });

  it("waits while any launched run is still going", () => {
    expect(nextWatchAction("aaa", state({ status: "testing" }), [
      { status: "passed" }, { status: "running" },
    ])).toBe("wait");
  });

  it("concludes once every run is terminal — passed, failed, or error", () => {
    expect(nextWatchAction("aaa", state({ status: "testing" }), [
      { status: "passed" }, { status: "failed" },
    ])).toBe("conclude");
    expect(nextWatchAction("aaa", state({ status: "testing" }), [
      { status: "error" },
    ])).toBe("conclude");
  });

  it("concludes when the launched runs vanished (deleted rows) — no infinite wait", () => {
    expect(nextWatchAction("aaa", state({ status: "testing" }), [])).toBe("conclude");
  });
});

describe("getWatchedRepos — active repos with a credentialed owner", () => {
  async function mkUser(id: string, withCred: boolean) {
    await queries.createUser({ id, email: `${id}@t.co` }).catch(() => {});
    if (withCred) {
      await getPool().query(
        "INSERT INTO user_git_credentials (user_id, ciphertext, nonce, key_ref) VALUES ($1, 'ct', 'n', 'k')",
        [id]
      );
    }
  }
  async function mkAgent(id: string, repo: string | null, userId: string) {
    await queries.insertAgent({
      id, name: id, prompt: "p", cwd: "/w", state: "completed", priority: "medium",
      permission_mode: "default", sdk_session_id: null, model: "m", max_turns: null,
      max_budget_usd: null, error_message: null, supervisor_instructions: "",
      permission_policy: "auto", created_by_user_id: userId, repo_url: repo,
      repo_ref: null, branch: null, service_account: null, worker_image: null,
      adopted_ref: null, size: null,
    });
  }

  it("dedupes to one row per repo, most recent owner wins, skips credential-less owners", async () => {
    await mkUser("usr_a", true);
    await mkUser("usr_b", true);
    await mkUser("usr_nocred", false);
    await mkAgent("ag_1", "https://github.com/o/r1.git", "usr_a");
    await mkAgent("ag_2", "https://github.com/o/r1.git", "usr_b"); // newer owner of r1
    await mkAgent("ag_3", "https://github.com/o/r2.git", "usr_nocred"); // owner has no cred
    await mkAgent("ag_4", null, "usr_a"); // no repo

    const repos = await queries.getWatchedRepos();
    expect(repos).toHaveLength(1);
    expect(repos[0].repo_url).toBe("https://github.com/o/r1");
    expect(repos[0].user_id).toBe("usr_b");
  });

  it("collapses URL variants of the same repo — .git and bare forms double-launched the watcher", async () => {
    await mkUser("usr_a", true);
    await mkAgent("ag_g1", "https://github.com/o/same.git", "usr_a");
    await mkAgent("ag_g2", "https://github.com/o/same", "usr_a");
    await mkAgent("ag_g3", "git@github.com:o/same.git", "usr_a");

    const repos = await queries.getWatchedRepos();
    expect(repos).toHaveLength(1);
    expect(repos[0].repo_url).toBe("https://github.com/o/same");
  });
});
