import { useState, useEffect } from "react";
import { RefreshCw } from "lucide-react";

interface UsageWindow {
  utilization: number;
  resets_at: string;
}

interface UsageData {
  five_hour: UsageWindow | null;
  seven_day: UsageWindow | null;
  seven_day_sonnet: UsageWindow | null;
  extra_usage: {
    is_enabled: boolean;
    monthly_limit: number | null;
    used_credits: number | null;
    utilization: number | null;
  } | null;
  account: {
    email: string | null;
    subscriptionType: string | null;
    rateLimitTier: string | null;
  };
  fetched_at: string;
}

function UsageBar({
  label,
  utilization,
  resetsAt,
}: {
  label: string;
  utilization: number;
  resetsAt: string;
}) {
  const pct = Math.min(100, utilization);
  const color =
    pct >= 100
      ? "bg-red-500"
      : pct >= 80
        ? "bg-yellow-500"
        : pct >= 50
          ? "bg-blue-500"
          : "bg-green-500";

  const resetDate = new Date(resetsAt);
  const now = new Date();
  const diffMs = resetDate.getTime() - now.getTime();
  const diffMins = Math.max(0, Math.floor(diffMs / 60000));
  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  const resetStr =
    hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-gray-300">{label}</span>
        <span className="text-gray-500">
          {pct >= 100 ? (
            <span className="text-red-400 font-medium">at limit</span>
          ) : (
            `${pct}%`
          )}
          {" · resets in "}
          {resetStr}
        </span>
      </div>
      <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function UsageWidget() {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchUsage = (force = false) => {
    setLoading(true);
    const url = force ? "/api/usage/refresh" : "/api/usage";
    const opts = force ? { method: "POST" } : {};
    fetch(url, opts)
      .then((r) => r.json())
      .then((d) => {
        if (!d.error) setUsage(d);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchUsage();
    const interval = setInterval(() => fetchUsage(), 3 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  if (!usage) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <h3 className="text-sm font-medium text-gray-400 mb-2">
          Anthropic Usage
        </h3>
        <p className="text-xs text-gray-600">Loading...</p>
      </div>
    );
  }

  const inExtraUsage =
    usage.five_hour && usage.five_hour.utilization >= 100;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-gray-300">
            Anthropic Usage
          </h3>
          {inExtraUsage && (
            <span className="px-1.5 py-0.5 text-[10px] font-semibold bg-red-900/50 text-red-400 border border-red-800 rounded">
              EXTRA USAGE
            </span>
          )}
        </div>
        <button
          onClick={() => fetchUsage(true)}
          disabled={loading}
          className="text-gray-500 hover:text-gray-300 disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="space-y-2.5">
        {usage.five_hour && (
          <UsageBar
            label="5-hour window"
            utilization={usage.five_hour.utilization}
            resetsAt={usage.five_hour.resets_at}
          />
        )}
        {usage.seven_day && (
          <UsageBar
            label="Weekly (all models)"
            utilization={usage.seven_day.utilization}
            resetsAt={usage.seven_day.resets_at}
          />
        )}
        {usage.seven_day_sonnet && (
          <UsageBar
            label="Weekly (Sonnet)"
            utilization={usage.seven_day_sonnet.utilization}
            resetsAt={usage.seven_day_sonnet.resets_at}
          />
        )}
        {usage.extra_usage?.is_enabled &&
          usage.extra_usage.used_credits != null &&
          usage.extra_usage.monthly_limit != null && (
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-gray-300">Extra usage</span>
                <span className="text-gray-500">
                  ${(usage.extra_usage.used_credits / 100).toFixed(2)} / $
                  {(usage.extra_usage.monthly_limit / 100).toFixed(2)}
                </span>
              </div>
              <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all bg-orange-500"
                  style={{
                    width: `${Math.min(100, usage.extra_usage.utilization || 0)}%`,
                  }}
                />
              </div>
            </div>
          )}
      </div>

      <div className="mt-3 flex items-center justify-between text-[10px] text-gray-600">
        <span>
          {usage.account.email} · {usage.account.subscriptionType}
        </span>
        <span>
          updated{" "}
          {new Date(usage.fetched_at).toLocaleTimeString()}
        </span>
      </div>
    </div>
  );
}
