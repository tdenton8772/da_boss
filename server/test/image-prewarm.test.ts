import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const resolved = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>>, fail: false }));
vi.mock("../src/agent/agent-image.js", () => ({
  resolveAgentImage: async (opts: Record<string, unknown>) => {
    resolved.calls.push(opts);
    if (resolved.fail) throw new Error("kaniko exploded");
    return { image: "reg/agent-o-r:abc", mountApp: true };
  },
}));

import * as queries from "../src/db/queries.js";
import { LocalAesCipher, setCipher } from "../src/crypto/cipher.js";
import { config } from "../src/config.js";
import { prewarmAllRepoImages } from "../src/agent/image-prewarm.js";

const KEY = Buffer.alloc(32, 9).toString("base64");

async function agentIn(repo: string, userId: string, id: string) {
  await queries.insertAgent({
    id, name: id, prompt: "p", cwd: "/work", state: "completed", priority: "medium", permission_mode: "default",
    sdk_session_id: null, model: "opus", max_turns: null, max_budget_usd: null, error_message: null,
    supervisor_instructions: "", permission_policy: "auto", created_by_user_id: userId, repo_url: repo, repo_ref: null,
    branch: null, service_account: null, worker_image: null, adopted_ref: null, size: null, toolchain: null,
  });
}

describe("agent image pre-build", () => {
  const saved = { base: config.agentBaseImage, exec: config.agentExecution, worker: config.workerImage };
  beforeEach(async () => {
    setCipher(new LocalAesCipher(KEY));
    resolved.calls = [];
    resolved.fail = false;
    Object.assign(config, { agentBaseImage: "reg/da-boss-os:t1", agentExecution: "pod", workerImage: "reg/da-boss:t1" });
    await queries.createUser({ id: "usr_dev", email: "dev@x.io" });
    await queries.upsertUserGitCredential("usr_dev", await new LocalAesCipher(KEY).encrypt("ghp_test"));
  });
  afterEach(() => {
    setCipher(null);
    Object.assign(config, { agentBaseImage: saved.base, agentExecution: saved.exec, workerImage: saved.worker });
  });

  it("builds each active repo's toolchain image on the OS base, with a user's git token", async () => {
    await agentIn("https://github.com/o/r.git", "usr_dev", "ag_1");
    await agentIn("https://github.com/o/r", "usr_dev", "ag_2"); // same repo, other spelling → once
    await agentIn("https://github.com/o/other.git", "usr_dev", "ag_3");
    await prewarmAllRepoImages();
    expect(resolved.calls.map((c) => c.repoUrl).sort()).toEqual(["https://github.com/o/other", "https://github.com/o/r"]);
    expect(resolved.calls[0]).toMatchObject({ gitToken: "ghp_test", toolchainBase: "reg/da-boss-os:t1", baseImage: "reg/da-boss:t1" });
  });

  it("does nothing without the split layout (local kind rebuilds per deploy anyway)", async () => {
    config.agentBaseImage = "";
    await agentIn("https://github.com/o/r.git", "usr_dev", "ag_1");
    await prewarmAllRepoImages();
    expect(resolved.calls).toHaveLength(0);
  });

  it("a failed build is logged, not thrown, and the other repos still build", async () => {
    resolved.fail = true;
    await agentIn("https://github.com/o/a.git", "usr_dev", "ag_1");
    await agentIn("https://github.com/o/b.git", "usr_dev", "ag_2");
    await expect(prewarmAllRepoImages()).resolves.toBeUndefined();
    expect(resolved.calls).toHaveLength(2);
  });
});
