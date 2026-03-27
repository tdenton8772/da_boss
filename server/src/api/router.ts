import { Router } from "express";
import { existsSync, statSync } from "node:fs";
import type { AgentManager } from "../agent/manager.js";
import type { CreateAgentRequest } from "../types/agent.js";
import * as queries from "../db/queries.js";
import { authMiddleware, handleLogin, handleLogout, handleMe } from "./auth.js";
import { config } from "../config.js";
import { AGENT_TEMPLATES } from "../agent/templates.js";

export function createRouter(manager: AgentManager): Router {
  const router = Router();

  // ── Auth ──────────────────────────────────────────────
  router.post("/api/auth/login", handleLogin);
  router.post("/api/auth/logout", handleLogout);
  router.get("/api/auth/me", handleMe);

  // All routes below require auth
  router.use("/api", authMiddleware);

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

  // ── Agents ────────────────────────────────────────────
  router.get("/api/agents", (_req, res) => {
    const agents = manager.getAllAgents();
    const tokenSummaries = queries.getAgentTokenSummaries();
    const summaryMap = new Map(tokenSummaries.map((s) => [s.agent_id, s]));

    const enriched = agents.map((a) => ({
      ...a,
      tokens: summaryMap.get(a.id) || {
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost_usd: 0,
      },
    }));

    res.json(enriched);
  });

  router.post("/api/agents", (req, res) => {
    try {
      const body = req.body as CreateAgentRequest;
      if (!body.name || !body.prompt || !body.cwd) {
        res.status(400).json({ error: "name, prompt, and cwd are required" });
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
      if (!existsSync(body.cwd) || !statSync(body.cwd).isDirectory()) {
        res.status(400).json({ error: "Working directory does not exist or is not a directory" });
        return;
      }
      const validModels = ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"];
      if (body.model && !validModels.includes(body.model)) {
        res.status(400).json({ error: `Invalid model. Must be one of: ${validModels.join(", ")}` });
        return;
      }

      const ip = req.ip || req.socket.remoteAddress || null;
      manager.createAgent(body).then((agent) => {
        queries.insertAuditLog(ip, "agent.create", "agent", agent.id, agent.name);
        res.status(201).json(agent);
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  router.get("/api/agents/:id", (req, res) => {
    const agent = manager.getAgent(req.params.id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const cost = queries.getAgentTotalCost(agent.id);
    res.json({ ...agent, total_cost_usd: cost });
  });

  router.post("/api/agents/:id/start", async (req, res) => {
    try {
      await manager.startAgent(req.params.id);
      const ip = req.ip || req.socket.remoteAddress || null;
      queries.insertAuditLog(ip, "agent.start", "agent", req.params.id);
      res.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  router.delete("/api/agents/:id", async (req, res) => {
    try {
      const agent = queries.getAgent(req.params.id);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      // Kill if running
      if (["running", "waiting_permission", "waiting_input"].includes(agent.state)) {
        await manager.killAgent(req.params.id);
      }
      queries.deleteAgent(req.params.id);
      const ip = req.ip || req.socket.remoteAddress || null;
      queries.insertAuditLog(ip, "agent.delete", "agent", req.params.id, agent.name);
      res.json({ ok: true });
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
      const agent = queries.getAgent(req.params.id);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      // Clear the session ID so it starts fresh, update prompt if provided
      const db = (await import("../db/index.js")).getDb();
      db.prepare(
        "UPDATE agents SET sdk_session_id = NULL, state = 'pending', error_message = NULL, prompt = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(prompt || agent.prompt, agent.id);

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
      const agent = queries.getAgent(req.params.id);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      if (!agent.sdk_session_id) {
        res.status(400).json({ error: "No session to compact" });
        return;
      }

      // Update state to show we're compacting
      queries.updateAgentState(agent.id, agent.state as any, {
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

      child.on("close", (code) => {
        if (code === 0) {
          queries.updateAgentState(agentId, "paused" as any, {
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
          queries.updateAgentState(agentId, "failed" as any, {
            error_message: `Compaction failed (code ${code}): ${errDetail.substring(0, 300)}`,
          });
          logger.error({ agentId, code, stderr: stderr.substring(0, 500) }, "Compaction failed");
        }
      });

      child.on("error", (err) => {
        queries.updateAgentState(agentId, "failed" as any, {
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
      const agent = queries.getAgent(req.params.id);
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

      queries.updateAgentState(agent.id, "paused" as any, {
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
      queries.insertAuditLog(ip, "agent.kill", "agent", req.params.id);
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
      res.json({ ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  router.put("/api/agents/:id/instructions", (req, res) => {
    const { supervisor_instructions } = req.body as { supervisor_instructions?: string };
    if (typeof supervisor_instructions !== "string") {
      res.status(400).json({ error: "supervisor_instructions is required" });
      return;
    }
    const agent = queries.getAgent(req.params.id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    queries.updateAgentSupervisorInstructions(req.params.id, supervisor_instructions);
    res.json({ ok: true });
  });

  router.get("/api/agents/:id/events", (req, res) => {
    const limit = parseInt(req.query.limit as string) || 100;
    const beforeId = req.query.before
      ? parseInt(req.query.before as string)
      : undefined;
    const events = queries.getAgentEvents(req.params.id, limit, beforeId);
    res.json(events);
  });

  // ── Permissions ───────────────────────────────────────
  router.get("/api/permissions/pending", (_req, res) => {
    res.json(queries.getPendingPermissions());
  });

  router.post("/api/permissions/:id/resolve", (req, res) => {
    const { decision } = req.body as { decision?: "approved" | "denied" };
    if (!decision || !["approved", "denied"].includes(decision)) {
      res.status(400).json({ error: "decision must be 'approved' or 'denied'" });
      return;
    }
    const id = parseInt(req.params.id);
    const ok = manager.resolvePermission(id, decision);
    if (!ok) {
      res.status(404).json({ error: "Permission request not found or already resolved" });
      return;
    }
    res.json({ ok: true });
  });

  // ── Budget ────────────────────────────────────────────
  router.get("/api/budget", (_req, res) => {
    res.json(manager.budgetManager.getStatus());
  });

  router.put("/api/budget", (req, res) => {
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
    queries.updateBudgetConfig(daily_budget_usd, monthly_budget_usd);
    res.json(manager.budgetManager.getStatus());
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
  router.get("/api/settings", (_req, res) => {
    const activeCount = manager.getActiveCount();
    const totalAgents = manager.getAllAgents().length;
    const nodes = queries.getAllFleetNodes();

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
    });
  });

  // ── Audit Log ──────────────────────────────────────────
  router.get("/api/audit", (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    const entries = queries.getAuditLog(limit, offset);
    const total = queries.getAuditLogCount();
    res.json({ entries, total, limit, offset });
  });

  // ── Fleet ──────────────────────────────────────────────
  router.get("/api/fleet/nodes", (_req, res) => {
    // Mark stale nodes before returning
    queries.markStaleNodes(10); // 10 min threshold
    res.json(queries.getAllFleetNodes());
  });

  router.post("/api/fleet/nodes", (req, res) => {
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
    const node = queries.upsertFleetNode({ id, hostname, url, role, agent_capacity });
    const ip = req.ip || req.socket.remoteAddress || null;
    queries.insertAuditLog(ip, "fleet.register", "node", id, hostname);
    res.json(node);
  });

  router.post("/api/fleet/nodes/:id/heartbeat", (req, res) => {
    const { agent_count } = req.body as { agent_count?: number };
    const node = queries.getFleetNode(req.params.id);
    if (!node) {
      res.status(404).json({ error: "Node not found" });
      return;
    }
    queries.updateFleetNodeHeartbeat(req.params.id, agent_count || 0);
    res.json({ ok: true });
  });

  return router;
}
