import { useState, useEffect } from "react";
import { RefreshCw } from "lucide-react";

interface UsageWindow {
  utilization: number;
  resets_at: string;
}

interface UsageData {
  five_hour: UsageWindow | null;
  seven_day: UsageWindow | null;
  seven_day_opus: UsageWindow | null;
  seven_day_sonnet: UsageWindow | null;
  seven_day_cowork: UsageWindow | null;
  seven_day_oauth_apps: UsageWindow | null;
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
  local: {
    allTime: Record<string, { input: number; output: number; cacheRead: number; cacheCreate: number }>;
    last7Days: Record<string, number>;
    totalSessions: number;
    totalMessages: number;
  } | null;
  fetched_at: string;
}

const MODEL_COLORS: Record<string, { out: string; in: string }> = {
  opus: { out: "bg-purple-500", in: "bg-purple-400/60" },
  sonnet: { out: "bg-blue-500", in: "bg-blue-400/60" },
  haiku: { out: "bg-green-500", in: "bg-green-400/60" },
};

function modelFamily(name: string): string {
  if (name.includes("opus")) return "opus";
  if (name.includes("haiku")) return "haiku";
  return "sonnet";
}

function shortModelName(name: string): string {
  const family = modelFamily(name);
  return family.charAt(0).toUpperCase() + family.slice(1);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
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

  let resetStr = "";
  if (resetsAt) {
    const diffMs = new Date(resetsAt).getTime() - Date.now();
    const diffMins = Math.max(0, Math.floor(diffMs / 60000));
    const hours = Math.floor(diffMins / 60);
    const mins = diffMins % 60;
    resetStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
  }

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
          {resetStr && ` · resets in ${resetStr}`}
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

  // Build local model breakdown — merge versions into families
  const localStats = usage.local;
  const familyTotals: Record<string, { input: number; output: number }> = {};
  if (localStats?.allTime) {
    for (const [model, u] of Object.entries(localStats.allTime)) {
      const family = modelFamily(model);
      if (!familyTotals[family]) familyTotals[family] = { input: 0, output: 0 };
      familyTotals[family].input += u.input;
      familyTotals[family].output += u.output;
    }
  }
  const familyEntries = Object.entries(familyTotals)
    .map(([family, u]) => ({ family, name: family.charAt(0).toUpperCase() + family.slice(1), ...u }))
    .sort((a, b) => b.output - a.output);
  const totalOutput = familyEntries.reduce((s, m) => s + m.output, 0);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 max-h-80 overflow-y-auto">
      <div className="flex items-center justify-between mb-3 sticky top-0 bg-gray-900 pb-1 -mt-1 pt-1 z-10">
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

      {/* Account-wide rate limits */}
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
        <UsageBar
          label="Weekly (Opus)"
          utilization={usage.seven_day_opus?.utilization ?? 0}
          resetsAt={usage.seven_day_opus?.resets_at ?? usage.seven_day?.resets_at ?? ""}
        />
        <UsageBar
          label="Weekly (Sonnet)"
          utilization={usage.seven_day_sonnet?.utilization ?? 0}
          resetsAt={usage.seven_day_sonnet?.resets_at ?? usage.seven_day?.resets_at ?? ""}
        />
        {usage.seven_day_cowork && (
          <UsageBar
            label="Weekly (Cowork)"
            utilization={usage.seven_day_cowork.utilization}
            resetsAt={usage.seven_day_cowork.resets_at}
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

      {/* Local model breakdown */}
      {familyEntries.length > 0 && (
        <div className="mt-4 pt-3 border-t border-gray-800">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] text-gray-500 uppercase tracking-wide">This machine · by model</span>
            {localStats && (
              <span className="text-[10px] text-gray-600">
                {localStats.totalSessions.toLocaleString()} sessions
              </span>
            )}
          </div>
          <div className="space-y-2">
            {familyEntries.map((m) => {
              const total = m.input + m.output;
              const allTokens = familyEntries.reduce((s, f) => s + f.input + f.output, 0);
              const pct = allTokens > 0 ? total / allTokens * 100 : 0;
              const outPct = total > 0 ? m.output / total * 100 : 0;
              const inPct = 100 - outPct;
              const colors = MODEL_COLORS[m.family] || { out: "bg-gray-500", in: "bg-gray-400/60" };
              return (
                <div key={m.family}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-gray-300">{m.name}</span>
                    <span className="text-gray-500">
                      {pct.toFixed(1)}% · {formatTokens(m.output)} out · {formatTokens(m.input)} in
                    </span>
                  </div>
                  <div className="h-2 bg-gray-800 rounded-full overflow-hidden flex">
                    <div
                      className={`h-full transition-all ${colors.out}`}
                      style={{ width: `${pct * (outPct / 100)}%` }}
                    />
                    <div
                      className={`h-full transition-all ${colors.in}`}
                      style={{ width: `${pct * (inPct / 100)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

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
