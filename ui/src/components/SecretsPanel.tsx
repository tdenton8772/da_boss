import { useState, useEffect } from "react";
import { KeySquare } from "lucide-react";
import { api } from "../api";
import { useToastHelpers } from "./Toast";

/**
 * Named secrets for pipeline phases (deploy creds, cloud keys, etc.) — the same
 * vault as your Claude/git tokens, extended to arbitrary named secrets that a
 * pipeline phase pulls in via `requires`. Write-only.
 */
export function SecretsPanel() {
  const toast = useToastHelpers();
  const [names, setNames] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  const refresh = () => api.listSecrets().then(setNames).catch(() => {});
  useEffect(() => { refresh(); }, []);

  const inputCls = "w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono text-sm";

  const save = async () => {
    if (!name.trim() || !value.trim()) return;
    setSaving(true);
    try {
      await api.setSecret(name.trim(), value);
      toast.success(`Secret '${name.trim()}' saved (encrypted)`);
      setName(""); setValue("");
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save secret");
    } finally { setSaving(false); }
  };

  const del = async (n: string) => {
    try { await api.deleteSecret(n); toast.success(`Removed '${n}'`); refresh(); }
    catch { toast.error("Failed to remove"); }
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
      <h2 className="text-lg font-semibold text-gray-100 mb-2 flex items-center gap-2">
        <KeySquare size={18} /> Pipeline Secrets
      </h2>
      <p className="text-gray-400 text-sm mb-4">
        Named secrets a pipeline phase pulls in via <code className="text-blue-400">requires</code> (e.g. a
        cloud service-account key). Injected as env (<code className="text-blue-400">gcp-sa</code> →{" "}
        <code className="text-blue-400">$GCP_SA</code>). Encrypted; never shown again.
      </p>

      {names.length > 0 && (
        <div className="mb-4 space-y-1">
          {names.map((n) => (
            <div key={n} className="flex items-center justify-between text-sm">
              <span className="text-green-400 font-mono">✓ {n}</span>
              <button onClick={() => del(n)} className="text-gray-500 hover:text-red-400 text-xs">remove</button>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <input className={inputCls} placeholder="name (e.g. gcp-sa)" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        <textarea className={`${inputCls} h-20 resize-y`} placeholder="value…" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" />
        <button onClick={save} disabled={saving || !name.trim() || !value.trim()}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded px-4 py-2">
          {saving ? "Saving…" : "Save secret"}
        </button>
      </div>
    </div>
  );
}
