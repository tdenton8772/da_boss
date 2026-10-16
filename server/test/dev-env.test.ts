import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Writable, Readable } from "node:stream";

// ── A fake cluster: Deployments, their pods, and exec ─────────────────────────
const k = vi.hoisted(() => ({
  deployments: new Map<string, Record<string, unknown>>(), // "ns/name" → body
  podPhase: "Running" as string,
  waitingReason: "" as string,
  execs: [] as Array<{ ns: string; pod: string; script: string; stdin: string }>,
  // decide an exec's exit code + output from its script
  onExec: (_script: string): { code: number; out: string } => ({ code: 0, out: "ok" }),
}));
vi.mock("@kubernetes/client-node", () => {
  class AppsV1Api {}
  class CoreV1Api {}
  const apps = {
    createNamespacedDeployment: async ({ namespace, body }: { namespace: string; body: { metadata: { name: string } } }) => {
      const key = `${namespace}/${body.metadata.name}`;
      if (k.deployments.has(key)) throw Object.assign(new Error("exists"), { code: 409 });
      k.deployments.set(key, body as unknown as Record<string, unknown>);
    },
    replaceNamespacedDeployment: async ({ namespace, name, body }: { namespace: string; name: string; body: Record<string, unknown> }) => {
      k.deployments.set(`${namespace}/${name}`, body);
    },
    deleteNamespacedDeployment: async ({ namespace, name }: { namespace: string; name: string }) => {
      if (!k.deployments.delete(`${namespace}/${name}`)) throw Object.assign(new Error("not found"), { code: 404 });
    },
  };
  const core = {
    listNamespacedPod: async ({ namespace, labelSelector }: { namespace: string; labelSelector: string }) => {
      const name = labelSelector.replace("app=", "");
      if (!k.deployments.has(`${namespace}/${name}`)) return { items: [] };
      const running = k.podPhase === "Running" && !k.waitingReason;
      return {
        items: [{
          metadata: { name: `${name}-pod` },
          status: {
            phase: k.podPhase,
            containerStatuses: [{ name: "dev", state: running ? { running: {} } : { waiting: { reason: k.waitingReason || "ContainerCreating" } } }],
          },
        }],
      };
    },
  };
  class KubeConfig {
    loadFromCluster() {}
    makeApiClient(cls: unknown) { return cls === AppsV1Api ? apps : core; }
  }
  class Exec {
    async exec(ns: string, pod: string, _c: string, cmd: string[], stdout: Writable, _stderr: Writable, stdin: Readable | null, _tty: boolean, cb: (s: unknown) => void) {
      let input = "";
      if (stdin) for await (const chunk of stdin) input += chunk.toString();
      const script = cmd[2];
      k.execs.push({ ns, pod, script, stdin: input });
      const r = k.onExec(script);
      const ws = new EventEmitter();
      setTimeout(() => {
        stdout.write(r.out);
        cb(r.code === 0 ? { status: "Success" } : { status: "Failure", details: { causes: [{ reason: "ExitCode", message: String(r.code) }] } });
        ws.emit("close");
      }, 0);
      return ws;
    }
  }
  return { KubeConfig, AppsV1Api, CoreV1Api, Exec };
});

const DEV_YAML = `
namespace: shop
port: 4000
workdir: web
start: mix phx.server
setup: [mix compile]
sync: [mix compile]
ready_check: curl -sf localhost:4000
ttl_hours: 2
`;
const forge = vi.hoisted(() => ({ devYaml: "" as string | null, branchExists: true, created: [] as string[], pr: { url: "https://github.com/o/shop/pull/7", number: 7, created: true } as { url: string; number: number; created: boolean } | null }));
vi.mock("../src/forge/github.js", () => ({
  getFileContents: async (_r: string, path: string, ref: string | undefined) => (path === ".daboss/dev.yaml" && ref === undefined ? forge.devYaml : null),
  getBranchHead: async (_r: string, branch: string) => (branch === "main" || forge.branchExists || forge.created.includes(branch) ? "sha1" : null),
  createBranch: async (_r: string, branch: string) => { forge.created.push(branch); return true; },
  ensurePullRequest: async () => forge.pr,
}));
vi.mock("../src/agent/agent-image.js", () => ({ resolveAgentImage: async () => ({ image: "reg/agent-shop:abc", mountApp: true }) }));
const pipeline = vi.hoisted(() => ({ runs: [{ phase: "test", runId: "run_1" }], reviews: 0 }));
vi.mock("../src/pipeline/service.js", () => ({ runTestPhasesForAgent: async () => pipeline.runs }));
vi.mock("../src/pipeline/review-agent.js", () => ({ dispatchReviewAgent: async () => { pipeline.reviews++; return "ag_review"; } }));

