// Prefix all API calls with the app's base path (import.meta.env.BASE_URL is "/"
// locally, "/daboss/" on GKE) so the app works under a path on a shared host.
const PREFIX = import.meta.env.BASE_URL.replace(/\/$/, "");
const BASE = `${PREFIX}/api`;

async function request<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export interface AuthedUser {
  userId: string;
  email: string | null;
  name: string | null;
  role: string;
}

export const api = {
  // Auth
  login: (email: string, password: string) =>
    request<{ user: AuthedUser }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  register: (email: string, password: string, displayName?: string) =>
    request<{ user: AuthedUser }>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, displayName }),
    }),
  logout: () => request("/auth/logout", { method: "POST" }),
  me: () =>
    request<{ authenticated: boolean; user: AuthedUser | null; authMode: "local" | "oidc"; ssoLabel?: string; ssoLoginUrl?: string }>(
      "/auth/me"
    ),

  // Per-user Claude credential (write-only — status never returns the token)
  credentialStatus: () =>
    request<{ hasCredential: boolean; kind: string | null; updatedAt: string | null }>(
      "/me/credential"
    ),
  setCredential: (kind: string, token: string) =>
    request<{ ok: boolean; kind: string }>("/me/credential", {
      method: "POST",
      body: JSON.stringify({ kind, token }),
    }),
  deleteCredential: () => request("/me/credential", { method: "DELETE" }),

  // Per-user git PAT (write-only)
  gitCredentialStatus: () =>
    request<{ hasCredential: boolean; updatedAt: string | null }>("/me/git-credential"),
  setGitCredential: (token: string) =>
    request<{ ok: boolean }>("/me/git-credential", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
  deleteGitCredential: () => request("/me/git-credential", { method: "DELETE" }),

  // Agents
  getAgents: (includeTest?: boolean, includeSubagents?: boolean) => {
    const q = [
      includeTest ? "includeTest=true" : "",
      includeSubagents ? "includeSubagents=true" : "",
    ].filter(Boolean).join("&");
    return request<AgentWithTokens[]>(`/agents${q ? `?${q}` : ""}`);
  },
  pruneTestAgents: () =>
    request<{ ok: boolean; pruned: number }>("/admin/test-agents/prune", { method: "POST" }),
  getAgent: (id: string) => request<AgentDetail>(`/agents/${id}`),
  resolveRef: (repo: string, ref: string) =>
    request<ResolvedRef>(`/forge/resolve-ref?repo=${encodeURIComponent(repo)}&ref=${encodeURIComponent(ref)}`),
  createAgent: (data: CreateAgentData) =>
    request("/agents", { method: "POST", body: JSON.stringify(data) }),
  deleteAgent: (id: string) =>
    request<{ ok: boolean; branchCleanup?: { deleted: boolean; branch?: string; reason?: string } }>(
      `/agents/${id}`,
      { method: "DELETE" }
    ),
  startAgent: (id: string) =>
    request(`/agents/${id}/start`, { method: "POST" }),
  pauseAgent: (id: string) =>
    request(`/agents/${id}/pause`, { method: "POST" }),
  resumeAgent: (id: string) =>
    request(`/agents/${id}/resume`, { method: "POST" }),
  killAgent: (id: string) =>
    request(`/agents/${id}/kill`, { method: "POST" }),
  sendInput: (id: string, message: string) =>
    request(`/agents/${id}/input`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
  sendUrgent: (id: string, message: string) =>
    request<{ ok: boolean; delivered: string }>(`/agents/${id}/urgent`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
  getEvents: (id: string, limit?: number) =>
    request<AgentEvent[]>(`/agents/${id}/events?limit=${limit || 100}`),

  // Permissions
  getPendingPermissions: () =>
    request<PermissionReq[]>("/permissions/pending"),
  resolvePermission: (id: number, decision: "approved" | "denied", answer?: string) =>
    request(`/permissions/${id}/resolve`, {
      method: "POST",
      body: JSON.stringify({ decision, ...(answer && { answer }) }),
    }),

  // Budget
  getBudget: () => request<BudgetStatus>("/budget"),
  updateBudget: (daily: number, monthly: number) =>
    request<BudgetStatus>("/budget", {
      method: "PUT",
      body: JSON.stringify({
        daily_budget_usd: daily,
        monthly_budget_usd: monthly,
      }),
    }),

  // Supervisor
  runSupervisor: () => request("/supervisor/run", { method: "POST" }),

  // Discover
  discoverProjects: () =>
    request<DiscoveredProject[]>("/discover/projects"),
  discoverSessions: (projectKey: string) =>
    request<DiscoveredSession[]>(
      `/discover/projects/${encodeURIComponent(projectKey)}/sessions`
    ),
  discoverMessages: (
    projectKey: string,
    sessionId: string,
    limit?: number
  ) =>
    request<SessionMessage[]>(
      `/discover/projects/${encodeURIComponent(projectKey)}/sessions/${sessionId}/messages?limit=${limit || 50}`
    ),
  importSession: (data: {
    projectKey: string;
    sessionId: string;
    name: string;
    priority?: string;
  }) =>
    request<{ id: string }>("/discover/import", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // Templates
  getTemplates: () => request<AgentTemplate[]>("/templates"),

  // Named secrets (pipeline creds — write-only)
  listSecrets: () => request<string[]>("/me/secrets"),
  setSecret: (name: string, value: string) =>
    request<{ ok: boolean }>(`/me/secrets/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ value }) }),
  deleteSecret: (name: string) => request(`/me/secrets/${encodeURIComponent(name)}`, { method: "DELETE" }),

  // Test agent — run the repo's test phase for this agent's branch; gates its PR
  testAgent: (id: string) =>
    request<{ runId: string; phase: string }>(`/agents/${id}/test`, { method: "POST" }),
  // Deploy this agent's BRANCH to staging (bypasses the main-only gate) — see it before merge
  deployBranch: (id: string) =>
    request<{ ok: boolean; runId: string; agentId?: string }>(`/agents/${id}/deploy-branch`, { method: "POST" }),
  // Merge the base branch (main) INTO this agent's feature branch (branch cut from an
  // older main). Clean → {clean:true} (resume to pick it up); conflicts → {dispatched:true}
  // (the agent resolves them, then da_boss pushes).
  syncMain: (id: string) =>
    request<{ ok: boolean; clean?: boolean; dispatched?: boolean }>(`/agents/${id}/sync-main`, { method: "POST" }),
  // Resize an agent's pod (applies on next resume/dispatch; agent must be paused)
  resizeAgent: (id: string, size: "s" | "m" | "l" | "xl") =>
    request<{ ok: boolean; size: string }>(`/agents/${id}/size`, { method: "POST", body: JSON.stringify({ size }) }),
  // Report-back actions
  mergeAgent: (id: string, override?: boolean) => request<{ ok?: boolean; merged?: boolean; landing?: boolean }>(`/agents/${id}/merge`, { method: "POST", body: JSON.stringify({ override: !!override }) }),
  requestChanges: (id: string, feedback: string) =>
    request<{ ok: boolean }>(`/agents/${id}/request-changes`, { method: "POST", body: JSON.stringify({ feedback }) }),
  queueReview: (id: string) =>
    request<{ ok: boolean; reviewAgentId: string }>(`/agents/${id}/review`, { method: "POST" }),

  // API tokens (headless auth for the MCP surface)
  listTokens: () => request<ApiTokenSummary[]>("/tokens"),
  createToken: (name: string, scopes: string[]) =>
    request<{ id: string; name: string; scopes: string; token: string }>("/tokens", {
      method: "POST",
      body: JSON.stringify({ name, scopes }),
    }),
  revokeToken: (id: string) => request<{ ok: boolean }>(`/tokens/${id}`, { method: "DELETE" }),

  // Pod t-shirt size presets (admin)
  getSizePresets: () => request<Record<string, SizePreset>>("/admin/size-presets"),
  saveSizePresets: (presets: Record<string, SizePreset>) =>
    request<{ ok: boolean }>("/admin/size-presets", { method: "PUT", body: JSON.stringify(presets) }),

  // Pipeline builder
  validatePipeline: (yaml: string) =>
    request<{ ok: boolean; error?: string; phases?: Array<{ name: string; image: string; gate: string; requires: string[]; only_ref: string | null }> }>(
      "/pipeline/validate",
      { method: "POST", body: JSON.stringify({ yaml }) }
    ),

  // Pipeline runs
  runPipeline: (repo_url: string, phase: string, ref?: string) =>
    request<{ runId: string; phase: string; gate: string }>("/pipeline/run", {
      method: "POST",
      body: JSON.stringify({ repo_url, phase, ...(ref && { ref }) }),
    }),
  getPipelineRun: (id: string) =>
    request<PipelineRunInfo>(`/pipeline/runs/${id}`),
  listPipelineRuns: () => request<PipelineRunInfo[]>("/pipeline/runs"),
  approvePipelineRun: (id: string) =>
    request<{ ok: boolean }>(`/pipeline/runs/${id}/approve`, { method: "POST" }),
  rejectPipelineRun: (id: string) =>
    request<{ ok: boolean }>(`/pipeline/runs/${id}/reject`, { method: "POST" }),

  // Reviews queue — changes + deploys awaiting a human decision (repo-scoped)
  getReviews: () =>
    request<{
      changes: Array<{
        id: string; name: string; owner_email: string | null; repo_url: string | null;
        pr_number: number | null; pr_url: string | null; branch: string | null;
        recommendation: string | null; review: string | null; state: string; landing: boolean;
      }>;
      deploys: Array<{
        id: string; phase: string; repo_url: string | null; git_ref: string | null;
        owner_email: string | null; recommendation: string | null; review: string | null;
      }>;
    }>("/reviews"),

  // Admin — live test scenarios
  listScenarios: () =>
    request<Array<{ name: string; description: string; steerAfterMs: number | null }>>("/test/scenarios"),
  runScenario: (name: string) =>
    request<{ agentId: string; scenario: string }>(`/test/scenarios/${name}/run`, { method: "POST" }),
  scenarioReport: (name: string, agentId: string) =>
    request<{ state: string; verdict: "pass" | "fail" | "pending"; checks: Array<{ label: string; pass: boolean }> }>(
      `/test/scenarios/${name}/report/${agentId}`
    ),
  armLandConflict: () =>
    request<{ agentId: string; prNumber: number; prUrl: string; conflict: boolean }>(
      "/test/land-conflict",
      { method: "POST" }
    ),

  // Admin — supervisor credential
  getSupervisorCredential: () =>
    request<{ userId: string | null; email: string | null; hasCredential: boolean }>(
      "/admin/supervisor-credential"
    ),
  setSupervisorCredential: (userId?: string) =>
    request<{ ok: boolean; userId: string; email: string | null; hasCredential: boolean }>(
      "/admin/supervisor-credential",
      { method: "PUT", body: JSON.stringify(userId ? { userId } : {}) }
    ),
  clearSupervisorCredential: () =>
    request("/admin/supervisor-credential", { method: "DELETE" }),

  // Admin — users
  listUsers: () => request<UserSummary[]>("/admin/users"),
  offboardUser: (id: string) =>
    request<{ ok: boolean; agentsRemoved: number; branchesDeleted: number }>(
      `/admin/users/${id}/offboard`,
      { method: "POST" }
    ),
  setUserAccess: (id: string, approved: boolean) =>
    request<{ ok: boolean; id: string; access_approved: boolean }>(
      `/admin/users/${id}/access`,
      { method: "PUT", body: JSON.stringify({ approved }) }
    ),

  // Settings
  getSettings: () => request<ServerSettings>("/settings"),
  setDefaultRepo: (repo_url: string, repo_ref: string) =>
    request<{ ok: boolean; default_repo_url: string | null; default_repo_ref: string | null }>(
      "/admin/default-repo",
      { method: "PUT", body: JSON.stringify({ repo_url, repo_ref }) }
    ),

  // Audit log
  getAuditLog: (limit?: number, offset?: number) =>
    request<AuditResponse>(`/audit?limit=${limit || 50}&offset=${offset || 0}`),

  // Files
  viewFile: (path: string) =>
    request<{ path: string; name: string; size: number; ext: string; isJson: boolean; content: string }>(
      `/file/view?path=${encodeURIComponent(path)}`
    ),
  listFiles: (dir: string, pattern?: string) =>
    request<{ dir: string; files: Array<{ name: string; path: string; size: number; modified: string }> }>(
      `/file/list?dir=${encodeURIComponent(dir)}${pattern ? `&pattern=${encodeURIComponent(pattern)}` : ""}`
    ),
  downloadFileUrl: (path: string) =>
    `${BASE}/file/download?path=${encodeURIComponent(path)}`,

  // Processes & queue
  getProcesses: () =>
    request<Record<string, { pids: number[]; descendants: number[] }>>("/processes"),
  getQueue: () =>
    request<Record<string, number>>("/queue"),
  killAll: () =>
    request<{ ok: boolean; killed: number; orphans: number }>("/agents/kill-all", { method: "POST" }),

  // Subagents
  getSubagents: (agentId: string) =>
    request<SubagentInfo[]>(`/agents/${agentId}/subagents`),
  getSubagentTranscript: (transcriptPath: string) =>
    request<Array<{ role: string; content: string }>>(`/subagent-transcript?path=${encodeURIComponent(transcriptPath)}`),

  // Activity trace — every pipeline run + child agent associated with an agent.
  getAgentActivity: (agentId: string) =>
    request<AgentActivity>(`/agents/${agentId}/activity`),

};

export interface ActivityRun {
  id: string;
  phase: string;
  status: string;
  exit_code: number | null;
  land_on_pass: boolean | null;
  deploy_gate_run_id: string | null;
  recommendation: string | null;
  created_at: string;
  completed_at: string | null;
  has_log: boolean;
}
export interface BranchDeploy {
  id: string;
  status: string;
  exit_code: number | null;
  executor_agent_id: string | null;
  created_at: string;
  completed_at: string | null;
  has_log: boolean;
}
export interface AgentActivity {
  runs: ActivityRun[];
  reviews: Array<{ id: string; name: string; state: string; recommendation: string | null; created_at: string }>;
  deploy_agent: { id: string; name: string; state: string } | null;
  shipped: Array<{ id: string; pr_number: number | null; name: string }>;
  branch_deploys: BranchDeploy[];
}

// Types shared with UI
export interface AgentWithTokens {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  state: string;
  priority: string;
  permission_mode: string;
  sdk_session_id: string | null;
  model: string;
  max_turns: number | null;
  max_budget_usd: number | null;
  error_message: string | null;
  pr_url: string | null;
  pr_number: number | null;
  recommendation: string | null;
  // THE canonical status, computed on the server (see deriveStatus — it renders this
  // as-is). Present on both the list and detail payloads so views can't disagree.
  status?: { key: string; label: string; color: string; spin?: boolean } | null;
  testing?: boolean;
  landing?: boolean;
  deploy_status?: string | null;
  deploy_agent_state?: string | null;
  deployed_by_agent_id?: string | null;
  review_of_agent_id?: string | null;
  adopted_ref?: string | null;
  branch?: string | null;
  size?: string | null;
  is_deploy_agent?: boolean;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  tokens: {
    total_input_tokens: number;
    total_output_tokens: number;
    total_cost_usd: number;
  };
}

export interface AgentDetail extends AgentWithTokens {
  total_cost_usd: number;
}

export interface CreateAgentData {
  name: string;
  prompt: string;
  cwd?: string;
  priority?: string;
  model?: string;
  max_turns?: number;
  max_budget_usd?: number;
  repo_url?: string;
  repo_ref?: string;
  branch_type?: string;
  issue_id?: string;
  branch?: string; // full override — set when adopting an existing PR/branch
  adopted_ref?: string; // display marker (e.g. "PR #17") shown on the agent
  size?: string; // pod t-shirt size (s|m|l|xl); omit for supervisor auto-sizing
}

export interface SizePreset {
  requests: { cpu: string; memory: string; "ephemeral-storage": string };
  limits: { memory: string; "ephemeral-storage": string };
}

export interface ApiTokenSummary {
  id: string;
  name: string | null;
  scopes: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface ResolvedRef {
  kind: "pr" | "branch";
  branch: string;
  adoptedRef: string;
  prNumber?: number;
  prState?: string;
  prUrl?: string;
  prTitle?: string;
}

export interface AgentEvent {
  id: number;
  agent_id: string;
  type: string;
  data: string;
  created_at: string;
}

export interface PermissionReq {
  id: number;
  agent_id: string;
  tool_name: string;
  tool_input: string;
  tool_use_id: string;
  status: string;
  created_at: string;
}

export interface BudgetStatus {
  config: { daily_budget_usd: number; monthly_budget_usd: number };
  daily_spend_usd: number;
  monthly_spend_usd: number;
  daily_remaining_usd: number;
  monthly_remaining_usd: number;
  daily_percent: number;
  monthly_percent: number;
}

export interface DiscoveredProject {
  projectKey: string;
  realPath: string;
  sessionCount: number;
  latestModified: string;
}

export interface DiscoveredSession {
  sessionId: string;
  modified: string;
  sizeBytes: number;
  firstPrompt: string | null;
  messageCount: number;
  isLocked: boolean;
}

export interface SessionMessage {
  role: string;
  content: string;
  timestamp: string;
}

export interface ServerSettings {
  node_id: string;
  node_role: string;
  max_concurrent_agents: number;
  active_agents: number;
  total_agents: number;
  supervisor_interval_minutes: number;
  permission_timeout_minutes: number;
  stuck_threshold_minutes: number;
  ntfy_topic: string | null;
  fleet_nodes: number;
  uptime_seconds: number;
  default_repo_url: string | null;
  default_repo_ref: string | null;
}

export interface AuditEntry {
  id: number;
  user_ip: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: string | null;
  created_at: string;
}

export interface AuditResponse {
  entries: AuditEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface SubagentInfo {
  agentId: string;
  agentType: string;
  sessionId: string;
  transcriptPath: string;
  parentAgentId: string;
  startedAt: string;
  stoppedAt?: string;
}

export interface PipelineRunInfo {
  id: string;
  repo_url: string | null;
  git_ref: string | null;
  phase: string;
  status: string;
  exit_code: number | null;
  artifact: string | null;
  log: string | null;
  review: string | null;
  recommendation: string | null;
  created_at: string;
}

export interface UserSummary {
  id: string;
  email: string | null;
  display_name: string | null;
  role: string;
  access_approved: boolean;
  created_at: string;
  agent_count: number;
}

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  prompt: string;
  model: string;
  max_turns: number | null;
  permission_policy: "auto" | "ask" | "strict";
  supervisor_instructions: string;
  priority: "high" | "medium" | "low";
}
