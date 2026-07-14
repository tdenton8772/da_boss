import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import session from "express-session";
import helmet from "helmet";
import { config } from "./config.js";
import { initDb, closeDb } from "./db/index.js";
import { AgentManager } from "./agent/manager.js";
import { createRouter } from "./api/router.js";
import { createDiscoveryRouter } from "./api/discovery.js";
import { createUsageRouter } from "./api/usage.js";
import { setupWebSocket } from "./api/websocket.js";
import { startSupervisor, stopSupervisor, runSupervisorOnce } from "./supervisor/index.js";
import { reapFinishedAgentPods } from "./agent/pod-dispatcher.js";
import { startLiveRelay } from "./api/live-relay.js";
import { startPipelineCompletionListener } from "./pipeline/completion.js";
import { startQueueListener, processQueue } from "./supervisor/dispatcher.js";
import { logger } from "./utils/logger.js";

async function main() {
  // Initialize database
  await initDb();
  logger.info("Database initialized");

  // Event bus for WebSocket broadcasting
  const eventBus = new EventEmitter();
  eventBus.setMaxListeners(50);

  // Agent manager
  const manager = new AgentManager(eventBus);
  await manager.restoreAgents();

  // Express app
  const app = express();

  // Behind the GKE ingress + nginx (TLS terminated upstream): trust the proxy
  // chain so req.ip is the real client (correct login rate-limiting + audit IPs)
  // and req.secure reflects the original HTTPS. TRUST_PROXY hop count is
  // configurable (GCE LB + nginx = 2); default off for local/direct.
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy) app.set("trust proxy", /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy === "true" ? true : trustProxy);

  // Security headers
  app.use(
    helmet({
      contentSecurityPolicy: false, // Let Vite handle CSP in dev
      crossOriginEmbedderPolicy: false,
    })
  );

  app.use(express.json({ limit: "1mb" }));
  app.use(
    session({
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      },
    })
  );

  // Wire up the manual supervisor trigger
  const router = createRouter(manager);
  // Override the supervisor route with actual implementation
  app.post("/api/supervisor/run", async (_req: express.Request, res: express.Response) => {
    try {
      const result = await runSupervisorOnce(manager);
      res.json({ ok: true, ...result });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.use(router);
  app.use(createDiscoveryRouter());
  app.use(createUsageRouter());

  // Serve UI static files in production
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const uiDistPath = path.resolve(__dirname, "../../ui/dist");
  if (existsSync(uiDistPath)) {
    app.use(express.static(uiDistPath));
    // SPA fallback: serve index.html for non-API routes
    app.get("/{*splat}", (req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.path.startsWith("/api") || req.path.startsWith("/ws")) {
        return next();
      }
      res.sendFile(path.join(uiDistPath, "index.html"));
    });
    logger.info({ path: uiDistPath }, "Serving UI from dist");
  }

  // HTTP server
  const server = createServer(app);

  // WebSocket
  setupWebSocket(server, eventBus);

  // Live relay: rebroadcast agent events written by worker pods to the UI
  startLiveRelay(eventBus);

  // Pipeline completion → gate the linked agent's PR (comment + ready-on-green)
  startPipelineCompletionListener(manager);

  // Supervisor dispatch loop — the control plane owns pod-building. Reacts to
  // queued agents via NOTIFY (+ a periodic fallback sweep for any missed one).
  startQueueListener();
  setInterval(() => { void processQueue(); }, 30_000);

  // Supervisor: in pod mode the orchestrator pod owns the monitoring loop;
  // otherwise (host/dev) run it in-process.
  if (config.agentExecution === "pod") {
    logger.info("Agent execution: pod mode — supervisor runs in the orchestrator pod; starting agent-pod reaper");
    setInterval(() => { void reapFinishedAgentPods(); }, 10_000);
  } else {
    startSupervisor(manager);
  }

  // Start server
  server.listen(config.port, () => {
    logger.info({ port: config.port, nodeId: config.nodeId, role: config.nodeRole }, "da_boss server running");
    logger.info(
      `  Dashboard: http://localhost:${config.port}`
    );
  });

  // Graceful shutdown
  const shutdown = () => {
    logger.info("Shutting down...");
    stopSupervisor();
    server.close();
    closeDb();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Prevent unhandled SDK errors (e.g. AbortError) from crashing the server
  process.on("uncaughtException", (err) => {
    const msg = err?.message || "";
    if (msg.includes("abort") || msg.includes("Abort")) {
      logger.warn({ err: msg }, "Caught AbortError (agent killed) — server continues");
      return;
    }
    logger.error({ err }, "Uncaught exception — shutting down");
    shutdown();
  });

  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (msg.includes("abort") || msg.includes("Abort")) {
      logger.warn({ reason: msg }, "Caught unhandled AbortError — server continues");
      return;
    }
    logger.error({ reason: msg }, "Unhandled rejection");
  });
}

main().catch((err) => {
  logger.error({ err }, "Failed to start server");
  process.exit(1);
});
