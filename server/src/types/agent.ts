export type AgentState =
  | "pending"
  | "running"
  | "waiting_permission"
  | "waiting_input"
  | "completed"
  | "verified"
  | "failed"
  | "paused"
  | "aborted";

export type PriorityTier = "high" | "medium" | "low";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "dontAsk"
  | "bypassPermissions"
  | "plan";

export interface AgentRecord {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  state: AgentState;
  priority: PriorityTier;
  permission_mode: PermissionMode;
  sdk_session_id: string | null;
  model: string;
  max_turns: number | null;
  max_budget_usd: number | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface CreateAgentRequest {
  name: string;
  prompt: string;
  cwd: string;
  priority?: PriorityTier;
  permission_mode?: PermissionMode;
  model?: string;
  max_turns?: number;
  max_budget_usd?: number;
}

export interface PermissionRequest {
  id: number;
  agent_id: string;
  tool_name: string;
  tool_input: string;
  tool_use_id: string;
  status: "pending" | "approved" | "denied";
  resolved_at: string | null;
  created_at: string;
}
