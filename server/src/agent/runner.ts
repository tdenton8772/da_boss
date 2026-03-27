import { EventEmitter } from "node:events";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRecord } from "../types/agent.js";
import type { ServerEvent } from "../types/events.js";
import { createPermissionHandler } from "./permissions.js";
import { assertTransition } from "../utils/state-machine.js";
import { TokenBudgetManager } from "../tokens/budget.js";
import * as queries from "../db/queries.js";
import { logger } from "../utils/logger.js";

type SDKQuery = ReturnType<typeof sdkQuery>;

export class AgentRunner {
  private currentQuery: SDKQuery | null = null;
  private abortController: AbortController | null = null;
  private _running = false;

  constructor(
    private agentId: string,
    private eventBus: EventEmitter,
    private budgetManager: TokenBudgetManager
  ) {}

  get running(): boolean {
    return this._running;
  }

  async start(): Promise<void> {
    const agent = queries.getAgent(this.agentId);
    if (!agent) throw new Error(`Agent ${this.agentId} not found`);

    // Budget check
    const canAllocate = this.budgetManager.canAllocate(agent.priority);
    if (!canAllocate.allowed) {
      throw new Error(`Budget denied: ${canAllocate.reason}`);
    }

    this.abortController = new AbortController();
    this._running = true;

    // Transition to running
    this.transitionState(agent, "running");
    queries.updateAgentState(this.agentId, "running", {
      started_at: new Date().toISOString(),
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
        ...(agent.max_turns && { maxTurns: agent.max_turns }),
        ...(agent.max_budget_usd && { maxBudgetUsd: agent.max_budget_usd }),
        ...(agent.sdk_session_id && { resume: agent.sdk_session_id }),
      };

      this.currentQuery = sdkQuery({
        prompt: agent.prompt,
        options,
      });

      let sessionId = agent.sdk_session_id;

      for await (const msg of this.currentQuery) {
        if (!this._running) break;

        // Extract session ID from init message
        if (
          "type" in msg &&
          msg.type === "system" &&
          "session_id" in msg &&
          msg.session_id
        ) {
          sessionId = msg.session_id as string;
          queries.updateAgentState(this.agentId, "running", {
            sdk_session_id: sessionId,
          });
        }

        // Handle assistant messages (complete)
        if ("type" in msg && msg.type === "assistant") {
          const content = this.extractTextContent(msg);
          if (content) {
            this.emitMessage("assistant", content);
            queries.insertAgentEvent(this.agentId, "message", {
              role: "assistant",
              content: content.substring(0, 2000),
            });
          }

          // Track token usage from assistant messages
          if ("message" in msg && msg.message && "usage" in msg.message) {
            const usage = msg.message.usage as {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
            if (usage.input_tokens || usage.output_tokens) {
              // Estimate cost (will be corrected by result message)
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

        // Handle result
        if ("type" in msg && msg.type === "result") {
          const result = msg as {
            result?: string;
            total_cost_usd?: number;
            is_error?: boolean;
            error?: string;
            session_id?: string;
          };

          if (result.session_id) {
            sessionId = result.session_id;
          }

          if (result.is_error) {
            const errMsg = result.error || result.result || "Unknown error";
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
            queries.updateAgentState(this.agentId, "completed", {
              sdk_session_id: sessionId,
              completed_at: new Date().toISOString(),
            });
            this.emitStateChange("running", "completed");
            queries.insertAgentEvent(this.agentId, "state_change", {
              from: "running",
              to: "completed",
            });
          }
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("aborted") || message.includes("abort")) {
        logger.info({ agentId: this.agentId }, "Agent aborted");
      } else if (message.includes("too long") || message.includes("too large") || message.includes("context")) {
        // Session too large to resume — mark as failed with actionable message
        this.handleError(
          "Session too large to resume. Use 'fresh start' to begin a new session with a summary of the previous work.",
          agent.sdk_session_id
        );
      } else {
        this.handleError(message, null);
      }
    } finally {
      this._running = false;
      this.currentQuery = null;
      this.abortController = null;
    }
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

    if (this.abortController) {
      this.abortController.abort();
    }

    queries.updateAgentState(this.agentId, "aborted");
    this.emitStateChange(agent.state, "aborted");
    queries.insertAgentEvent(this.agentId, "state_change", {
      from: agent.state,
      to: "aborted",
    });
  }

  async sendInput(userMessage: string): Promise<void> {
    if (!this.currentQuery) {
      throw new Error("No active query to send input to");
    }

    const sdkMessage = {
      type: "user" as const,
      message: {
        role: "user" as const,
        content: userMessage,
      },
      parent_tool_use_id: null,
      session_id: "",
    };

    async function* inputStream() {
      yield sdkMessage;
    }
    await this.currentQuery.streamInput(inputStream() as AsyncIterable<import("@anthropic-ai/claude-agent-sdk").SDKUserMessage>);

    const agent = queries.getAgent(this.agentId);
    if (agent?.state === "waiting_input") {
      queries.updateAgentState(this.agentId, "running");
      this.emitStateChange("waiting_input", "running");
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

  private transitionState(
    agent: AgentRecord,
    newState: AgentRecord["state"]
  ): void {
    if (agent.state !== newState) {
      assertTransition(agent.state, newState);
    }
  }
}
