export type AgentState =
  | "pending"
  | "queued"
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

export type PermissionPolicy = "auto" | "ask" | "strict";

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
  supervisor_instructions: string;
  permission_policy: PermissionPolicy;
  created_by_user_id: string | null;
  repo_url: string | null;
  repo_ref: string | null;
  branch: string | null;
  pr_url: string | null;
  pr_number: number | null;
  advisory_strikes: number;
  review: string | null;
  recommendation: string | null;
  service_account: string | null;
  worker_image: string | null;
  pipeline_run_id: string | null;
  review_of_agent_id: string | null;
  deployed_by_agent_id: string | null;
  adopted_ref: string | null; // display marker when adopting an existing PR/branch
  size: string | null; // t-shirt pod size (s|m|l|xl); null until set by caller or supervisor
  toolchain: string | null; // Dockerfile build target in .daboss/agent.Dockerfile (toolchain flavor); null → final stage
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  last_heartbeat_at: string | null; // sidecar beats while the pod is alive; stale = dead pod
  plan: string | null; // the agent's full TodoWrite todos JSON (set by the worker)
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
  supervisor_instructions?: string;
  permission_policy?: PermissionPolicy;
  repo_url?: string;
  repo_ref?: string;
  branch?: string; // full override; else computed from the pieces below
  adopted_ref?: string; // display marker: the user's PR/branch reference when adopting
  size?: string; // explicit t-shirt pod size (s|m|l|xl) — skips supervisor assessment
  toolchain?: string; // Dockerfile build target (toolchain flavor) in .daboss/agent.Dockerfile
  branch_type?: string; // feat | fix | chore | docs | refactor | test
  issue_id?: string;
  service_account?: string; // k8s SA the agent pod runs as (e.g. the deploy identity)
  worker_image?: string; // image override for the agent container (e.g. a gcloud/kubectl image)
}

/** A review as a first-class entity (review-platform plan §3.1). Additive to the
 *  legacy agents.review_of_agent_id linkage. `reviewed_agent_id` is today's delta
 *  handle; no forge/PR vocabulary, per the neutrality check (§8). */
export interface Review {
  id: string;
  reviewed_agent_id: string;
  review_agent_id: string | null;
  requested_by: string | null;
  runner: string;
  status: "pending" | "running" | "done" | "error";
  recommendation: "merge" | "fix" | "hold" | null;
  rationale: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface PermissionRequest {
  id: number;
  agent_id: string;
  tool_name: string;
  tool_input: string;
  tool_use_id: string;
  status: "pending" | "approved" | "denied";
  resolution_answer: string | null;
  /** Who resolved it: a user id (human), 'supervisor' (auto-approval), or
   *  'timeout' (worker auto-deny). NULL on legacy rows. */
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}
