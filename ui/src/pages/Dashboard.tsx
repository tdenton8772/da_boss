import { useState, useEffect, useCallback } from "react";
import { api, type AgentWithTokens, type BudgetStatus, type PermissionReq } from "../api";
import { useWebSocket, type ServerEvent } from "../ws";
import { AgentCard } from "../components/AgentCard";
import { TokenBudgetBar } from "../components/TokenBudgetBar";
import { PermissionDialog } from "../components/PermissionDialog";
import { CreateAgentForm } from "../components/CreateAgentForm";
import { Plus, Wifi, WifiOff } from "lucide-react";

export function Dashboard() {
  const [agents, setAgents] = useState<AgentWithTokens[]>([]);
  const [budget, setBudget] = useState<BudgetStatus | null>(null);
  const [permissions, setPermissions] = useState<PermissionReq[]>([]);
  const [showCreate, setShowCreate] = useState(false);

  const refresh = useCallback(() => {
    api.getAgents().then(setAgents).catch(() => {});
    api.getBudget().then(setBudget).catch(() => {});
    api.getPendingPermissions().then(setPermissions).catch(() => {});
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

  const active = agents.filter((a) =>
    ["running", "waiting_permission", "waiting_input"].includes(a.state)
  );
  const other = agents.filter(
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
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded"
        >
          <Plus size={16} />
          New Agent
        </button>
      </div>

      {/* Budget + Permissions */}
      <div className="grid gap-4 md:grid-cols-2 mb-6">
        <TokenBudgetBar budget={budget} />
        <PermissionDialog permissions={permissions} onResolved={refresh} />
      </div>

      {/* Active Agents */}
      {active.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide mb-3">
            Active ({active.length})
          </h2>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {active.map((a) => (
              <AgentCard key={a.id} agent={a} />
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
              <AgentCard key={a.id} agent={a} />
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
