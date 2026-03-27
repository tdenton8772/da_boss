import { getDb } from "./index.js";
import type {
  AgentRecord,
  AgentState,
  PermissionRequest,
} from "../types/agent.js";
import type {
  BudgetConfig,
  TokenUsageRecord,
  AgentTokenSummary,
} from "../types/token.js";

// ── Agents ──────────────────────────────────────────────

export function insertAgent(agent: Omit<AgentRecord, "created_at" | "updated_at" | "started_at" | "completed_at">): AgentRecord {
  const db = getDb();
  db.prepare(`
    INSERT INTO agents (id, name, prompt, cwd, state, priority, permission_mode, sdk_session_id, model, max_turns, max_budget_usd, error_message)
    VALUES (@id, @name, @prompt, @cwd, @state, @priority, @permission_mode, @sdk_session_id, @model, @max_turns, @max_budget_usd, @error_message)
  `).run(agent);
  return getAgent(agent.id)!;
}

export function getAgent(id: string): AgentRecord | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as
    | AgentRecord
    | undefined;
}

export function getAllAgents(): AgentRecord[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM agents ORDER BY created_at DESC")
    .all() as AgentRecord[];
}

export function getAgentsByState(...states: AgentState[]): AgentRecord[] {
  const db = getDb();
  const placeholders = states.map(() => "?").join(",");
  return db
    .prepare(`SELECT * FROM agents WHERE state IN (${placeholders})`)
    .all(...states) as AgentRecord[];
}

export function updateAgentState(
  id: string,
  state: AgentState,
  extra?: Partial<Pick<AgentRecord, "sdk_session_id" | "error_message" | "started_at" | "completed_at">>
): void {
  const db = getDb();
  const sets = ["state = ?", "updated_at = datetime('now')"];
  const params: unknown[] = [state];

  if (extra?.sdk_session_id !== undefined) {
    sets.push("sdk_session_id = ?");
    params.push(extra.sdk_session_id);
  }
  if (extra?.error_message !== undefined) {
    sets.push("error_message = ?");
    params.push(extra.error_message);
  }
  if (extra?.started_at !== undefined) {
    sets.push("started_at = ?");
    params.push(extra.started_at);
  }
  if (extra?.completed_at !== undefined) {
    sets.push("completed_at = ?");
    params.push(extra.completed_at);
  }

  params.push(id);
  db.prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`).run(
    ...params
  );
}

// ── Agent Events ────────────────────────────────────────

export function insertAgentEvent(
  agentId: string,
  type: string,
  data: unknown
): number {
  const db = getDb();
  const result = db
    .prepare(
      "INSERT INTO agent_events (agent_id, type, data) VALUES (?, ?, ?)"
    )
    .run(agentId, type, JSON.stringify(data));
  return result.lastInsertRowid as number;
}

export function getAgentEvents(
  agentId: string,
  limit = 100,
  beforeId?: number
): Array<{ id: number; agent_id: string; type: string; data: string; created_at: string }> {
  const db = getDb();
  if (beforeId) {
    return db
      .prepare(
        "SELECT * FROM agent_events WHERE agent_id = ? AND id < ? ORDER BY id DESC LIMIT ?"
      )
      .all(agentId, beforeId, limit) as Array<{ id: number; agent_id: string; type: string; data: string; created_at: string }>;
  }
  return db
    .prepare(
      "SELECT * FROM agent_events WHERE agent_id = ? ORDER BY id DESC LIMIT ?"
    )
    .all(agentId, limit) as Array<{ id: number; agent_id: string; type: string; data: string; created_at: string }>;
}

export function getLatestEventTime(agentId: string): string | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT created_at FROM agent_events WHERE agent_id = ? ORDER BY id DESC LIMIT 1"
    )
    .get(agentId) as { created_at: string } | undefined;
  return row?.created_at ?? null;
}

// ── Token Usage ─────────────────────────────────────────

export function insertTokenUsage(
  agentId: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadInputTokens: number,
  cacheCreationInputTokens: number,
  costUsd: number
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO token_usage (agent_id, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, cost_usd)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    agentId,
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    costUsd
  );
}

export function getDailySpend(): number {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) as total FROM token_usage WHERE recorded_at >= date('now')"
    )
    .get() as { total: number };
  return row.total;
}

export function getMonthlySpend(): number {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) as total FROM token_usage WHERE recorded_at >= date('now', 'start of month')"
    )
    .get() as { total: number };
  return row.total;
}

export function getAgentTotalCost(agentId: string): number {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) as total FROM token_usage WHERE agent_id = ?"
    )
    .get(agentId) as { total: number };
  return row.total;
}

export function getAgentTokenSummaries(): AgentTokenSummary[] {
  const db = getDb();
  return db
    .prepare(`
      SELECT agent_id,
             COALESCE(SUM(input_tokens), 0) as total_input_tokens,
             COALESCE(SUM(output_tokens), 0) as total_output_tokens,
             COALESCE(SUM(cost_usd), 0) as total_cost_usd
      FROM token_usage
      GROUP BY agent_id
    `)
    .all() as AgentTokenSummary[];
}

// ── Permissions ─────────────────────────────────────────

export function insertPermissionRequest(
  agentId: string,
  toolName: string,
  toolInput: unknown,
  toolUseId: string
): PermissionRequest {
  const db = getDb();
  const result = db
    .prepare(`
      INSERT INTO permission_requests (agent_id, tool_name, tool_input, tool_use_id)
      VALUES (?, ?, ?, ?)
    `)
    .run(agentId, toolName, JSON.stringify(toolInput), toolUseId);
  return db
    .prepare("SELECT * FROM permission_requests WHERE id = ?")
    .get(result.lastInsertRowid) as PermissionRequest;
}

export function resolvePermission(
  id: number,
  decision: "approved" | "denied"
): void {
  const db = getDb();
  db.prepare(`
    UPDATE permission_requests SET status = ?, resolved_at = datetime('now') WHERE id = ?
  `).run(decision, id);
}

export function getPendingPermissions(): PermissionRequest[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM permission_requests WHERE status = 'pending' ORDER BY created_at ASC"
    )
    .all() as PermissionRequest[];
}

export function getPermission(id: number): PermissionRequest | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM permission_requests WHERE id = ?")
    .get(id) as PermissionRequest | undefined;
}

// ── Budget Config ───────────────────────────────────────

export function getBudgetConfig(): BudgetConfig {
  const db = getDb();
  return db
    .prepare("SELECT daily_budget_usd, monthly_budget_usd, updated_at FROM budget_config WHERE id = 1")
    .get() as BudgetConfig;
}

export function updateBudgetConfig(
  dailyBudgetUsd: number,
  monthlyBudgetUsd: number
): void {
  const db = getDb();
  db.prepare(`
    UPDATE budget_config SET daily_budget_usd = ?, monthly_budget_usd = ?, updated_at = datetime('now') WHERE id = 1
  `).run(dailyBudgetUsd, monthlyBudgetUsd);
}

// ── Supervisor ──────────────────────────────────────────

export function insertSupervisorRun(): number {
  const db = getDb();
  const result = db
    .prepare("INSERT INTO supervisor_runs DEFAULT VALUES")
    .run();
  return result.lastInsertRowid as number;
}

export function completeSupervisorRun(
  id: number,
  findings: unknown,
  actions: unknown
): void {
  const db = getDb();
  db.prepare(`
    UPDATE supervisor_runs SET completed_at = datetime('now'), findings = ?, actions = ? WHERE id = ?
  `).run(JSON.stringify(findings), JSON.stringify(actions), id);
}
