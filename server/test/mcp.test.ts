import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import session from "express-session";
import type { Server } from "node:http";
import { EventEmitter } from "node:events";
import { AgentManager } from "../src/agent/manager.js";
import { createRouter } from "../src/api/router.js";
import * as queries from "../src/db/queries.js";
import { generateToken } from "../src/api/tokens.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Real HTTP: the MCP client speaks Streamable HTTP to a listening app.
function startApp(): Promise<{ server: Server; port: number }> {
  const manager = new AgentManager(new EventEmitter());
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "s", resave: false, saveUninitialized: false }));
  app.use(createRouter(manager));
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, port });
    });
  });
}

async function mintMcpToken(scopes = "mcp,review:create,review:read"): Promise<string> {
  await queries.createUser({ id: "usr_bot", email: "bot@test.co", role: "bot" }).catch(() => {});
  const { token, hash } = generateToken();
  await queries.createApiToken({ user_id: "usr_bot", name: "bot", token_hash: hash, scopes });
  return token;
}

async function connect(port: number, token: string): Promise<Client> {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

describe("MCP surface", () => {
  let server: Server;
  let port: number;
  beforeEach(async () => { ({ server, port } = await startApp()); });
  afterEach(() => { server?.close(); });

  it("exposes the review tools to an authenticated MCP client", async () => {
    const client = await connect(port, await mintMcpToken());
    const tools = new Set((await client.listTools()).tools.map((t) => t.name));
    for (const t of [
      "create_agent", "list_agents", "get_agent", "get_agent_events",
      "start_agent", "pause_agent", "resume_agent", "kill_agent", "send_input",
      "list_pending_permissions", "resolve_permission",
      "list_reviewable_changes", "request_review", "run_checks", "get_verdict",
      "list_deploys", "get_deploy_verdict",
    ]) expect(tools.has(t)).toBe(true);
    await client.close();
  });

  it("list_deploys + get_deploy_verdict return the PRE-DEPLOY review (not just code review)", async () => {
    const repo = "https://github.com/o/r.git";
    await queries.insertPipelineRun({ id: "run_dep", repoUrl: repo, ref: "main", phase: "deploy", status: "pending_review" });
    await queries.setPipelineReview("run_dep", "RECOMMENDATION: hold\nASSESSMENT: worker image build is uncertain.", "hold");
    await queries.insertPipelineRun({ id: "run_gt", repoUrl: repo, ref: "main", phase: "test", status: "passed", deployGateRunId: "run_dep" });

    const client = await connect(port, await mintMcpToken());

    const list = await client.callTool({ name: "list_deploys", arguments: {} });
    expect(JSON.stringify(list.content)).toContain("run_dep");
    expect(JSON.stringify(list.content)).toContain("hold");

    // by run_id
    const byId = await client.callTool({ name: "get_deploy_verdict", arguments: { run_id: "run_dep" } });
    const s = JSON.stringify(byId.content);
    expect(s).toContain("hold");
    expect(s).toContain("worker image build is uncertain");
    expect(s).toContain("main_tests"); // includes the gate results
    expect(s).toContain("passed");

    // by repo/ref (finds the in-flight deploy)
    const byRepo = await client.callTool({ name: "get_deploy_verdict", arguments: { repo_url: repo, ref: "main" } });
    expect(JSON.stringify(byRepo.content)).toContain("hold");

    await client.close();
  });

  it("request_review → get_verdict flows through the reviews entity", async () => {
    // an agent with a repo/branch/owner to review
    await queries.createUser({ id: "usr_bot", email: "bot@test.co", role: "bot" }).catch(() => {});
    await queries.insertAgent({
      id: "ag_target", name: "add feature", prompt: "do it", cwd: "/work", state: "completed",
      priority: "medium", permission_mode: "default", sdk_session_id: null, model: "claude-sonnet-5",
      max_turns: null, max_budget_usd: null, error_message: null, supervisor_instructions: "",
      permission_policy: "auto", created_by_user_id: "usr_bot", repo_url: "https://github.com/o/r.git",
      repo_ref: "main", branch: "feat/x", service_account: null, worker_image: null, adopted_ref: null,
    });
    const client = await connect(port, await mintMcpToken());

    // list shows it
    const list = await client.callTool({ name: "list_reviewable_changes", arguments: {} });
    expect(JSON.stringify(list.content)).toContain("ag_target");

    // request_review opens a running review row (the pod itself won't run in-test,
    // but the entity + dispatch orchestration is what we're asserting)
    const req = await client.callTool({ name: "request_review", arguments: { agent_id: "ag_target" } });
    expect(JSON.stringify(req.content)).toContain("running");
    const rows = await queries.getReviewsForAgent("ag_target");
    expect(rows).toHaveLength(1);
    expect(rows[0].requested_by).toBe("usr_bot");

    // get_verdict reflects the open review
    const verdict = await client.callTool({ name: "get_verdict", arguments: { agent_id: "ag_target" } });
    expect(JSON.stringify(verdict.content)).toContain("running");
    await client.close();
  });

  it("create_agent creates + starts an agent when the token has agent:create", async () => {
    await queries.setAppSetting("default_repo_url", "https://github.com/o/r.git");
    const client = await connect(port, await mintMcpToken("mcp,agent:create"));
    const res = await client.callTool({
      name: "create_agent",
      arguments: { name: "fix the bug", prompt: "fix it", branch_type: "fix" },
    });
    const txt = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(txt.agent_id).toMatch(/^ag_/);
    const created = await queries.getAgent(txt.agent_id);
    expect(created!.created_by_user_id).toBe("usr_bot"); // runs as the token principal
    expect(created!.repo_url).toBe("https://github.com/o/r.git");
    await client.close();
  });

  it("create_agent is denied without the agent:create scope", async () => {
    const client = await connect(port, await mintMcpToken("mcp,review:read"));
    const res = await client.callTool({ name: "create_agent", arguments: { name: "x", prompt: "y" } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("agent:create");
    await client.close();
  });

  it("rejects a token without the mcp scope", async () => {
    const token = await mintMcpToken("review:read"); // no mcp scope
    await expect(connect(port, token)).rejects.toThrow();
  });

  it("rejects a bogus token", async () => {
    await expect(connect(port, "dbt_bogus")).rejects.toThrow();
  });
});
