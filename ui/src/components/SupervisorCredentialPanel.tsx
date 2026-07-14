import { useState, useEffect } from "react";
import { Bot } from "lucide-react";
import { api } from "../api";
import { useToastHelpers } from "./Toast";

/**
 * Admin control for which user's Claude token powers the headless supervisor.
 * Renders nothing for non-admins. Supervision bills to the designated user, so
 * this is a deliberate, visible choice — and it degrades to rules-only (not
 * silently) if unset or the user is offboarded.
 */
export function SupervisorCredentialPanel() {
  const toast = useToastHelpers();
  const [isAdmin, setIsAdmin] = useState(false);
  const [status, setStatus] = useState<{ userId: string | null; email: string | null; hasCredential: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => api.getSupervisorCredential().then(setStatus).catch(() => {});

  useEffect(() => {
    api.me().then((res) => {
      if (res.user?.role === "admin") {
        setIsAdmin(true);
        refresh();
      }
    }).catch(() => {});
  }, []);

  if (!isAdmin) return null;

  const useMine = async () => {
    setBusy(true);
    try {
      await api.setSupervisorCredential(); // defaults to the calling admin
      toast.success("Supervisor will use your Claude credential");
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to set supervisor credential");
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      await api.clearSupervisorCredential();
      toast.success("Supervisor credential cleared — running rules-only");
      refresh();
    } catch {
      toast.error("Failed to clear");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
      <h2 className="text-lg font-semibold text-gray-100 mb-2 flex items-center gap-2">
        <Bot size={18} /> Supervisor Credential
      </h2>
      <p className="text-gray-400 text-sm mb-4">
        The background supervisor evaluates idle/blocked agents with Claude. It has no
        identity of its own, so it runs on a designated user's token —{" "}
        <span className="text-gray-200">usage bills to that user</span>. Without one it
        falls back to rules only (no auto-evaluation).
      </p>

      {status?.userId ? (
        status.hasCredential ? (
          <div className="text-sm text-green-400 mb-4">✓ Running on {status.email || status.userId}</div>
        ) : (
          <div className="text-sm text-red-400 mb-4">
            ⚠ Set to {status.email || status.userId}, but they have no Claude credential — supervisor is rules-only.
          </div>
        )
      ) : (
        <div className="text-sm text-yellow-400 mb-4">Not configured — supervisor runs rules-only.</div>
      )}

      <div className="flex gap-2">
        <button
          onClick={useMine}
          disabled={busy}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded px-4 py-2"
        >
          Use my credential
        </button>
        {status?.userId && (
          <button
            onClick={clear}
            disabled={busy}
            className="bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm rounded px-4 py-2"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
