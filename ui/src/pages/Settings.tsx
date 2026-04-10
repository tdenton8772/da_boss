import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router";
import { api, type BudgetStatus } from "../api";
import { useToastHelpers } from "../components/Toast";
import {
  ArrowLeft,
  LogOut,
  Save,
  Server,
  Clock,
  Shield,
  DollarSign,
  Bell,
  Network,
  Activity,
} from "lucide-react";

interface ServerSettings {
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
}

interface AuditEntry {
  id: number;
  user_ip: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: string | null;
  created_at: string;
}

export function Settings() {
  const navigate = useNavigate();
  const toast = useToastHelpers();
  const [budget, setBudget] = useState<BudgetStatus | null>(null);
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Budget form state
  const [dailyBudget, setDailyBudget] = useState("");
  const [monthlyBudget, setMonthlyBudget] = useState("");

  useEffect(() => {
    Promise.all([
      api.getBudget(),
      api.getSettings(),
      api.getAuditLog(),
    ]).then(([budgetData, settingsData, auditData]) => {
      setBudget(budgetData);
      setSettings(settingsData);
      setAuditEntries(auditData.entries || []);
      setDailyBudget(budgetData.config.daily_budget_usd.toString());
      setMonthlyBudget(budgetData.config.monthly_budget_usd.toString());
      setLoading(false);
    }).catch((err) => {
      toast.error("Failed to load settings", err.message);
      setLoading(false);
    });
  }, []);

  const handleSaveBudget = async () => {
    setSaving(true);
    try {
      const daily = parseFloat(dailyBudget);
      const monthly = parseFloat(monthlyBudget);
      if (isNaN(daily) || isNaN(monthly) || daily <= 0 || monthly <= 0) {
        toast.error("Invalid budget", "Budget values must be positive numbers");
        return;
      }
      const updatedBudget = await api.updateBudget(daily, monthly);
      setBudget(updatedBudget);
      toast.success("Budget updated successfully");
    } catch (err: any) {
      toast.error("Failed to update budget", err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = async () => {
    try {
      await api.logout();
      toast.success("Logged out successfully");
      navigate("/login");
    } catch (err: any) {
      toast.error("Logout failed", err.message);
    }
  };

  const formatUptime = (seconds: number): string => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  };

  const formatDate = (dateStr: string): string => {
    return new Date(dateStr).toLocaleString();
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center text-gray-400">
        Loading settings...
      </div>
    );
  }

  if (!budget || !settings) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-400 mb-4">Failed to load settings</p>
          <Link to="/" className="text-blue-400 hover:text-blue-300">
            Back to dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 p-4 md:p-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <Link
          to="/"
          className="flex items-center gap-2 text-gray-500 hover:text-gray-300 text-sm"
        >
          <ArrowLeft size={16} />
          Back to Dashboard
        </Link>
        <button
          onClick={handleLogout}
          className="flex items-center gap-2 px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white text-sm rounded transition-colors"
        >
          <LogOut size={16} />
          Logout
        </button>
      </div>

      <h1 className="text-2xl font-bold text-gray-100 mb-8">Settings</h1>

      {/* Server Info */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6">
        <h2 className="flex items-center gap-2 text-lg font-medium text-gray-200 mb-4">
          <Server size={20} />
          Server Information
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-gray-500">Node ID:</span>
            <span className="text-gray-200 ml-2 font-mono">{settings.node_id}</span>
          </div>
          <div>
            <span className="text-gray-500">Role:</span>
            <span className="text-gray-200 ml-2 capitalize">{settings.node_role}</span>
          </div>
          <div>
            <span className="text-gray-500">Uptime:</span>
            <span className="text-gray-200 ml-2">{formatUptime(settings.uptime_seconds)}</span>
          </div>
          <div>
            <span className="text-gray-500">Fleet Nodes:</span>
            <span className="text-gray-200 ml-2">{settings.fleet_nodes}</span>
          </div>
          <div>
            <span className="text-gray-500">Max Concurrent:</span>
            <span className="text-gray-200 ml-2">{settings.max_concurrent_agents} agents</span>
          </div>
          <div>
            <span className="text-gray-500">Active/Total:</span>
            <span className="text-gray-200 ml-2">{settings.active_agents}/{settings.total_agents}</span>
          </div>
        </div>
      </div>

      {/* Usage Limits */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6">
        <h2 className="flex items-center gap-2 text-lg font-medium text-gray-200 mb-4">
          <DollarSign size={20} />
          Usage Limits
        </h2>
        <p className="text-xs text-gray-500 mb-4">
          Set the % of your Anthropic plan utilization at which agents will be paused. Predicted from cached OAuth data + local token tracking.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm text-gray-400 mb-2">5-hour limit (%)</label>
            <input
              type="number"
              step="1"
              min="0"
              max="100"
              value={dailyBudget}
              onChange={(e) => setDailyBudget(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-200 focus:outline-none focus:border-blue-500"
            />
            <div className="text-xs text-gray-600 mt-1">
              Current 5h utilization: {budget.daily_spend_usd.toFixed(0)}%
            </div>
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-2">Weekly limit (%)</label>
            <input
              type="number"
              step="1"
              min="0"
              max="100"
              value={monthlyBudget}
              onChange={(e) => setMonthlyBudget(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-200 focus:outline-none focus:border-blue-500"
            />
            <div className="text-xs text-gray-600 mt-1">
              Current weekly utilization: {budget.monthly_spend_usd.toFixed(0)}%
            </div>
          </div>
        </div>
        <button
          onClick={handleSaveBudget}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-700 disabled:opacity-50 text-white rounded transition-colors"
        >
          <Save size={16} />
          {saving ? "Saving..." : "Save Budget"}
        </button>
      </div>

      {/* System Configuration */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6">
        <h2 className="flex items-center gap-2 text-lg font-medium text-gray-200 mb-4">
          <Clock size={20} />
          System Configuration
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-gray-500">Supervisor Interval:</span>
            <span className="text-gray-200 ml-2">{settings.supervisor_interval_minutes} minutes</span>
          </div>
          <div>
            <span className="text-gray-500">Permission Timeout:</span>
            <span className="text-gray-200 ml-2">{settings.permission_timeout_minutes} minutes</span>
          </div>
          <div>
            <span className="text-gray-500">Stuck Threshold:</span>
            <span className="text-gray-200 ml-2">{settings.stuck_threshold_minutes} minutes</span>
          </div>
          <div>
            <span className="text-gray-500">Notifications:</span>
            <span className="text-gray-200 ml-2">
              {settings.ntfy_topic ? `ntfy.sh/${settings.ntfy_topic}` : "Disabled"}
            </span>
          </div>
        </div>
        <div className="text-xs text-gray-600 mt-3">
          These values are configured via environment variables and require a restart to change.
        </div>
      </div>

      {/* Recent Activity */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
        <h2 className="flex items-center gap-2 text-lg font-medium text-gray-200 mb-4">
          <Activity size={20} />
          Recent Activity
        </h2>
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {auditEntries.length === 0 ? (
            <div className="text-gray-500 text-sm">No recent activity</div>
          ) : (
            auditEntries.slice(0, 10).map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between py-2 px-3 bg-gray-950 rounded text-sm"
              >
                <div className="flex items-center gap-3">
                  <span className="text-gray-400 font-mono">{formatDate(entry.created_at)}</span>
                  <span className="text-blue-400">{entry.action}</span>
                  {entry.target_type && (
                    <span className="text-gray-500">
                      {entry.target_type}:{entry.target_id}
                    </span>
                  )}
                  {entry.details && (
                    <span className="text-gray-300 truncate max-w-xs">{entry.details}</span>
                  )}
                </div>
                <span className="text-gray-600 text-xs">{entry.user_ip || "system"}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}