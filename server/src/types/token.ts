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
  updated_at: string;
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
