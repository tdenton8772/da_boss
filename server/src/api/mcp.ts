/**
 * MCP surface — the AGENT-facing way to drive review (the human surface is REST +
 * the button). Remote Streamable HTTP at POST /mcp, authenticated by a Bearer API
 * token carrying the `mcp` scope; the connection acts as that token's principal.
 * Tools sit on the SAME core (dispatchReviewAgent + the reviews entity) as REST.
 * Stateless: each request builds a fresh server bound to the caller's principal.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Request, Response, NextFunction } from "express";
import type { AgentManager } from "../agent/manager.js";
import type { AuthedUser } from "../types/auth.js";
import * as queries from "../db/queries.js";
import { dispatchReviewAgent } from "../pipeline/review-agent.js";
import { deployAgentBranch } from "../pipeline/deploy-agent.js";
import { runTestPhasesForAgent } from "../pipeline/service.js";
import { resolveBearer } from "./tokens.js";
import { logger } from "../utils/logger.js";

/** Gate /mcp on a Bearer token with the `mcp` scope. Token-only (no sessions). */
export function requireMcpAuth(req: Request, res: Response, next: NextFunction): void {
  resolveBearer(req)
    .then((user) => {
      if (!user) { res.status(401).json({ error: "MCP requires a Bearer API token" }); return; }
      const scopes = user.scopes ?? [];
      if (!scopes.includes("mcp") && !scopes.includes("*")) {
        res.status(403).json({ error: "This token lacks the 'mcp' scope" });
        return;
      }
      req.user = user;
      next();
    })
    .catch((err) => {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, "MCP auth failed");
      res.status(500).json({ error: "Auth error" });
    });
}

const asText = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const asError = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });

/** Per-tool scope enforcement. /mcp only requires the 'mcp' scope to connect;
 *  each tool additionally requires its own scope, so a review-only token can't
 *  create agents (and vice versa). Returns an error result, or null if allowed. */
function denyIfMissing(principal: AuthedUser, scope: string): ReturnType<typeof asError> | null {
  const s = principal.scopes ?? [];
  return s.includes(scope) || s.includes("*") ? null : asError(`This token lacks the '${scope}' scope.`);
}

