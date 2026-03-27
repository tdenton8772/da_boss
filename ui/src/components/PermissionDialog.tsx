import { useState } from "react";
import { Link } from "react-router";
import { api, type PermissionReq } from "../api";
import {
  ShieldQuestion,
  Check,
  X,
  ChevronDown,
  ChevronUp,
  Terminal,
  FileEdit,
  FileText,
  Globe,
  HelpCircle,
  Clock,
} from "lucide-react";

// Tool category badges
const TOOL_BADGES: Record<string, { color: string; icon: React.ReactNode }> = {
  Bash: { color: "bg-orange-900/50 text-orange-300 border-orange-800/50", icon: <Terminal size={12} /> },
  Edit: { color: "bg-blue-900/50 text-blue-300 border-blue-800/50", icon: <FileEdit size={12} /> },
  Write: { color: "bg-purple-900/50 text-purple-300 border-purple-800/50", icon: <FileText size={12} /> },
  NotebookEdit: { color: "bg-purple-900/50 text-purple-300 border-purple-800/50", icon: <FileText size={12} /> },
  WebFetch: { color: "bg-green-900/50 text-green-300 border-green-800/50", icon: <Globe size={12} /> },
  WebSearch: { color: "bg-green-900/50 text-green-300 border-green-800/50", icon: <Globe size={12} /> },
};

