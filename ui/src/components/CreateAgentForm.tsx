import { useState, useEffect } from "react";
import { api, type CreateAgentData, type AgentTemplate } from "../api";
import { X, FolderOpen, LayoutTemplate } from "lucide-react";
import { DirPicker } from "./DirPicker";

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
    model: "claude-sonnet-4-6",
  });
  const [autoStart, setAutoStart] = useState(true);
  const [showDirPicker, setShowDirPicker] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<AgentTemplate | null>(null);

  useEffect(() => {
    api.getTemplates().then(setTemplates).catch(() => {});
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
    setSubmitting(true);
    try {
      const agent = (await api.createAgent(form)) as { id: string };
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
                    setForm({ name: "", prompt: "", cwd: "", priority: "medium", model: "claude-sonnet-4-6" });
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
            <label className="block text-sm text-gray-400 mb-1">Working Directory</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={form.cwd}
                onChange={(e) => setForm((f) => ({ ...f, cwd: e.target.value }))}
                className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-100 text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono"
                placeholder="/path/to/repo"
                required
              />
              <button
                type="button"
                onClick={() => setShowDirPicker(!showDirPicker)}
                className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded"
                title="Browse"
              >
                <FolderOpen size={16} />
              </button>
            </div>
            {showDirPicker && (
              <div className="mt-2">
                <DirPicker
                  value={form.cwd}
                  onChange={(path) => setForm((f) => ({ ...f, cwd: path }))}
                  onClose={() => setShowDirPicker(false)}
                />
              </div>
            )}
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
                <option value="claude-sonnet-4-6">Sonnet 4.6</option>
                <option value="claude-opus-4-6">Opus 4.6</option>
                <option value="claude-haiku-4-5-20251001">Haiku 4.5</option>
              </select>
            </div>
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
