import dotenv from "dotenv";
import path from "node:path";
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
  maxConcurrentAgents: 3,
  supervisorIntervalMinutes: 5,
  permissionTimeoutMinutes: 30,
  stuckThresholdMinutes: 15,
};
