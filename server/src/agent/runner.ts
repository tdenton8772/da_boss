import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRecord } from "../types/agent.js";
import type { ServerEvent } from "../types/events.js";
import { createPermissionHandler } from "./permissions.js";
import { assertTransition } from "../utils/state-machine.js";
import { TokenBudgetManager } from "../tokens/budget.js";
import type { TaskMonitor } from "./task-monitor.js";
import * as queries from "../db/queries.js";
import { logger } from "../utils/logger.js";

type SDKQuery = ReturnType<typeof sdkQuery>;

/** Get all claude PIDs (excluding interactive sessions). */
function getClaudePids(): Set<number> {
  try {
    const output = execSync(
      "ps -eo pid,command | grep '[c]laude' | grep -v 'skip-permissions' | grep -v 'Code Helper'",
      { encoding: "utf-8", timeout: 3000 }
    ).trim();
    const pids = new Set<number>();
    for (const line of output.split("\n")) {
      const pid = parseInt(line.trim());
      if (pid) pids.add(pid);
    }
    return pids;
  } catch {
    return new Set();
  }
}

/** Recursively find all descendant PIDs of a given PID. */
function getDescendantPids(pid: number): number[] {
  const descendants: number[] = [];
  try {
    const output = execSync(`pgrep -P ${pid}`, { encoding: "utf-8", timeout: 3000 }).trim();
    for (const line of output.split("\n")) {
      const childPid = parseInt(line.trim());
      if (childPid) {
        descendants.push(childPid);
        descendants.push(...getDescendantPids(childPid));
      }
    }
  } catch {
    // No children
  }
  return descendants;
}

/** SIGKILL a PID and all its descendants. Returns count killed. */
function killProcessTree(pid: number): number {
  const descendants = getDescendantPids(pid);
  const allPids = [...descendants.reverse(), pid]; // children first, then parent
  let killed = 0;
  for (const p of allPids) {
    try {
      process.kill(p, "SIGKILL");
      killed++;
    } catch {
      // Already dead
    }
  }
  return killed;
}

export interface SubagentInfo {
  agentId: string;     // SDK's agent_id
  agentType: string;   // e.g. "Explore", "general-purpose"
  sessionId: string;
  transcriptPath: string;
  parentAgentId: string; // da_boss agent ID
  startedAt: string;
  stoppedAt?: string;
}

export class AgentRunner {
  private currentQuery: SDKQuery | null = null;
  private abortController: AbortController | null = null;
  private _running = false;
  private _sessionId: string | null = null;
  /** PIDs spawned by this runner (claude + subagents). */
  private _trackedPids = new Set<number>();
  /** Active subagents tracked via SDK hooks. */
  private _subagents = new Map<string, SubagentInfo>();

  constructor(
    private agentId: string,
    private eventBus: EventEmitter,
    private budgetManager: TokenBudgetManager,
    private taskMonitor: TaskMonitor
  ) {}

  get trackedPids(): Set<number> {
    return this._trackedPids;
  }

  get subagents(): Map<string, SubagentInfo> {
    return this._subagents;
  }

  get running(): boolean {
    return this._running;
  }

