import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import session from "express-session";
import type { Server } from "node:http";
import { EventEmitter } from "node:events";

// adopt_change hands off to the same hand-back path as a dev env; stub it here so
// this file asserts the adoption wiring (handback has its own tests).
vi.mock("../src/dev/handback.js", () => ({
  handbackChange: vi.fn(async () => ({ pr: { number: 42, url: "https://github.com/o/r/pull/42" }, runs: [{ phase: "test", runId: "run_1" }], review_agent_id: "ag_rev", notes: [] })),
}));

import { AgentManager } from "../src/agent/manager.js";
import { createRouter } from "../src/api/router.js";
import * as queries from "../src/db/queries.js";
import { generateToken } from "../src/api/tokens.js";
import { LocalAesCipher, setCipher } from "../src/crypto/cipher.js";
import { handbackChange } from "../src/dev/handback.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const KEY = Buffer.alloc(32, 7).toString("base64");
const REPO = "https://github.com/o/r.git";

function startApp(): Promise<{ server: Server; port: number }> {
  const manager = new AgentManager(new EventEmitter());
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "s", resave: false, saveUninitialized: false }));
  app.use(createRouter(manager));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

async function mintToken(scopes: string): Promise<string> {
  await queries.createUser({ id: "usr_bot", email: "bot@test.co", role: "bot" }).catch(() => {});
  const { token, hash } = generateToken();
  await queries.createApiToken({ user_id: "usr_bot", name: "bot", token_hash: hash, scopes });
  return token;
}

async function connect(port: number, token: string): Promise<Client> {
  const client = new Client({ name: "t", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const pr = (n: number, head: string, headRepo: string) => ({
  number: n, state: "open", head: { ref: head, repo: { full_name: headRepo } },
  base: { ref: "release", repo: { full_name: "o/r" } }, html_url: `https://github.com/o/r/pull/${n}`, title: `PR ${n} title`,
});

/** GitHub stub; everything else (the MCP client's own HTTP) passes through. */
function stubGitHub() {
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://api.github.com/")) return real(input, init);
    if (url.endsWith("/pulls/42")) return json(200, pr(42, "fix/nginx-pin", "o/r"));
    if (url.endsWith("/pulls/43")) return json(200, pr(43, "patch-1", "stranger/r"));
    if (url.includes("/git/ref/heads/fix%2Fhand-pushed")) return json(200, { object: { sha: "abc" } });
    if (url.includes("/git/ref/heads/")) return json(404, {});
    if (url.includes("/pulls?head=")) return json(200, []);
    return json(404, {});
  }));
}

const body = (res: { content: unknown }) => JSON.parse((res.content as Array<{ text: string }>)[0].text);
const text = (res: { content: unknown }) => JSON.stringify(res.content);

describe("MCP adoption", () => {
  let server: Server;
  let port: number;
  beforeEach(async () => {
    setCipher(new LocalAesCipher(KEY));
    ({ server, port } = await startApp());
    await queries.createUser({ id: "usr_bot", email: "bot@test.co", role: "bot" }).catch(() => {});
    await queries.upsertUserGitCredential("usr_bot", await new LocalAesCipher(KEY).encrypt("ghp_bot"));
    await queries.setAppSetting("default_repo_url", REPO);
    stubGitHub();
    vi.mocked(handbackChange).mockClear();
    // Never launch a real agent from a test (the in-process runner spawns claude on the host).
    vi.spyOn(AgentManager.prototype, "startAgent").mockResolvedValue(undefined as never);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); server?.close(); });

  it("create_agent adopt=<PR#> runs the agent ON the PR's head branch, records the PR, lands onto the PR base", async () => {
    const client = await connect(port, await mintToken("mcp,agent:create"));
    const res = await client.callTool({ name: "create_agent", arguments: { name: "bump nginx", prompt: "finish it", adopt: "#42" } });
    expect(res.isError).toBeFalsy();
    const out = body(res);
    expect(out.branch).toBe("fix/nginx-pin");
    expect(out.pr_number).toBe(42);
    const a = await queries.getAgent(out.agent_id);
    expect(a!.branch).toBe("fix/nginx-pin");
    expect(a!.adopted_ref).toBe("PR #42");
    expect(a!.pr_number).toBe(42);
    expect(a!.repo_ref).toBe("release");
    await client.close();
  });

  it("create_agent adopt=<branch> uses that branch; an unpushed branch is a clear error", async () => {
    const client = await connect(port, await mintToken("mcp,agent:create"));
    const ok = body(await client.callTool({ name: "create_agent", arguments: { name: "x", prompt: "y", adopt: "fix/hand-pushed" } }));
    expect((await queries.getAgent(ok.agent_id))!.branch).toBe("fix/hand-pushed");

    const missing = await client.callTool({ name: "create_agent", arguments: { name: "x", prompt: "y", adopt: "fix/local-only" } });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("not found on the remote");
    await client.close();
  });

  it("refuses to adopt a fork PR", async () => {
    const client = await connect(port, await mintToken("mcp,agent:create,review:create"));
    const res = await client.callTool({ name: "create_agent", arguments: { name: "x", prompt: "y", adopt: "https://github.com/o/r/pull/43" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("fork");
    const res2 = await client.callTool({ name: "adopt_change", arguments: { ref: "43" } });
    expect(res2.isError).toBe(true);
    await client.close();
  });

  it("adopt_change records the change with NO agent run and hands it to gates + review", async () => {
    const client = await connect(port, await mintToken("mcp,agent:create,review:create"));
    const res = await client.callTool({ name: "adopt_change", arguments: { ref: "fix/hand-pushed" } });
    expect(res.isError).toBeFalsy();
    const out = body(res);
    expect(out.reused_existing_change).toBe(false);
    expect(out.review_agent_id).toBe("ag_rev");
    const a = await queries.getAgent(out.agent_id);
    expect(a!.branch).toBe("fix/hand-pushed");
    expect(a!.adopted_ref).toBe("fix/hand-pushed");
    expect(a!.state).toBe("pending"); // never started — handback (mocked here) completes it
    expect(vi.mocked(handbackChange)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handbackChange).mock.calls[0][1].id).toBe(out.agent_id);

    // Adopting the same branch again reuses the change rather than duplicating it.
    const again = body(await client.callTool({ name: "adopt_change", arguments: { ref: "fix/hand-pushed" } }));
    expect(again.agent_id).toBe(out.agent_id);
    expect(again.reused_existing_change).toBe(true);
    await client.close();
  });

  it("adopt_change needs both agent:create and review:create", async () => {
    const client = await connect(port, await mintToken("mcp,agent:create"));
    const res = await client.callTool({ name: "adopt_change", arguments: { ref: "fix/hand-pushed" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("review:create");
    await client.close();
  });
});
