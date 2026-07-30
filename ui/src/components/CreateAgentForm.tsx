import { useState, useEffect } from "react";
import { api, type CreateAgentData, type AgentTemplate, type ResolvedRef } from "../api";
import { X, GitBranch, Loader, CheckCircle } from "lucide-react";

export function CreateAgentForm({
  onCreated,
  onClose,
}: {
  onCreated: () => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<CreateAgentData>({
    name: "",
    prompt: "",
    cwd: "",
    priority: "medium",
    model: "claude-opus-5",
    repo_url: "",
    repo_ref: "",
    branch_type: "feat",
    issue_id: "",
  });
  const [autoStart, setAutoStart] = useState(true);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<AgentTemplate | null>(null);
  // "Adopt an existing PR/branch": raw input, the resolved head branch, and status.
  const [adopt, setAdopt] = useState("");
  const [resolved, setResolved] = useState<ResolvedRef | null>(null);
  const [adoptError, setAdoptError] = useState("");
  const [resolving, setResolving] = useState(false);

  // Resolve the typed PR/branch reference against the remote. Returns the resolved
  // ref, or null (with adoptError set) if it doesn't validate. No-op when blank.
  const resolveAdopt = async (): Promise<ResolvedRef | null> => {
    const ref = adopt.trim();
    if (!ref) { setResolved(null); setAdoptError(""); return null; }
    if (!form.repo_url?.trim()) { setAdoptError("Enter a Repo URL first."); setResolved(null); return null; }
    setResolving(true);
    setAdoptError("");
    try {
      const r = await api.resolveRef(form.repo_url.trim(), ref);
      setResolved(r);
      return r;
    } catch (err) {
      setResolved(null);
      setAdoptError(err instanceof Error ? err.message : "Couldn't resolve that reference.");
      return null;
    } finally {
      setResolving(false);
    }
  };

  useEffect(() => {
    api.getTemplates().then(setTemplates).catch(() => {});
    // Prefill repo from the admin-configured default (only if the user hasn't typed one).
    api.getSettings().then((s) => {
      if (s.default_repo_url || s.default_repo_ref) {
        setForm((f) => ({
          ...f,
          repo_url: f.repo_url || s.default_repo_url || "",
          repo_ref: f.repo_ref || s.default_repo_ref || "",
        }));
      }
    }).catch(() => {});
  }, []);

  const applyTemplate = (template: AgentTemplate) => {
    setSelectedTemplate(template);
    setForm({
      ...form,
      name: template.name,
      prompt: template.prompt,
      priority: template.priority,
      model: template.model,
      max_turns: template.max_turns || undefined,
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    // If an adopt reference was typed, it must resolve before we can submit —
    // re-resolve if the input changed since the last check (resolved cleared).
    let adoption = resolved;
    if (adopt.trim() && !adoption) {
      adoption = await resolveAdopt();
      if (!adoption) { setError("Fix the 'Adopt existing PR or branch' field before creating."); return; }
    }
    setSubmitting(true);
    try {
      const payload: CreateAgentData = adoption
        ? { ...form, branch: adoption.branch, adopted_ref: adoption.adoptedRef }
        : form;
      const agent = (await api.createAgent(payload)) as { id: string };
      if (autoStart) {
        await api.startAgent(agent.id);
      }
      onCreated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <form
        onSubmit={handleSubmit}
        className="bg-gray-900 border border-gray-800 rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-gray-100">New Agent</h2>
          <button type="button" onClick={onClose} className="text-gray-500 hover:text-gray-300">
            <X size={20} />
          </button>
        </div>

        <div className="space-y-3">
          {/* Template Selector */}
          {templates.length > 0 && (
            <div>
              <label className="block text-sm text-gray-400 mb-2">Template (optional)</label>
              <div className="grid grid-cols-2 gap-2 mb-3">
                {templates.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => applyTemplate(template)}
                    className={`p-2 rounded border text-left text-sm transition-colors ${
                      selectedTemplate?.id === template.id
                        ? "bg-blue-900/30 border-blue-700 text-blue-200"
                        : "bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-600"
                    }`}
                  >
                    <div className="font-medium">{template.name}</div>
                    <div className="text-xs opacity-75 mt-1">{template.description}</div>
                  </button>
                ))}
              </div>
              {selectedTemplate && (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedTemplate(null);
                    setForm({ name: "", prompt: "", cwd: "", priority: "medium", model: "claude-opus-5" });
                  }}
                  className="text-xs text-gray-500 hover:text-gray-400"
                >
                  Clear template
                </button>
              )}
            </div>
          )}
          <Field
            label="Name"
            value={form.name}
            onChange={(v) => setForm((f) => ({ ...f, name: v }))}
            placeholder="auth-refactor"
            required
          />
          <div>
            <label className="block text-sm text-gray-400 mb-1">Prompt</label>
            <textarea
              value={form.prompt}
              onChange={(e) =>
                setForm((f) => ({ ...f, prompt: e.target.value }))
              }
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-100 text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500 h-24 resize-y"
              placeholder="Implement the auth module..."
              required
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">
              Repo URL <span className="text-gray-600">(optional)</span>
            </label>
            <input
              type="text"
              value={form.repo_url}
              onChange={(e) => setForm((f) => ({ ...f, repo_url: e.target.value }))}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-100 text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono"
              placeholder="https://github.com/org/repo.git"
            />
            <div className="flex gap-2 mt-2">
              <input
                type="text"
                value={form.repo_ref}
                onChange={(e) => setForm((f) => ({ ...f, repo_ref: e.target.value }))}
                className="w-40 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-100 text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono"
                placeholder="base ref (main)"
              />
              <select
                value={form.branch_type}
                onChange={(e) => setForm((f) => ({ ...f, branch_type: e.target.value }))}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-2 text-gray-100 text-sm focus:outline-none focus:border-blue-500"
              >
                {["feat", "fix", "chore", "docs", "refactor", "test"].map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              <input
                type="text"
                value={form.issue_id}
                onChange={(e) => setForm((f) => ({ ...f, issue_id: e.target.value }))}
                className="w-28 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-100 text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono"
                placeholder="issue #"
              />
            </div>
            <p className="text-xs text-gray-600 mt-1">
              {resolved ? (
                <>
                  Branch: <code className="text-amber-300">{resolved.branch}</code>{" "}
                  — <span className="text-amber-300">adopted</span>, overrides the computed name above.
                </>
              ) : (
                <>
                  Branch: <code className="text-gray-400">{form.branch_type}/&lt;you&gt;/{form.issue_id ? `${form.issue_id}-` : ""}&lt;name&gt;</code>{" "}
                  — belongs to the work, continued across runs.
                </>
              )}
            </p>

            {/* Adopt an existing PR/branch — a full branch override + findOpenPr */}
            <div className="mt-3 border-t border-gray-800 pt-3">
              <label className="block text-sm text-gray-400 mb-1">
                <GitBranch size={13} className="inline mr-1 -mt-0.5" />
                Adopt existing PR or branch <span className="text-gray-600">(optional)</span>
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={adopt}
                  onChange={(e) => { setAdopt(e.target.value); setResolved(null); setAdoptError(""); }}
                  onBlur={resolveAdopt}
                  className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-100 text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono"
                  placeholder="PR #17, a PR URL, or fix/audit-alerts"
                />
                <button
                  type="button"
                  onClick={resolveAdopt}
                  disabled={resolving || !adopt.trim()}
                  className="px-3 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 border border-gray-700 rounded text-gray-300 text-sm whitespace-nowrap"
                >
                  {resolving ? <Loader size={14} className="animate-spin" /> : "Check"}
                </button>
              </div>
              {resolved && (
                <p className="text-xs text-green-400 mt-1 flex items-center gap-1">
                  <CheckCircle size={12} />
                  {resolved.kind === "pr"
                    ? <>Adopting <span className="font-medium">PR #{resolved.prNumber}</span> → branch <code className="text-green-300">{resolved.branch}</code>{resolved.prTitle ? ` — ${resolved.prTitle}` : ""}</>
                    : <>Adopting branch <code className="text-green-300">{resolved.branch}</code></>}
                </p>
              )}
              {adoptError && <p className="text-xs text-red-400 mt-1">{adoptError}</p>}
              <p className="text-xs text-gray-600 mt-1">
                The agent pushes onto this existing branch instead of creating one. It must push at
                least one commit for PR adoption to take effect (the PR is picked up on push).
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-gray-400 mb-1">
                Priority
              </label>
              <select
                value={form.priority}
                onChange={(e) =>
                  setForm((f) => ({ ...f, priority: e.target.value }))
                }
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-100 text-sm"
              >
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Model</label>
              <select
                value={form.model}
                onChange={(e) =>
                  setForm((f) => ({ ...f, model: e.target.value }))
                }
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-100 text-sm"
              >
                <option value="claude-opus-5">Opus 5 (default — code work)</option>
                <option value="claude-opus-4-8">Opus 4.8</option>
                <option value="claude-fable-5">Fable 5</option>
                <option value="claude-sonnet-5">Sonnet 5</option>
                <option value="claude-haiku-4-5-20251001">Haiku 4.5</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">
              Pod size <span className="text-gray-600">(resources)</span>
            </label>
            <select
              value={form.size || ""}
              onChange={(e) => setForm((f) => ({ ...f, size: e.target.value || undefined }))}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-100 text-sm"
            >
              <option value="">Auto — supervisor sizes it</option>
              <option value="s">S — review, docs, small edits</option>
              <option value="m">M — normal change + tests</option>
              <option value="l">L — builds, dep compiles, apt</option>
              <option value="xl">XL — heavy builds / big suites</option>
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Max Turns"
              type="number"
              value={form.max_turns?.toString() || ""}
              onChange={(v) =>
                setForm((f) => ({
                  ...f,
                  max_turns: v ? parseInt(v) : undefined,
                }))
              }
              placeholder="20"
            />
            <Field
              label="Max Budget ($)"
              type="number"
              value={form.max_budget_usd?.toString() || ""}
              onChange={(v) =>
                setForm((f) => ({
                  ...f,
                  max_budget_usd: v ? parseFloat(v) : undefined,
                }))
              }
              placeholder="5.00"
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-400">
            <input
              type="checkbox"
              checked={autoStart}
              onChange={(e) => setAutoStart(e.target.checked)}
              className="rounded bg-gray-800 border-gray-700"
            />
            Start immediately
          </label>
        </div>

        {error && <p className="text-red-400 text-sm mt-3">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="w-full mt-4 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white font-medium rounded px-4 py-2"
        >
          {submitting ? "Creating..." : "Create Agent"}
        </button>
      </form>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  required,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  type?: string;
}) {
  return (
    <div>
      <label className="block text-sm text-gray-400 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-100 text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500"
        placeholder={placeholder}
        required={required}
      />
    </div>
  );
}