  /**
   * Run a single turn: send a prompt (or resume), iterate messages,
   * then transition to waiting_input when the turn completes.
   * The process exits after each turn — this matches terminal behavior.
   */
  async runTurn(prompt: string, isResume: boolean): Promise<void> {
    const agent = queries.getAgent(this.agentId);
    if (!agent) throw new Error(`Agent ${this.agentId} not found`);

    // Budget check
    const canAllocate = this.budgetManager.canAllocate(agent.priority);
    if (!canAllocate.allowed) {
      throw new Error(`Budget denied: ${canAllocate.reason}`);
    }

    this.abortController = new AbortController();
    this._running = true;

    // Snapshot PIDs before starting so we can detect new ones
    const pidsBefore = getClaudePids();

    // Transition to running
    this.transitionState(agent, "running");
    queries.updateAgentState(this.agentId, "running", {
      started_at: new Date().toISOString(),
      error_message: null,
    });

    const permissionHandler = createPermissionHandler(
      this.agentId,
      this.eventBus
    );

    try {
      const options: Parameters<typeof sdkQuery>[0]["options"] = {
        cwd: agent.cwd,
        abortController: this.abortController,
        includePartialMessages: true,
        model: agent.model,
        canUseTool: permissionHandler,
        systemPrompt: {
          type: "preset" as const,
          preset: "claude_code" as const,
          append: [
            "IMPORTANT: You are running as a managed agent via da_boss.",
            "For long-running or background commands, do NOT use run_in_background (it does not persist between turns).",
            "Instead, use shell backgrounding with output redirection to a file, e.g.:",
            "  `my-command > /tmp/my-output.log 2>&1 &`",
            "da_boss automatically detects backgrounded commands and monitors their output files.",
            "When the command completes, da_boss will automatically notify you with the results.",
            "Do NOT restart the da_boss server, kill port 3847, or run launchctl commands.",
          ].join("\n"),
        },
        ...(agent.max_turns && { maxTurns: agent.max_turns }),
        ...(agent.max_budget_usd && { maxBudgetUsd: agent.max_budget_usd }),
        ...(agent.sdk_session_id && { resume: agent.sdk_session_id }),
        hooks: {
          SubagentStart: [{
            hooks: [async (input) => {
              logger.info({ agentId: this.agentId, hookInput: JSON.stringify(input).substring(0, 500) }, "SubagentStart hook fired");
              const hi = input as Record<string, unknown>;
              const subId = String(hi.agent_id || hi.agentId || `sub_${Date.now()}`);
              const info: SubagentInfo = {
                agentId: subId,
                agentType: String(hi.agent_type || "unknown"),
                sessionId: String(hi.session_id || ""),
                transcriptPath: String(hi.transcript_path || ""),
                parentAgentId: this.agentId,
                startedAt: new Date().toISOString(),
              };
              this._subagents.set(subId, info);
              logger.info({ parentId: this.agentId, subagentId: subId, type: info.agentType }, "Subagent started");

              // Detect the new PID
              setTimeout(() => {
                const currentPids = getClaudePids();
                for (const pid of currentPids) {
                  if (!this._trackedPids.has(pid)) {
                    this._trackedPids.add(pid);
                    logger.info({ agentId: this.agentId, subagentId: subId, pid }, "Tracking subagent process");
                  }
                }
              }, 500);

              this.eventBus.emit("server-event", {
                type: "agent:subagent_start",
                agentId: this.agentId,
                subagent: info,
              });
              queries.insertAgentEvent(this.agentId, "message", {
                role: "system",
                content: `Subagent started: **${info.agentType}** (${subId})`,
              });
              return { continue: true };
            }],
          }],
          SubagentStop: [{
            hooks: [async (input) => {
              const hi = input as { agent_id?: string; agent_transcript_path?: string };
              const subId = hi.agent_id || "";
              const info = this._subagents.get(subId);
              if (info) {
                info.stoppedAt = new Date().toISOString();
                if (hi.agent_transcript_path) info.transcriptPath = hi.agent_transcript_path;
              }
              logger.info({ parentId: this.agentId, subagentId: subId }, "Subagent stopped");
              this.eventBus.emit("server-event", {
                type: "agent:subagent_stop",
                agentId: this.agentId,
                subagentId: subId,
                transcriptPath: hi.agent_transcript_path || "",
              });
              queries.insertAgentEvent(this.agentId, "message", {
                role: "system",
                content: `Subagent finished: **${info?.agentType || "unknown"}** (${subId})`,
              });
              return { continue: true };
            }],
          }],
        },
      };

      this.currentQuery = sdkQuery({
        prompt,
        options,
      });

      let sessionId = agent.sdk_session_id;

      // Detect the new claude PID(s) spawned by the SDK
      setTimeout(() => {
        const pidsAfter = getClaudePids();
        for (const pid of pidsAfter) {
          if (!pidsBefore.has(pid)) {
            this._trackedPids.add(pid);
            logger.info({ agentId: this.agentId, pid }, "Tracking claude process");
          }
        }
      }, 1000);

      for await (const msg of this.currentQuery) {
        if (!this._running) break;

        // Scan all messages for background task output file references
        try {
          const raw = JSON.stringify(msg);
          if ((raw.includes(">") && raw.includes("&")) || raw.includes("tasks/")) {
            this.taskMonitor.detectFromContent(this.agentId, raw);
          }
        } catch { /* ignore stringify errors */ }

        // Extract session ID from init message
        if (
          "type" in msg &&
          msg.type === "system" &&
          "session_id" in msg &&
          msg.session_id
        ) {
          sessionId = msg.session_id as string;
          this._sessionId = sessionId;
          queries.updateAgentState(this.agentId, "running", {
            sdk_session_id: sessionId,
          });
        }

        // Handle assistant messages
        if ("type" in msg && msg.type === "assistant") {
          const content = this.extractTextContent(msg);
          if (content) {
            this.emitMessage("assistant", content);
            this.taskMonitor.detectFromContent(this.agentId, content);
            queries.insertAgentEvent(this.agentId, "message", {
              role: "assistant",
              content: content.substring(0, 2000),
            });
          }

          // Emit tool_use blocks as separate "tool" messages
          const toolUses = this.extractToolUses(msg);
          for (const tu of toolUses) {
            this.emitMessage("tool", tu);
            this.taskMonitor.detectFromContent(this.agentId, tu);
            queries.insertAgentEvent(this.agentId, "message", {
              role: "tool",
              content: tu.substring(0, 4000),
            });
          }

          // Detect backgrounded Bash commands from raw tool_use input
          const m2 = msg as { message?: { content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }> } };
          for (const block of m2?.message?.content || []) {
            if (block.type === "tool_use" && block.name === "Bash" && typeof block.input?.command === "string") {
              this.taskMonitor.detectFromCommand(this.agentId, block.input.command);
            }
          }

          // Track token usage
          if ("message" in msg && msg.message && "usage" in msg.message) {
            const usage = msg.message.usage as {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
            if (usage.input_tokens || usage.output_tokens) {
              const estimatedCost =
                ((usage.input_tokens || 0) * 0.000003 +
                  (usage.output_tokens || 0) * 0.000015);
              this.budgetManager.recordUsage(
                this.agentId,
                usage.input_tokens || 0,
                usage.output_tokens || 0,
                usage.cache_read_input_tokens || 0,
                usage.cache_creation_input_tokens || 0,
                estimatedCost
              );
            }
          }
        }

        // Handle tool results (user messages with tool_use_result)
        if ("type" in msg && msg.type === "user") {
          const userMsg = msg as {
            tool_use_result?: unknown;
            message?: { content?: Array<{ type: string; text?: string; content?: string }> };
          };
          if (userMsg.tool_use_result) {
            const result = userMsg.tool_use_result;
            let resultText = "";
            if (typeof result === "string") {
              resultText = result;
            } else if (typeof result === "object" && result !== null) {
              const r = result as Record<string, unknown>;
              const stdout = typeof r.stdout === "string" ? r.stdout : "";
              const output = typeof r.output === "string" ? r.output : "";
              const content = typeof r.content === "string" ? r.content : "";
              resultText = stdout || output || content || JSON.stringify(result).substring(0, 4000);
            }
            if (resultText && resultText.length > 0) {
              const preview = resultText.length > 2000 ? resultText.substring(0, 2000) + "\n..." : resultText;
              this.emitMessage("tool", `**Result**:\n\`\`\`\n${preview}\n\`\`\``);
              queries.insertAgentEvent(this.agentId, "message", {
                role: "tool",
                content: `Result: ${resultText.substring(0, 4000)}`,
              });
            }
          }
        }

        // Handle streaming partial messages
        if ("type" in msg && msg.type === "stream_event" && "event" in msg) {
          const event = msg.event as {
            type?: string;
            delta?: { type?: string; text?: string };
          };
          if (
            event?.type === "content_block_delta" &&
            event.delta?.type === "text_delta" &&
            event.delta.text
          ) {
            const streamEvent: ServerEvent = {
              type: "agent:stream",
              agentId: this.agentId,
              delta: event.delta.text,
            };
            this.eventBus.emit("server-event", streamEvent);
          }
        }

        // Handle result — turn completed
        if ("type" in msg && msg.type === "result") {
          const result = msg as {
            subtype?: string;
            result?: string;
            total_cost_usd?: number;
            is_error?: boolean;
            errors?: string[];
            session_id?: string;
          };

          if (result.session_id) {
            sessionId = result.session_id;
            this._sessionId = sessionId;
          }

          if (result.is_error || result.subtype?.startsWith("error_")) {
            const errMsg = result.errors?.join("; ") || result.result || "Unknown error";
            if (errMsg.toLowerCase().includes("too long") || errMsg.toLowerCase().includes("too large")) {
              this.handleError(
                "Session too large to resume — use Compact & Resume or Fresh Start below.",
                sessionId
              );
            } else {
              this.handleError(errMsg, sessionId);
            }
          } else {
            if (result.result) {
              this.emitMessage("assistant", result.result);
            }
            // Turn completed successfully. Save session, go to waiting_input.
            // Process will exit — next user message starts a new turn via resume.
            queries.updateAgentState(this.agentId, "waiting_input", {
              sdk_session_id: sessionId,
            });
            this.emitStateChange("running", "waiting_input");
            queries.insertAgentEvent(this.agentId, "state_change", {
              from: "running",
              to: "waiting_input",
            });
          }
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("aborted") || message.includes("abort")) {
        logger.info({ agentId: this.agentId }, "Agent aborted");
      } else if (message.includes("too long") || message.includes("too large") || message.includes("context")) {
        this.handleError(
          "Session too large to resume. Use 'fresh start' to begin a new session with a summary of the previous work.",
          agent.sdk_session_id
        );
      } else {
        // Don't treat process exit as error if we already transitioned to waiting_input
        const currentAgent = queries.getAgent(this.agentId);
        if (currentAgent?.state === "waiting_input") {
          logger.info({ agentId: this.agentId, error: message }, "Process exited after turn (expected)");
        } else {
          this.handleError(message, this._sessionId || null);
        }
      }
    } finally {
      this._running = false;
      this.currentQuery = null;
      // Always abort the child process to prevent orphans
      if (this.abortController) {
        try { this.abortController.abort(); } catch { /* ignore */ }
      }
      this.abortController = null;
      // SIGKILL any tracked processes that are still alive
      for (const pid of this._trackedPids) {
        try { process.kill(pid, 0); killProcessTree(pid); } catch { /* already dead */ }
      }
      this._trackedPids.clear();
    }
  }

  /** Start a new agent (first turn). */
  async start(): Promise<void> {
    const agent = queries.getAgent(this.agentId);
    if (!agent) throw new Error(`Agent ${this.agentId} not found`);
    await this.runTurn(agent.prompt, false);
  }

  /** Resume with a user message (subsequent turns). */
  async resumeWithInput(userMessage: string): Promise<void> {
    // Emit the user message to UI
    queries.insertAgentEvent(this.agentId, "message", {
      role: "user",
      content: userMessage,
    });
    this.eventBus.emit("server-event", {
      type: "agent:message",
      agentId: this.agentId,
      role: "user",
      content: userMessage,
      timestamp: new Date().toISOString(),
    });

    await this.runTurn(userMessage, true);
  }

  async pause(): Promise<void> {
    const agent = queries.getAgent(this.agentId);
    if (!agent) return;

    assertTransition(agent.state, "paused");
    this._running = false;

    if (this.currentQuery) {
      try {
        await this.currentQuery.interrupt();
      } catch {
        // ignore interrupt errors
      }
    }

    queries.updateAgentState(this.agentId, "paused");
    this.emitStateChange(agent.state, "paused");
    queries.insertAgentEvent(this.agentId, "state_change", {
      from: agent.state,
      to: "paused",
    });
  }

  async kill(): Promise<void> {
    const agent = queries.getAgent(this.agentId);
    if (!agent) return;

    this._running = false;
    this.taskMonitor.removeAgent(this.agentId);

    // SIGKILL the entire process tree first — no mercy
    let totalKilled = 0;
    for (const pid of this._trackedPids) {
      totalKilled += killProcessTree(pid);
    }
    if (totalKilled > 0) {
      logger.info({ agentId: this.agentId, killed: totalKilled }, "SIGKILL'd process tree");
    }
    this._trackedPids.clear();

    // Then abort via SDK (may be redundant but covers edge cases)
    if (this.abortController) {
      try { this.abortController.abort(); } catch { /* ignore */ }
    }

    this.currentQuery = null;
    this.abortController = null;

    queries.updateAgentState(this.agentId, "aborted");
    this.emitStateChange(agent.state, "aborted");
    queries.insertAgentEvent(this.agentId, "state_change", {
      from: agent.state,
      to: "aborted",
    });
  }

  async sendInput(userMessage: string): Promise<void> {
    // This is called when the runner is active and agent is waiting.
    // Start a new turn with the user's message.
    await this.resumeWithInput(userMessage);
  }

  /** Interrupt the running agent and deliver an urgent message. */
  async sendUrgent(userMessage: string): Promise<boolean> {
    if (!this.currentQuery || !this._running) {
      return false;
    }

    try {
      // Interrupt the current turn — agent pauses after current tool completes
      this.currentQuery.interrupt();
      logger.info({ agentId: this.agentId }, "Agent interrupted for urgent message");

      this.emitMessage("system", `Urgent: ${userMessage}`);
      queries.insertAgentEvent(this.agentId, "message", {
        role: "user",
        content: `[URGENT] ${userMessage}`,
      });

      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ agentId: this.agentId, error: msg }, "Failed to send urgent message");
      return false;
    }
  }

  private handleError(message: string, sessionId: string | null): void {
    logger.error({ agentId: this.agentId, error: message }, "Agent error");
    queries.updateAgentState(this.agentId, "failed", {
      error_message: message,
      ...(sessionId && { sdk_session_id: sessionId }),
    });
    this.emitStateChange("running", "failed");
    queries.insertAgentEvent(this.agentId, "error", { error: message });

    const errorEvent: ServerEvent = {
      type: "agent:error",
      agentId: this.agentId,
      error: message,
    };
    this.eventBus.emit("server-event", errorEvent);
  }

  private emitMessage(
    role: "assistant" | "tool" | "system",
    content: string
  ): void {
    const event: ServerEvent = {
      type: "agent:message",
      agentId: this.agentId,
      role,
      content,
      timestamp: new Date().toISOString(),
    };
    this.eventBus.emit("server-event", event);
  }

  private emitStateChange(
    previousState: string,
    newState: string
  ): void {
    const event = {
      type: "agent:state_changed" as const,
      agentId: this.agentId,
      state: newState,
      previousState,
    };
    this.eventBus.emit("server-event", event);
  }

  private extractTextContent(msg: unknown): string | null {
    const m = msg as {
      message?: { content?: Array<{ type: string; text?: string }> };
    };
    if (!m?.message?.content) return null;

    const textParts = m.message.content
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text!);

    return textParts.length > 0 ? textParts.join("\n") : null;
  }

  private extractToolUses(msg: unknown): string[] {
    const m = msg as {
      message?: { content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }> };
    };
    if (!m?.message?.content) return [];

    return m.message.content
      .filter((b) => b.type === "tool_use" && b.name)
      .map((b) => {
        const name = b.name!;
        const input = b.input || {};
        // Format based on tool type
        if (name === "Bash" && input.command) {
          return `**Bash**: \`${input.command}\``;
        }
        if (name === "Edit" && input.file_path) {
          const lines = [
            `**Edit**: \`${input.file_path}\``,
            ...(input.old_string ? ["```diff", `- ${String(input.old_string).substring(0, 500)}`, `+ ${String(input.new_string || "").substring(0, 500)}`, "```"] : []),
          ];
          return lines.join("\n");
        }
        if (name === "Write" && input.file_path) {
          const content = String(input.content || "");
          return `**Write**: \`${input.file_path}\`\n\`\`\`\n${content.substring(0, 1000)}${content.length > 1000 ? "\n..." : ""}\n\`\`\``;
        }
        if (name === "Read" && input.file_path) {
          return `**Read**: \`${input.file_path}\``;
        }
        if ((name === "Grep" || name === "Glob") && input.pattern) {
          return `**${name}**: \`${input.pattern}\`${input.path ? ` in \`${input.path}\`` : ""}`;
        }
        if (name === "TodoWrite" && Array.isArray(input.todos)) {
          const todos = input.todos as Array<{ content?: string; status?: string }>;
          const lines = todos.map((t) => {
            const check = t.status === "completed" ? "x" : " ";
            const label = t.status === "in_progress" ? " *(in progress)*" : "";
            return `- [${check}] ${t.content || ""}${label}`;
          });
          return `**Tasks**:\n${lines.join("\n")}`;
        }
        if (name === "AskUserQuestion" && Array.isArray(input.questions)) {
          const qs = input.questions as Array<{ question?: string; header?: string; options?: Array<{ label?: string }> }>;
          const lines = qs.map((q) => {
            const header = q.header ? `**${q.header}**: ` : "";
            const opts = q.options?.map((o) => o.label).join(", ") || "";
            return `${header}${q.question || ""}${opts ? `\n  Options: ${opts}` : ""}`;
          });
          return `**Question for user**:\n${lines.join("\n")}`;
        }
        if (name === "EnterPlanMode") {
          return "**Entering plan mode** — agent is designing an approach before coding";
        }
        if (name === "ExitPlanMode") {
          return "**Plan ready for review** — waiting for your approval";
        }
        // Generic fallback
        return `**${name}**: ${JSON.stringify(input).substring(0, 500)}`;
      });
  }

  private transitionState(
    agent: AgentRecord,
    newState: AgentRecord["state"]
  ): void {
    if (agent.state !== newState) {
      assertTransition(agent.state, newState);
    }
  }

}
