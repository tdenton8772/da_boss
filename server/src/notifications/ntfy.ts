import { config } from "../config.js";
import { logger } from "../utils/logger.js";

export async function sendNotification(
  title: string,
  message: string,
  priority: "default" | "high" | "urgent" = "default"
): Promise<void> {
  if (!config.ntfyTopic) {
    logger.debug({ title, message }, "Notification skipped (no ntfy topic)");
    return;
  }

  try {
    await fetch(`https://ntfy.sh/${config.ntfyTopic}`, {
      method: "POST",
      headers: {
        Title: title,
        Priority: priority === "urgent" ? "5" : priority === "high" ? "4" : "3",
        Tags: "robot",
      },
      body: message,
    });
    logger.info({ title }, "Notification sent");
  } catch (err) {
    logger.error({ err, title }, "Failed to send notification");
  }
}
