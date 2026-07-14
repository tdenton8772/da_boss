import { useState, useEffect } from "react";
import { KeyRound } from "lucide-react";
import { api } from "../api";
import { useToastHelpers } from "./Toast";

interface CredStatus {
  hasCredential: boolean;
  kind: string | null;
  updatedAt: string | null;
}

export function CredentialPanel() {
  const toast = useToastHelpers();
  const [status, setStatus] = useState<CredStatus | null>(null);
  const [kind, setKind] = useState("claude_oauth_token");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);

  const refresh = () => api.credentialStatus().then(setStatus).catch(() => {});
  useEffect(() => {
    refresh();
  }, []);

  const save = async () => {
    if (!token.trim()) return;
    setSaving(true);
    try {
      await api.setCredential(kind, token.trim());
      setToken("");
      toast.success("Credential saved (encrypted)");
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save credential");
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    try {
      await api.deleteCredential();
      toast.success("Credential removed");
      refresh();
    } catch {
      toast.error("Failed to remove credential");
    }
  };

  const inputCls =
    "w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500";

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
      <h2 className="text-lg font-semibold text-gray-100 mb-2 flex items-center gap-2">
        <KeyRound size={18} /> Claude Credential
      </h2>
      <p className="text-gray-400 text-sm mb-4">
        Your agents run on <span className="text-gray-200">your own</span> Claude token, so usage bills to you.
        Generate a long-lived token with <code className="text-blue-400">claude setup-token</code> (or use an{" "}
        <code className="text-blue-400">sk-ant-</code> API key). It's stored encrypted and never shown again.
      </p>

      {status?.hasCredential ? (
        <div className="text-sm text-green-400 mb-4">
          ✓ {status.kind} on file
          {status.updatedAt ? ` — updated ${new Date(status.updatedAt).toLocaleString()}` : ""}
        </div>
      ) : (
        <div className="text-sm text-yellow-400 mb-4">
          No credential set — agents you dispatch can't call Claude until you add one.
        </div>
      )}

      <div className="space-y-3">
        <select value={kind} onChange={(e) => setKind(e.target.value)} className={inputCls}>
          <option value="claude_oauth_token">Claude OAuth token (claude setup-token)</option>
          <option value="anthropic_api_key">Anthropic API key (sk-ant-…)</option>
        </select>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Paste your token…"
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
