import type { AgentState, PermissionRequest } from "./agent.js";

// Server → Client WebSocket events
export type ServerEvent =
  | {
      type: "agent:state_changed";
      agentId: string;
      state: AgentState;
      previousState: AgentState;
    }
  | {
      type: "agent:message";
      agentId: string;
      role: "assistant" | "tool" | "system";
      content: string;
      timestamp: string;
    }
  | {
      type: "agent:stream";
      agentId: string;
      delta: string;
    }
  | {
      type: "agent:token_usage";
      agentId: string;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      totalCostUsd: number;
    }
  | {
      type: "agent:error";
      agentId: string;
      error: string;
    }
  | {
      type: "permission:requested";
      request: PermissionRequest;
    }
  | {
      type: "permission:resolved";
      requestId: number;
      decision: "approved" | "denied";
    }
  | {
      type: "budget:updated";
      dailySpendUsd: number;
      dailyBudgetUsd: number;
      monthlySpendUsd: number;
      monthlyBudgetUsd: number;
    }
  | {
      type: "supervisor:finding";
      finding: string;
      action?: string;
    }
  | {
      type: "agent:subagent_start";
      agentId: string;
      subagent: {
        agentId: string;
        agentType: string;
        sessionId: string;
        transcriptPath: string;
        startedAt: string;
      };
    }
  | {
      type: "agent:subagent_stop";
      agentId: string;
      subagentId: string;
      transcriptPath: string;
    };

// Client → Server WebSocket commands
export type ClientCommand =
  | { type: "subscribe"; agentId: string }
  | { type: "unsubscribe"; agentId: string };
