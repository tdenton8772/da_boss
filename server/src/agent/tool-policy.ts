/**
 * Shared tool-permission policy — the single source of truth for "which tool
 * calls are safe to auto-approve vs. must round-trip to the human", used by BOTH
 * the in-process boss handler (permissions.ts) and the pod worker (worker/index.ts).
 *
 * Keeping this pure and dependency-light means a pod worker can make the exact
 * same decision the boss would, without the EventEmitter/WebSocket machinery.
 */
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";

export type PermissionPolicy = "auto" | "ask" | "strict";

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
  // Note: AskUserQuestion and ExitPlanMode are NOT here — they route to the human
  // Note: Config and KillShell are NOT here — they escalate
];

// Bash commands that should NEVER be auto-approved
const DANGEROUS_BASH_PATTERNS = [
  /rm\s+(-rf?|--recursive)\s+[/~]/,     // rm -rf with absolute/home paths
  />\s*\/etc\//, />\s*\/usr\//,          // writing to system dirs
  /sudo\s/, /chmod\s.*777/,              // privilege escalation
  /curl.*\|\s*(bash|sh)/,                // pipe to shell
  /\beval\s+[^"(]/, /\beval\s+"[^$]/,    // code execution (allow eval "$(tool init -)" patterns)
  /DROP\s+TABLE/i, /DELETE\s+FROM/i,     // destructive SQL
  /git\s+push\s+.*--force/,              // force push
  /git\s+reset\s+--hard/,                // destructive git
  /launchctl\s+(unload|load|remove)/,    // don't let agents touch launchd services
  /kill\s+.*3847/, /lsof.*3847.*kill/,   // don't let agents kill the da_boss server
  /pkill.*(node|da.?boss)/,              // don't kill node processes
];

export function isBashDangerous(command: string): boolean {
  const trimmed = command.trim();
  return DANGEROUS_BASH_PATTERNS.some((p) => p.test(trimmed));
}

export function isPathSafe(filePath: string, agentCwd: string): boolean {
  if (agentCwd && filePath.startsWith(agentCwd)) return true;
  if (filePath.startsWith("/tmp/") || filePath.startsWith("/private/tmp/")) return true;
  return false;
}

/**
 * The core decision: may this tool call be auto-approved, or must a human see it?
 * `cwd` is the agent's working directory (writes inside it are trusted). Under a
 * pod, that's the pod's WORK_DIR — the whole clone is the agent's sandbox.
 */
export function shouldAutoApprove(
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd: string,
  policy: PermissionPolicy
): boolean {
  // Read-only tools are always safe, regardless of policy.
  if (ALWAYS_SAFE_TOOLS.includes(toolName)) return true;

  // strict/ask: escalate everything else to the human.
  if (policy === "strict" || policy === "ask") return false;

  // "auto": smart approval.
  if ((toolName === "Edit" || toolName === "Write") && typeof toolInput.file_path === "string") {
    return isPathSafe(toolInput.file_path, cwd);
  }
  if (toolName === "Bash" && typeof toolInput.command === "string") {
    return !isBashDangerous(toolInput.command);
  }
  if (toolName === "NotebookEdit" && typeof toolInput.file_path === "string") {
    return isPathSafe(toolInput.file_path, cwd);
  }
  return false;
}

/**
 * Map a resolved permission (decision + optional human answer) to the SDK result.
 * Identical for the in-process handler and the pod worker so behavior can't drift.
 *
 * AskUserQuestion / ExitPlanMode are special: the human's text answer is fed back
 * to the agent by DENYING with the answer as the message (the agent reads the deny
 * message as the tool result), so a Q&A round-trip works without a real tool run.
 */
export function mapPermissionDecision(
  toolName: string,
  toolInput: Record<string, unknown>,
  decision: "approved" | "denied",
  answer?: string | null
): PermissionResult {
  if (toolName === "AskUserQuestion" && answer) {
    return { behavior: "deny", message: `User answered: ${answer}` };
  }
  if (toolName === "ExitPlanMode") {
    if (decision === "approved" && answer) {
      return { behavior: "deny", message: `Plan approved. User feedback: ${answer}` };
    }
    if (decision === "approved") {
      return { behavior: "allow", updatedInput: toolInput };
    }
    return { behavior: "deny", message: `Plan rejected. ${answer || "Plan rejected by user"}` };
  }
  if (decision === "approved") {
    return { behavior: "allow", updatedInput: toolInput };
  }
  return { behavior: "deny", message: answer ? `Denied: ${answer}` : "Denied by user" };
}