import * as queries from "../src/db/queries.js";
import { LocalAesCipher, setCipher } from "../src/crypto/cipher.js";
import { config } from "../src/config.js";
import { startDevEnv, syncDevEnv, stopDevEnv, reapDevEnvs, ensureRemoteBranch, previewDevEnv, DevEnvError } from "../src/dev/dev-env.js";
import { handbackChange } from "../src/dev/handback.js";
import type { AgentRecord } from "../src/types/agent.js";

const KEY = Buffer.alloc(32, 5).toString("base64");
const ACTOR = { userId: "usr_alice", email: "alice@co.io", name: "Alice" };

async function change(over: Partial<AgentRecord> = {}): Promise<AgentRecord> {
  return queries.insertAgent({
    id: "ag_1", name: "Fix totals", prompt: "p", cwd: "/work", state: "pending", priority: "medium", permission_mode: "default",
    sdk_session_id: null, model: "opus", max_turns: null, max_budget_usd: null, error_message: null, supervisor_instructions: "",
    permission_policy: "auto", created_by_user_id: "usr_alice", repo_url: "https://github.com/o/shop", repo_ref: "main",
    branch: "feat/alice/fix-totals", service_account: null, worker_image: null, adopted_ref: null, size: null, toolchain: null,
    ...over,
  });
}
const settled = async (id: string) => {
  await vi.waitFor(async () => expect((await queries.getDevEnv(id))?.status).not.toBe("starting"), { timeout: 3000 });
  return (await queries.getDevEnv(id))!;
};
const events = async () => (await queries.getAgentEvents("ag_1", 100)).map((e) => JSON.stringify(e.data)).join("\n");

