import { EventEmitter } from "node:events";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import * as queries from "../db/queries.js";
import type { ServerEvent } from "../types/events.js";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";

const ALWAYS_SAFE_TOOLS = ["Read", "Grep", "Glob", "Explore", "LSP"];

// Pending permission promises keyed by tool_use_id
const pendingResolvers = new Map<
  string,
  { resolve: (result: PermissionResult) => void; timeoutId: NodeJS.Timeout }
>();

export function createPermissionHandler(
  agentId: string,
  eventBus: EventEmitter
) {
  return async (
    toolName: string,
    toolInput: Record<string, unknown>,
    options: {
      signal: AbortSignal;
      suggestions?: unknown[];
      blockedPath?: string;
      decisionReason?: string;
      toolUseID: string;
    }
  ): Promise<PermissionResult> => {
    // Auto-approve safe read-only tools
    if (ALWAYS_SAFE_TOOLS.includes(toolName)) {
      return { behavior: "allow", updatedInput: toolInput };
    }

    // Insert permission request into DB
    const request = queries.insertPermissionRequest(
      agentId,
      toolName,
      toolInput,
      options.toolUseID
    );

    logger.info(
      { agentId, toolName, requestId: request.id },
      "Permission requested"
    );

    // Broadcast to UI
    const event: ServerEvent = {
      type: "permission:requested",
      request,
    };
    eventBus.emit("server-event", event);

    // Wait for resolution via API
    return new Promise<PermissionResult>((resolve) => {
      const timeoutId = setTimeout(
        () => {
          // Auto-deny on timeout
          pendingResolvers.delete(options.toolUseID);
          queries.resolvePermission(request.id, "denied");
          logger.warn(
            { agentId, requestId: request.id },
            "Permission timed out, auto-denied"
          );
          resolve({ behavior: "deny", message: "Permission timed out" });
        },
        config.permissionTimeoutMinutes * 60 * 1000
      );

      pendingResolvers.set(options.toolUseID, { resolve, timeoutId });
    });
  };
}

export function resolvePermissionRequest(
  requestId: number,
  decision: "approved" | "denied",
  eventBus: EventEmitter
): boolean {
  const request = queries.getPermission(requestId);
  if (!request || request.status !== "pending") return false;

  const toolInput = JSON.parse(request.tool_input) as Record<string, unknown>;
  queries.resolvePermission(requestId, decision);

  const pending = pendingResolvers.get(request.tool_use_id);
  if (pending) {
    clearTimeout(pending.timeoutId);
    if (decision === "approved") {
      pending.resolve({ behavior: "allow", updatedInput: toolInput });
    } else {
      pending.resolve({ behavior: "deny", message: "Denied by user" });
    }
    pendingResolvers.delete(request.tool_use_id);
  }

  const event: ServerEvent = {
    type: "permission:resolved",
    requestId,
    decision,
  };
  eventBus.emit("server-event", event);

  return true;
}
