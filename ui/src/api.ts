const BASE = "/api";

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

export const api = {
  // Auth
  login: (password: string) =>
    request("/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  logout: () => request("/auth/logout", { method: "POST" }),
  me: () => request<{ authenticated: boolean }>("/auth/me"),

  // Agents
  getAgents: () => request<AgentWithTokens[]>("/agents"),
  getAgent: (id: string) => request<AgentDetail>(`/agents/${id}`),
  createAgent: (data: CreateAgentData) =>
    request("/agents", { method: "POST", body: JSON.stringify(data) }),
  deleteAgent: (id: string) =>
    request(`/agents/${id}`, { method: "DELETE" }),
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
  getEvents: (id: string, limit?: number) =>
    request<AgentEvent[]>(`/agents/${id}/events?limit=${limit || 100}`),

  // Permissions
  getPendingPermissions: () =>
    request<PermissionReq[]>("/permissions/pending"),
  resolvePermission: (id: number, decision: "approved" | "denied") =>
    request(`/permissions/${id}/resolve`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    }),

  // Budget
  getBudget: () => request<BudgetStatus>("/budget"),
  updateBudget: (daily: number, monthly: number) =>
    request("/budget", {
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
};

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
  cwd: string;
  priority?: string;
  model?: string;
  max_turns?: number;
  max_budget_usd?: number;
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
