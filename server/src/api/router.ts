import { Router } from "express";
import { existsSync, statSync } from "node:fs";
import type { AgentManager } from "../agent/manager.js";
import type { AgentRecord } from "../types/agent.js";
import { deleteAgentRemoteBranch, launchStateCleanupPod, launchPipelineRunner } from "../agent/pod-dispatcher.js";
import { parsePipeline } from "../pipeline/config.js";
import * as pipelineService from "../pipeline/service.js";
import { maybeProposeDeploy } from "../pipeline/completion.js";
import { dispatchDeployAgent, deployAgentBranch } from "../pipeline/deploy-agent.js";
import { dispatchReviewAgent } from "../pipeline/review-agent.js";
import { mergePr, updateBranch, getPullRequest, getBranchHead, markReadyForReview } from "../forge/github.js";
import { syncMainIntoBranch } from "../forge/sync-branch.js";
import { nanoid } from "nanoid";
import { SUPERVISOR_CRED_SETTING } from "../supervisor/credential.js";
import { scenarios } from "../testing/scenarios.js";
import { armLandConflict } from "../testing/land-conflict.js";
import { TEST_USER_ID, ensureTestUser } from "../testing/user.js";

const FIXTURE_REPO = "https://github.com/tdenton8772/daboss-e2e-fixture";
import type { CreateAgentRequest } from "../types/agent.js";
import * as queries from "../db/queries.js";
import { requireAuth, requireAdmin, handleRegister, handleLogin, handleLogout, handleMe } from "./auth.js";
import { handleCreateToken, handleListTokens, handleRevokeToken } from "./tokens.js";
import { requireMcpAuth, mcpHandler } from "./mcp.js";
import { getConfiguredPresets } from "../agent/sizing.js";
import { getCipher } from "../crypto/cipher.js";
import { config } from "../config.js";
import { AGENT_TEMPLATES } from "../agent/templates.js";

const DEFAULT_REPO_URL_SETTING = "default_repo_url";
const DEFAULT_REPO_REF_SETTING = "default_repo_ref";

/** Human-readable actor for the visible trace (who clicked). The audit log stores
 *  the user id separately. */
function actorOf(req: { user?: { email?: string; name?: string } }): string {
  return req.user?.email || req.user?.name || "someone";
}

