import "dotenv/config";

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
