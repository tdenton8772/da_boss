import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import session from "express-session";
import { config } from "./config.js";
import { getDb, closeDb } from "./db/index.js";
import { AgentManager } from "./agent/manager.js";
import { createRouter } from "./api/router.js";
import { setupWebSocket } from "./api/websocket.js";
import { startSupervisor, stopSupervisor, runSupervisorOnce } from "./supervisor/index.js";
import { logger } from "./utils/logger.js";

async function main() {
  // Initialize database
  getDb();
  logger.info("Database initialized");

  // Event bus for WebSocket broadcasting
  const eventBus = new EventEmitter();
  eventBus.setMaxListeners(50);

  // Agent manager
  const manager = new AgentManager(eventBus);
  await manager.restoreAgents();

  // Express app
  const app = express();
  app.use(express.json());
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
  app.post("/api/supervisor/run", async (_req, res) => {
    try {
      const result = await runSupervisorOnce(manager);
      res.json({ ok: true, ...result });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.use(router);

  // Serve UI static files in production
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const uiDistPath = path.resolve(__dirname, "../../ui/dist");
  if (existsSync(uiDistPath)) {
    app.use(express.static(uiDistPath));
    // SPA fallback: serve index.html for non-API routes
    app.get("/{*splat}", (req, res, next) => {
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

  // Start supervisor cron
  startSupervisor(manager);

  // Start server
  server.listen(config.port, () => {
    logger.info({ port: config.port }, "da_boss server running");
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
}

main().catch((err) => {
  logger.error({ err }, "Failed to start server");
  process.exit(1);
});
