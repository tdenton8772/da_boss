import type { BudgetStatus } from "../api";

export function TokenBudgetBar({
  budget,
}: {
  budget: BudgetStatus | null;
}) {
  if (!budget) return null;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <h3 className="text-sm font-medium text-gray-300 mb-3">Token Budget</h3>
      <div className="space-y-3">
        <BudgetMeter
          label="Daily"
          spent={budget.daily_spend_usd}
          total={budget.config.daily_budget_usd}
          percent={budget.daily_percent}
        />
        <BudgetMeter
          label="Monthly"
          spent={budget.monthly_spend_usd}
          total={budget.config.monthly_budget_usd}
          percent={budget.monthly_percent}
        />
      </div>
    </div>
  );
}

function BudgetMeter({
  label,
  spent,
  total,
  percent,
}: {
  label: string;
  spent: number;
  total: number;
  percent: number;
}) {
  const barColor =
    percent >= 100
      ? "bg-red-500"
      : percent >= 90
        ? "bg-amber-500"
        : percent >= 80
          ? "bg-yellow-500"
          : "bg-green-500";

  return (
    <div>
      <div className="flex justify-between text-xs text-gray-400 mb-1">
        <span>{label}</span>
        <span>
          ${spent.toFixed(2)} / ${total.toFixed(2)}
        </span>
      </div>
      <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>
    </div>
  );
}
