import { EventEmitter } from "node:events";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import * as queries from "../db/queries.js";
import type { ServerEvent } from "../types/events.js";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";
import { shouldAutoApprove, mapPermissionDecision, type PermissionPolicy } from "./tool-policy.js";

// Pending permission promises keyed by tool_use_id
const pendingResolvers = new Map<
  string,
  { resolve: (result: PermissionResult) => void; timeoutId: NodeJS.Timeout }
>();

export async function createPermissionHandler(
  agentId: string,
  eventBus: EventEmitter
) {
  // Get the agent's cwd and policy for decisions
  const agent = await queries.getAgent(agentId);
  const agentCwd = agent?.cwd || "";
  const policy: PermissionPolicy = (agent?.permission_policy as PermissionPolicy) || "auto";

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
    if (shouldAutoApprove(toolName, toolInput, agentCwd, policy)) {
      return { behavior: "allow", updatedInput: toolInput };
    }

    // Everything else: escalate to UI
    const request = await queries.insertPermissionRequest(
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
          void queries.resolvePermission(request.id, "denied").catch(() => {});
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

export async function resolvePermissionRequest(
  requestId: number,
  decision: "approved" | "denied",
  eventBus: EventEmitter,
  answer?: string,
  resolvedBy?: string
): Promise<boolean> {
  const request = await queries.getPermission(requestId);
  if (!request || request.status !== "pending") return false;

  const toolInput = JSON.parse(request.tool_input) as Record<string, unknown>;
  // Persist decision + answer + resolver so a pod worker (polling this row) can
  // read the outcome AND its provenance (human user id / supervisor / timeout).
  await queries.resolvePermission(requestId, decision, answer, resolvedBy);

  // In-process agents (non-pod mode) resolve via the in-memory promise.
  const pending = pendingResolvers.get(request.tool_use_id);
  if (pending) {
    clearTimeout(pending.timeoutId);
    pending.resolve(mapPermissionDecision(request.tool_name, toolInput, decision, answer));
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
