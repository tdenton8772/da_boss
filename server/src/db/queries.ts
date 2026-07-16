import { nanoid } from "nanoid";
import { getPool, withTx } from "./index.js";
import type {
  AgentRecord,
  AgentState,
  PermissionRequest,
  Review,
} from "../types/agent.js";
import type {
  BudgetConfig,
  TokenUsageRecord,
  AgentTokenSummary,
} from "../types/token.js";

// UTC start-of-day / start-of-month, as ISO strings. Computed in JS so the
// date-range filters stay portable (and avoid pg-mem's interval-math gaps).
function startOfDayUtc(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}
function startOfMonthUtc(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

// ── Agents ──────────────────────────────────────────────

export async function insertAgent(
  agent: Omit<
    AgentRecord,
    "created_at" | "updated_at" | "started_at" | "completed_at" | "pr_url" | "pr_number" | "advisory_strikes" | "review" | "recommendation" | "pipeline_run_id" | "review_of_agent_id" | "deployed_by_agent_id"
  >
): Promise<AgentRecord> {
  await getPool().query(
    `INSERT INTO agents (id, name, prompt, cwd, state, priority, permission_mode, sdk_session_id, model, max_turns, max_budget_usd, error_message, supervisor_instructions, permission_policy, created_by_user_id, repo_url, repo_ref, branch, service_account, worker_image, adopted_ref, size)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
    [
      agent.id,
      agent.name,
      agent.prompt,
      agent.cwd,
      agent.state,
      agent.priority,
      agent.permission_mode,
      agent.sdk_session_id,
      agent.model,
      agent.max_turns,
      agent.max_budget_usd,
      agent.error_message,
      agent.supervisor_instructions,
      agent.permission_policy,
      agent.created_by_user_id,
      agent.repo_url,
      agent.repo_ref,
      agent.branch,
      agent.service_account,
      agent.worker_image,
      agent.adopted_ref,
      agent.size,
    ]
  );
  return (await getAgent(agent.id))!;
}

export async function getAgent(id: string): Promise<AgentRecord | undefined> {
  const res = await getPool().query<AgentRecord>("SELECT * FROM agents WHERE id = $1", [id]);
  return res.rows[0];
}

export async function getAllAgents(): Promise<AgentRecord[]> {
  const res = await getPool().query<AgentRecord>("SELECT * FROM agents ORDER BY created_at DESC");
  return res.rows;
}

/** Changes awaiting a human decision: completed agents with an open PR that have
 *  been reviewed (recommendation set) but not yet merged (verified). Across ALL
 *  users — the review surface is repo-scoped, not owner-scoped. Owner email joined
 *  in so a reviewer knows whose change it is. Hides the hidden test-harness user. */
export async function getReviewQueueChanges(): Promise<Array<AgentRecord & { owner_email: string | null; landing: boolean }>> {
  const res = await getPool().query<AgentRecord & { owner_email: string | null }>(
    `SELECT a.*, u.email AS owner_email
       FROM agents a LEFT JOIN users u ON u.id = a.created_by_user_id
      WHERE a.state = 'completed'
        AND a.pr_number IS NOT NULL
        AND a.recommendation IS NOT NULL AND a.recommendation <> ''
        AND (a.created_by_user_id IS NULL OR a.created_by_user_id <> 'usr_test_harness')
      ORDER BY a.updated_at DESC`
  );
  if (res.rows.length === 0) return [];
  // Flag which of these have a land in flight (Merge already clicked → disable the
  // button). One flat query keyed by id — correlated subqueries don't run on pg-mem.
  const landing = await getPool().query<{ agent_id: string }>(
    `SELECT DISTINCT agent_id FROM pipeline_runs
      WHERE agent_id = ANY($1) AND land_on_pass = true
        AND status IN ('pending','pending_review','pending_approval','running')`,
    [res.rows.map((r) => r.id)]
  );
  const landingSet = new Set(landing.rows.map((r) => r.agent_id));
  return res.rows.map((r) => ({ ...r, landing: landingSet.has(r.id) }));
}

/** Gated pipeline runs awaiting approval (e.g. a deploy phase, pre-audited by the
 *  reviewer → pending_approval). Same review surface as changes. */
export async function getReviewQueueDeploys(): Promise<Array<PipelineRun & { owner_email: string | null }>> {
  const res = await getPool().query<PipelineRun & { owner_email: string | null }>(
    `SELECT r.*, u.email AS owner_email
       FROM pipeline_runs r LEFT JOIN users u ON u.id = r.created_by_user_id
      WHERE r.status = 'pending_approval'
      ORDER BY r.created_at DESC`
  );
  return res.rows;
}

export async function getAgentsByState(...states: AgentState[]): Promise<AgentRecord[]> {
  if (states.length === 0) return [];
  const placeholders = states.map((_, i) => `$${i + 1}`).join(",");
  const res = await getPool().query<AgentRecord>(
    `SELECT * FROM agents WHERE state IN (${placeholders})`,
    states
  );
  return res.rows;
}

export async function updateAgentState(
  id: string,
  state: AgentState,
  extra?: Partial<Pick<AgentRecord, "sdk_session_id" | "error_message" | "started_at" | "completed_at">>
): Promise<void> {
  const sets = ["state = $1", "updated_at = now()"];
  const params: unknown[] = [state];
  let n = 2;

  if (extra?.sdk_session_id !== undefined) {
    sets.push(`sdk_session_id = $${n++}`);
    params.push(extra.sdk_session_id);
  }
  if (extra?.error_message !== undefined) {
    sets.push(`error_message = $${n++}`);
    params.push(extra.error_message);
  }
  if (extra?.started_at !== undefined) {
    sets.push(`started_at = $${n++}`);
    params.push(extra.started_at);
  }
  if (extra?.completed_at !== undefined) {
    sets.push(`completed_at = $${n++}`);
    params.push(extra.completed_at);
  }

  params.push(id);
  await getPool().query(`UPDATE agents SET ${sets.join(", ")} WHERE id = $${n}`, params);
}

export async function deleteAgent(id: string): Promise<void> {
  await withTx(async (client) => {
    await client.query("DELETE FROM token_usage WHERE agent_id = $1", [id]);
    await client.query("DELETE FROM permission_requests WHERE agent_id = $1", [id]);
    await client.query("DELETE FROM agent_events WHERE agent_id = $1", [id]);
    await client.query("DELETE FROM agent_commands WHERE agent_id = $1", [id]);
    await client.query("DELETE FROM leases WHERE holder_agent_id = $1", [id]);
    await client.query("DELETE FROM intents WHERE agent_id = $1", [id]);
    // A reviewed agent (or a review agent) has reviews rows FK'd to it — these blocked
    // deleting completed agents (they'd been through review). Clear both linkages.
    await client.query("DELETE FROM reviews WHERE reviewed_agent_id = $1 OR review_agent_id = $1", [id]);
    await client.query("DELETE FROM agents WHERE id = $1", [id]);
  });
}

/** Increment an agent's advisory-strike count (ignored a freeze-lease advisory)
 *  and return the new total. */
export async function bumpAdvisoryStrikes(agentId: string): Promise<number> {
  const res = await getPool().query<{ advisory_strikes: number }>(
    "UPDATE agents SET advisory_strikes = advisory_strikes + 1, updated_at = now() WHERE id = $1 RETURNING advisory_strikes",
    [agentId]
  );
  return res.rows[0]?.advisory_strikes ?? 0;
}

/** Running agents that have crossed the advisory-strike block threshold. */
export async function getAgentsOverStrikeThreshold(threshold: number): Promise<AgentRecord[]> {
  const res = await getPool().query<AgentRecord>(
    "SELECT * FROM agents WHERE state = 'running' AND advisory_strikes >= $1",
    [threshold]
  );
  return res.rows;
}

/** Store the reviewing agent's verdict for this agent's change (report-back). */
export async function setAgentReview(agentId: string, review: string, recommendation: string): Promise<void> {
  await getPool().query(
    "UPDATE agents SET review = $2, recommendation = $3, updated_at = now() WHERE id = $1",
    [agentId, review, recommendation]
  );
}

/** Record the pull request an agent opened (for the UI + idempotency). */
export async function setAgentPullRequest(agentId: string, url: string, number: number): Promise<void> {
  await getPool().query(
    "UPDATE agents SET pr_url = $1, pr_number = $2, updated_at = now() WHERE id = $3",
    [url, number, agentId]
  );
}

/** All agents dispatched by a user — used to tear them down on offboarding. */
export async function getAgentsByUser(userId: string): Promise<AgentRecord[]> {
  const res = await getPool().query<AgentRecord>(
    "SELECT * FROM agents WHERE created_by_user_id = $1",
    [userId]
  );
  return res.rows;
}

/** Session ids still referenced by a user's agents. Anything on that user's
 *  shard NOT in this set is an orphaned transcript (its agent was deleted) and
 *  can be garbage-collected. */
export async function getSessionIdsForUser(userId: string): Promise<string[]> {
  const res = await getPool().query<{ sdk_session_id: string }>(
    "SELECT sdk_session_id FROM agents WHERE created_by_user_id = $1 AND sdk_session_id IS NOT NULL",
    [userId]
  );
  return res.rows.map((r) => r.sdk_session_id);
}

/** How many OTHER agent records still target this exact repo+branch. Used before
 *  deleting a remote branch on agent-delete: the per-work branch can be shared
 *  across runs, so we must not yank it out from under a sibling. */
export async function countOtherAgentsOnBranch(
  repoUrl: string,
  branch: string,
  excludeId: string
): Promise<number> {
  const res = await getPool().query<{ n: string }>(
    "SELECT COUNT(*)::int AS n FROM agents WHERE repo_url = $1 AND branch = $2 AND id <> $3",
    [repoUrl, branch, excludeId]
  );
  return Number(res.rows[0]?.n ?? 0);
}

export async function updateAgentSupervisorInstructions(
  id: string,
  supervisorInstructions: string
): Promise<void> {
  await getPool().query(
    "UPDATE agents SET supervisor_instructions = $1, updated_at = now() WHERE id = $2",
    [supervisorInstructions, id]
  );
}

// ── Agent Events ────────────────────────────────────────

export async function insertAgentEvent(
  agentId: string,
  type: string,
  data: unknown
): Promise<number> {
  const res = await getPool().query<{ id: number }>(
    "INSERT INTO agent_events (agent_id, type, data) VALUES ($1, $2, $3) RETURNING id",
    [agentId, type, JSON.stringify(data)]
  );
  const id = res.rows[0].id;
  // Live relay: notify the boss so it can rebroadcast to the UI over WebSocket.
  // Works cross-process (worker pods → boss). Tolerant of pg-mem in tests.
  try {
    await getPool().query("SELECT pg_notify('daboss_agent_event', $1)", [String(id)]);
  } catch { /* pg-mem / no listener — fine */ }
  return id;
}

export async function getAgentEventById(id: number): Promise<AgentEventRow | undefined> {
  const res = await getPool().query<AgentEventRow>("SELECT * FROM agent_events WHERE id = $1", [id]);
  return res.rows[0];
}

interface AgentEventRow {
  id: number;
  agent_id: string;
  type: string;
  data: string;
  created_at: string;
}

export async function getAgentEvents(
  agentId: string,
  limit = 100,
  beforeId?: number
): Promise<AgentEventRow[]> {
  if (beforeId) {
    const res = await getPool().query<AgentEventRow>(
      "SELECT * FROM agent_events WHERE agent_id = $1 AND id < $2 ORDER BY id DESC LIMIT $3",
      [agentId, beforeId, limit]
    );
    return res.rows;
  }
  const res = await getPool().query<AgentEventRow>(
    "SELECT * FROM agent_events WHERE agent_id = $1 ORDER BY id DESC LIMIT $2",
    [agentId, limit]
  );
  return res.rows;
}

export async function getLatestEventTime(agentId: string): Promise<string | null> {
  const res = await getPool().query<{ created_at: string }>(
    "SELECT created_at FROM agent_events WHERE agent_id = $1 ORDER BY id DESC LIMIT 1",
    [agentId]
  );
  return res.rows[0]?.created_at ?? null;
}

// ── Token Usage ─────────────────────────────────────────

export async function insertTokenUsage(
  agentId: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadInputTokens: number,
  cacheCreationInputTokens: number,
  costUsd: number
): Promise<void> {
  await getPool().query(
    `INSERT INTO token_usage (agent_id, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, cost_usd)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [agentId, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUsd]
  );
}

export async function getDailySpend(): Promise<number> {
  const res = await getPool().query<{ total: number }>(
    "SELECT COALESCE(SUM(cost_usd), 0)::double precision as total FROM token_usage WHERE recorded_at >= $1",
    [startOfDayUtc()]
  );
  return res.rows[0].total;
}

export async function getMonthlySpend(): Promise<number> {
  const res = await getPool().query<{ total: number }>(
    "SELECT COALESCE(SUM(cost_usd), 0)::double precision as total FROM token_usage WHERE recorded_at >= $1",
    [startOfMonthUtc()]
  );
  return res.rows[0].total;
}

export async function getAgentTotalCost(agentId: string): Promise<number> {
  const res = await getPool().query<{ total: number }>(
    "SELECT COALESCE(SUM(cost_usd), 0)::double precision as total FROM token_usage WHERE agent_id = $1",
    [agentId]
  );
  return res.rows[0].total;
}

export async function getAgentTokenSummaries(): Promise<AgentTokenSummary[]> {
  const res = await getPool().query<AgentTokenSummary>(`
    SELECT agent_id,
           COALESCE(SUM(input_tokens), 0)::double precision as total_input_tokens,
           COALESCE(SUM(output_tokens), 0)::double precision as total_output_tokens,
           COALESCE(SUM(cost_usd), 0)::double precision as total_cost_usd
    FROM token_usage
    GROUP BY agent_id
  `);
  return res.rows;
}

// ── Permissions ─────────────────────────────────────────

export async function insertPermissionRequest(
  agentId: string,
  toolName: string,
  toolInput: unknown,
  toolUseId: string
): Promise<PermissionRequest> {
  const res = await getPool().query<PermissionRequest>(
    `INSERT INTO permission_requests (agent_id, tool_name, tool_input, tool_use_id)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [agentId, toolName, JSON.stringify(toolInput), toolUseId]
  );
  const request = res.rows[0];
  // Notify the boss so it surfaces the dialog live (cross-process: worker pod →
  // boss → WebSocket → browser). Tolerant of pg-mem in tests.
  try {
    await getPool().query("SELECT pg_notify('daboss_permission', $1)", [String(request.id)]);
  } catch { /* pg-mem / no listener — fine */ }
  return request;
}

export async function resolvePermission(
  id: number,
  decision: "approved" | "denied",
  answer?: string | null
): Promise<void> {
  // Store the human's answer so a WORKER in a different pod can read the outcome
  // (the in-process handler resolves via an in-memory promise; the pod worker polls
  // this row). resolved_at flips the row out of 'pending' — the poll's exit signal.
  await getPool().query(
    "UPDATE permission_requests SET status = $1, resolution_answer = $2, resolved_at = now() WHERE id = $3",
    [decision, answer ?? null, id]
  );
}

export async function getPendingPermissions(): Promise<PermissionRequest[]> {
  const res = await getPool().query<PermissionRequest>(
    "SELECT * FROM permission_requests WHERE status = 'pending' ORDER BY created_at ASC"
  );
  return res.rows;
}

export async function getPermission(id: number): Promise<PermissionRequest | undefined> {
  const res = await getPool().query<PermissionRequest>(
    "SELECT * FROM permission_requests WHERE id = $1",
    [id]
  );
  return res.rows[0];
}

// ── Budget Config ───────────────────────────────────────

export async function getBudgetConfig(): Promise<BudgetConfig> {
  const res = await getPool().query<BudgetConfig>(
    "SELECT daily_budget_usd, monthly_budget_usd, updated_at FROM budget_config WHERE id = 1"
  );
  return res.rows[0];
}

export async function updateBudgetConfig(
  dailyBudgetUsd: number,
  monthlyBudgetUsd: number
): Promise<void> {
  await getPool().query(
    "UPDATE budget_config SET daily_budget_usd = $1, monthly_budget_usd = $2, updated_at = now() WHERE id = 1",
    [dailyBudgetUsd, monthlyBudgetUsd]
  );
}

// ── Supervisor ──────────────────────────────────────────

export async function insertSupervisorRun(): Promise<number> {
  // pg-mem doesn't parse INSERT ... DEFAULT VALUES, so set started_at explicitly.
  const res = await getPool().query<{ id: number }>(
    "INSERT INTO supervisor_runs (started_at) VALUES (now()) RETURNING id"
  );
  return res.rows[0].id;
}

export async function completeSupervisorRun(
  id: number,
  findings: unknown,
  actions: unknown
): Promise<void> {
  await getPool().query(
    "UPDATE supervisor_runs SET completed_at = now(), findings = $1, actions = $2 WHERE id = $3",
    [JSON.stringify(findings), JSON.stringify(actions), id]
  );
}

// ── Audit Log ──────────────────────────────────────────────

export interface AuditEntry {
  id: number;
  user_ip: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: string | null;
  created_at: string;
}

export async function insertAuditLog(
  userIp: string | null,
  action: string,
  targetType?: string,
  targetId?: string,
  details?: string,
  userId?: string | null
): Promise<void> {
  await getPool().query(
    `INSERT INTO audit_log (user_ip, action, target_type, target_id, details, user_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [userIp, action, targetType || null, targetId || null, details || null, userId || null]
  );
}

export async function getAuditLog(limit = 50, offset = 0): Promise<AuditEntry[]> {
  const res = await getPool().query<AuditEntry>(
    "SELECT * FROM audit_log ORDER BY id DESC LIMIT $1 OFFSET $2",
    [limit, offset]
  );
  return res.rows;
}

export async function getAuditLogCount(): Promise<number> {
  const res = await getPool().query<{ count: number }>(
    "SELECT COUNT(*)::integer as count FROM audit_log"
  );
  return res.rows[0].count;
}

// ── Fleet Nodes ────────────────────────────────────────────

export interface FleetNode {
  id: string;
  hostname: string;
  url: string;
  role: string;
  status: string;
  last_heartbeat: string | null;
  agent_capacity: number;
  agent_count: number;
  created_at: string;
  updated_at: string;
}

export async function getAllFleetNodes(): Promise<FleetNode[]> {
  const res = await getPool().query<FleetNode>("SELECT * FROM fleet_nodes ORDER BY created_at ASC");
  return res.rows;
}

export async function getFleetNode(id: string): Promise<FleetNode | undefined> {
  const res = await getPool().query<FleetNode>("SELECT * FROM fleet_nodes WHERE id = $1", [id]);
  return res.rows[0];
}

export async function upsertFleetNode(node: {
  id: string;
  hostname: string;
  url: string;
  role?: string;
  agent_capacity?: number;
}): Promise<FleetNode> {
  await getPool().query(
    `INSERT INTO fleet_nodes (id, hostname, url, role, agent_capacity, status, last_heartbeat)
     VALUES ($1,$2,$3,$4,$5,'online',now())
     ON CONFLICT (id) DO UPDATE SET
       hostname = EXCLUDED.hostname,
       url = EXCLUDED.url,
       role = COALESCE(EXCLUDED.role, fleet_nodes.role),
       agent_capacity = COALESCE(EXCLUDED.agent_capacity, fleet_nodes.agent_capacity),
       status = 'online',
       last_heartbeat = now(),
       updated_at = now()`,
    [node.id, node.hostname, node.url, node.role || "worker", node.agent_capacity || 3]
  );
  return (await getFleetNode(node.id))!;
}

export async function updateFleetNodeHeartbeat(id: string, agentCount: number): Promise<void> {
  await getPool().query(
    "UPDATE fleet_nodes SET last_heartbeat = now(), agent_count = $1, status = 'online', updated_at = now() WHERE id = $2",
    [agentCount, id]
  );
}

export async function markStaleNodes(thresholdMinutes: number): Promise<void> {
  const boundary = new Date(Date.now() - thresholdMinutes * 60_000).toISOString();
  await getPool().query(
    "UPDATE fleet_nodes SET status = 'offline', updated_at = now() WHERE status = 'online' AND last_heartbeat < $1",
    [boundary]
  );
}

// ── Users (identity) ────────────────────────────────────────

export interface User {
  id: string;
  external_id: string | null;
  email: string | null;
  display_name: string | null;
  role: string;
  password_hash: string | null;
  access_approved: boolean;
  created_at: string;
}

export async function createUser(u: {
  id: string;
  email: string;
  display_name?: string | null;
  role?: string;
  password_hash?: string | null;
  external_id?: string | null;
}): Promise<User> {
  await getPool().query(
    `INSERT INTO users (id, email, display_name, role, password_hash, external_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [u.id, u.email, u.display_name ?? null, u.role ?? "developer", u.password_hash ?? null, u.external_id ?? null]
  );
  return (await getUserById(u.id))!;
}

export async function getUserById(id: string): Promise<User | undefined> {
  const res = await getPool().query<User>("SELECT * FROM users WHERE id = $1", [id]);
  return res.rows[0];
}

export async function getUserByEmail(email: string): Promise<User | undefined> {
  const res = await getPool().query<User>("SELECT * FROM users WHERE lower(email) = lower($1)", [email]);
  return res.rows[0];
}

export async function getUserByExternalId(externalId: string): Promise<User | undefined> {
  const res = await getPool().query<User>("SELECT * FROM users WHERE external_id = $1", [externalId]);
  return res.rows[0];
}

export async function countUsers(): Promise<number> {
  const res = await getPool().query<{ count: number }>("SELECT COUNT(*)::integer AS count FROM users");
  return res.rows[0].count;
}

// ── Leases (semantic freeze on symbols) ────────────────────
// resource_ref = `${repoKey}#${symbol}`; predicate_kind = 'symbol'. Held by the
// editing agent, kept alive by the sidecar heartbeat, reclaimed when stale.

export interface LeaseRow {
  resource_ref: string;
  holder_agent_id: string;
}

/** Acquire exclusive leases on symbols not already held-active by this agent. */
export async function acquireLeases(agentId: string, repoKey: string, symbols: string[]): Promise<void> {
  for (const s of symbols) {
    const ref = `${repoKey}#${s}`;
    await getPool().query(
      `INSERT INTO leases (id, holder_agent_id, resource_ref, predicate_kind, exclusive, state, heartbeat_at)
       SELECT $1, $2, $3, 'symbol', true, 'active', now()
       WHERE NOT EXISTS (
         SELECT 1 FROM leases WHERE holder_agent_id = $2 AND resource_ref = $3 AND state = 'active'
       )`,
      [`lease_${nanoid(12)}`, agentId, ref]
    );
  }
}

/** Active leases on any of these symbols held by a DIFFERENT agent = conflicts. */
export async function getLeaseConflicts(
  repoKey: string,
  symbols: string[],
  excludeAgentId: string
): Promise<LeaseRow[]> {
  if (!symbols.length) return [];
  const refs = symbols.map((s) => `${repoKey}#${s}`);
  const res = await getPool().query<LeaseRow>(
    `SELECT resource_ref, holder_agent_id FROM leases
     WHERE state = 'active' AND holder_agent_id <> $1 AND resource_ref = ANY($2)`,
    [excludeAgentId, refs]
  );
  return res.rows;
}

export async function heartbeatLeases(agentId: string): Promise<void> {
  await getPool().query(
    "UPDATE leases SET heartbeat_at = now() WHERE holder_agent_id = $1 AND state = 'active'",
    [agentId]
  );
}

export async function releaseLeases(agentId: string): Promise<void> {
  await getPool().query(
    "UPDATE leases SET state = 'released', released_at = now() WHERE holder_agent_id = $1 AND state = 'active'",
    [agentId]
  );
}

/** Reclaim leases whose holder's sidecar heartbeat has gone stale (dead pod). */
export async function reclaimStaleLeases(cutoffIso: string): Promise<LeaseRow[]> {
  const res = await getPool().query<LeaseRow>(
    `UPDATE leases SET state = 'reclaimed', released_at = now()
     WHERE state = 'active' AND heartbeat_at IS NOT NULL AND heartbeat_at < $1
     RETURNING resource_ref, holder_agent_id`,
    [cutoffIso]
  );
  return res.rows;
}

/** All active leases (holder + symbol) — the supervisor computes overlap from this. */
export async function getActiveLeases(): Promise<LeaseRow[]> {
  const res = await getPool().query<LeaseRow>(
    "SELECT resource_ref, holder_agent_id FROM leases WHERE state = 'active'"
  );
  return res.rows;
}

export async function getActiveLeasesForAgent(agentId: string): Promise<string[]> {
  const res = await getPool().query<{ resource_ref: string }>(
    "SELECT resource_ref FROM leases WHERE holder_agent_id = $1 AND state = 'active' ORDER BY resource_ref",
    [agentId]
  );
  return res.rows.map((r) => r.resource_ref);
}

// ── Sidecar: heartbeat + command channel ───────────────────

export async function updateAgentHeartbeat(agentId: string): Promise<void> {
  await getPool().query("UPDATE agents SET last_heartbeat_at = now() WHERE id = $1", [agentId]);
}

/** Running agents whose sidecar heartbeat has gone stale (hung/dead pod). Only
 *  considers agents that beat at least once, so non-sidecar agents aren't flagged. */
export async function getStaleHeartbeatAgents(cutoffIso: string): Promise<AgentRecord[]> {
  const res = await getPool().query<AgentRecord>(
    "SELECT * FROM agents WHERE state = 'running' AND last_heartbeat_at IS NOT NULL AND last_heartbeat_at < $1",
    [cutoffIso]
  );
  return res.rows;
}

export interface AgentCommand {
  id: number;
  agent_id: string;
  command: string;
  args: Record<string, unknown>;
  status: string;
  created_at: string;
  handled_at: string | null;
}

/** Issue a command to an agent's sidecar: durable row (history) + live NOTIFY. */
export async function insertAgentCommand(
  agentId: string,
  command: string,
  args: Record<string, unknown> = {}
): Promise<AgentCommand> {
  const res = await getPool().query<AgentCommand>(
    `INSERT INTO agent_commands (agent_id, command, args) VALUES ($1, $2, $3) RETURNING *`,
    [agentId, command, JSON.stringify(args)]
  );
  try {
    // Payload = agent id; each sidecar filters to its own agent, then drains rows.
    await getPool().query("SELECT pg_notify('daboss_agent_cmd', $1)", [agentId]);
  } catch { /* pg-mem / no listener — the catch-up read still delivers it */ }
  return res.rows[0];
}

export async function getPendingCommands(agentId: string): Promise<AgentCommand[]> {
  const res = await getPool().query<AgentCommand>(
    "SELECT * FROM agent_commands WHERE agent_id = $1 AND status = 'pending' ORDER BY id ASC",
    [agentId]
  );
  return res.rows;
}

export async function completeCommand(id: number, status: "done" | "failed"): Promise<void> {
  await getPool().query(
    "UPDATE agent_commands SET status = $1, handled_at = now() WHERE id = $2",
    [status, id]
  );
}

// ── App settings (generic singleton key/value) ─────────────

export async function getAppSetting(key: string): Promise<string | null> {
  const res = await getPool().query<{ value: string | null }>(
    "SELECT value FROM app_settings WHERE key = $1",
    [key]
  );
  return res.rows[0]?.value ?? null;
}

export async function setAppSetting(key: string, value: string): Promise<void> {
  await getPool().query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value]
  );
}

export async function deleteAppSetting(key: string): Promise<void> {
  await getPool().query("DELETE FROM app_settings WHERE key = $1", [key]);
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

/** Users + how many agents each still has — for the admin roster. */
export async function listUsersWithAgentCounts(): Promise<UserSummary[]> {
  const res = await getPool().query<UserSummary>(`
    SELECT u.id, u.email, u.display_name, u.role, u.access_approved, u.created_at,
           COUNT(a.id)::integer AS agent_count
    FROM users u
    LEFT JOIN agents a ON a.created_by_user_id = u.id
    WHERE u.role <> 'test'
    GROUP BY u.id, u.email, u.display_name, u.role, u.access_approved, u.created_at
    ORDER BY u.created_at ASC
  `);
  return res.rows;
}

/** Update a user's role. Used by the OIDC provider to keep admin-ness in sync
 *  with the IdP group/role claim on every login (the IdP is authoritative). */
export async function updateUserRole(userId: string, role: string): Promise<void> {
  await getPool().query("UPDATE users SET role = $1 WHERE id = $2", [role, userId]);
}

/** Adopt an existing (e.g. local) account under an IdP subject — the migration
 *  path from password accounts to SSO: the same person keeps their id + creds. */
export async function setUserExternalId(userId: string, externalId: string): Promise<void> {
  await getPool().query("UPDATE users SET external_id = $1 WHERE id = $2", [externalId, userId]);
}

/** Grant or revoke da_boss access for a user — the flag the access gate checks. */
export async function setUserAccessApproved(userId: string, approved: boolean): Promise<void> {
  await getPool().query("UPDATE users SET access_approved = $1 WHERE id = $2", [approved, userId]);
}

/** All users, newest first — for the admin access-management view. */
export async function listUsers(): Promise<User[]> {
  const res = await getPool().query<User>("SELECT * FROM users ORDER BY created_at DESC");
  return res.rows;
}

/** Record that an identity was offboarded, so neither auth provider re-admits it
 *  (OIDC re-provisioning / local re-registration) until an admin clears it. */
export async function recordOffboardedIdentity(rec: {
  externalId?: string | null;
  email?: string | null;
  offboardedBy?: string | null;
}): Promise<void> {
  if (!rec.externalId && !rec.email) return;
  await getPool().query(
    "INSERT INTO offboarded_identities (external_id, email, offboarded_by) VALUES ($1,$2,$3)",
    [rec.externalId ?? null, rec.email ?? null, rec.offboardedBy ?? null]
  );
}

/** Has this identity been offboarded? Matches on IdP subject OR email. */
export async function isIdentityOffboarded(id: {
  externalId?: string | null;
  email?: string | null;
}): Promise<boolean> {
  const res = await getPool().query<{ n: number }>(
    `SELECT COUNT(*)::integer AS n FROM offboarded_identities
     WHERE ($1::text IS NOT NULL AND external_id = $1)
        OR ($2::text IS NOT NULL AND lower(email) = lower($2))`,
    [id.externalId ?? null, id.email ?? null]
  );
  return (res.rows[0]?.n ?? 0) > 0;
}

/** Lift an offboard tombstone (re-admit). */
export async function clearOffboardedIdentity(id: {
  externalId?: string | null;
  email?: string | null;
}): Promise<void> {
  await getPool().query(
    `DELETE FROM offboarded_identities
     WHERE ($1::text IS NOT NULL AND external_id = $1)
        OR ($2::text IS NOT NULL AND lower(email) = lower($2))`,
    [id.externalId ?? null, id.email ?? null]
  );
}

/** Remove a user + their credential vault. Agents must already be torn down
 *  (FK agents.created_by_user_id → users). Audit rows are KEPT — we just null the
 *  linkage so the history survives the person leaving. */
export async function deleteUser(userId: string): Promise<void> {
  await withTx(async (client) => {
    await client.query("UPDATE audit_log SET user_id = NULL WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM user_credentials WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM user_git_credentials WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM users WHERE id = $1", [userId]);
  });
}

// ── Per-user credential vault ───────────────────────────────

export interface StoredCredential {
  kind: string;
  ciphertext: string;
  nonce: string;
  key_ref: string;
  updated_at: string;
}

export async function upsertUserCredential(
  userId: string,
  kind: string,
  blob: { ciphertext: string; nonce: string; keyRef: string }
): Promise<void> {
  await getPool().query(
    `INSERT INTO user_credentials (id, user_id, kind, ciphertext, nonce, key_ref)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id) DO UPDATE SET
       kind = EXCLUDED.kind,
       ciphertext = EXCLUDED.ciphertext,
       nonce = EXCLUDED.nonce,
       key_ref = EXCLUDED.key_ref,
       updated_at = now()`,
    [`uc_${nanoid(10)}`, userId, kind, blob.ciphertext, blob.nonce, blob.keyRef]
  );
}

/** Returns the encrypted blob (never the plaintext) or undefined. */
export async function getUserCredential(userId: string): Promise<StoredCredential | undefined> {
  const res = await getPool().query<StoredCredential>(
    "SELECT kind, ciphertext, nonce, key_ref, updated_at FROM user_credentials WHERE user_id = $1",
    [userId]
  );
  return res.rows[0];
}

export async function deleteUserCredential(userId: string): Promise<void> {
  await getPool().query("DELETE FROM user_credentials WHERE user_id = $1", [userId]);
}

// ── Per-user git credential (PAT) ───────────────────────────

export async function upsertUserGitCredential(
  userId: string,
  blob: { ciphertext: string; nonce: string; keyRef: string }
): Promise<void> {
  await getPool().query(
    `INSERT INTO user_git_credentials (user_id, kind, ciphertext, nonce, key_ref)
     VALUES ($1, 'github_pat', $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET
       ciphertext = EXCLUDED.ciphertext,
       nonce = EXCLUDED.nonce,
       key_ref = EXCLUDED.key_ref,
       updated_at = now()`,
    [userId, blob.ciphertext, blob.nonce, blob.keyRef]
  );
}

export async function getUserGitCredential(userId: string): Promise<StoredCredential | undefined> {
  const res = await getPool().query<StoredCredential>(
    "SELECT kind, ciphertext, nonce, key_ref, updated_at FROM user_git_credentials WHERE user_id = $1",
    [userId]
  );
  return res.rows[0];
}

export async function deleteUserGitCredential(userId: string): Promise<void> {
  await getPool().query("DELETE FROM user_git_credentials WHERE user_id = $1", [userId]);
}

// ── Named secrets (pipeline creds — arbitrary, per user) ────

export async function upsertUserSecret(
  userId: string,
  name: string,
  blob: { ciphertext: string; nonce: string; keyRef: string }
): Promise<void> {
  await getPool().query(
    `INSERT INTO user_secrets (user_id, name, ciphertext, nonce, key_ref)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, name) DO UPDATE SET
       ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce, key_ref = EXCLUDED.key_ref, updated_at = now()`,
    [userId, name, blob.ciphertext, blob.nonce, blob.keyRef]
  );
}

export async function getUserSecret(userId: string, name: string): Promise<StoredCredential | undefined> {
  const res = await getPool().query<StoredCredential>(
    "SELECT 'secret' AS kind, ciphertext, nonce, key_ref, updated_at FROM user_secrets WHERE user_id = $1 AND name = $2",
    [userId, name]
  );
  return res.rows[0];
}

export async function listUserSecretNames(userId: string): Promise<string[]> {
  const res = await getPool().query<{ name: string }>(
    "SELECT name FROM user_secrets WHERE user_id = $1 ORDER BY name",
    [userId]
  );
  return res.rows.map((r) => r.name);
}

export async function deleteUserSecret(userId: string, name: string): Promise<void> {
  await getPool().query("DELETE FROM user_secrets WHERE user_id = $1 AND name = $2", [userId, name]);
}

// ── Pipeline runs ──────────────────────────────────────────

export interface PipelineRun {
  id: string;
  repo_url: string | null;
  git_ref: string | null;
  phase: string;
  status: string;
  exit_code: number | null;
  artifact: string | null;
  log: string | null;
  created_by_user_id: string | null;
  agent_id: string | null;
  pr_posted: boolean;
  review: string | null;
  recommendation: string | null;
  land_on_pass: boolean;
  deploy_gate_run_id: string | null;
  created_at: string;
  completed_at: string | null;
}

export async function setPipelineReview(id: string, review: string, recommendation: string): Promise<void> {
  await getPool().query(
    "UPDATE pipeline_runs SET review = $2, recommendation = $3, status = 'pending_approval' WHERE id = $1 AND status = 'pending_review'",
    [id, review, recommendation]
  );
}

export async function insertPipelineRun(run: {
  id: string;
  repoUrl: string | null;
  ref: string | null;
  phase: string;
  status?: string;
  createdByUserId?: string | null;
  agentId?: string | null;
  landOnPass?: boolean;
  deployGateRunId?: string | null;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO pipeline_runs (id, repo_url, git_ref, phase, status, created_by_user_id, agent_id, land_on_pass, deploy_gate_run_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [run.id, run.repoUrl, run.ref, run.phase, run.status ?? "pending", run.createdByUserId ?? null, run.agentId ?? null, run.landOnPass ?? false, run.deployGateRunId ?? null]
  );
}

/** The pre-deploy test runs launched on `main` for a given deploy run (its gate
 *  batch). Newest first. Empty if the repo has no test phase. */
export async function getDeployGateTests(deployRunId: string): Promise<PipelineRun[]> {
  const res = await getPool().query<PipelineRun>(
    "SELECT * FROM pipeline_runs WHERE deploy_gate_run_id = $1 ORDER BY created_at DESC",
    [deployRunId]
  );
  return res.rows;
}

/** Read-only view of the changes a proposed deploy will ship (merged, not yet
 *  deployed) WITH each one's prior report-back review — so the deploy review can
 *  validate intent + confirm the earlier concerns, not just the deploy path.
 *  Mirrors claimDeployManifest's WHERE, but claims nothing. */
export async function getPendingDeployChanges(repoUrl: string): Promise<Array<{ id: string; pr_number: number | null; name: string; prompt: string; review: string | null; recommendation: string | null }>> {
  const bare = repoUrl.replace(/\.git$/, "");
  const res = await getPool().query<{ id: string; pr_number: number | null; name: string; prompt: string; review: string | null; recommendation: string | null }>(
    `SELECT id, pr_number, name, prompt, review, recommendation FROM agents
      WHERE (repo_url = $1 OR repo_url = $2)
        AND state = 'verified' AND pr_number IS NOT NULL
        AND deployed_by_agent_id IS NULL
        AND review_of_agent_id IS NULL
      ORDER BY pr_number`,
    [bare, `${bare}.git`]
  );
  return res.rows;
}

export async function markPipelineRunPrPosted(id: string): Promise<void> {
  await getPool().query("UPDATE pipeline_runs SET pr_posted = true WHERE id = $1", [id]);
}

export async function updatePipelineRun(
  id: string,
  patch: { status?: string; exit_code?: number; artifact?: string; log?: string; completed?: boolean }
): Promise<void> {
  await getPool().query(
    `UPDATE pipeline_runs SET
       status = COALESCE($2, status),
       exit_code = COALESCE($3, exit_code),
       artifact = COALESCE($4, artifact),
       log = COALESCE($5, log),
       completed_at = CASE WHEN $6 THEN now() ELSE completed_at END
     WHERE id = $1`,
    [id, patch.status ?? null, patch.exit_code ?? null, patch.artifact ?? null, patch.log ?? null, patch.completed ?? false]
  );
  if (patch.completed) {
    // Tell the boss a run finished → gate the linked PR. Tolerant of pg-mem.
    try {
      await getPool().query("SELECT pg_notify('daboss_pipeline_done', $1)", [id]);
    } catch { /* pg-mem / no listener */ }
  }
}

export async function getPipelineRun(id: string): Promise<PipelineRun | undefined> {
  const res = await getPool().query<PipelineRun>("SELECT * FROM pipeline_runs WHERE id = $1", [id]);
  return res.rows[0];
}

/** Atomically claim a batch of test runs for gating so exactly one completion
 *  acts. Flips pr_posted false→true for the terminal runs of these phases in this
 *  mode (land vs PR-gate) and returns the claimed ids. A concurrent caller gets
 *  []. Prior-cycle runs are already pr_posted, so this targets only the current
 *  batch. */
export async function claimTestBatch(agentId: string, phases: string[], landOnPass: boolean): Promise<string[]> {
  const res = await getPool().query<{ id: string }>(
    `UPDATE pipeline_runs SET pr_posted = true
      WHERE agent_id = $1 AND phase = ANY($2) AND land_on_pass = $3
        AND status IN ('passed','failed') AND pr_posted = false
      RETURNING id`,
    [agentId, phases, landOnPass]
  );
  return res.rows.map((r) => r.id);
}

/** Point a run at the agent executing it (deploy-manager). */
export async function setPipelineRunAgent(runId: string, agentId: string): Promise<void> {
  await getPool().query("UPDATE pipeline_runs SET agent_id = $2 WHERE id = $1", [runId, agentId]);
}

/** Link the pipeline run a deploy-manager agent executes, so its pod carries a
 *  recorder sidecar tied to that run. */
export async function setAgentPipelineRun(agentId: string, runId: string): Promise<void> {
  await getPool().query("UPDATE agents SET pipeline_run_id = $2 WHERE id = $1", [agentId, runId]);
}

/** Set an agent's t-shirt pod size (the supervisor's assessment, or a bump). */
export async function setAgentSize(agentId: string, size: string | null): Promise<void> {
  await getPool().query("UPDATE agents SET size = $2 WHERE id = $1", [agentId, size]);
}

/** Nudge the supervisor's queue listener that an agent is ready to dispatch. */
export async function notifyAgentQueued(agentId: string): Promise<void> {
  await getPool().query("SELECT pg_notify('daboss_agent_queued', $1)", [agentId]);
}

/** Mark an agent as the reviewer of another agent's change. */
export async function setAgentReviewOf(agentId: string, reviewedAgentId: string): Promise<void> {
  await getPool().query("UPDATE agents SET review_of_agent_id = $2 WHERE id = $1", [agentId, reviewedAgentId]);
}

// ── reviews (first-class entity, review-platform plan §3.1) ──────────
export async function createReview(r: {
  id?: string;
  reviewed_agent_id: string;
  review_agent_id?: string | null;
  requested_by?: string | null;
  runner?: string;
  status?: string;
}): Promise<Review> {
  const id = r.id ?? `rev_${nanoid(10)}`;
  await getPool().query(
    `INSERT INTO reviews (id, reviewed_agent_id, review_agent_id, requested_by, runner, status)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, r.reviewed_agent_id, r.review_agent_id ?? null, r.requested_by ?? null, r.runner ?? "pod", r.status ?? "running"]
  );
  return (await getReview(id))!;
}

export async function getReview(id: string): Promise<Review | undefined> {
  const res = await getPool().query<Review>("SELECT * FROM reviews WHERE id = $1", [id]);
  return res.rows[0];
}

/** The most recent review whose reviewer is this agent — used to complete the
 *  row when a review agent terminates. */
export async function getReviewByReviewAgent(reviewAgentId: string): Promise<Review | undefined> {
  const res = await getPool().query<Review>(
    "SELECT * FROM reviews WHERE review_agent_id = $1 ORDER BY created_at DESC LIMIT 1",
    [reviewAgentId]
  );
  return res.rows[0];
}

export async function getReviewsForAgent(reviewedAgentId: string): Promise<Review[]> {
  const res = await getPool().query<Review>(
    "SELECT * FROM reviews WHERE reviewed_agent_id = $1 ORDER BY created_at DESC",
    [reviewedAgentId]
  );
  return res.rows;
}

// ── api tokens (headless auth for the MCP surface) ──────────────────
export interface ApiTokenRow {
  id: string;
  user_id: string;
  name: string | null;
  token_hash: string;
  scopes: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export async function createApiToken(t: {
  id?: string;
  user_id: string;
  name?: string | null;
  token_hash: string;
  scopes?: string;
}): Promise<ApiTokenRow> {
  const id = t.id ?? `tok_${nanoid(10)}`;
  await getPool().query(
    `INSERT INTO api_tokens (id, user_id, name, token_hash, scopes) VALUES ($1,$2,$3,$4,$5)`,
    [id, t.user_id, t.name ?? null, t.token_hash, t.scopes ?? ""]
  );
  return (await getPool().query<ApiTokenRow>("SELECT * FROM api_tokens WHERE id = $1", [id])).rows[0];
}

/** Look up an ACTIVE (non-revoked) token by its sha256 hash. */
export async function getActiveApiTokenByHash(hash: string): Promise<ApiTokenRow | undefined> {
  const res = await getPool().query<ApiTokenRow>(
    "SELECT * FROM api_tokens WHERE token_hash = $1 AND revoked_at IS NULL LIMIT 1",
    [hash]
  );
  return res.rows[0];
}

export async function touchApiToken(id: string): Promise<void> {
  await getPool().query("UPDATE api_tokens SET last_used_at = now() WHERE id = $1", [id]);
}

/** Revoke a token — scoped to its owner so one user can't revoke another's. */
export async function revokeApiToken(id: string, userId: string): Promise<boolean> {
  const res = await getPool().query(
    "UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
    [id, userId]
  );
  return (res.rowCount ?? 0) > 0;
}

/** Tokens for a user — WITHOUT the hash (never leaves the DB after creation). */
export async function listApiTokensForUser(userId: string): Promise<Omit<ApiTokenRow, "token_hash">[]> {
  const res = await getPool().query<ApiTokenRow>(
    "SELECT id, user_id, name, scopes, created_at, last_used_at, revoked_at FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC",
    [userId]
  );
  return res.rows;
}

/** Record a review's verdict + rationale and close it. status is 'done' for a
 *  real result, 'error' when the reviewer produced nothing. */
export async function completeReview(
  id: string,
  recommendation: string,
  rationale: string,
  status: "done" | "error" = "done"
): Promise<void> {
  await getPool().query(
    "UPDATE reviews SET status = $2, recommendation = $3, rationale = $4, completed_at = now() WHERE id = $1",
    [id, status, recommendation, rationale]
  );
}

/** True if this agent already has a live/finished review agent — so we don't
 *  dispatch a second one for the same completion. */
export async function hasActiveReviewAgent(reviewedAgentId: string): Promise<boolean> {
  // Only a review that's still in flight blocks dispatching another. A COMPLETED (or
  // verified) review must NOT block a fresh one — otherwise, after the change is
  // re-worked and re-tested, no new review ever runs and the change is stuck with a
  // stale/empty verdict (it never re-enters the Reviews queue).
  const res = await getPool().query(
    "SELECT 1 FROM agents WHERE review_of_agent_id = $1 AND state NOT IN ('failed','aborted','completed','verified') LIMIT 1",
    [reviewedAgentId]
  );
  return res.rows.length > 0;
}

/** Claim the merged changes currently on the repo's main into a deploy's manifest:
 *  every verified agent with a merged PR on this repo that no deploy has claimed
 *  yet (excludes review agents + deploy agents). Returns the shipped changes. */
export async function claimDeployManifest(deployAgentId: string, repoUrl: string): Promise<Array<{ id: string; pr_number: number | null; name: string }>> {
  const bare = repoUrl.replace(/\.git$/, "");
  const res = await getPool().query<{ id: string; pr_number: number | null; name: string }>(
    `UPDATE agents SET deployed_by_agent_id = $1
      WHERE (repo_url = $2 OR repo_url = $3)
        AND state = 'verified' AND pr_number IS NOT NULL
        AND deployed_by_agent_id IS NULL
        AND review_of_agent_id IS NULL
        AND id <> $1
      RETURNING id, pr_number, name`,
    [deployAgentId, bare, `${bare}.git`]
  );
  return res.rows;
}

/** The changes a deploy shipped (its manifest), for the deploy agent's page. */
export async function getShippedAgents(deployAgentId: string): Promise<Array<{ id: string; pr_number: number | null; name: string }>> {
  const res = await getPool().query<{ id: string; pr_number: number | null; name: string }>(
    "SELECT id, pr_number, name FROM agents WHERE deployed_by_agent_id = $1 ORDER BY pr_number",
    [deployAgentId]
  );
  return res.rows;
}

/** The review agent reviewing this agent (most recent), so the UI can link to its
 *  live trace. */
export async function getReviewAgentIdFor(reviewedAgentId: string): Promise<string | null> {
  const res = await getPool().query<{ id: string }>(
    "SELECT id FROM agents WHERE review_of_agent_id = $1 ORDER BY created_at DESC LIMIT 1",
    [reviewedAgentId]
  );
  return res.rows[0]?.id ?? null;
}

/** A still-running run this agent is executing (its executor link), if any — for
 *  reconciling deploy runs when the deploy-manager agent finishes. */
export async function getRunningRunForExecutor(agentId: string): Promise<PipelineRun | undefined> {
  const res = await getPool().query<PipelineRun>(
    "SELECT * FROM pipeline_runs WHERE agent_id = $1 AND status = 'running' ORDER BY created_at DESC LIMIT 1",
    [agentId]
  );
  return res.rows[0];
}

/** Agent ids that currently have a test phase (test / test-*) in flight — batch
 *  version for the agent list, so a card can show "Testing" (one coherent status
 *  everywhere) instead of a bare "completed". */
export async function getAgentsWithActiveTestRuns(): Promise<string[]> {
  const res = await getPool().query<{ agent_id: string }>(
    `SELECT DISTINCT agent_id FROM pipeline_runs
      WHERE agent_id IS NOT NULL AND (phase = 'test' OR phase LIKE 'test-%')
        AND status IN ('pending','running')`
  );
  return res.rows.map((r) => r.agent_id);
}

/** Agents that are DEPLOY executors — an agent that ran a non-test pipeline phase
 *  (change agents only ever run test / test-* phases; a deploy agent runs the
 *  gated deploy phase). Used to nest these sub-agents under the change they ship
 *  instead of cluttering the main dashboard. Mirrors isTestPhase(). */
export async function getDeployAgentIds(): Promise<string[]> {
  // Only runs actually DISPATCHED to an executor — a gated deploy still awaiting
  // approval (pending/pending_review/pending_approval) is attributed to the
  // change agent that created it, and must NOT nest that change as a "deploy".
  const res = await getPool().query<{ agent_id: string }>(
    `SELECT DISTINCT agent_id FROM pipeline_runs
      WHERE agent_id IS NOT NULL
        AND NOT (phase = 'test' OR phase LIKE 'test-%')
        AND status NOT IN ('pending','pending_review','pending_approval')`
  );
  return res.rows.map((r) => r.agent_id);
}

/** Whether the agent has a test phase (test / test-*) in flight — so the UI can
 *  show "Testing…" instead of a finished-looking "completed + Resume" while its
 *  suites run in separate pods. */
export async function hasActiveTestRuns(agentId: string): Promise<boolean> {
  const res = await getPool().query(
    `SELECT 1 FROM pipeline_runs
      WHERE agent_id = $1 AND (phase = 'test' OR phase LIKE 'test-%')
        AND status IN ('pending','running') LIMIT 1`,
    [agentId]
  );
  return res.rows.length > 0;
}

/** True while a land is in flight for this agent (Merge clicked → rebase on main +
 *  retest, merging on green). Used to keep the Merge button disabled until it
 *  finishes, so a second click can't stack another land. */
export async function hasLandInFlight(agentId: string): Promise<boolean> {
  const res = await getPool().query(
    `SELECT 1 FROM pipeline_runs
      WHERE agent_id = $1 AND land_on_pass = true
        AND status IN ('pending','pending_review','pending_approval','running') LIMIT 1`,
    [agentId]
  );
  return res.rows.length > 0;
}

export async function getPipelineRunsForAgent(agentId: string): Promise<PipelineRun[]> {
  const res = await getPool().query<PipelineRun>(
    "SELECT * FROM pipeline_runs WHERE agent_id = $1 ORDER BY created_at DESC",
    [agentId]
  );
  return res.rows;
}

/** An in-flight (proposed, awaiting approval, or running) deploy for this repo+ref,
 *  if any — so we don't stack duplicate deploy cards on every merge to main. The
 *  repo_url is matched with and without a trailing `.git` (agents clone `…​.git`;
 *  manual runs may not). Returns the most recent match. */
export async function getActiveDeployRun(repoUrl: string, ref: string): Promise<PipelineRun | undefined> {
  const bare = repoUrl.replace(/\.git$/, "");
  const res = await getPool().query<PipelineRun>(
    `SELECT * FROM pipeline_runs
      WHERE phase = 'deploy' AND git_ref = $3
        AND (repo_url = $1 OR repo_url = $2)
        AND status IN ('pending','pending_review','pending_approval','running')
      ORDER BY created_at DESC LIMIT 1`,
    [bare, `${bare}.git`, ref]
  );
  return res.rows[0];
}

/** All in-flight deploy runs (any active status), keyed for the dashboard so a
 *  verified change can show "deploy gate / awaiting approval / deploying" instead of
 *  a flat "needs deploy". Key = `<bare repo>@<ref>`; newest wins. */
export async function getActiveDeployStatusByRepoRef(): Promise<Map<string, string>> {
  const res = await getPool().query<{ repo_url: string | null; git_ref: string | null; status: string }>(
    `SELECT repo_url, git_ref, status FROM pipeline_runs
      WHERE phase = 'deploy' AND status IN ('pending','pending_review','pending_approval','running')
      ORDER BY created_at DESC`
  );
  const map = new Map<string, string>();
  for (const r of res.rows) {
    const key = `${(r.repo_url || "").replace(/\.git$/, "")}@${r.git_ref || "main"}`;
    if (!map.has(key)) map.set(key, r.status); // newest (ordered desc) wins
  }
  return map;
}

/** States of the given agent ids, keyed by id — for resolving a change's deploy
 *  agent state (deployed_by_agent_id → its deploy agent's state). */
export async function getAgentStatesByIds(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const res = await getPool().query<{ id: string; state: string }>(
    "SELECT id, state FROM agents WHERE id = ANY($1)", [ids]
  );
  return new Map(res.rows.map((r) => [r.id, r.state]));
}

/** The most recent completed test run for an agent — feeds the deploy review. */
export async function getLatestTestRunForAgent(agentId: string): Promise<PipelineRun | undefined> {
  const res = await getPool().query<PipelineRun>(
    "SELECT * FROM pipeline_runs WHERE agent_id = $1 AND status IN ('passed','failed') ORDER BY created_at DESC LIMIT 1",
    [agentId]
  );
  return res.rows[0];
}

export async function listPipelineRuns(limit = 50): Promise<PipelineRun[]> {
  const res = await getPool().query<PipelineRun>(
    "SELECT * FROM pipeline_runs ORDER BY created_at DESC LIMIT $1",
    [limit]
  );
  return res.rows;
}