describe("dev environment lifecycle", () => {
  const saved = { ns: config.devNamespaces, ctx: config.devKubeContext, exec: config.agentExecution };
  beforeEach(async () => {
    setCipher(new LocalAesCipher(KEY));
    Object.assign(config, { devNamespaces: ["shop"], devKubeContext: "gw_ctx", agentExecution: "pod" });
    k.deployments.clear(); k.execs = []; k.podPhase = "Running"; k.waitingReason = "";
    k.onExec = () => ({ code: 0, out: "ok" });
    Object.assign(forge, { devYaml: DEV_YAML, branchExists: true, created: [], pr: { url: "https://github.com/o/shop/pull/7", number: 7, created: true } });
    pipeline.reviews = 0;
    await queries.createUser({ id: "usr_alice", email: "alice@co.io" });
    await queries.upsertUserGitCredential("usr_alice", await new LocalAesCipher(KEY).encrypt("ghp_alice"));
  });
  afterEach(() => { setCipher(null); Object.assign(config, { devNamespaces: saved.ns, devKubeContext: saved.ctx, agentExecution: saved.exec }); });

  it("provisions: Deployment in the declared namespace, clone+setup with the token on stdin, ready check, then ready", async () => {
    const agent = await change();
    const env = await startDevEnv(agent, ACTOR);
    expect(env.status).toBe("starting");
    const done = await settled(env.id);
    expect(done.status).toBe("ready");
    expect(done.image).toBe("reg/agent-shop:abc");
    expect([...k.deployments.keys()]).toEqual(["shop/dev-alice-ag-1"]);
    const [boot, ready] = k.execs;
    expect(boot.script).toContain("clone --quiet --branch 'feat/alice/fix-totals' 'https://github.com/o/shop'");
    expect(boot.stdin).toBe("ghp_alice\n");
    expect(boot.script).not.toContain("ghp_alice");
    expect(ready.script).toContain("curl -sf localhost:4000");
    expect(await events()).toContain("kubectl --context gw_ctx -n shop port-forward deploy/dev-alice-ag-1 4000:4000");
  });

  it("is idempotent while live, and a failed env is replaced by a restart", async () => {
    const agent = await change();
    const a = await startDevEnv(agent, ACTOR);
    expect((await startDevEnv(agent, ACTOR)).id).toBe(a.id);
    await settled(a.id);
    k.onExec = (s) => (s.includes("clone") ? { code: 2, out: "** (Mix) Could not compile dependency :foo" } : { code: 0, out: "" });
    await stopDevEnv((await queries.getDevEnv(a.id))!, "test");
    const b = await startDevEnv(agent, ACTOR);
    const failed = await settled(b.id);
    expect(failed.status).toBe("failed");
    expect(failed.detail).toMatch(/setup exited 2[\s\S]*Could not compile/);
    expect(k.deployments.size).toBe(1); // a failed env keeps its pod for debugging
    k.onExec = () => ({ code: 0, out: "" });
    const c = await startDevEnv(agent, ACTOR);
    expect(c.id).not.toBe(b.id);
    expect((await queries.getDevEnv(b.id))?.status).toBe("stopped");
    expect((await settled(c.id)).status).toBe("ready");
  });

  it("surfaces a pod that can't start", async () => {
    k.waitingReason = "ImagePullBackOff";
    const env = await startDevEnv(await change(), ACTOR);
    const done = await settled(env.id);
    expect(done.status).toBe("failed");
    expect(done.detail).toMatch(/ImagePullBackOff/);
  });

  it.each([
    ["disabled", () => { config.devNamespaces = []; }, 400, /aren't enabled/],
    ["no dev.yaml", () => { forge.devYaml = null; }, 404, /no .daboss\/dev.yaml/],
    ["namespace not allowed", () => { forge.devYaml = DEV_YAML.replace("shop", "kube-system"); }, 403, /doesn't allow/],
    ["bad dev.yaml", () => { forge.devYaml = "namespace: shop\nport: x\nstart: y"; }, 400, /port/],
    ["branch not pushed", () => { forge.branchExists = false; }, 400, /isn't on the remote/],
  ])("refuses to start when %s", async (_l, arrange, status, msg) => {
    arrange();
    const err = await startDevEnv(await change(), ACTOR).catch((e) => e);
    expect(err).toBeInstanceOf(DevEnvError);
    expect(err).toMatchObject({ status });
    expect(err.message).toMatch(msg);
    expect(k.deployments.size).toBe(0);
  });

  it("sync pulls with the token on stdin and extends the expiry", async () => {
    const env = await settled((await startDevEnv(await change(), ACTOR)).id);
    await queries.updateDevEnv(env.id, { expires_at: new Date(Date.now() + 60_000) });
    k.onExec = () => ({ code: 0, out: "at abc123 fix totals" });
    const r = await syncDevEnv((await queries.getDevEnv(env.id))!, "usr_alice");
    expect(r.output).toContain("abc123");
    const sync = k.execs.at(-1)!;
    expect(sync.script).toContain("git reset --quiet --hard FETCH_HEAD");
    expect(sync.stdin).toBe("ghp_alice\n");
    const after = (await queries.getDevEnv(env.id))!;
    expect(Date.parse(after.expires_at)).toBeGreaterThan(Date.now() + 3600_000); // ~2h ttl
  });

  it("stop deletes the Deployment; the reaper expires old envs and fails orphaned setups", async () => {
    const env = await settled((await startDevEnv(await change(), ACTOR)).id);
    await stopDevEnv(env, "done");
    expect(k.deployments.size).toBe(0);
    expect((await queries.getDevEnv(env.id))?.status).toBe("stopped");
    await stopDevEnv((await queries.getDevEnv(env.id))!, "again"); // idempotent

    const e2 = await settled((await startDevEnv(await change({ id: "ag_2" }), ACTOR)).id);
    await queries.updateDevEnv(e2.id, { expires_at: new Date(Date.now() - 1000) });
    const orphan = await queries.insertDevEnv({
      id: "dev_orphan", agent_id: "ag_2", user_id: "usr_alice", repo_url: "r", branch: "b", namespace: "shop",
      name: "dev-x", image: null, port: 1, ttl_hours: 1, expires_at: new Date(Date.now() + 3600_000),
    });
    await reapDevEnvs();
    expect((await queries.getDevEnv(e2.id))?.status).toBe("stopped");
    expect((await queries.getDevEnv(orphan.id))?.status).toBe("failed");
  });

  it("a stop during provisioning leaves no Deployment behind", async () => {
    k.podPhase = "Pending";
    const env = await startDevEnv(await change(), ACTOR);
    await vi.waitFor(() => expect(k.deployments.size).toBe(1));
    await stopDevEnv((await queries.getDevEnv(env.id))!, "changed my mind");
    k.podPhase = "Running";
    await vi.waitFor(() => expect(k.deployments.size).toBe(0), { timeout: 5000 });
    expect((await queries.getDevEnv(env.id))?.status).toBe("stopped");
  });

  it("previews the real commands before anything starts, or says why it can't", async () => {
    const agent = await change();
    const p = await previewDevEnv(agent, { userId: "usr_alice", email: "alice@co.io" });
    expect(p).toMatchObject({ available: true, namespace: "shop", name: "dev-alice-ag-1", port: 4000 });
    if (p.available) {
      expect(p.commands.port_forward).toBe("kubectl --context gw_ctx -n shop port-forward deploy/dev-alice-ag-1 4000:4000");
      expect(p.local_claude_prompt).toContain("feat/alice/fix-totals");
    }
    expect(k.deployments.size).toBe(0); // a preview touches nothing
    forge.devYaml = null;
    expect(await previewDevEnv(agent, { userId: "usr_alice", email: "alice@co.io" })).toMatchObject({ available: false, reason: expect.stringMatching(/no .daboss\/dev.yaml/) });
  });

  it("cuts a new branch from the base when a local-dev change starts", async () => {
    forge.branchExists = false;
    await ensureRemoteBranch(await change(), "usr_alice");
    expect(forge.created).toEqual(["feat/alice/fix-totals"]);
  });
});

describe("hand-back", () => {
  beforeEach(async () => {
    setCipher(new LocalAesCipher(KEY));
    Object.assign(forge, { branchExists: true, created: [], pr: { url: "https://github.com/o/shop/pull/7", number: 7, created: true } });
    pipeline.reviews = 0;
    await queries.createUser({ id: "usr_alice", email: "alice@co.io" });
    await queries.upsertUserGitCredential("usr_alice", await new LocalAesCipher(KEY).encrypt("ghp_alice"));
  });
  afterEach(() => setCipher(null));
  const fakeManager = { createAgent: async () => { throw new Error("unused"); }, startAgent: async () => {} };

  it("opens the PR, completes a local-dev change, runs checks and queues the review", async () => {
    const agent = await change();
    const r = await handbackChange(fakeManager, agent, { userId: "usr_alice", label: "alice@co.io" });
    expect(r).toMatchObject({ pr: { number: 7 }, runs: [{ phase: "test" }], review_agent_id: "ag_review" });
    const after = (await queries.getAgent("ag_1"))!;
    expect(after).toMatchObject({ state: "completed", pr_number: 7 });
    expect(pipeline.reviews).toBe(1);
  });

  it("refuses when the branch isn't pushed or has nothing to PR", async () => {
    forge.branchExists = false;
    await expect(handbackChange(fakeManager, await change(), { userId: "usr_alice", label: "a" })).rejects.toThrow(/push your work/);
    forge.branchExists = true;
    forge.pr = null;
    await expect(handbackChange(fakeManager, await change({ id: "ag_2" }), { userId: "usr_alice", label: "a" })).rejects.toThrow(/commits ahead/);
  });
});
