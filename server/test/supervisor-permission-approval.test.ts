import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The supervisor's judgment call is a real SDK query in production; here we pin
// its answer per-test. Everything else (credential resolution, cipher, DB rows,
// the runChecks flow) is real.
const claude = vi.hoisted(() => ({ result: "DECISION: approved\nANSWER: ok" }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: () =>
    (async function* () {
      yield { type: "result", result: claude.result };
    })(),
}));

import { runChecks, type SupervisorDeps } from "../src/supervisor/checks.js";
import * as queries from "../src/db/queries.js";
import { getPool } from "../src/db/index.js";
import { LocalAesCipher, setCipher } from "../src/crypto/cipher.js";
import { SUPERVISOR_CRED_SETTING } from "../src/supervisor/credential.js";

const KEY = Buffer.alloc(32, 7).toString("base64");

const agentBase = {
  name: "a", prompt: "add tests for the schema module", cwd: "/tmp", state: "running" as const,
  priority: "medium" as const, permission_mode: "default" as const,
  sdk_session_id: null, model: "claude-sonnet-4-6", max_turns: null,
  max_budget_usd: null, error_message: null,
  supervisor_instructions: "Approve read-only and test-running commands; deny anything destructive.",
  permission_policy: "auto" as const,
};

function deps(over: Partial<SupervisorDeps> = {}): SupervisorDeps {
  return {
    getAgentsToPause: async () => [],
    pauseAgent: async () => {},
    ...over,
  };
}

async function designateSupervisorCredential(): Promise<void> {
  await queries.createUser({ id: "usr_sup", email: "sup@x.io" });
  const blob = await new LocalAesCipher(KEY).encrypt("test-cred-secret");
  await queries.upsertUserCredential("usr_sup", "anthropic_api_key", blob);
  await queries.setAppSetting(SUPERVISOR_CRED_SETTING, "usr_sup");
}

async function insertStalePermission(agentId: string, toolName: string, toolInput: unknown, minutesAgo: number): Promise<number> {
  const perm = await queries.insertPermissionRequest(agentId, toolName, toolInput, `tu_${agentId}`);
  await getPool().query("UPDATE permission_requests SET created_at = $1 WHERE id = $2", [
    new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    perm.id,
  ]);
  return perm.id;
}

describe("supervisor resolves stale tool permissions (the second-agent approval)", () => {
  beforeEach(() => {
    setCipher(new LocalAesCipher(KEY));
    claude.result = "DECISION: approved\nANSWER: ok";
  });
  afterEach(() => setCipher(null));

  it("approves a stale Bash request for an agent with supervisor_instructions", async () => {
    await designateSupervisorCredential();
    await queries.insertAgent({ ...agentBase, id: "ag_bash" });
    await queries.insertAgentEvent("ag_bash", "message", { role: "assistant", content: "running tests" });
    const permId = await insertStalePermission("ag_bash", "Bash", { command: "npm test" }, 6);

    claude.result = "DECISION: approved\nANSWER: test run serves the task";
    const resolvePermission = vi.fn(async () => true);
    const { actions, findings } = await runChecks(deps({ resolvePermission }));

    expect(resolvePermission).toHaveBeenCalledWith(permId, "approved", "test run serves the task");
    const act = actions.find((a) => a.type === "supervisor_permission");
    expect(act).toBeDefined();
    expect(act!.detail).toMatch(/approved Bash/);
    expect(findings.find((f) => f.type === "permission_timeout")).toBeUndefined();
  });

  it("denies when the supervisor judges the command out of scope", async () => {
    await designateSupervisorCredential();
    await queries.insertAgent({ ...agentBase, id: "ag_deny" });
    await insertStalePermission("ag_deny", "Bash", { command: "rm -rf /data" }, 6);

    claude.result = "DECISION: denied\nANSWER: destructive and unrelated to the task";
    const resolvePermission = vi.fn(async () => true);
    const { actions } = await runChecks(deps({ resolvePermission }));

    expect(resolvePermission).toHaveBeenCalledWith(expect.any(Number), "denied", "destructive and unrelated to the task");
    expect(actions.find((a) => a.type === "supervisor_permission")!.detail).toMatch(/denied Bash/);
  });

  it("still auto-resolves interactive tools through the same path", async () => {
    await designateSupervisorCredential();
    await queries.insertAgent({ ...agentBase, id: "ag_q" });
    await insertStalePermission("ag_q", "AskUserQuestion", { questions: [{ question: "Which DB?", options: [{ label: "postgres" }] }] }, 6);

    claude.result = "DECISION: approved\nANSWER: postgres";
    const resolvePermission = vi.fn(async () => true);
    const { actions } = await runChecks(deps({ resolvePermission }));

    expect(resolvePermission).toHaveBeenCalledWith(expect.any(Number), "approved", "postgres");
    expect(actions.find((a) => a.type === "supervisor_permission")).toBeDefined();
  });

  it("does NOT touch fresh requests (under the 5-minute staleness window)", async () => {
    await designateSupervisorCredential();
    await queries.insertAgent({ ...agentBase, id: "ag_fresh" });
    await insertStalePermission("ag_fresh", "Bash", { command: "npm test" }, 2);

    const resolvePermission = vi.fn(async () => true);
    const { findings } = await runChecks(deps({ resolvePermission }));

    expect(resolvePermission).not.toHaveBeenCalled();
    expect(findings.find((f) => f.type === "permission_timeout")).toBeUndefined();
  });

  it("falls through to permission_timeout when the agent has no supervisor_instructions", async () => {
    await designateSupervisorCredential();
    await queries.insertAgent({ ...agentBase, id: "ag_noinstr", supervisor_instructions: "" });
    await insertStalePermission("ag_noinstr", "Bash", { command: "npm test" }, 45);

    const resolvePermission = vi.fn(async () => true);
    const { findings } = await runChecks(deps({ resolvePermission }));

    expect(resolvePermission).not.toHaveBeenCalled();
    expect(findings.find((f) => f.type === "permission_timeout" && f.agentId === "ag_noinstr")).toBeDefined();
  });

  it("falls through to permission_timeout when no credential is configured", async () => {
    // No designateSupervisorCredential() — credEnv.ok is false.
    await queries.insertAgent({ ...agentBase, id: "ag_nocred" });
    await insertStalePermission("ag_nocred", "Bash", { command: "npm test" }, 45);

    const resolvePermission = vi.fn(async () => true);
    const { findings } = await runChecks(deps({ resolvePermission }));

    expect(resolvePermission).not.toHaveBeenCalled();
    expect(findings.find((f) => f.type === "permission_timeout" && f.agentId === "ag_nocred")).toBeDefined();
  });
});
