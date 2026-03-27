import { Router } from "express";
import type { AgentManager } from "../agent/manager.js";
import type { CreateAgentRequest } from "../types/agent.js";
import * as queries from "../db/queries.js";
import { authMiddleware, handleLogin, handleLogout, handleMe } from "./auth.js";

export function createRouter(manager: AgentManager): Router {
  const router = Router();

  // ── Auth ──────────────────────────────────────────────
  router.post("/api/auth/login", handleLogin);
  router.post("/api/auth/logout", handleLogout);
  router.get("/api/auth/me", handleMe);

  // All routes below require auth
  router.use("/api", authMiddleware);

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
      manager.createAgent(body).then((agent) => {
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
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);

      const claudePath = process.env.CLAUDE_PATH || "claude";

      // Run compaction in background
      execFileAsync(claudePath, [
        "-r", agent.sdk_session_id,
        "-p", "/compact",
        "--output-format", "json",
        "--max-turns", "1",
      ], {
        cwd: agent.cwd,
        timeout: 120_000, // 2 min timeout
        env: { ...process.env },
      }).then(async () => {
        queries.updateAgentState(agent.id, "paused" as any, {
          error_message: "Session compacted — ready to resume",
        });
        queries.insertAgentEvent(agent.id, "state_change", {
          from: agent.state,
          to: "paused",
          reason: "Session compacted",
        });
        const { logger } = await import("../utils/logger.js");
        logger.info({ agentId: agent.id }, "Session compacted successfully");
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        queries.updateAgentState(agent.id, "failed" as any, {
          error_message: `Compaction failed: ${msg}`,
        });
      });

      res.json({ ok: true, message: "Compaction started" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  router.post("/api/agents/:id/kill", async (req, res) => {
    try {
      await manager.killAgent(req.params.id);
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

  return router;
}
