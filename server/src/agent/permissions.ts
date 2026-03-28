import { EventEmitter } from "node:events";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import * as queries from "../db/queries.js";
import type { ServerEvent } from "../types/events.js";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";

const ALWAYS_SAFE_TOOLS = [
  // Read-only tools
  "Read", "Grep", "Glob", "Explore", "LSP", "ToolSearch",
  // Agent/task management
  "Agent", "Task", "TaskCreate", "TaskUpdate", "TaskGet", "TaskList",
  "TaskOutput", "TaskStop",
  // EnterPlanMode is auto-approved (just a mode signal)
  "EnterPlanMode",
  // Todo management
  "TodoRead", "TodoWrite",
  // Web (read-only fetches)
  "WebFetch", "WebSearch",
  // Skills
  "Skill",
  // Note: AskUserQuestion and ExitPlanMode are NOT here — they route to UI
  // Note: Config and KillShell are NOT here — they escalate to UI
];

// Bash commands that are safe to auto-approve
const SAFE_BASH_PREFIXES = [
  "cat ", "head ", "tail ", "less ", "wc ", "file ",
  "ls", "pwd", "find ", "which ", "type ", "echo ",
  "git status", "git log", "git diff", "git branch", "git show", "git rev-parse", "git remote",
  "npm test", "npm run test", "npm run lint", "npm run build", "npm run check",
  "npx tsc", "npx vitest", "npx jest", "npx prettier", "npx eslint",
  "cargo test", "cargo check", "cargo build", "cargo clippy",
  "python -m pytest", "python -m mypy", "python3 -m pytest",
  "make test", "make check", "make build",
  "grep ", "rg ", "ag ", "sed -n", "awk ",
  "stat ", "du ", "df ",
  "node -e", "node --eval", "python -c", "python3 -c",
  "mkdir -p ", "touch ",
  "curl ", "wget ",
  "docker ps", "docker images", "docker logs", "docker inspect", "docker stats",
  "docker build", "docker run ", "docker exec ", "docker start", "docker stop",
  "docker rm ", "docker rmi ", "docker pull ", "docker push ", "docker tag ",
  "docker network", "docker volume", "docker info", "docker version",
  "docker compose ", "docker-compose ",
  "kubectl get", "kubectl describe", "kubectl logs", "kubectl exec ", "kubectl apply ",
  "kubectl delete ", "kubectl create ", "kubectl patch ", "kubectl scale ",
  "kubectl rollout", "kubectl config", "kubectl cluster-info", "kubectl version",
  "kubectl port-forward", "kubectl label", "kubectl annotate", "kubectl explain",
  "helm install ", "helm upgrade ", "helm uninstall ", "helm list", "helm status ",
  "helm get ", "helm show ", "helm search ", "helm repo ", "helm template ",
  "helm rollback ", "helm history ", "helm lint ",
];

