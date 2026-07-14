import { useState, useEffect, useCallback } from "react";
import { Key, Copy, Check, Trash2, Plus } from "lucide-react";
import { api, type ApiTokenSummary } from "../api";

const ALL_SCOPES = ["mcp", "agent:create", "agent:read", "agent:control", "review:create", "review:read"] as const;

export function TokensPanel() {
  const [tokens, setTokens] = useState<ApiTokenSummary[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Set<string>>(new Set(ALL_SCOPES));
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    api.listTokens().then(setTokens).catch(() => {});
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const toggleScope = (s: string) =>
    setScopes((prev) => {
      const next = new Set(prev);
      next.has(s) ? next.delete(s) : next.add(s);
      return next;
    });

  const create = async () => {
    setError("");
    if (!scopes.size) { setError("Pick at least one scope."); return; }
    try {
      const res = await api.createToken(name.trim() || "api token", [...scopes]);
      setFreshToken(res.token);
      setCopied(false);
      setName("");
      setShowForm(false);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create token");
    }
  };

  const revoke = async (id: string) => {
    if (!confirm("Revoke this token? Anything using it stops working immediately.")) return;
    await api.revokeToken(id).catch(() => {});
    refresh();
  };

  const copy = () => {
    if (!freshToken) return;
    navigator.clipboard?.writeText(freshToken).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {});
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="flex items-center gap-2 text-lg font-medium text-gray-200">
          <Key size={20} />
          API Tokens
        </h2>
        <button
          onClick={() => { setShowForm((v) => !v); setError(""); }}
          className="flex items-center gap-1 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded px-3 py-1.5"
        >
          <Plus size={14} /> New token
        </button>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        Headless auth for agents driving the MCP surface (<code className="text-gray-400">/daboss/mcp</code>).
        Send as <code className="text-gray-400">Authorization: Bearer &lt;token&gt;</code>. Scoped, attributed to you, and revocable.
      </p>

      {/* freshly-minted token — shown ONCE */}
      {freshToken && (
        <div className="bg-amber-900/20 border border-amber-700/50 rounded-lg p-4 mb-4">
          <div className="text-amber-300 text-sm font-medium mb-2">
            Copy this now — it's shown once and can't be retrieved again.
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-gray-950 border border-gray-800 rounded px-3 py-2 text-gray-100 text-sm font-mono break-all">{freshToken}</code>
            <button onClick={copy} className="shrink-0 flex items-center gap-1 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded px-3 py-2 text-sm">
              {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <button onClick={() => setFreshToken(null)} className="text-xs text-gray-500 hover:text-gray-400 mt-2">Dismiss</button>
        </div>
      )}

      {/* create form */}
      {showForm && (
        <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-4 mb-4 space-y-3">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Token name (e.g. security-eval-agent)"
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-100 text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
          <div className="flex flex-wrap gap-3">
            {ALL_SCOPES.map((s) => (
              <label key={s} className="flex items-center gap-2 text-sm text-gray-300">
                <input type="checkbox" checked={scopes.has(s)} onChange={() => toggleScope(s)} className="rounded bg-gray-800 border-gray-700" />
                <code className="text-gray-400">{s}</code>
              </label>
            ))}
          </div>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <div className="flex gap-2">
            <button onClick={create} className="bg-blue-600 hover:bg-blue-500 text-white rounded px-4 py-1.5 text-sm">Create</button>
            <button onClick={() => { setShowForm(false); setError(""); }} className="text-gray-400 hover:text-gray-300 text-sm px-2">Cancel</button>
          </div>
        </div>
      )}

      {/* token list */}
      {tokens.length === 0 ? (
        <p className="text-sm text-gray-600">No tokens yet.</p>
      ) : (
        <div className="space-y-2">
          {tokens.map((t) => (
            <div key={t.id} className={`flex items-center justify-between rounded border px-3 py-2 text-sm ${t.revoked_at ? "bg-gray-900 border-gray-800 opacity-50" : "bg-gray-800/40 border-gray-700"}`}>
              <div className="min-w-0">
                <span className="text-gray-200">{t.name || t.id}</span>
                {t.revoked_at && <span className="ml-2 text-xs uppercase text-red-400 border border-red-800 rounded px-1">revoked</span>}
                <div className="text-xs text-gray-500 mt-0.5">
                  <code>{t.scopes || "—"}</code>
                  <span className="mx-2">·</span>
                  {t.last_used_at ? `last used ${new Date(t.last_used_at).toLocaleDateString()}` : "never used"}
                </div>
              </div>
              {!t.revoked_at && (
                <button onClick={() => revoke(t.id)} title="Revoke" className="shrink-0 text-gray-500 hover:text-red-400 p-1">
                  <Trash2 size={16} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
