import { useState } from "react";
import { Link } from "react-router";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
  MessageCircleQuestion,
  Send,
  ClipboardCheck,
} from "lucide-react";

// Tool category badges
const TOOL_BADGES: Record<string, { color: string; icon: React.ReactNode }> = {
  Bash: { color: "bg-orange-900/50 text-orange-300 border-orange-800/50", icon: <Terminal size={12} /> },
  Edit: { color: "bg-blue-900/50 text-blue-300 border-blue-800/50", icon: <FileEdit size={12} /> },
  Write: { color: "bg-purple-900/50 text-purple-300 border-purple-800/50", icon: <FileText size={12} /> },
  NotebookEdit: { color: "bg-purple-900/50 text-purple-300 border-purple-800/50", icon: <FileText size={12} /> },
  WebFetch: { color: "bg-green-900/50 text-green-300 border-green-800/50", icon: <Globe size={12} /> },
  WebSearch: { color: "bg-green-900/50 text-green-300 border-green-800/50", icon: <Globe size={12} /> },
  AskUserQuestion: { color: "bg-cyan-900/50 text-cyan-300 border-cyan-800/50", icon: <MessageCircleQuestion size={12} /> },
  ExitPlanMode: { color: "bg-indigo-900/50 text-indigo-300 border-indigo-800/50", icon: <ClipboardCheck size={12} /> },
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

interface AskQuestion {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

function AskUserQuestionCard({
  perm,
  agentName,
  onResolve,
}: {
  perm: PermissionReq;
  agentName?: string;
  onResolve: (id: number, decision: "approved" | "denied") => void;
}) {
  const [selectedOptions, setSelectedOptions] = useState<Record<number, Set<number>>>({});
  const [customAnswers, setCustomAnswers] = useState<Record<number, string>>({});
  const [submitting, setSubmitting] = useState(false);

  let questions: AskQuestion[] = [];
  try {
    const parsed = JSON.parse(perm.tool_input);
    questions = parsed.questions || [];
  } catch {
    questions = [];
  }

  const toggleOption = (qIdx: number, optIdx: number, multiSelect: boolean) => {
    setSelectedOptions((prev) => {
      const current = prev[qIdx] || new Set<number>();
      const next = new Set(current);
      if (multiSelect) {
        if (next.has(optIdx)) next.delete(optIdx);
        else next.add(optIdx);
      } else {
        if (next.has(optIdx)) next.clear();
        else { next.clear(); next.add(optIdx); }
      }
      return { ...prev, [qIdx]: next };
    });
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      // Build a combined answer string from all questions
      const answers: string[] = [];
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const selected = selectedOptions[i] || new Set<number>();
        const custom = customAnswers[i]?.trim();
        const parts: string[] = [];

        if (selected.size > 0 && q.options) {
          for (const idx of selected) {
            parts.push(q.options[idx]?.label || `Option ${idx + 1}`);
          }
        }
        if (custom) parts.push(custom);

        if (parts.length > 0) {
          const prefix = questions.length > 1 ? `${q.header || q.question}: ` : "";
          answers.push(`${prefix}${parts.join(", ")}`);
        }
      }

      const answer = answers.join("\n") || "No answer provided";
      await api.resolvePermission(perm.id, "approved", answer);
      onResolve(perm.id, "approved");
    } catch {
      // ignore
    } finally {
      setSubmitting(false);
    }
  };

  const badge = TOOL_BADGES.AskUserQuestion;

  return (
    <div className="bg-gray-900 border border-cyan-800/50 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-gray-800/50">
        <span className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium border ${badge.color}`}>
          {badge.icon}
          Question
        </span>
        <span className="flex-1 text-sm text-cyan-200 font-medium">Agent needs your input</span>
        <span className="text-xs text-gray-600">
          Agent:{" "}
          <Link to={`/agent/${perm.agent_id}`} className="text-blue-500 hover:text-blue-400">
            {agentName || perm.agent_id}
          </Link>
        </span>
      </div>

      {/* Questions */}
      <div className="px-3 py-3 space-y-4">
        {questions.map((q, qIdx) => (
          <div key={qIdx}>
            {q.header && (
              <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">{q.header}</div>
            )}
            <div className="text-sm text-gray-200 mb-2">{q.question}</div>

            {/* Options */}
            {q.options && q.options.length > 0 && (
              <div className="space-y-1.5 mb-2">
                {q.options.map((opt, optIdx) => {
                  const isSelected = selectedOptions[qIdx]?.has(optIdx) ?? false;
                  return (
                    <button
                      key={optIdx}
                      onClick={() => toggleOption(qIdx, optIdx, !!q.multiSelect)}
                      className={`w-full text-left px-3 py-2 rounded border text-sm transition-colors ${
                        isSelected
                          ? "bg-cyan-900/40 border-cyan-600 text-cyan-200"
                          : "bg-gray-800/50 border-gray-700 text-gray-300 hover:border-gray-600 hover:bg-gray-800"
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <div className={`mt-0.5 w-4 h-4 rounded${q.multiSelect ? "" : "-full"} border flex items-center justify-center shrink-0 ${
                          isSelected ? "border-cyan-500 bg-cyan-600" : "border-gray-600"
                        }`}>
                          {isSelected && <Check size={10} className="text-white" />}
                        </div>
                        <div className="min-w-0">
                          <div className="font-medium">{opt.label}</div>
                          {opt.description && (
                            <div className="text-xs text-gray-500 mt-0.5">{opt.description}</div>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Custom text input (always shown — "Other" option) */}
            <div className="flex gap-2">
              <input
                type="text"
                value={customAnswers[qIdx] || ""}
                onChange={(e) => setCustomAnswers((prev) => ({ ...prev, [qIdx]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); } }}
                placeholder="Type a custom answer..."
                className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-cyan-600"
              />
            </div>
          </div>
        ))}

        {/* Submit button */}
        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={async () => {
              setSubmitting(true);
              try {
                await api.resolvePermission(perm.id, "denied");
                onResolve(perm.id, "denied");
              } catch {} finally { setSubmitting(false); }
            }}
            disabled={submitting}
            className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 text-sm rounded disabled:opacity-50"
          >
            Skip
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-cyan-700 hover:bg-cyan-600 text-white text-sm rounded font-medium disabled:opacity-50"
          >
            <Send size={14} />
            {submitting ? "Sending..." : "Answer"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ExitPlanModeCard({
  perm,
  agentName,
  onResolve,
}: {
  perm: PermissionReq;
  agentName?: string;
  onResolve: (id: number, decision: "approved" | "denied") => void;
}) {
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Extract plan content from tool input
  let planContent = "";
  try {
    const parsed = JSON.parse(perm.tool_input);
    planContent = parsed.plan || "";
  } catch {
    planContent = "";
  }

  const badge = TOOL_BADGES.ExitPlanMode;

  const handleApprove = async () => {
    setSubmitting(true);
    try {
      await api.resolvePermission(perm.id, "approved", feedback.trim() || undefined);
      onResolve(perm.id, "approved");
    } catch {} finally { setSubmitting(false); }
  };

  const handleReject = async () => {
    setSubmitting(true);
    try {
      await api.resolvePermission(perm.id, "denied", feedback.trim() || "Plan rejected — please revise.");
      onResolve(perm.id, "denied");
    } catch {} finally { setSubmitting(false); }
  };

  return (
    <div className="bg-gray-900 border border-indigo-800/50 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-gray-800/50">
        <span className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium border ${badge.color}`}>
          {badge.icon}
          Plan Review
        </span>
        <span className="flex-1 text-sm text-indigo-200 font-medium">
          Agent has a plan ready for approval
        </span>
        <span className="text-xs text-gray-600">
          Agent:{" "}
          <Link to={`/agent/${perm.agent_id}`} className="text-blue-500 hover:text-blue-400">
            {agentName || perm.agent_id}
          </Link>
        </span>
      </div>

      <div className="px-3 py-3 space-y-3">
        {/* Plan content rendered as markdown */}
        {planContent ? (
          <div className="max-h-96 overflow-y-auto bg-gray-950 border border-gray-800 rounded-lg p-4 prose prose-invert prose-sm max-w-none
            prose-headings:text-gray-200 prose-headings:mt-3 prose-headings:mb-1
            prose-p:my-1.5 prose-p:text-gray-300
            prose-a:text-blue-400
            prose-strong:text-gray-200
            prose-code:text-green-400 prose-code:bg-gray-800 prose-code:px-1 prose-code:rounded prose-code:text-xs
            prose-pre:bg-gray-800 prose-pre:border prose-pre:border-gray-700 prose-pre:rounded prose-pre:text-xs
            prose-li:text-gray-300 prose-li:my-0.5
            prose-ul:my-1 prose-ol:my-1
            prose-hr:border-gray-700">
            <Markdown remarkPlugins={[remarkGfm]}>{planContent}</Markdown>
          </div>
        ) : (
          <p className="text-xs text-gray-400">
            Review the agent's plan in the message stream below.
          </p>
        )}

        {/* Feedback input */}
        <div>
          <label className="block text-xs text-gray-400 mb-1">Feedback (required for rejection, optional for approval)</label>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="e.g. 'Use a different approach for auth' or 'Looks good, but also add error handling for...'"
            rows={3}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-indigo-600 resize-y"
          />
        </div>

        {/* Approve / Reject */}
        <div className="flex justify-end gap-2">
          <button
            onClick={handleReject}
            disabled={submitting}
            className="flex items-center gap-1.5 px-4 py-2 bg-red-900/40 hover:bg-red-800/50 text-red-300 text-sm rounded border border-red-800/50 disabled:opacity-50"
          >
            <X size={14} />
            Reject & Revise
          </button>
          <button
            onClick={handleApprove}
            disabled={submitting}
            className="flex items-center gap-1.5 px-5 py-2 bg-green-700 hover:bg-green-600 text-white text-sm rounded font-medium disabled:opacity-50"
          >
            <Check size={14} />
            {submitting ? "..." : "Approve Plan"}
          </button>
        </div>
      </div>
    </div>
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
        {permissions.map((perm) =>
          perm.tool_name === "AskUserQuestion" ? (
            <AskUserQuestionCard
              key={perm.id}
              perm={perm}
              agentName={agentNames?.[perm.agent_id]}
              onResolve={() => onResolved()}
            />
          ) : perm.tool_name === "ExitPlanMode" ? (
            <ExitPlanModeCard
              key={perm.id}
              perm={perm}
              agentName={agentNames?.[perm.agent_id]}
              onResolve={() => onResolved()}
            />
          ) : (
            <PermissionCard
              key={perm.id}
              perm={perm}
              agentName={agentNames?.[perm.agent_id]}
              onResolve={() => onResolved()}
            />
          )
        )}
      </div>
    </div>
  );
}
