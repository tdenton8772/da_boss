import { Link } from "react-router";
import type { AgentWithTokens } from "../api";
import {
  Play,
  Pause,
  Square,
  Clock,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Loader,
  ShieldQuestion,
} from "lucide-react";

const STATE_CONFIG: Record<
  string,
  { label: string; color: string; icon: React.ReactNode }
> = {
  pending: {
    label: "Pending",
    color: "text-gray-400",
    icon: <Clock size={14} />,
  },
  running: {
    label: "Running",
    color: "text-green-400",
    icon: <Loader size={14} className="animate-spin" />,
  },
  waiting_permission: {
    label: "Needs Approval",
    color: "text-amber-400",
    icon: <ShieldQuestion size={14} />,
  },
  waiting_input: {
    label: "Needs Input",
    color: "text-amber-400",
    icon: <AlertTriangle size={14} />,
  },
  completed: {
    label: "Completed",
    color: "text-blue-400",
    icon: <CheckCircle size={14} />,
  },
  verified: {
    label: "Verified",
    color: "text-green-400",
    icon: <CheckCircle size={14} />,
  },
  failed: {
    label: "Failed",
    color: "text-red-400",
    icon: <XCircle size={14} />,
  },
  paused: {
    label: "Paused",
    color: "text-yellow-400",
    icon: <Pause size={14} />,
  },
  aborted: {
    label: "Aborted",
    color: "text-gray-500",
    icon: <Square size={14} />,
  },
};

const PRIORITY_COLORS: Record<string, string> = {
  high: "bg-red-900/50 text-red-300",
  medium: "bg-yellow-900/50 text-yellow-300",
  low: "bg-gray-800 text-gray-400",
};

export function AgentCard({ agent, processCount }: { agent: AgentWithTokens; processCount?: number }) {
  const stateInfo = STATE_CONFIG[agent.state] || STATE_CONFIG.pending;
  const cost = agent.tokens.total_cost_usd;

  return (
    <Link
      to={`/agent/${agent.id}`}
      className="block bg-gray-900 border border-gray-800 rounded-lg p-4 hover:border-gray-600 transition-colors"
    >
      <div className="flex items-start justify-between mb-2">
        <div className="flex-1 min-w-0">
          <h3 className="text-gray-100 font-medium truncate">{agent.name}</h3>
          <p className="text-gray-500 text-sm truncate">{agent.cwd}</p>
        </div>
        <span
          className={`flex items-center gap-1.5 text-sm ${stateInfo.color} ml-2 shrink-0`}
        >
          {stateInfo.icon}
          {stateInfo.label}
        </span>
      </div>

      <p className="text-gray-400 text-sm line-clamp-2 mb-3">
        {agent.prompt}
      </p>

      <div className="flex items-center gap-3 text-xs text-gray-500">
        <span className={`px-2 py-0.5 rounded ${PRIORITY_COLORS[agent.priority]}`}>
          {agent.priority}
        </span>
        <span>{agent.model}</span>
        {processCount != null && processCount > 0 && (
          <span className="px-2 py-0.5 rounded bg-orange-900/50 text-orange-300">
            {processCount} proc{processCount !== 1 ? "s" : ""}
          </span>
        )}
        <span className="ml-auto font-mono">
          ${cost.toFixed(4)}
        </span>
      </div>
    </Link>
  );
}
