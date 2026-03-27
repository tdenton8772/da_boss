import dotenv from "dotenv";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load .env from project root (two levels up from server/src/)
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
// Also try project root relative to cwd (for production)
dotenv.config({ path: path.resolve(process.cwd(), "../.env") });

export const config = {
  port: parseInt(process.env.PORT || "3847", 10),
  authPassword: process.env.AUTH_PASSWORD || "da-boss-dev",
  sessionSecret: process.env.SESSION_SECRET || "dev-secret-change-me",
  ntfyTopic: process.env.NTFY_TOPIC || "",
  anthropicAdminApiKey: process.env.ANTHROPIC_ADMIN_API_KEY || "",
  claudePath: process.env.CLAUDE_PATH || "claude",
  maxConcurrentAgents: parseInt(process.env.MAX_CONCURRENT_AGENTS || "3", 10),
  supervisorIntervalMinutes: parseInt(process.env.SUPERVISOR_INTERVAL_MINUTES || "5", 10),
  permissionTimeoutMinutes: parseInt(process.env.PERMISSION_TIMEOUT_MINUTES || "30", 10),
  stuckThresholdMinutes: parseInt(process.env.STUCK_THRESHOLD_MINUTES || "15", 10),

  // Fleet
  nodeId: process.env.NODE_ID || os.hostname(),
  nodeRole: (process.env.NODE_ROLE || "boss") as "boss" | "worker",
  bossUrl: process.env.BOSS_URL || "",

  // Rate limiting
  loginRateLimitWindowMs: 60_000, // 1 minute
  loginRateLimitMax: 5,           // max 5 attempts per window
};