const DEFAULT_BADGE = { color: "bg-gray-800 text-gray-300 border-gray-700", icon: <HelpCircle size={12} /> };

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffSec = Math.floor((now - then) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

function ToolInputPreview({ toolName, toolInput }: { toolName: string; toolInput: string }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any;
  try {
    parsed = JSON.parse(toolInput);
  } catch {
    return <pre className="text-xs text-gray-400 whitespace-pre-wrap break-all">{toolInput}</pre>;
  }

  const str = (v: unknown): string => (v == null ? "" : String(v));

  // Bash: show the command
  if (toolName === "Bash" && typeof parsed.command === "string") {
    const desc = str(parsed.description);
    return (
      <div>
        <div className="text-xs text-gray-500 mb-1">Command:</div>
        <pre className="text-xs text-gray-200 bg-gray-950 rounded p-2 whitespace-pre-wrap break-words border border-gray-800 font-mono max-h-40 overflow-y-auto">
          {parsed.command}
        </pre>
        {desc && (
          <div className="text-xs text-gray-500 mt-1 italic">{desc}</div>
        )}
      </div>
    );
  }

  // Edit: show file path and old/new strings
  if (toolName === "Edit" && typeof parsed.file_path === "string") {
    const oldStr = str(parsed.old_string);
    const newStr = str(parsed.new_string);
    return (
      <div className="space-y-1">
        <div className="text-xs">
          <span className="text-gray-500">File: </span>
          <span className="text-blue-300 font-mono">{parsed.file_path}</span>
        </div>
        {oldStr && (
          <div>
            <div className="text-xs text-red-400 mb-0.5">- Old:</div>
            <pre className="text-xs text-red-300/80 bg-red-950/20 rounded p-1.5 whitespace-pre-wrap break-words border border-red-900/30 font-mono max-h-24 overflow-y-auto">
              {oldStr}
            </pre>
          </div>
        )}
        {newStr && (
          <div>
            <div className="text-xs text-green-400 mb-0.5">+ New:</div>
            <pre className="text-xs text-green-300/80 bg-green-950/20 rounded p-1.5 whitespace-pre-wrap break-words border border-green-900/30 font-mono max-h-24 overflow-y-auto">
              {newStr}
            </pre>
          </div>
        )}
      </div>
    );
  }

  // Write: show file path and content preview
  if (toolName === "Write" && typeof parsed.file_path === "string") {
    const content = str(parsed.content);
    return (
      <div className="space-y-1">
        <div className="text-xs">
          <span className="text-gray-500">File: </span>
          <span className="text-purple-300 font-mono">{parsed.file_path}</span>
        </div>
        {content && (
          <pre className="text-xs text-gray-300 bg-gray-950 rounded p-1.5 whitespace-pre-wrap break-words border border-gray-800 font-mono max-h-32 overflow-y-auto">
            {content.substring(0, 500)}
            {content.length > 500 ? "\n... (truncated)" : ""}
          </pre>
        )}
      </div>
    );
  }

  // Default: pretty-print JSON
  return (
    <pre className="text-xs text-gray-300 bg-gray-950 rounded p-2 whitespace-pre-wrap break-words border border-gray-800 font-mono max-h-48 overflow-y-auto">
      {JSON.stringify(parsed, null, 2)}
    </pre>
  );
}

function PermissionCard({
  perm,
  agentName,
  onResolve,
}: {
  perm: PermissionReq;
  agentName?: string;
  onResolve: (id: number, decision: "approved" | "denied") => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [resolving, setResolving] = useState(false);

  const badge = TOOL_BADGES[perm.tool_name] || DEFAULT_BADGE;

  // Generate a short summary for collapsed view
  let summary = "";
  try {
    const parsed = JSON.parse(perm.tool_input);
    if (perm.tool_name === "Bash") {
      summary = (parsed.command as string)?.substring(0, 80) || "";
    } else if (perm.tool_name === "Edit" || perm.tool_name === "Write") {
      summary = parsed.file_path || "";
    } else {
      summary = JSON.stringify(parsed).substring(0, 80);
    }
  } catch {
    summary = perm.tool_input.substring(0, 80);
  }
  if (summary.length >= 80) summary += "...";

  const handleResolve = async (decision: "approved" | "denied") => {
    setResolving(true);
    try {
      await api.resolvePermission(perm.id, decision);
      onResolve(perm.id, decision);
    } catch {
      // ignore
    } finally {
      setResolving(false);
    }
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
      {/* Header row */}
      <div className="flex items-center gap-2 px-3 py-2.5">
        {/* Tool badge */}
        <span className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium border ${badge.color}`}>
          {badge.icon}
          {perm.tool_name}
        </span>

        {/* Summary (clickable to expand) */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex-1 text-left text-xs text-gray-400 truncate hover:text-gray-300 min-w-0"
          title="Click to expand"
        >
          {summary}
        </button>

        {/* Timestamp */}
        <span className="flex items-center gap-1 text-xs text-gray-600 shrink-0">
          <Clock size={10} />
          {timeAgo(perm.created_at)}
        </span>

        {/* Expand/Collapse */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-gray-500 hover:text-gray-300 shrink-0"
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>

        {/* Approve/Deny */}
        <div className="flex gap-1 shrink-0 ml-1">
          <button
            onClick={() => handleResolve("approved")}
            disabled={resolving}
            className="p-1.5 bg-green-900/50 hover:bg-green-800/60 text-green-400 rounded disabled:opacity-50"
            title="Approve"
          >
            <Check size={14} />
          </button>
          <button
            onClick={() => handleResolve("denied")}
            disabled={resolving}
            className="p-1.5 bg-red-900/50 hover:bg-red-800/60 text-red-400 rounded disabled:opacity-50"
            title="Deny"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Agent info */}
      <div className="px-3 pb-1 text-xs text-gray-600">
        Agent:{" "}
        <Link to={`/agent/${perm.agent_id}`} className="text-blue-500 hover:text-blue-400">
          {agentName || perm.agent_id}
        </Link>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-gray-800/50">
          <ToolInputPreview toolName={perm.tool_name} toolInput={perm.tool_input} />
        </div>
      )}
    </div>
  );
}

export function PermissionDialog({
  permissions,
  onResolved,
  agentNames,
}: {
  permissions: PermissionReq[];
  onResolved: () => void;
  agentNames?: Record<string, string>;
}) {
  if (permissions.length === 0) return null;

  return (
    <div className="bg-amber-950/30 border border-amber-800/50 rounded-lg p-4">
      <h3 className="flex items-center gap-2 text-sm font-medium text-amber-300 mb-3">
        <ShieldQuestion size={16} />
        Pending Approvals ({permissions.length})
      </h3>
      <div className="space-y-2">
        {permissions.map((perm) => (
          <PermissionCard
            key={perm.id}
            perm={perm}
            agentName={agentNames?.[perm.agent_id]}
            onResolve={() => onResolved()}
          />
        ))}
      </div>
    </div>
  );
}
