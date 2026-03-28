import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router";
import { api, type AgentWithTokens, type BudgetStatus, type PermissionReq } from "../api";
import { useWebSocket, type ServerEvent } from "../ws";
import { AgentCard } from "../components/AgentCard";
import { TokenBudgetBar } from "../components/TokenBudgetBar";
import { PermissionDialog } from "../components/PermissionDialog";
import { CreateAgentForm } from "../components/CreateAgentForm";
import { Plus, Wifi, WifiOff, Settings, Search, Filter, Skull } from "lucide-react";
import { UsageWidget } from "../components/UsageWidget";

export function Dashboard() {
  const [agents, setAgents] = useState<AgentWithTokens[]>([]);
  const [budget, setBudget] = useState<BudgetStatus | null>(null);
  const [permissions, setPermissions] = useState<PermissionReq[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [sortBy, setSortBy] = useState<"name" | "date" | "cost" | "status">("date");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [processInfo, setProcessInfo] = useState<Record<string, { pids: number[]; descendants: number[] }>>({});
  const [queueInfo, setQueueInfo] = useState<Record<string, number>>({});

  const refresh = useCallback(() => {
    api.getAgents().then(setAgents).catch(() => {});
    api.getBudget().then(setBudget).catch(() => {});
    api.getPendingPermissions().then(setPermissions).catch(() => {});
    api.getProcesses().then(setProcessInfo).catch(() => {});
    api.getQueue().then(setQueueInfo).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 10_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const handleEvent = useCallback(
    (event: ServerEvent) => {
      if (
        event.type === "agent:state_changed" ||
        event.type === "agent:token_usage"
      ) {
        refresh();
      }
      if (event.type === "permission:requested" || event.type === "permission:resolved") {
        api.getPendingPermissions().then(setPermissions).catch(() => {});
      }
      if (event.type === "budget:updated") {
        api.getBudget().then(setBudget).catch(() => {});
      }
    },
    [refresh]
  );

  const { connected } = useWebSocket(handleEvent);

  // Filter and sort logic
  let filteredAgents = agents.filter((agent) => {
    const matchesSearch = agent.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         agent.prompt.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesFilter = filterStatus === "all" || agent.state === filterStatus;
    return matchesSearch && matchesFilter;
  });

  // Sort agents
  filteredAgents.sort((a, b) => {
    switch (sortBy) {
      case "name":
        return a.name.localeCompare(b.name);
      case "cost":
        return b.tokens.total_cost_usd - a.tokens.total_cost_usd;
      case "status":
        return a.state.localeCompare(b.state);
      case "date":
      default:
        return new Date(b.updated_at || b.created_at).getTime() -
               new Date(a.updated_at || a.created_at).getTime();
    }
  });

  const active = filteredAgents.filter((a) =>
    ["running", "waiting_permission", "waiting_input"].includes(a.state)
  );
  const other = filteredAgents.filter(
    (a) => !["running", "waiting_permission", "waiting_input"].includes(a.state)
  );

  return (
    <div className="min-h-screen bg-gray-950 p-4 md:p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-gray-100">da_boss</h1>
          <span
            className={`flex items-center gap-1 text-xs ${connected ? "text-green-500" : "text-red-500"}`}
          >
            {connected ? <Wifi size={12} /> : <WifiOff size={12} />}
            {connected ? "live" : "disconnected"}
          </span>
        </div>
        <div className="flex gap-2">
          <Link
            to="/settings"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded"
            title="Settings"
          >
            <Settings size={16} />
          </Link>
          <button
            onClick={async () => {
              if (!confirm("KILL ALL running agents and orphaned processes?")) return;
              try {
                const res = await api.killAll();
                alert(`Killed ${res.killed} agents, ${res.orphans} orphaned processes`);
                refresh();
              } catch (err) {
                alert("Kill all failed: " + (err instanceof Error ? err.message : err));
              }
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-red-700 hover:bg-red-600 text-white text-sm font-medium rounded"
          >
            <Skull size={16} />
            Kill All
          </button>
          <Link
            to="/discover"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded"
          >
            Import
          </Link>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded"
          >
            <Plus size={16} />
            New Agent
          </button>
        </div>
      </div>

      {/* Usage + Permissions */}
      <div className="grid gap-4 md:grid-cols-2 mb-6">
        <UsageWidget />
        <PermissionDialog
          permissions={permissions}
          onResolved={refresh}
          agentNames={Object.fromEntries(agents.map(a => [a.id, a.name]))}
        />
      </div>

      {/* Search and Filters */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-6">
        <div className="flex flex-col sm:flex-row gap-4">
          {/* Search */}
          <div className="flex-1 relative">
            <Search size={16} className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500" />
            <input
              type="text"
              placeholder="Search agents..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-3 py-2 bg-gray-800 border border-gray-700 rounded text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
          </div>
          {/* Sort */}
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as any)}
            className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-gray-200 focus:outline-none focus:border-blue-500"
          >
            <option value="date">Sort by Date</option>
            <option value="name">Sort by Name</option>
            <option value="cost">Sort by Cost</option>
            <option value="status">Sort by Status</option>
          </select>
          {/* Filter */}
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-gray-200 focus:outline-none focus:border-blue-500"
          >
            <option value="all">All Status</option>
            <option value="pending">Pending</option>
            <option value="running">Running</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="paused">Paused</option>
          </select>
        </div>
        {(searchTerm || filterStatus !== "all") && (
          <div className="mt-3 text-sm text-gray-400">
            Showing {filteredAgents.length} of {agents.length} agents
          </div>
        )}
      </div>

      {/* Active Agents */}
      {active.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide mb-3">
            Active ({active.length})
          </h2>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {active.map((a) => (
              <AgentCard key={a.id} agent={a} processCount={processInfo[a.id] ? processInfo[a.id].pids.length + processInfo[a.id].descendants.length : undefined} queuedCount={queueInfo[a.id]} />
            ))}
          </div>
        </div>
      )}

      {/* Other Agents */}
      {other.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide mb-3">
            All Agents ({other.length})
          </h2>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {other.map((a) => (
              <AgentCard key={a.id} agent={a} processCount={processInfo[a.id] ? processInfo[a.id].pids.length + processInfo[a.id].descendants.length : undefined} queuedCount={queueInfo[a.id]} />
            ))}
          </div>
        </div>
      )}

      {agents.length === 0 && (
        <div className="text-center text-gray-600 py-16">
          No agents yet. Create one to get started.
        </div>
      )}

      {/* Create Modal */}
      {showCreate && (
        <CreateAgentForm
          onCreated={() => {
            setShowCreate(false);
            refresh();
          }}
          onClose={() => setShowCreate(false)}
        />
      )}
    </div>
  );
}