function buildMcpServer(manager: AgentManager, principal: AuthedUser): McpServer {
  const server = new McpServer({ name: "da_boss-review", version: "1.0.0" });

  server.registerTool(
    "list_reviewable_changes",
    {
      description:
        "List agents whose change can be reviewed (has a repo + branch, and isn't itself a review). Returns id, name, pr_number, state, and the current recommendation if a review already ran.",
      inputSchema: {},
    },
    async () => {
      const deny = denyIfMissing(principal, "review:read"); if (deny) return deny;
      const agents = await queries.getAllAgents();
      const rows = agents
        .filter((a) => a.repo_url && a.branch && !a.review_of_agent_id)
        .map((a) => ({ id: a.id, name: a.name, pr_number: a.pr_number, state: a.state, recommendation: a.recommendation }));
      return asText(rows);
    }
  );

  server.registerTool(
    "create_agent",
    {
      description:
        "Create and START a da_boss agent to do a task (make a change, fix a bug, write a test, etc.). It runs in its own isolated pod on YOUR principal's Claude + git credentials, on its own branch, and da_boss opens a PR when it pushes. Returns the agent id — track it with list_agents / get_agent. Requires the 'agent:create' scope.",
      inputSchema: {
        name: z.string().describe("Short name for the task (used in the branch name)"),
        prompt: z.string().describe("The full task instructions for the agent"),
        repo_url: z.string().optional().describe("Git repo URL. Defaults to the server's configured default repo."),
        repo_ref: z.string().optional().describe("Base ref to branch from (default: main / the default repo ref)."),
        branch_type: z.string().optional().describe("feat | fix | chore | docs | refactor | test (default feat)"),
        model: z.string().optional().describe("Defaults to claude-opus-4-8 (code work). Options: claude-opus-4-8 | claude-fable-5 | claude-sonnet-5 | claude-haiku-4-5-20251001"),
        max_budget_usd: z.number().optional().describe("Optional spend cap in USD."),
        size: z.enum(["s", "m", "l", "xl"]).optional().describe("Pod t-shirt size — s/m/l/xl. Omit to let the supervisor assess the task and size it."),
      },
    },
    async (args) => {
      const deny = denyIfMissing(principal, "agent:create"); if (deny) return deny;
      const repoUrl = args.repo_url ?? (await queries.getAppSetting("default_repo_url")) ?? undefined;
      const repoRef = args.repo_ref ?? (await queries.getAppSetting("default_repo_ref")) ?? undefined;
      if (!repoUrl) return asError("No repo_url given and no default repo configured. Pass repo_url.");
      try {
        const agent = await manager.createAgent(
          {
            name: args.name,
            prompt: args.prompt,
            cwd: "/work",
            repo_url: repoUrl,
            repo_ref: repoRef,
            branch_type: args.branch_type ?? "feat",
            model: args.model,
            max_budget_usd: args.max_budget_usd,
            size: args.size,
          },
          principal.userId,
          principal.email?.split("@")[0] ?? null
        );
        await manager.startAgent(agent.id);
        return asText({ agent_id: agent.id, state: "pending", branch: agent.branch });
      } catch (err) {
        return asError(`Couldn't create the agent: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  server.registerTool(
    "get_agent",
    {
      description: "Get an agent's current state, PR number, and review recommendation. Use to track an agent created with create_agent.",
      inputSchema: { agent_id: z.string() },
    },
    async ({ agent_id }) => {
      const deny = denyIfMissing(principal, "review:read"); if (deny) return deny;
      const a = await queries.getAgent(agent_id);
      if (!a) return asError(`No agent ${agent_id}`);
      return asText({ id: a.id, name: a.name, state: a.state, pr_number: a.pr_number, branch: a.branch, recommendation: a.recommendation });
    }
  );

  server.registerTool(
    "request_review",
    {
      description:
        "Queue a READ-ONLY review of an agent's change. The review runs asynchronously in its own pod; its verdict lands later — poll get_verdict. Returns the review id + review agent id.",
      inputSchema: { agent_id: z.string().describe("The id of the agent whose change to review") },
    },
    async ({ agent_id }) => {
      const deny = denyIfMissing(principal, "review:create"); if (deny) return deny;
      const agent = await queries.getAgent(agent_id);
      if (!agent) return asError(`No agent ${agent_id}`);
      if (await queries.hasActiveReviewAgent(agent.id)) return asError("A review is already in progress for this change.");
      const reviewAgentId = await dispatchReviewAgent(manager, agent, principal.userId);
      if (!reviewAgentId) return asError("Couldn't queue a review — the agent has no repo/branch/owner.");
      const review = await queries.getReviewByReviewAgent(reviewAgentId);
      return asText({ review_id: review?.id ?? null, review_agent_id: reviewAgentId, status: "running" });
    }
  );

  server.registerTool(
    "deploy_branch",
    {
      description:
        "Deploy an agent's CURRENT branch to staging WITHOUT merging — bypasses the main-only gate so a human can see the build before the PR merges. Ships the branch to the SHARED staging env (replacing what's there until main is redeployed). Returns the deploy run id + the deploy-manager agent id (poll get_agent_events on it to watch progress). Requires the repo to define an agent-managed `deploy` phase.",
      inputSchema: { agent_id: z.string().describe("The agent whose branch to deploy to staging") },
    },
    async ({ agent_id }) => {
      const deny = denyIfMissing(principal, "agent:control"); if (deny) return deny;
      const agent = await queries.getAgent(agent_id);
      if (!agent) return asError(`No agent ${agent_id}`);
      try {
        const { runId, agentId } = await deployAgentBranch(manager, agent);
        if (agentId) await queries.insertAgentEvent(agent_id, "message", { role: "system", content: `🌿 Deploying this branch to staging (bypassing main) — [watch it](/agent/${agentId}).` }).catch(() => {});
        return asText({ run_id: runId, deploy_agent_id: agentId ?? null, note: "Branch deploying to staging; watch the deploy agent for progress." });
      } catch (err) {
        const e = err as { status?: number; message?: string };
        return asError(e.message || String(err));
      }
    }
  );

  server.registerTool(
    "run_checks",
    {
      description:
        "Re-run the repo's pipeline gates (ALL test phases) on an agent's CURRENT branch WITHOUT merging — use after you pushed a fix to re-validate. Runs asynchronously; when the gates finish the PR is re-gated (comment + marked ready on green). It does NOT auto-dispatch a review — call request_review separately when you want the deep review. Returns the runs started (or an error if the repo declares no test phase).",
      inputSchema: { agent_id: z.string().describe("The agent whose current branch to re-check") },
    },
    async ({ agent_id }) => {
      const deny = denyIfMissing(principal, "review:create"); if (deny) return deny;
      const agent = await queries.getAgent(agent_id);
      if (!agent) return asError(`No agent ${agent_id}`);
      try {
        const runs = await runTestPhasesForAgent(agent);
        return asText({ runs, note: "Gates re-running on the current branch; the PR re-gates and a fresh review dispatches when they finish." });
      } catch (err) {
        const e = err as { status?: number; message?: string };
        return asError(e.message || String(err));
      }
    }
  );

  // ── Agent lifecycle + monitoring (parity with the UI) ──────────────
  server.registerTool(
    "list_agents",
    { description: "List all agents with their state, PR number, and review recommendation.", inputSchema: {} },
    async () => {
      const deny = denyIfMissing(principal, "agent:read"); if (deny) return deny;
      const rows = (await queries.getAllAgents()).map((a) => ({
        id: a.id, name: a.name, state: a.state, pr_number: a.pr_number, recommendation: a.recommendation,
        review_of: a.review_of_agent_id, repo_url: a.repo_url,
      }));
      return asText(rows);
    }
  );

  server.registerTool(
    "get_agent_events",
    {
      description: "Read an agent's recent trace — its messages, tool calls, and system events (newest first). Use to watch what an agent is doing or read a review's reasoning.",
      inputSchema: { agent_id: z.string(), limit: z.number().optional().describe("max events (default 40)") },
    },
    async ({ agent_id, limit }) => {
      const deny = denyIfMissing(principal, "agent:read"); if (deny) return deny;
      const events = await queries.getAgentEvents(agent_id, Math.min(limit ?? 40, 200));
      const out = events.map((e) => {
        let d: unknown = e.data;
        try { d = typeof e.data === "string" ? JSON.parse(e.data) : e.data; } catch { /* keep raw */ }
        return { type: e.type, at: e.created_at, data: d };
      });
      return asText(out);
    }
  );

  const control = (
    name: string,
    description: string,
    run: (agentId: string) => Promise<unknown>
  ) =>
    server.registerTool(name, { description, inputSchema: { agent_id: z.string() } }, async ({ agent_id }) => {
      const deny = denyIfMissing(principal, "agent:control"); if (deny) return deny;
      if (!(await queries.getAgent(agent_id))) return asError(`No agent ${agent_id}`);
      try { await run(agent_id); return asText({ ok: true, agent_id }); }
      catch (err) { return asError(err instanceof Error ? err.message : String(err)); }
    });

  control("start_agent", "Start (or restart) a pending/stopped agent.", (id) => manager.startAgent(id));
  control("pause_agent", "Pause a running agent (interrupt it without losing its work).", (id) => manager.pauseAgent(id));
  control("resume_agent", "Resume a paused agent.", (id) => manager.resumeAgent(id));
  control("kill_agent", "Kill an agent — terminates its pod. Not reversible for that run.", (id) => manager.killAgent(id));

  server.registerTool(
    "send_input",
    {
      description: "Send a message to a running agent (steer it, answer a question, give more instructions).",
      inputSchema: { agent_id: z.string(), message: z.string() },
    },
    async ({ agent_id, message }) => {
      const deny = denyIfMissing(principal, "agent:control"); if (deny) return deny;
      if (!(await queries.getAgent(agent_id))) return asError(`No agent ${agent_id}`);
      try { await manager.sendInput(agent_id, message); return asText({ ok: true }); }
      catch (err) { return asError(err instanceof Error ? err.message : String(err)); }
    }
  );

  server.registerTool(
    "list_pending_permissions",
    { description: "List tool-call permission requests awaiting a human/agent decision (agent, tool, and what it wants to do).", inputSchema: {} },
    async () => {
      const deny = denyIfMissing(principal, "agent:read"); if (deny) return deny;
      const rows = (await queries.getPendingPermissions()).map((p) => ({ id: p.id, agent_id: p.agent_id, tool: p.tool_name, input: p.tool_input }));
      return asText(rows);
    }
  );

  server.registerTool(
    "resolve_permission",
    {
      description: "Approve or deny a pending tool-call permission request (from list_pending_permissions).",
      inputSchema: { permission_id: z.number(), decision: z.enum(["approve", "deny"]), answer: z.string().optional() },
    },
    async ({ permission_id, decision, answer }) => {
      const deny = denyIfMissing(principal, "agent:control"); if (deny) return deny;
      const ok = await manager.resolvePermission(permission_id, decision === "approve" ? "approved" : "denied", answer);
      return ok ? asText({ ok: true }) : asError("Permission request not found or already resolved.");
    }
  );

  server.registerTool(
    "get_verdict",
    {
      description:
        "Get the CODE-REVIEW verdict for an agent's change (from request_review). status is running|done|error; recommendation is merge|fix|hold; rationale is the reviewer's assessment once available. For the PRE-DEPLOY review of a deploy, use get_deploy_verdict instead.",
      inputSchema: { agent_id: z.string().describe("The reviewed agent's id") },
    },
    async ({ agent_id }) => {
      const reviews = await queries.getReviewsForAgent(agent_id);
      if (!reviews.length) return asText("No review found for this agent. Call request_review first.");
      const r = reviews[0];
      return asText({ status: r.status, recommendation: r.recommendation, rationale: r.rationale, review_agent_id: r.review_agent_id, requested_by: r.requested_by });
    }
  );

  server.registerTool(
    "list_deploys",
    {
      description:
        "List deploys awaiting a human decision (the deploy review has run → pending_approval). Returns each deploy run's id, repo, ref, the pre-deploy review recommendation (approve|hold|reject) and a snippet of its assessment. Use get_deploy_verdict for the full review + the main-test results.",
      inputSchema: {},
    },
    async () => {
      const deny = denyIfMissing(principal, "review:read"); if (deny) return deny;
      const deploys = await queries.getReviewQueueDeploys();
      return asText(deploys.map((d) => ({
        run_id: d.id, repo_url: d.repo_url, git_ref: d.git_ref, status: d.status,
        recommendation: d.recommendation, assessment: (d.review || "").slice(0, 400), owner_email: d.owner_email,
      })));
    }
  );

  server.registerTool(
    "get_deploy_verdict",
    {
      description:
        "Get the PRE-DEPLOY review verdict for a deploy. Give run_id (from list_deploys) OR repo_url (+ ref, default main) to find the in-flight deploy. Returns status (pending_review = tests still running on main, pending_approval = reviewed & awaiting a human, passed/failed = done), recommendation (approve|hold|reject), the full review, and the main-test gate results.",
      inputSchema: {
        run_id: z.string().optional().describe("The deploy run id (from list_deploys)"),
        repo_url: z.string().optional().describe("Repo URL — used with ref to find the in-flight deploy if run_id is omitted"),
        ref: z.string().optional().describe("Git ref (default 'main'), used with repo_url"),
      },
    },
    async ({ run_id, repo_url, ref }) => {
      const deny = denyIfMissing(principal, "review:read"); if (deny) return deny;
      const run = run_id
        ? await queries.getPipelineRun(run_id)
        : repo_url ? await queries.getActiveDeployRun(repo_url, ref || "main") : undefined;
      if (!run) return asError(run_id ? "No deploy run with that id." : repo_url ? "No in-flight deploy for that repo/ref." : "Provide run_id, or repo_url (+ ref).");
      if (run.phase !== "deploy") return asError(`Run ${run.id} is a '${run.phase}' run, not a deploy. Use get_verdict for code reviews.`);
      const gate = await queries.getDeployGateTests(run.id);
      return asText({
        run_id: run.id, repo_url: run.repo_url, git_ref: run.git_ref, status: run.status,
        recommendation: run.recommendation, review: run.review,
        main_tests: gate.map((t) => ({ phase: t.phase, status: t.status, exit_code: t.exit_code })),
      });
    }
  );

  return server;
}

/** Express handler for POST /mcp — stateless Streamable HTTP. */
export function mcpHandler(manager: AgentManager) {
  return async (req: Request, res: Response): Promise<void> => {
    const server = buildMcpServer(manager, req.user!);
    // Stateless + plain-JSON responses (no SSE): our tools are request/response
    // with no server-initiated stream, so JSON works — and it rides through the
    // existing `/daboss/` nginx proxy (which does NOT set proxy_buffering off,
    // unlike the app's own `/mcp` route) with no shared-infra change. da_boss's
    // MCP is reached at /daboss/mcp; the app's Downstream MCP stays at /mcp — no collision.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, "MCP request failed");
      if (!res.headersSent) res.status(500).json({ error: "MCP error" });
    }
  };
}