export function createRouter(manager: AgentManager): Router {
  const router = Router();

  // ── Auth ──────────────────────────────────────────────
  router.post("/api/auth/register", handleRegister);
  router.post("/api/auth/login", handleLogin);
  router.post("/api/auth/logout", handleLogout);
  router.get("/api/auth/me", handleMe);

  // MCP surface (agent-facing) — Bearer token + 'mcp' scope, its own auth (not the
  // session-based /api requireAuth). Same review core as the REST endpoints.
  router.post("/mcp", requireMcpAuth, mcpHandler(manager));

  // All routes below require an authenticated user (req.user is set)
  router.use("/api", requireAuth);

  // ── API tokens — headless auth for the MCP surface. Minting/revoking is
  //    session-only (these paths aren't in the token allow-list → default-deny). ──
  router.post("/api/tokens", handleCreateToken);
  router.get("/api/tokens", handleListTokens);
  router.delete("/api/tokens/:id", handleRevokeToken);

  // ── Pod t-shirt size presets (admin-configurable resource map) ──
  router.get("/api/admin/size-presets", requireAdmin, async (_req, res) => {
    res.json(await getConfiguredPresets());
  });
  router.put("/api/admin/size-presets", requireAdmin, async (req, res) => {
    const presets = req.body as Record<string, unknown>;
    // Minimal shape check: each size must have requests + limits objects.
    for (const s of ["s", "m", "l", "xl"]) {
      const p = presets?.[s] as { requests?: unknown; limits?: unknown } | undefined;
      if (!p || typeof p.requests !== "object" || typeof p.limits !== "object") {
        res.status(400).json({ error: `size '${s}' must have { requests, limits }` });
        return;
      }
    }
    await queries.setAppSetting("size_presets", JSON.stringify(presets));
    await queries.insertAuditLog(req.ip || null, "size_presets.update", "settings", "size_presets", null, req.user?.userId);
    res.json({ ok: true });
  });

  // ── Per-user Claude credential (write-only vault) ─────
  router.get("/api/me/credential", async (req, res) => {
    const cred = await queries.getUserCredential(req.user!.userId);
    // status only — never the token itself
    res.json({ hasCredential: !!cred, kind: cred?.kind ?? null, updatedAt: cred?.updated_at ?? null });
  });

  router.post("/api/me/credential", async (req, res) => {
    try {
      const { kind, token } = req.body as { kind?: string; token?: string };
      if (!token || typeof token !== "string" || token.trim().length < 10) {
        res.status(400).json({ error: "A valid token is required" });
        return;
      }
      const k = kind === "anthropic_api_key" ? "anthropic_api_key" : "claude_oauth_token";
      const blob = await getCipher().encrypt(token.trim());
      await queries.upsertUserCredential(req.user!.userId, k, blob);
      await queries.insertAuditLog(
        req.ip || null, "credential.set", "user", req.user!.userId, k, req.user!.userId
      );
      res.json({ ok: true, kind: k });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete("/api/me/credential", async (req, res) => {
    await queries.deleteUserCredential(req.user!.userId);
    await queries.insertAuditLog(req.ip || null, "credential.delete", "user", req.user!.userId, undefined, req.user!.userId);
    res.json({ ok: true });
  });

  // ── Per-user git credential (PAT) ─────────────────────
  router.get("/api/me/git-credential", async (req, res) => {
    const cred = await queries.getUserGitCredential(req.user!.userId);
    res.json({ hasCredential: !!cred, updatedAt: cred?.updated_at ?? null });
  });

  router.post("/api/me/git-credential", async (req, res) => {
    try {
      const { token } = req.body as { token?: string };
      if (!token || typeof token !== "string" || token.trim().length < 10) {
        res.status(400).json({ error: "A valid git token is required" });
        return;
      }
      const blob = await getCipher().encrypt(token.trim());
      await queries.upsertUserGitCredential(req.user!.userId, blob);
      await queries.insertAuditLog(req.ip || null, "git_credential.set", "user", req.user!.userId, undefined, req.user!.userId);
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete("/api/me/git-credential", async (req, res) => {
    await queries.deleteUserGitCredential(req.user!.userId);
    await queries.insertAuditLog(req.ip || null, "git_credential.delete", "user", req.user!.userId, undefined, req.user!.userId);
    res.json({ ok: true });
  });

  // ── Filesystem browsing ────────────────────────────────
  router.get("/api/browse", async (req, res) => {
    const dir = (req.query.dir as string) || process.env.HOME || "/";
    const fs = await import("node:fs/promises");
    const path = await import("node:path");

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => ({
          name: e.name,
          path: path.join(dir, e.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const parent = path.dirname(dir);
      res.json({ current: dir, parent: parent !== dir ? parent : null, dirs });
    } catch {
      res.status(400).json({ error: "Cannot read directory" });
    }
  });

  // ── File operations ───────────────────────────────────

  // View file contents (no truncation)
  router.get("/api/file/view", async (req, res) => {
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    try {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const stat = await fs.stat(filePath);
      if (stat.size > 50 * 1024 * 1024) {
        res.status(400).json({ error: "File too large (>50MB). Use download instead." });
        return;
      }
      const content = await fs.readFile(filePath, "utf-8");
      const ext = path.extname(filePath).toLowerCase();
      const isJson = ext === ".json" || ext === ".jsonl";
      res.json({
        path: filePath,
        name: path.basename(filePath),
        size: stat.size,
        ext,
        isJson,
        content,
      });
    } catch (err) {
      res.status(404).json({ error: "File not found or not readable" });
    }
  });

  // Download file
  router.get("/api/file/download", async (req, res) => {
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    try {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      await fs.access(filePath);
      const name = path.basename(filePath);
      res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
      const { createReadStream } = await import("node:fs");
      createReadStream(filePath).pipe(res);
    } catch {
      res.status(404).json({ error: "File not found" });
    }
  });

  // Upload file to a directory
  router.post("/api/file/upload", async (req, res) => {
    const targetDir = req.query.dir as string;
    const filename = req.query.name as string;
    if (!targetDir || !filename) {
      res.status(400).json({ error: "dir and name query params are required" });
      return;
    }
    try {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const targetPath = path.join(targetDir, filename);
      // Read raw body
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      await fs.writeFile(targetPath, Buffer.concat(chunks));
      res.json({ ok: true, path: targetPath, size: Buffer.concat(chunks).length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  // List files in a directory (extends browse to include files)
  router.get("/api/file/list", async (req, res) => {
    const dir = (req.query.dir as string) || "/tmp";
    const pattern = (req.query.pattern as string) || "";
    try {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files = entries
        .filter((e) => e.isFile() && (!pattern || e.name.includes(pattern)))
        .map((e) => ({
          name: e.name,
          path: path.join(dir, e.name),
        }));
      // Get sizes
      const result = await Promise.all(
        files.map(async (f) => {
          try {
            const stat = await fs.stat(f.path);
            return { ...f, size: stat.size, modified: stat.mtime.toISOString() };
          } catch {
            return { ...f, size: 0, modified: "" };
          }
        })
      );
      result.sort((a, b) => b.modified.localeCompare(a.modified));
      res.json({ dir, files: result });
    } catch {
      res.status(400).json({ error: "Cannot read directory" });
    }
  });

  // ── Process & queue info ──────────────────────────────
  router.get("/api/processes", async (_req, res) => {
    res.json(await manager.getProcessInfo());
  });

  router.get("/api/queue", (_req, res) => {
    res.json(manager.getQueueInfo());
  });

  // ── Subagents ────────────────────────────────────────
  router.get("/api/agents/:id/subagents", (req, res) => {
    res.json(manager.getSubagents(req.params.id));
  });

  router.get("/api/subagent-transcript", async (req, res) => {
    const transcriptPath = req.query.path as string;
    if (!transcriptPath || !transcriptPath.endsWith(".jsonl")) {
      res.status(400).json({ error: "Invalid transcript path" });
      return;
    }
    try {
      const fs = await import("node:fs");
      const content = fs.readFileSync(transcriptPath, "utf-8");
      const messages: Array<{ role: string; content: string; timestamp?: string }> = [];
      for (const line of content.split("\n").filter(Boolean)) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === "assistant" && entry.message?.content) {
            const text = entry.message.content
              .filter((b: { type: string; text?: string }) => b.type === "text" && b.text)
              .map((b: { text: string }) => b.text)
              .join("\n");
            if (text) messages.push({ role: "assistant", content: text.substring(0, 2000) });

            const tools = entry.message.content
              .filter((b: { type: string; name?: string }) => b.type === "tool_use" && b.name)
              .map((b: { name: string; input?: Record<string, unknown> }) => {
                if (b.name === "Bash" && b.input?.command) return `**Bash**: \`${String(b.input.command).substring(0, 200)}\``;
                if (b.name === "Edit" && b.input?.file_path) return `**Edit**: \`${b.input.file_path}\``;
                if (b.name === "Write" && b.input?.file_path) return `**Write**: \`${b.input.file_path}\``;
                if (b.name === "Read" && b.input?.file_path) return `**Read**: \`${b.input.file_path}\``;
                return `**${b.name}**`;
              });
            for (const t of tools) messages.push({ role: "tool", content: t });
          }
        } catch { /* skip bad lines */ }
      }
      res.json(messages);
    } catch {
      res.json([]);
    }
  });

  // ── Agents ────────────────────────────────────────────
  router.get("/api/agents", async (req, res) => {
    // Hide hidden test-harness agents from the dashboard — unless an admin asks
    // for them (to review + prune).
    const includeTest = req.query.includeTest === "true" && req.user?.role === "admin";
    // Nest review + deploy sub-agents under the change they belong to instead of
    // cluttering the dashboard — they stay reachable via the change's links
    // ("🔍 review agent", "🚀 shipped in deploy"). ?includeSubagents=true unnests.
    const includeSubagents = req.query.includeSubagents === "true";
    const deployAgentIds = includeSubagents ? new Set<string>() : new Set(await queries.getDeployAgentIds());
    const agents = (await manager.getAllAgents()).filter(
      (a) =>
        (includeTest || a.created_by_user_id !== TEST_USER_ID) &&
        (includeSubagents || (!a.review_of_agent_id && !deployAgentIds.has(a.id)))
    );
    const tokenSummaries = await queries.getAgentTokenSummaries();
    const summaryMap = new Map(tokenSummaries.map((s) => [s.agent_id, s]));
    const testing = new Set(await queries.getAgentsWithActiveTestRuns());
    // In-flight deploy per repo/ref (the pre-claim gate) + the state of each change's
    // deploy agent (once claimed) → one coherent deploy status per change.
    const deployStatus = await queries.getActiveDeployStatusByRepoRef();
    const deployAgentStates = await queries.getAgentStatesByIds(
      agents.map((a) => a.deployed_by_agent_id).filter((x): x is string => !!x)
    );

    const enriched = agents.map((a) => ({
      ...a,
      testing: testing.has(a.id), // so the card shows one coherent status
      deploy_status: a.repo_url ? deployStatus.get(`${a.repo_url.replace(/\.git$/, "")}@${a.repo_ref || "main"}`) ?? null : null,
      deploy_agent_state: a.deployed_by_agent_id ? deployAgentStates.get(a.deployed_by_agent_id) ?? null : null,
      tokens: summaryMap.get(a.id) || {
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost_usd: 0,
      },
    }));

    res.json(enriched);
  });

  // Resolve an "adopt an existing PR/branch" reference the user typed on the
  // create form into a concrete head branch, validating it against the remote.
  // Accepts a branch name, a PR number (`17` / `#17`), or a PR URL. Adoption is
  // then a pure consequence of passing this branch as the agents.branch override.
  router.get("/api/forge/resolve-ref", async (req, res) => {
    const repo = String(req.query.repo || "").trim();
    const ref = String(req.query.ref || "").trim();
    if (!repo || !ref) { res.status(400).json({ error: "repo and ref are required" }); return; }
    const gc = await queries.getUserGitCredential(req.user!.userId);
    if (!gc) { res.status(400).json({ error: "Set a git credential first (Settings) so we can look up the branch/PR." }); return; }
    let token: string;
    try {
      token = await getCipher().decrypt({ ciphertext: gc.ciphertext, nonce: gc.nonce, keyRef: gc.key_ref });
    } catch {
      res.status(400).json({ error: "Could not decrypt your git credential." });
      return;
    }

    // Is this a PR reference (a #N / N number, or a .../pull/N URL) or a branch?
    const urlMatch = ref.match(/\/pull\/(\d+)/);
    const numMatch = ref.match(/^#?(\d+)$/);
    const prNumber = urlMatch ? Number(urlMatch[1]) : numMatch ? Number(numMatch[1]) : null;

    try {
      if (prNumber !== null) {
        const pr = await getPullRequest(repo, prNumber, token);
        if (!pr) { res.status(404).json({ error: `PR #${prNumber} not found in ${repo}.` }); return; }
        if (pr.state !== "open") { res.status(400).json({ error: `PR #${prNumber} is ${pr.state}, not open — can't adopt a closed/merged PR.` }); return; }
        // NOTE: pr.crossRepo flags a fork PR. We surface it (fork/headRepo below)
        // rather than hard-block: a fork PR is safe to REVIEW read-only, only
        // dangerous if its code reaches a test/deploy phase with privileged creds.
        // The proper handling (fetch refs/pull/N/head, review-only, no execute) is
        // a follow-up; for now the caller is told it's a fork so it can decide.
        res.json({ kind: "pr", branch: pr.head, prNumber: pr.number, prState: pr.state, prUrl: pr.url, prTitle: pr.title, adoptedRef: `PR #${pr.number}`, fork: pr.crossRepo, headRepo: pr.headRepo });
        return;
      }
      const head = await getBranchHead(repo, ref, token);
      if (!head) { res.status(404).json({ error: `Branch '${ref}' not found on the remote.` }); return; }
      res.json({ kind: "branch", branch: ref, adoptedRef: ref });
    } catch (err) {
      res.status(502).json({ error: `Forge lookup failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  router.post("/api/agents", (req, res) => {
    try {
      const body = req.body as CreateAgentRequest;
      if (!body.name || !body.prompt) {
        res.status(400).json({ error: "name and prompt are required" });
        return;
      }
      // Input validation
      if (body.name.length > 100) {
        res.status(400).json({ error: "Agent name must be 100 characters or less" });
        return;
      }
      if (body.prompt.length > 50_000) {
        res.status(400).json({ error: "Prompt must be 50,000 characters or less" });
        return;
      }
      // In pod mode the agent runs in its pod's /work — there is no boss-node
      // filesystem to point at, so cwd is just the in-pod path (default /work).
      // In host/dev mode cwd is a real local directory and must exist.
      if (config.agentExecution === "pod") {
        body.cwd = body.cwd || "/work";
      } else {
        if (!body.cwd) {
          res.status(400).json({ error: "cwd is required" });
          return;
        }
        if (!existsSync(body.cwd) || !statSync(body.cwd).isDirectory()) {
          res.status(400).json({ error: "Working directory does not exist or is not a directory" });
          return;
        }
      }
      const validModels = ["claude-opus-4-8", "claude-fable-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"];
      if (body.model && !validModels.includes(body.model)) {
        res.status(400).json({ error: `Invalid model. Must be one of: ${validModels.join(", ")}` });
        return;
      }

      const ip = req.ip || req.socket.remoteAddress || null;
      manager.createAgent(body, req.user?.userId, req.user?.email?.split("@")[0]).then(async (agent) => {
        await queries.insertAuditLog(ip, "agent.create", "agent", agent.id, agent.name, req.user?.userId);
        res.status(201).json(agent);
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) res.status(500).json({ error: message });
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // Kill ALL running agents and orphaned processes — before :id routes
  router.post("/api/agents/kill-all", async (req, res) => {
    try {
      const agents = await queries.getAllAgents();
      let killed = 0;
      for (const agent of agents) {
        if (["running", "waiting_permission", "waiting_input"].includes(agent.state)) {
          try {
            await manager.killAgent(agent.id);
            killed++;
          } catch { /* continue killing others */ }
        }
      }
      const orphans = await manager.killOrphanedProcesses();
      const ip = req.ip || req.socket.remoteAddress || null;
      await queries.insertAuditLog(ip, "agents.kill_all", null, null, JSON.stringify({ killed, orphans }));
      res.json({ ok: true, killed, orphans });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.get("/api/agents/:id", async (req, res) => {
    const agent = await manager.getAgent(req.params.id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const cost = await queries.getAgentTotalCost(agent.id);
    const testing = await queries.hasActiveTestRuns(agent.id);
    // A land in flight (rebase+retest after a Merge click) → keep Merge disabled.
    const landing = await queries.hasLandInFlight(agent.id);
    // A deploy already in flight for this repo+ref (proposed → gate tests → review →
    // awaiting approval → deploying). deploy_status drives a coherent label + the
    // Deploy button; deploy_pending keeps it from being re-proposed.
    const activeDeploy = agent.repo_url
      ? await queries.getActiveDeployRun(agent.repo_url, agent.repo_ref || "main")
      : undefined;
    const deploy_pending = !!activeDeploy;
    const deploy_status = activeDeploy?.status ?? null;
    // Once a deploy has CLAIMED this change, its status follows that deploy agent.
    const deploy_agent_state = agent.deployed_by_agent_id
      ? (await queries.getAgent(agent.deployed_by_agent_id))?.state ?? null
      : null;
    // Link to the review agent (its live trace) so the UI can offer "watch the review".
    const review_agent_id = await queries.getReviewAgentIdFor(agent.id);
    // Deploy manifest: if this is a deploy agent, what it shipped.
    const shipped = await queries.getShippedAgents(agent.id);
    res.json({ ...agent, total_cost_usd: cost, testing, landing, deploy_pending, deploy_status, deploy_agent_state, review_agent_id, shipped });
  });

  // Queue the standard review agent on demand (not just auto-after-tests). Same
  // reviewer that runs in the pipeline — reads the branch in depth, covers
  // correctness + security/operational risk, ends with a parsed RECOMMENDATION.
  router.post("/api/agents/:id/review", async (req, res) => {
    const agent = await queries.getAgent(req.params.id);
    if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
    if (!agent.repo_url || !agent.branch || !agent.created_by_user_id) {
      res.status(400).json({ error: "This agent has no repo/branch/owner to review." });
      return;
    }
    if (await queries.hasActiveReviewAgent(agent.id)) {
      res.status(409).json({ error: "A review is already in progress for this change." });
      return;
    }
    try {
      const reviewAgentId = await dispatchReviewAgent(manager, agent, req.user?.userId ?? null);
      if (!reviewAgentId) { res.status(400).json({ error: "Couldn't queue a review for this agent." }); return; }
      const ip = req.ip || req.socket.remoteAddress || null;
      await queries.insertAgentEvent(agent.id, "message", { role: "system", content: `👤 **${actorOf(req)}** queued a review.` });
      await queries.insertAuditLog(ip, "agent.review", "agent", agent.id, `queued review ${reviewAgentId} by ${actorOf(req)}`, req.user?.userId);
      res.status(202).json({ ok: true, reviewAgentId });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/agents/:id/start", async (req, res) => {
    try {
      await manager.startAgent(req.params.id);
      const ip = req.ip || req.socket.remoteAddress || null;
      await queries.insertAuditLog(ip, "agent.start", "agent", req.params.id);
      res.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  router.delete("/api/agents/:id", async (req, res) => {
    try {
      const agent = await queries.getAgent(req.params.id);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      // Kill if running
      if (["running", "waiting_permission", "waiting_input"].includes(agent.state)) {
        await manager.killAgent(req.params.id);
      }
      // Clean up the agent's remote branch (best-effort) unless asked to keep it.
      // Runs BEFORE the row is deleted so the sibling-branch check can see it.
      let branchCleanup: { deleted: boolean; branch?: string; reason?: string } | undefined;
      if (req.query.keepBranch !== "true") {
        branchCleanup = await deleteAgentRemoteBranch(agent);
        if (branchCleanup.deleted) {
          const ipB = req.ip || req.socket.remoteAddress || null;
          await queries.insertAuditLog(ipB, "agent.branch_delete", "agent", agent.id, branchCleanup.branch ?? null, agent.created_by_user_id ?? undefined);
        }
      }
      // Reclaim the agent's persisted state on the user's shard via a self-deleting
      // cleanup pod (the boss can't mount the RWO shard itself). Best-effort — the
      // worker's start-up reconciliation sweeps anything this misses.
      let stateCleanup = false;
      if (config.agentExecution === "pod") {
        stateCleanup = await launchStateCleanupPod(agent).catch(() => false);
      }
      await queries.deleteAgent(req.params.id);
      const ip = req.ip || req.socket.remoteAddress || null;
      await queries.insertAuditLog(ip, "agent.delete", "agent", req.params.id, agent.name);
      res.json({ ok: true, branchCleanup, stateCleanup });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  router.post("/api/agents/:id/pause", async (req, res) => {
    try {
      await manager.pauseAgent(req.params.id);
      res.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  router.post("/api/agents/:id/resume", async (req, res) => {
    try {
      await manager.resumeAgent(req.params.id);
      res.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  router.post("/api/agents/:id/fresh-start", async (req, res) => {
    try {
      const { prompt } = req.body as { prompt?: string };
      const agent = await queries.getAgent(req.params.id);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      // Clear the session ID so it starts fresh, update prompt if provided
      const { getPool } = await import("../db/index.js");
      await getPool().query(
        "UPDATE agents SET sdk_session_id = NULL, state = 'pending', error_message = NULL, prompt = $1, updated_at = now() WHERE id = $2",
        [prompt || agent.prompt, agent.id]
      );

      // Start it
      await manager.startAgent(agent.id);
      res.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  router.post("/api/agents/:id/compact", async (req, res) => {
    try {
      const agent = await queries.getAgent(req.params.id);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      if (!agent.sdk_session_id) {
        res.status(400).json({ error: "No session to compact" });
        return;
      }

      // Update state to show we're compacting
      await queries.updateAgentState(agent.id, agent.state as any, {
        error_message: "Compacting session...",
      });

      // Shell out to claude CLI to compact the session
      const { spawn } = await import("node:child_process");
      const { logger } = await import("../utils/logger.js");

      const claudePath = config.claudePath;
      const agentId = agent.id;
      const agentState = agent.state;

      // Run compaction in background with stdin closed
      const child = spawn(claudePath, [
        "-r", agent.sdk_session_id!,
        "-p", "/compact",
        "--output-format", "json",
        "--max-turns", "1",
      ], {
        cwd: agent.cwd,
        env: { ...process.env, HOME: process.env.HOME },
        stdio: ["ignore", "pipe", "pipe"],  // stdin closed, capture stdout/stderr
        timeout: 300_000, // 5 min timeout
      });

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

      child.on("close", async (code) => {
        if (code === 0) {
          await queries.updateAgentState(agentId, "paused" as any, {
            error_message: null,
          });
          queries.insertAgentEvent(agentId, "state_change", {
            from: agentState,
            to: "paused",
            reason: "Session compacted",
          });
          logger.info({ agentId, stdout: stdout.substring(0, 200) }, "Session compacted successfully");
        } else {
          const errDetail = stderr || stdout || `exit code ${code}`;
          await queries.updateAgentState(agentId, "failed" as any, {
            error_message: `Compaction failed (code ${code}): ${errDetail.substring(0, 300)}`,
          });
          logger.error({ agentId, code, stderr: stderr.substring(0, 500) }, "Compaction failed");
        }
      });

      child.on("error", async (err) => {
        await queries.updateAgentState(agentId, "failed" as any, {
          error_message: `Compaction failed: ${err.message}`,
        });
        logger.error({ agentId, err }, "Compaction spawn failed");
      });

      res.json({ ok: true, message: "Compaction started" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  router.post("/api/agents/:id/trim", async (req, res) => {
    try {
      const agent = await queries.getAgent(req.params.id);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      if (!agent.sdk_session_id) {
        res.status(400).json({ error: "No session to trim" });
        return;
      }

      const os = await import("node:os");
      const path = await import("node:path");

      // Find the session file
      const projectsDir = path.join(os.default.homedir(), ".claude", "projects");
      const { readdirSync, existsSync } = await import("node:fs");
      let sessionPath = "";

      for (const dir of readdirSync(projectsDir)) {
        const candidate = path.join(projectsDir, dir, `${agent.sdk_session_id}.jsonl`);
        if (existsSync(candidate)) {
          sessionPath = candidate;
          break;
        }
      }

      if (!sessionPath) {
        res.status(400).json({ error: "Session file not found on disk" });
        return;
      }

      const { trimSession } = await import("../utils/session-trim.js");
      const keepLast = parseInt(req.query.keep as string) || 10;
      const result = await trimSession(sessionPath, keepLast);

      await queries.updateAgentState(agent.id, "paused" as any, {
        error_message: null,
      });

      res.json({
        ok: true,
        originalLines: result.originalLines,
        trimmedLines: result.trimmedLines,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  router.post("/api/agents/:id/kill", async (req, res) => {
    try {
      await manager.killAgent(req.params.id);
      const ip = req.ip || req.socket.remoteAddress || null;
      await queries.insertAuditLog(ip, "agent.kill", "agent", req.params.id);
      res.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });


  router.post("/api/agents/:id/input", async (req, res) => {
    try {
      const { message } = req.body as { message?: string };
      if (!message) {
        res.status(400).json({ error: "message is required" });
        return;
      }
      await manager.sendInput(req.params.id, message);
      // Reset supervisor cooldown — user is actively interacting
      const { resetAgentCooldown } = await import("../supervisor/checks.js");
      resetAgentCooldown(req.params.id);
      res.json({ ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  router.post("/api/agents/:id/urgent", async (req, res) => {
    try {
      const { message } = req.body as { message?: string };
      if (!message) {
        res.status(400).json({ error: "message is required" });
        return;
      }
      const sent = await manager.sendUrgent(req.params.id, message);
      const { resetAgentCooldown } = await import("../supervisor/checks.js");
      resetAgentCooldown(req.params.id);
      res.json({ ok: true, delivered: sent ? "immediate" : "queued" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  router.put("/api/agents/:id/instructions", async (req, res) => {
    const { supervisor_instructions } = req.body as { supervisor_instructions?: string };
    if (typeof supervisor_instructions !== "string") {
      res.status(400).json({ error: "supervisor_instructions is required" });
      return;
    }
    const agent = await queries.getAgent(req.params.id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await queries.updateAgentSupervisorInstructions(req.params.id, supervisor_instructions);
    res.json({ ok: true });
  });

  // Ask the agent's live sidecar to push a fresh working-tree snapshot now
  // (durable command row + NOTIFY; the sidecar is listening).
  router.post("/api/agents/:id/snapshot", async (req, res) => {
    const agent = await queries.getAgent(req.params.id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await queries.insertAgentCommand(req.params.id, "snapshot");
    res.json({ ok: true });
  });

  router.get("/api/agents/:id/events", async (req, res) => {
    const limit = parseInt(req.query.limit as string) || 100;
    const beforeId = req.query.before
      ? parseInt(req.query.before as string)
      : undefined;
    const events = await queries.getAgentEvents(req.params.id, limit, beforeId);
    res.json(events);
  });

  // ── Named secrets (pipeline creds) — per user, write-only ─
  router.get("/api/me/secrets", async (req, res) => {
    res.json(await queries.listUserSecretNames(req.user!.userId));
  });
  router.put("/api/me/secrets/:name", async (req, res) => {
    const value = (req.body as { value?: string })?.value;
    if (!value) { res.status(400).json({ error: "value is required" }); return; }
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(req.params.name)) { res.status(400).json({ error: "invalid secret name" }); return; }
    const blob = await getCipher().encrypt(String(value));
    await queries.upsertUserSecret(req.user!.userId, req.params.name, blob);
    res.json({ ok: true });
  });
  router.delete("/api/me/secrets/:name", async (req, res) => {
    await queries.deleteUserSecret(req.user!.userId, req.params.name);
    res.json({ ok: true });
  });

  // ── Pipeline runs ─────────────────────────────────────
  router.post("/api/pipeline/run", async (req, res) => {
    const { repo_url, ref, phase, agent_id } = req.body as { repo_url?: string; ref?: string; phase?: string; agent_id?: string };
    if (!repo_url || !phase) { res.status(400).json({ error: "repo_url and phase are required" }); return; }
    const userId = req.user!.userId;
    try {
      const { runId, gated } = await pipelineService.runPhase({ userId, repoUrl: repo_url, ref, phaseName: phase, agentId: agent_id || null });
      const ip = req.ip || req.socket.remoteAddress || null;
      await queries.insertAuditLog(ip, "pipeline.run", "pipeline", runId, `${phase} @ ${repo_url}${gated ? " (awaiting review+approval)" : ""}`, userId);
      res.status(201).json({ runId, phase, gate: gated ? "human" : "auto", pendingReview: gated });
    } catch (err) {
      const e = err as { status?: number; message?: string };
      res.status(e.status || 400).json({ error: e.message || String(err) });
    }
  });

  // Reject a gated run (do NOT deploy).
  router.post("/api/pipeline/runs/:id/reject", async (req, res) => {
    const run = await queries.getPipelineRun(req.params.id);
    if (!run) { res.status(404).json({ error: "Run not found" }); return; }
    if (!["pending_review", "pending_approval"].includes(run.status)) {
      res.status(400).json({ error: `Run is '${run.status}', not gated` }); return;
    }
    await queries.updatePipelineRun(run.id, { status: "failed", log: `Rejected at the human gate by ${actorOf(req)}`, completed: true });
    if (run.agent_id) await queries.insertAgentEvent(run.agent_id, "message", { role: "system", content: `🚫 **${actorOf(req)}** rejected the \`${run.phase}\` — not run.` }).catch(() => {});
    const ip = req.ip || req.socket.remoteAddress || null;
    await queries.insertAuditLog(ip, "pipeline.reject", "pipeline", run.id, `${run.phase} (by ${actorOf(req)})`, req.user?.userId);
    res.json({ ok: true });
  });

  // Approve a gated (gate: human) run → launch it now. Re-resolves the phase +
  // secrets as the run's owner (nothing sensitive is stored between request+approve).
  router.post("/api/pipeline/runs/:id/approve", async (req, res) => {
    const run = await queries.getPipelineRun(req.params.id);
    if (!run) { res.status(404).json({ error: "Run not found" }); return; }
    if (run.status !== "pending_approval") { res.status(400).json({ error: `Run is '${run.status}', not awaiting approval (a review must complete first)` }); return; }
    if (!run.repo_url || !run.created_by_user_id) { res.status(400).json({ error: "Run missing repo/owner" }); return; }
    try {
      const r = await pipelineService.resolvePhase(run.created_by_user_id, run.repo_url, run.git_ref || undefined, run.phase);
      const ip = req.ip || req.socket.remoteAddress || null;
      // Agent-managed phase → dispatch a deploy-manager agent (live trace + rollback)
      // instead of a plain pod. The approval IS the human gate; the agent executes.
      if (r.ph.agent) {
        const agentId = await dispatchDeployAgent(manager, run, r.ph);
        await queries.insertAgentEvent(agentId, "message", { role: "system", content: `👤 **${actorOf(req)}** approved this deploy of \`${run.git_ref || "main"}\` — running it now.` });
        await queries.insertAuditLog(ip, "pipeline.approve", "pipeline", run.id, `${run.phase} @ ${run.repo_url} → agent ${agentId} (by ${actorOf(req)})`, req.user?.userId);
        res.json({ ok: true, runId: run.id, agentId });
        return;
      }
      await queries.updatePipelineRun(run.id, { status: "pending" });
      await queries.insertAuditLog(ip, "pipeline.approve", "pipeline", run.id, `${run.phase} @ ${run.repo_url}`, req.user?.userId);
      await pipelineService.launchResolved(run.id, run.repo_url, run.git_ref || undefined, r);
      res.json({ ok: true, runId: run.id });
    } catch (err) {
      const e = err as { status?: number; message?: string };
      res.status(e.status || 400).json({ error: e.message || String(err) });
    }
  });

  // Deploy an agent's BRANCH to staging directly — bypasses the main-only guardrail
  // AND the pre-deploy gate. This is an iteration deploy you trigger explicitly (the
  // click IS the approval), so you can see the build before the PR merges. Reuses the
  // repo's `deploy` phase command + identity, just on the branch. NOTE: it ships the
  // branch to the SHARED staging env, replacing what's there until main is redeployed.
  router.post("/api/agents/:id/deploy-branch", async (req, res) => {
    const agent = await queries.getAgent(req.params.id);
    if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
    if (!agent.repo_url || !agent.branch || !agent.created_by_user_id) { res.status(400).json({ error: "Agent has no repo/branch to deploy" }); return; }
    try {
      const { runId, agentId } = await deployAgentBranch(manager, agent);
      const ip = req.ip || req.socket.remoteAddress || null;
      if (agentId) {
        await queries.insertAgentEvent(agentId, "message", { role: "system", content: `🌿 **${actorOf(req)}** deployed BRANCH \`${agent.branch}\` to staging (bypassing the main gate) — running it now.` });
        await queries.insertAgentEvent(agent.id, "message", { role: "system", content: `🌿 Deploying this branch to staging (bypassing main) — [watch it](/agent/${agentId}).` }).catch(() => {});
      }
      await queries.insertAuditLog(ip, "pipeline.deploy_branch", "pipeline", runId, `${agent.branch} @ ${agent.repo_url}${agentId ? ` → agent ${agentId}` : ""} (by ${actorOf(req)})`, req.user?.userId);
      res.json({ ok: true, runId, agentId });
    } catch (err) {
      const e = err as { status?: number; message?: string };
      res.status(e.status || 400).json({ error: e.message || String(err) });
    }
  });

  // Bring the base branch (main) INTO the agent's feature branch — for a branch cut
  // from an older main that has since diverged. Two paths:
  //  • Clean, and the branch has a PR → GitHub merges base→head server-side
  //    (updateBranch, a merge commit — NOT a rebase, so the branch history the agent
  //    has checked out isn't rewritten). Resume the agent to pick it up.
  //  • Conflicts, or no PR yet → hand it to the agent: it merges origin/<base>
  //    locally, resolves conflicts with its knowledge of the code, and stops; da_boss
  //    pushes the branch as usual. This is the common case for a truly diverged branch.
  router.post("/api/agents/:id/sync-main", async (req, res) => {
    const agent = await queries.getAgent(req.params.id);
    if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
    if (!agent.repo_url || !agent.branch || !agent.created_by_user_id) { res.status(400).json({ error: "Agent has no repo/branch to sync" }); return; }
    const ip = req.ip || req.socket.remoteAddress || null;
    try {
      const { clean, baseRef } = await syncMainIntoBranch(manager, agent);
      if (clean) {
        await queries.insertAgentEvent(agent.id, "message", { role: "system", content: `⬇️ **${actorOf(req)}** merged the latest \`${baseRef}\` into \`${agent.branch}\` (clean, server-side). Resume the agent so its pod picks up the updated branch.` });
        await queries.insertAuditLog(ip, "agent.sync_main", "agent", agent.id, `PR #${agent.pr_number}: clean merge of ${baseRef}`, req.user?.userId);
        res.json({ ok: true, clean: true });
        return;
      }
      await queries.insertAgentEvent(agent.id, "message", { role: "system", content: `⬇️ **${actorOf(req)}** asked to merge \`${baseRef}\` into \`${agent.branch}\`${agent.pr_number ? " — it conflicts, so" : " —"} the agent is merging and resolving conflicts now. da_boss pushes the branch when it finishes.` });
      await queries.insertAuditLog(ip, "agent.sync_main", "agent", agent.id, `${baseRef} → ${agent.branch} (agent resolve)`, req.user?.userId);
      res.status(202).json({ ok: true, dispatched: true });
    } catch (err) {
      const e = err as { status?: number; message?: string };
      res.status(e.status || 500).json({ error: e.message || (err instanceof Error ? err.message : String(err)) });
    }
  });

  // Test agent: run a pipeline phase (default 'test') for an agent's branch; the
  // result gates its PR (comment + ready-on-green) via the completion listener.
  router.post("/api/agents/:id/test", async (req, res) => {
    const agent = await queries.getAgent(req.params.id);
    if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
    const phaseName = (req.body as { phase?: string })?.phase || "test";
    try {
      const runId = await pipelineService.runPhaseForAgent(agent, phaseName);
      res.status(201).json({ runId, phase: phaseName });
    } catch (err) {
      const e = err as { status?: number; message?: string };
      res.status(e.status || 400).json({ error: e.message || String(err) });
    }
  });

  // ── Report-back actions (the "what to do next" from the verdict card) ──
  // Merge the agent's PR (the reviewer said 'merge', you agree).
  // Land gate: don't merge blindly. Update the branch with main, and if the repo
  // has a test phase, re-run it on the rebased branch — the completion listener
  // merges only on green (else it blocks + reports). No test phase → straight merge.
  router.post("/api/agents/:id/merge", async (req, res) => {
    const agent = await queries.getAgent(req.params.id);
    if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
    if (!agent.repo_url || !agent.pr_number || !agent.created_by_user_id) { res.status(400).json({ error: "Agent has no PR to merge" }); return; }
    // Guard against double-clicks: a land is async (rebase → retest → merge on the
    // completion listener), so without this each click spawns another rebase+retest
    // run against the same PR. Reject if already merged or a land is in flight.
    if (agent.state === "verified") { res.status(409).json({ error: "PR already merged (agent is verified)." }); return; }
    const landInFlight = (await queries.getPipelineRunsForAgent(agent.id)).some(
      (r) => r.land_on_pass && ["pending", "pending_review", "pending_approval", "running"].includes(r.status)
    );
    if (landInFlight) { res.status(409).json({ error: "A land is already in progress for this PR — wait for it to finish." }); return; }
    // HOLD-merge guard: if the reviewer flagged this change (hold/fix), don't let it
    // ship silently (a HOLD got merged on #13). Require an explicit override — the UI
    // asks "merge anyway?", and the override is recorded against the actor.
    const rec = agent.recommendation;
    const override = (req.body as { override?: boolean })?.override === true;
    if ((rec === "hold" || rec === "fix") && !override) {
      res.status(409).json({
        error: `The review is ${rec.toUpperCase()} — the reviewer flagged this change. Merge anyway?`,
        needsOverride: true,
        recommendation: rec,
      });
      return;
    }
    const overrode = override && (rec === "hold" || rec === "fix");
    // Attribute the click in the visible trace (audit log records it too, below).
    await queries.insertAgentEvent(agent.id, "message", {
      role: "system",
      content: `👤 **${actorOf(req)}** clicked Merge on PR #${agent.pr_number}${overrode ? ` — ⚠️ **overriding the ${rec!.toUpperCase()} review**` : ""} — landing (rebase on main + retest before merge).`,
    });
    if (overrode) await queries.insertAuditLog(req.ip || null, "agent.merge_override", "agent", agent.id, `PR #${agent.pr_number} merged past ${rec!.toUpperCase()} by ${actorOf(req)}`, req.user?.userId);
    try {
      const gc = await queries.getUserGitCredential(agent.created_by_user_id);
      if (!gc) { res.status(400).json({ error: "Owner has no git credential" }); return; }
      const token = await getCipher().decrypt({ ciphertext: gc.ciphertext, nonce: gc.nonce, keyRef: gc.key_ref });

      // 1. Rebase on main (GitHub merges base→head). A conflict is the agent's to resolve.
      const upd = await updateBranch(agent.repo_url, agent.pr_number, token);
      if (upd.conflict) { res.status(409).json({ error: "Branch conflicts with main — the agent must resolve it. Use Request changes to send it back." }); return; }
      if (!upd.ok) { res.status(400).json({ error: `Couldn't update the branch with main: ${upd.message}` }); return; }

      const ip = req.ip || req.socket.remoteAddress || null;

      // 2. Re-run ALL test phases on the rebased branch; the completion listener
      //    merges once EVERY test phase passes. If the repo has no test phase, merge now.
      try {
        const started = await pipelineService.runTestPhasesForAgent(agent, { landOnPass: true });
        await queries.insertAuditLog(ip, "agent.land", "agent", agent.id, `PR #${agent.pr_number} (retest ${started.map((s) => s.phase).join(",")})`, req.user?.userId);
        res.status(202).json({ landing: true, runs: started });
      } catch (err) {
        const e = err as { status?: number };
        if (e.status !== 404) throw err; // 404 = no test phase → fall through to direct merge
        await markReadyForReview(agent.repo_url, agent.pr_number, token).catch(() => {}); // un-draft — can't merge a draft
        const result = await mergePr(agent.repo_url, agent.pr_number, token);
        if (!result.merged) { res.status(400).json({ error: `Merge failed: ${result.message}` }); return; }
        await queries.updateAgentState(agent.id, "verified");
        await queries.insertAgentEvent(agent.id, "message", { role: "system", content: `✅ Merged PR #${agent.pr_number} (rebased on main; no test phase to run).` });
        await queries.insertAuditLog(ip, "agent.merge", "agent", agent.id, `PR #${agent.pr_number}`, req.user?.userId);
        await maybeProposeDeploy(agent); // gated deploy card, if the repo declares one
        res.json({ ok: true, merged: true });
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Send the agent back to work with the reviewer's / your feedback (the reviewer
  // said 'fix'). Resumes the same session; a fresh review is produced after.
  router.post("/api/agents/:id/request-changes", async (req, res) => {
    const agent = await queries.getAgent(req.params.id);
    if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
    const feedback = (req.body as { feedback?: string })?.feedback?.trim();
    if (!feedback) { res.status(400).json({ error: "feedback is required" }); return; }
    try {
      await queries.setAgentReview(agent.id, "", ""); // clear the prior verdict; re-review after the fix
      await manager.sendInput(agent.id, `The reviewer requested changes before this can merge:\n\n${feedback}\n\nAddress this, then push again.`);
      await queries.insertAgentEvent(agent.id, "message", { role: "system", content: `↩️ **${actorOf(req)}** requested changes: ${feedback.slice(0, 200)}` });
      const ip = req.ip || req.socket.remoteAddress || null;
      await queries.insertAuditLog(ip, "agent.request_changes", "agent", agent.id, feedback.slice(0, 100), req.user?.userId);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Validate a .daboss/pipeline.yaml draft (the pipeline builder) — reuses the
  // real parser so what validates here is exactly what the runner accepts.
  router.post("/api/pipeline/validate", (req, res) => {
    const yaml = (req.body as { yaml?: string })?.yaml || "";
    try {
      const p = parsePipeline(yaml);
      res.json({
        ok: true,
        phases: Object.entries(p.phases).map(([name, ph]) => ({
          name, image: ph.image || "(da_boss default)", gate: ph.gate,
          requires: ph.requires || [], only_ref: ph.only_ref || null,
        })),
      });
    } catch (err) {
      res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/pipeline/runs", async (_req, res) => {
    res.json(await queries.listPipelineRuns(50));
  });

  // The Reviews queue: every change + deploy awaiting a human decision, across all
  // users (repo-scoped review — you review the repos you work on, not just your
  // own changes). Merge/request-changes use the change owner's git token; approve/
  // reject act on gated runs.
  router.get("/api/reviews", async (_req, res) => {
    const [changes, deploys] = await Promise.all([
      queries.getReviewQueueChanges(),
      queries.getReviewQueueDeploys(),
    ]);
    res.json({ changes, deploys });
  });
  router.get("/api/pipeline/runs/:id", async (req, res) => {
    const run = await queries.getPipelineRun(req.params.id);
    if (!run) { res.status(404).json({ error: "Run not found" }); return; }
    res.json(run);
  });

  // ── Admin: live test scenarios ────────────────────────
  router.get("/api/test/scenarios", requireAdmin, (_req, res) => {
    res.json(
      Object.values(scenarios).map((s) => ({
        name: s.name,
        description: s.description,
        steerAfterMs: s.steerAfterMs ?? null,
      }))
    );
  });

  // Run a scenario: create a real agent on the narrative prompt, start it, and
  // (if the scenario steers) auto-send the steer after its delay. Returns the
  // agent id; poll the report endpoint for the verdict.
  router.post("/api/test/scenarios/:name/run", requireAdmin, async (req, res) => {
    const scenario = scenarios[String(req.params.name)];
    if (!scenario) {
      res.status(404).json({ error: "Unknown scenario" });
      return;
    }
    try {
      // Own the test agent under the hidden test-harness user (copies the admin's
      // credential so it can actually run), not the admin's own account.
      await ensureTestUser(req.user?.userId);
      const agent = await manager.createAgent(
        {
          name: `test-${scenario.name}`,
          prompt: scenario.prompt,
          cwd: "/work",
          ...(scenario.repo ? { repo_url: scenario.repo, branch_type: scenario.branchType || "test", issue_id: "e2e" } : {}),
        },
        TEST_USER_ID,
        "test-harness"
      );
      await manager.startAgent(agent.id);
      if (scenario.steerMessage && scenario.steerAfterMs) {
        setTimeout(() => {
          void manager.sendUrgent(agent.id, scenario.steerMessage!).catch(() => {});
        }, scenario.steerAfterMs);
      }
      const ip = req.ip || req.socket.remoteAddress || null;
      await queries.insertAuditLog(ip, "test.scenario.run", "agent", agent.id, scenario.name, req.user?.userId);
      res.status(201).json({ agentId: agent.id, scenario: scenario.name });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/test/scenarios/:name/report/:agentId", requireAdmin, async (req, res) => {
    const scenario = scenarios[String(req.params.name)];
    if (!scenario) {
      res.status(404).json({ error: "Unknown scenario" });
      return;
    }
    const agentId = String(req.params.agentId);
    const events = await queries.getAgentEvents(agentId, 500);
    const contents = events
      .filter((e) => e.type === "message")
      .map((e) => {
        try { return String((JSON.parse(e.data) as { content?: string }).content || ""); } catch { return ""; }
      });
    const agent = await queries.getAgent(agentId);
    const runs = await queries.getPipelineRunsForAgent(agentId);
    // autoTest scenarios: once the agent has opened its PR, run the test phase once.
    if (scenario.autoTest && agent?.state === "completed" && agent.pr_number && runs.length === 0) {
      try { await pipelineService.runPhaseForAgent(agent, "test"); } catch { /* surfaced via verify */ }
    }
    const ctx = {
      pipelineRuns: runs.map((r) => ({ phase: r.phase, status: r.status, pr_posted: r.pr_posted })),
      prOpened: !!agent?.pr_number,
    };
    res.json({ state: agent?.state ?? "unknown", ...scenario.verify(contents, ctx) });
  });

  // Arm a deterministic land conflict: script both sides (branch + main diverge on
  // the same line via the forge) and wire a real agent to the PR, so the conflict
  // path is testable through the actual UI — open the agent → Merge → 409.
  router.post("/api/test/land-conflict", requireAdmin, async (req, res) => {
    const repoUrl = (req.body as { repo?: string })?.repo?.trim() || FIXTURE_REPO;
    const base = (req.body as { base?: string })?.base?.trim() || "main";
    try {
      await ensureTestUser(req.user?.userId);
      const gc = await queries.getUserGitCredential(TEST_USER_ID);
      if (!gc) { res.status(400).json({ error: "Test user has no git credential" }); return; }
      const token = await getCipher().decrypt({ ciphertext: gc.ciphertext, nonce: gc.nonce, keyRef: gc.key_ref });

      const branch = `docs/landtest/${nanoid(6)}`; // unique → createBranch won't collide
      const agent = await manager.createAgent(
        { name: "test-land-conflict", prompt: "(scripted land-conflict fixture — no agent run)", cwd: "/work", repo_url: repoUrl, repo_ref: base, branch },
        TEST_USER_ID,
        "test-harness"
      );

      const armed = await armLandConflict(repoUrl, base, branch, token);

      // Wire the agent to the PR + give it a merge verdict so the card + Merge button show.
      await queries.setAgentPullRequest(agent.id, armed.prUrl, armed.prNumber);
      await queries.updateAgentState(agent.id, "completed", { completed_at: new Date().toISOString() });
      await queries.setAgentReview(
        agent.id,
        `Armed conflict: this branch and main both edit \`calc.py\`'s \`return a + b\` line. Clicking Merge should be BLOCKED by the land gate (rebase conflict) → 409, then Request changes.`,
        "merge"
      );
      await queries.insertAgentEvent(agent.id, "message", {
        role: "system",
        content: `🧨 Armed a land conflict on PR #${armed.prNumber} (${armed.prUrl}). Click Merge — the land gate should reject it: ${armed.conflict ? "updateBranch confirmed CONFLICT ✅" : "⚠️ updateBranch did NOT report a conflict"}.`,
      });

      const ip = req.ip || req.socket.remoteAddress || null;
      await queries.insertAuditLog(ip, "test.land-conflict.arm", "agent", agent.id, `PR #${armed.prNumber} conflict=${armed.conflict}`, req.user?.userId);
      res.status(201).json({ agentId: agent.id, prNumber: armed.prNumber, prUrl: armed.prUrl, conflict: armed.conflict });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Prune all test-harness agents (review→cleanup: kill, delete branch, cleanup
  // session storage, drop rows). Reclaims the test shard's accumulated sessions.
  router.post("/api/admin/test-agents/prune", requireAdmin, async (req, res) => {
    const agents = await queries.getAgentsByUser(TEST_USER_ID);
    let pruned = 0;
    for (const agent of agents) {
      try {
        if (["running", "waiting_permission", "waiting_input"].includes(agent.state)) {
          await manager.killAgent(agent.id).catch(() => {});
        }
        await deleteAgentRemoteBranch(agent).catch(() => {});
        if (config.agentExecution === "pod") await launchStateCleanupPod(agent).catch(() => {});
        await queries.deleteAgent(agent.id);
        pruned++;
      } catch { /* keep going */ }
    }
    const ip = req.ip || req.socket.remoteAddress || null;
    await queries.insertAuditLog(ip, "test-agents.prune", "user", TEST_USER_ID, `pruned ${pruned}`, req.user?.userId);
    res.json({ ok: true, pruned });
  });

  // ── Admin: users ──────────────────────────────────────
  router.get("/api/admin/users", requireAdmin, async (_req, res) => {
    res.json(await queries.listUsersWithAgentCounts());
  });

  // Grant or revoke a user's da_boss access — the kill switch. A revoke bites on
  // the target's next request. NOTE: a user who still qualifies by IdP role will
  // be auto-re-granted on their next login; to keep someone out permanently,
  // offboard them (which records the identity as denied).
  router.put("/api/admin/users/:id/access", requireAdmin, async (req, res) => {
    const targetId = String(req.params.id);
    const approved = !!(req.body as { approved?: boolean }).approved;
    if (targetId === req.user?.userId && !approved) {
      res.status(400).json({ error: "You can't revoke your own access" });
      return;
    }
    const target = await queries.getUserById(targetId);
    if (!target) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    await queries.setUserAccessApproved(targetId, approved);
    const ip = req.ip || req.socket.remoteAddress || null;
    await queries.insertAuditLog(
      ip, approved ? "user.access_grant" : "user.access_revoke", "user", targetId,
      target.email ?? targetId, req.user?.userId
    );
    res.json({ ok: true, id: targetId, access_approved: approved });
  });

  // Offboard: tear down the user's agents, shard, credentials, and the user row.
  router.post("/api/admin/users/:id/offboard", requireAdmin, async (req, res) => {
    const targetId = String(req.params.id);
    if (targetId === req.user?.userId) {
      res.status(400).json({ error: "You can't offboard yourself" });
      return;
    }
    if (targetId === TEST_USER_ID) {
      res.status(400).json({ error: "The test-harness user can't be offboarded" });
      return;
    }
    const target = await queries.getUserById(targetId);
    if (!target) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    try {
      const summary = await manager.offboardUser(targetId, req.user?.userId);
      const ip = req.ip || req.socket.remoteAddress || null;
      await queries.insertAuditLog(
        ip,
        "user.offboard",
        "user",
        targetId,
        `${target.email ?? targetId} — removed ${summary.agentsRemoved} agent(s), ${summary.branchesDeleted} branch(es)`,
        req.user?.userId
      );
      res.json({ ok: true, ...summary });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Admin: supervisor credential ──────────────────────
  // Which user's stored Claude token the headless supervisor runs on.
  router.get("/api/admin/supervisor-credential", requireAdmin, async (_req, res) => {
    const userId = await queries.getAppSetting(SUPERVISOR_CRED_SETTING);
    if (!userId) {
      res.json({ userId: null, email: null, hasCredential: false });
      return;
    }
    const user = await queries.getUserById(userId);
    const cred = await queries.getUserCredential(userId);
    res.json({ userId, email: user?.email ?? null, hasCredential: !!cred });
  });

  // Designate a user (defaults to the calling admin). Must have a credential.
  router.put("/api/admin/supervisor-credential", requireAdmin, async (req, res) => {
    const body = req.body as { userId?: string };
    const userId = body.userId || req.user?.userId;
    if (!userId) {
      res.status(400).json({ error: "userId required" });
      return;
    }
    const user = await queries.getUserById(userId);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const cred = await queries.getUserCredential(userId);
    if (!cred) {
      res.status(400).json({ error: "That user has no Claude credential on file — add one first." });
      return;
    }
    await queries.setAppSetting(SUPERVISOR_CRED_SETTING, userId);
    const ip = req.ip || req.socket.remoteAddress || null;
    await queries.insertAuditLog(ip, "supervisor.credential_set", "user", userId, user.email ?? userId, req.user?.userId);
    res.json({ ok: true, userId, email: user.email ?? null, hasCredential: true });
  });

  router.delete("/api/admin/supervisor-credential", requireAdmin, async (req, res) => {
    await queries.deleteAppSetting(SUPERVISOR_CRED_SETTING);
    const ip = req.ip || req.socket.remoteAddress || null;
    await queries.insertAuditLog(ip, "supervisor.credential_cleared", "config", null, null, req.user?.userId);
    res.json({ ok: true });
  });

  // ── Permissions ───────────────────────────────────────
  router.get("/api/permissions/pending", async (_req, res) => {
    res.json(await queries.getPendingPermissions());
  });

  router.post("/api/permissions/:id/resolve", async (req, res) => {
    const { decision, answer } = req.body as { decision?: "approved" | "denied"; answer?: string };
    if (!decision || !["approved", "denied"].includes(decision)) {
      res.status(400).json({ error: "decision must be 'approved' or 'denied'" });
      return;
    }
    const id = parseInt(req.params.id);
    const ok = await manager.resolvePermission(id, decision, answer);
    if (!ok) {
      res.status(404).json({ error: "Permission request not found or already resolved" });
      return;
    }
    res.json({ ok: true });
  });

  // ── Budget ────────────────────────────────────────────
  router.get("/api/budget", async (_req, res) => {
    res.json(await manager.budgetManager.getStatus());
  });

  router.put("/api/budget", async (req, res) => {
    const { daily_budget_usd, monthly_budget_usd } = req.body as {
      daily_budget_usd?: number;
      monthly_budget_usd?: number;
    };
    if (
      typeof daily_budget_usd !== "number" ||
      typeof monthly_budget_usd !== "number"
    ) {
      res.status(400).json({
        error: "daily_budget_usd and monthly_budget_usd are required numbers",
      });
      return;
    }
    await queries.updateBudgetConfig(daily_budget_usd, monthly_budget_usd);
    res.json(await manager.budgetManager.getStatus());
  });

  // ── Supervisor ────────────────────────────────────────
  router.post("/api/supervisor/run", async (_req, res) => {
    // Manual trigger — will be implemented with supervisor module
    res.json({ ok: true, message: "Supervisor run triggered" });
  });

  // ── Templates ──────────────────────────────────────────
  router.get("/api/templates", (_req, res) => {
    res.json(AGENT_TEMPLATES);
  });

  // ── Settings ───────────────────────────────────────────
  router.get("/api/settings", async (_req, res) => {
    const activeCount = manager.getActiveCount();
    const totalAgents = (await manager.getAllAgents()).length;
    const nodes = await queries.getAllFleetNodes();

    res.json({
      node_id: config.nodeId,
      node_role: config.nodeRole,
      max_concurrent_agents: config.maxConcurrentAgents,
      active_agents: activeCount,
      total_agents: totalAgents,
      supervisor_interval_minutes: config.supervisorIntervalMinutes,
      permission_timeout_minutes: config.permissionTimeoutMinutes,
      stuck_threshold_minutes: config.stuckThresholdMinutes,
      ntfy_topic: config.ntfyTopic || null,
      fleet_nodes: nodes.length,
      uptime_seconds: Math.floor(process.uptime()),
      // Prefill for new agents — set by an admin, applied by the create form.
      default_repo_url: (await queries.getAppSetting(DEFAULT_REPO_URL_SETTING)) || null,
      default_repo_ref: (await queries.getAppSetting(DEFAULT_REPO_REF_SETTING)) || null,
    });
  });

  // Admin: set (or clear) the default repo new agents are prefilled with.
  router.put("/api/admin/default-repo", requireAdmin, async (req, res) => {
    const { repo_url, repo_ref } = req.body as { repo_url?: string; repo_ref?: string };
    const url = (repo_url ?? "").trim();
    const ref = (repo_ref ?? "").trim();
    if (url) await queries.setAppSetting(DEFAULT_REPO_URL_SETTING, url);
    else await queries.deleteAppSetting(DEFAULT_REPO_URL_SETTING);
    if (ref) await queries.setAppSetting(DEFAULT_REPO_REF_SETTING, ref);
    else await queries.deleteAppSetting(DEFAULT_REPO_REF_SETTING);
    const ip = req.ip || req.socket.remoteAddress || null;
    await queries.insertAuditLog(ip, "settings.default_repo", "config", null, `${url || "(cleared)"}${ref ? ` @ ${ref}` : ""}`, req.user?.userId);
    res.json({ ok: true, default_repo_url: url || null, default_repo_ref: ref || null });
  });

  // ── Audit Log ──────────────────────────────────────────
  router.get("/api/audit", async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    const entries = await queries.getAuditLog(limit, offset);
    const total = await queries.getAuditLogCount();
    res.json({ entries, total, limit, offset });
  });

  // ── Fleet ──────────────────────────────────────────────
  router.get("/api/fleet/nodes", async (_req, res) => {
    // Mark stale nodes before returning
    await queries.markStaleNodes(10); // 10 min threshold
    res.json(await queries.getAllFleetNodes());
  });

  router.post("/api/fleet/nodes", async (req, res) => {
    const { id, hostname, url, role, agent_capacity } = req.body as {
      id?: string;
      hostname?: string;
      url?: string;
      role?: string;
      agent_capacity?: number;
    };
    if (!id || !hostname || !url) {
      res.status(400).json({ error: "id, hostname, and url are required" });
      return;
    }
    const node = await queries.upsertFleetNode({ id, hostname, url, role, agent_capacity });
    const ip = req.ip || req.socket.remoteAddress || null;
    await queries.insertAuditLog(ip, "fleet.register", "node", id, hostname);
    res.json(node);
  });

  router.post("/api/fleet/nodes/:id/heartbeat", async (req, res) => {
    const { agent_count } = req.body as { agent_count?: number };
    const node = await queries.getFleetNode(req.params.id);
    if (!node) {
      res.status(404).json({ error: "Node not found" });
      return;
    }
    await queries.updateFleetNodeHeartbeat(req.params.id, agent_count || 0);
    res.json({ ok: true });
  });

  return router;
}