// Bash commands that should NEVER be auto-approved
const DANGEROUS_BASH_PATTERNS = [
  /rm\s+(-rf?|--recursive)\s+[\/~]/,  // rm -rf with absolute/home paths
  />\s*\/etc\//, />\s*\/usr\//,         // writing to system dirs
  /sudo\s/, /chmod\s.*777/,             // privilege escalation
  /curl.*\|\s*(bash|sh)/,               // pipe to shell
  /\beval\s+[^"(]/, /\beval\s+"[^$]/,   // code execution (allow eval "$(tool init -)" patterns)
  /DROP\s+TABLE/i, /DELETE\s+FROM/i,    // destructive SQL
  /git\s+push\s+.*--force/,             // force push
  /git\s+reset\s+--hard/,              // destructive git
  /launchctl\s+(unload|load|remove)/,  // don't let agents touch launchd services
  /kill\s+.*3847/, /lsof.*3847.*kill/, // don't let agents kill the da_boss server
  /pkill.*(node|da.?boss)/,            // don't kill node processes
];

function isBashDangerous(command: string): boolean {
  const trimmed = command.trim();
  for (const pattern of DANGEROUS_BASH_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }
  return false;
}

function isPathSafe(filePath: string, agentCwd: string): boolean {
  // Allow writes within the agent's working directory
  if (filePath.startsWith(agentCwd)) return true;
  // Allow /tmp
  if (filePath.startsWith("/tmp/") || filePath.startsWith("/private/tmp/")) return true;
  return false;
}

// Pending permission promises keyed by tool_use_id
const pendingResolvers = new Map<
  string,
  { resolve: (result: PermissionResult) => void; timeoutId: NodeJS.Timeout }
>();

export function createPermissionHandler(
  agentId: string,
  eventBus: EventEmitter
) {
  // Get the agent's cwd and policy for decisions
  const agent = queries.getAgent(agentId);
  const agentCwd = agent?.cwd || "";
  const policy = agent?.permission_policy || "auto";

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
    // "strict" policy: only auto-approve truly read-only tools, escalate everything else
    // "ask": same as strict (legacy, ask for everything)
    // "auto": smart auto-approval based on safety analysis

    // Always auto-approve read-only tools regardless of policy
    if (ALWAYS_SAFE_TOOLS.includes(toolName)) {
      return { behavior: "allow", updatedInput: toolInput };
    }

    // In strict/ask mode, escalate everything else to UI
    if (policy === "strict" || policy === "ask") {
      // fall through to escalation below
    } else {
      // "auto" mode: smart approval

      // Auto-approve Edit/Write within the agent's working directory
      if ((toolName === "Edit" || toolName === "Write") && typeof toolInput.file_path === "string") {
        if (isPathSafe(toolInput.file_path, agentCwd)) {
          logger.info({ agentId, toolName, path: toolInput.file_path }, "Auto-approved (within cwd)");
          return { behavior: "allow", updatedInput: toolInput };
        }
      }

      // Auto-approve Bash unless it matches a dangerous pattern
      if (toolName === "Bash" && typeof toolInput.command === "string") {
        if (!isBashDangerous(toolInput.command)) {
          logger.info({ agentId, command: toolInput.command.substring(0, 80) }, "Auto-approved bash");
          return { behavior: "allow", updatedInput: toolInput };
        }
      }

      // Auto-approve NotebookEdit within cwd
      if (toolName === "NotebookEdit" && typeof toolInput.file_path === "string") {
        if (isPathSafe(toolInput.file_path, agentCwd)) {
          return { behavior: "allow", updatedInput: toolInput };
        }
      }
    }

    // Everything else: escalate to UI
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
  eventBus: EventEmitter,
  answer?: string
): boolean {
  const request = queries.getPermission(requestId);
  if (!request || request.status !== "pending") return false;

  const toolInput = JSON.parse(request.tool_input) as Record<string, unknown>;
  queries.resolvePermission(requestId, decision);

  const pending = pendingResolvers.get(request.tool_use_id);
  if (pending) {
    clearTimeout(pending.timeoutId);
    if (request.tool_name === "AskUserQuestion" && answer) {
      // For AskUserQuestion, deny with the user's answer so the agent receives it.
      // The agent sees the deny message as the tool result containing the user's response.
      pending.resolve({ behavior: "deny", message: `User answered: ${answer}` });
    } else if (request.tool_name === "ExitPlanMode") {
      if (decision === "approved" && answer) {
        // Approve with feedback — deny so the agent sees the message, but prefix with approval
        pending.resolve({ behavior: "deny", message: `Plan approved. User feedback: ${answer}` });
      } else if (decision === "approved") {
        pending.resolve({ behavior: "allow", updatedInput: toolInput });
      } else {
        // Deny with feedback so agent knows to revise the plan
        const feedback = answer || "Plan rejected by user";
        pending.resolve({ behavior: "deny", message: `Plan rejected. ${feedback}` });
      }
    } else if (decision === "approved") {
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
