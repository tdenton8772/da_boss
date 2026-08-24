export interface TokenUsageRecord {
  id: number;
  agent_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cost_usd: number;
  recorded_at: string;
}

export interface BudgetConfig {
  daily_budget_usd: number;
  monthly_budget_usd: number;
  /** Default per-user caps (each user's spend on their OWN credential).
   *  NULL = per-user capping disabled unless a user has an explicit override. */
  user_daily_default_usd: number | null;
  user_monthly_default_usd: number | null;
  updated_at: string;
}

/** Admin view: one user's spend vs their effective caps. */
export interface UserBudget {
  user_id: string;
  email: string;
  daily_spend_usd: number;
  monthly_spend_usd: number;
  /** Explicit per-user overrides (NULL = inherit the default). */
  daily_budget_usd: number | null;
  monthly_budget_usd: number | null;
  /** Override ?? default — what enforcement actually uses. NULL = uncapped. */
  effective_daily_usd: number | null;
  effective_monthly_usd: number | null;
}

export interface BudgetStatus {
  config: BudgetConfig;
  daily_spend_usd: number;
  monthly_spend_usd: number;
  daily_remaining_usd: number;
  monthly_remaining_usd: number;
  daily_percent: number;
  monthly_percent: number;
}

export interface AgentTokenSummary {
  agent_id: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
}
