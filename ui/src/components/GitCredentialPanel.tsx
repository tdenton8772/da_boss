import { useState, useEffect } from "react";
import { GitBranch } from "lucide-react";
import { api } from "../api";
import { useToastHelpers } from "./Toast";

export function GitCredentialPanel() {
  const toast = useToastHelpers();
  const [status, setStatus] = useState<{ hasCredential: boolean; updatedAt: string | null } | null>(null);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);

  const refresh = () => api.gitCredentialStatus().then(setStatus).catch(() => {});
  useEffect(() => {
    refresh();
  }, []);

  const save = async () => {
    if (!token.trim()) return;
    setSaving(true);
    try {
      await api.setGitCredential(token.trim());
      setToken("");
      toast.success("Git token saved (encrypted)");
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save git token");
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    try {
      await api.deleteGitCredential();
      toast.success("Git token removed");
      refresh();
    } catch {
      toast.error("Failed to remove git token");
    }
  };

  const inputCls =
    "w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500";

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
      <h2 className="text-lg font-semibold text-gray-100 mb-2 flex items-center gap-2">
        <GitBranch size={18} /> Git Credential
      </h2>
      <p className="text-gray-400 text-sm mb-3">
        Run <code className="text-blue-400">gh auth token</code> in your terminal and paste it here.
        Your agents clone private repos and push their branch <span className="text-gray-200">as you</span>.
        Stored encrypted; never shown again. (A fine-grained PAT with repo scope works too.)
      </p>
      <div className="mb-4 flex items-center gap-2 bg-gray-800 border border-gray-700 rounded px-3 py-2">
        <code className="text-gray-300 text-sm flex-1">gh auth token</code>
        <button
          type="button"
          onClick={() => navigator.clipboard?.writeText("gh auth token")}
          className="text-xs text-gray-400 hover:text-gray-200"
        >
          copy
        </button>
      </div>

      {status?.hasCredential ? (
        <div className="text-sm text-green-400 mb-4">
          ✓ git token on file
          {status.updatedAt ? ` — updated ${new Date(status.updatedAt).toLocaleString()}` : ""}
        </div>
      ) : (
        <div className="text-sm text-gray-500 mb-4">
          No git token — agents can still work on public repos, but not private ones.
        </div>
      )}

      <div className="space-y-3">
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="gho_… (from gh auth token)"
          className={inputCls}
          autoComplete="off"
        />
        <div className="flex gap-2">
          <button
            onClick={save}
            disabled={saving || !token.trim()}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded px-4 py-2"
          >
            {saving ? "Saving…" : status?.hasCredential ? "Replace" : "Save"}
          </button>
          {status?.hasCredential && (
            <button
              onClick={clear}
              className="bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm rounded px-4 py-2"
            >
              Remove
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
