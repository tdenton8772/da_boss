import { useState, useEffect } from "react";
import { Cpu, RefreshCw, RotateCcw, Save } from "lucide-react";
import { api, type ModelChoice, type ModelsInfo } from "../api";
import { useToastHelpers } from "./Toast";
import { ModelSelect, EffortSelect, effortLevelsFor } from "./ModelPicker";

const CELL = "w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-100 text-xs disabled:opacity-50 focus:outline-none focus:border-blue-500";

/**
 * Admin: which model + effort each part of da_boss runs on, picked from the
 * discovered catalog. Renders nothing for non-admins (the endpoints are admin-only).
 */
export function ModelDefaultsPanel() {
  const [info, setInfo] = useState<ModelsInfo | null>(null);
  const [draft, setDraft] = useState<Record<string, ModelChoice>>({});
  const [busy, setBusy] = useState<"" | "save" | "refresh" | "reset">("");
  const [isAdmin, setIsAdmin] = useState(false);
  const { success, error } = useToastHelpers();

  const load = () =>
    api.getModels().then((i) => { setInfo(i); setDraft(i.defaults); }).catch(() => {});
  useEffect(() => {
    api.me().then((res) => {
      if (res.user?.role === "admin") { setIsAdmin(true); void load(); }
    }).catch(() => {});
  }, []);

  const run = async (kind: "save" | "refresh" | "reset", fn: () => Promise<unknown>, done: string) => {
    setBusy(kind);
    try { await fn(); success(done); await load(); }
    catch (e) { error(e instanceof Error ? e.message : "Failed"); }
    finally { setBusy(""); }
  };

  if (!isAdmin || !info) return null;

  const set = (role: string, patch: Partial<ModelChoice>) =>
    setDraft((d) => {
      const next = { ...d[role], ...patch };
      // a model change drops an effort the new model can't take
      if (patch.model !== undefined && next.effort && !effortLevelsFor(info, next.model).includes(next.effort)) next.effort = null;
      return { ...d, [role]: next };
    });

  const catalogNote = info.source === "live"
    ? `${info.models.length} models discovered ${info.fetched_at ? new Date(info.fetched_at).toLocaleString() : ""}${info.sdk_version ? ` · Agent SDK ${info.sdk_version}` : ""}`
    : "Not discovered yet — showing family aliases only. Set a supervisor credential, then Refresh.";

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h2 className="flex items-center gap-2 text-lg font-medium text-gray-200">
          <Cpu size={20} /> Models &amp; Effort
        </h2>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => run("refresh", api.refreshModels, "Model catalog refreshed")} disabled={!!busy}
            className="flex items-center gap-1 text-sm bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-200 rounded px-3 py-1.5">
            <RefreshCw size={14} className={busy === "refresh" ? "animate-spin" : ""} /> Refresh catalog
          </button>
          <button onClick={() => run("reset", api.resetModelDefaults, "Model defaults reset to deployment defaults")} disabled={!!busy}
            className="flex items-center gap-1 text-sm bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-200 rounded px-3 py-1.5">
            <RotateCcw size={14} /> Reset
          </button>
          <button onClick={() => run("save", () => api.saveModelDefaults(draft), "Model defaults saved — applies to new agents and calls")} disabled={!!busy}
            className="flex items-center gap-1 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white rounded px-3 py-1.5">
            <Save size={14} /> {busy === "save" ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      <p className="text-sm text-gray-500 mb-1">
        The model and reasoning effort each part of da_boss uses. "Latest" choices are family aliases that
        move to each new release automatically; pin a version only when you need one.
      </p>
      <p className={`text-xs mb-4 ${info.error ? "text-amber-400" : "text-gray-600"}`}>
        {catalogNote}{info.error ? ` · Last refresh failed: ${info.error}` : ""}
      </p>
      <div className="overflow-x-auto">
        <table className="text-sm text-gray-300 w-full">
          <thead>
            <tr className="text-xs text-gray-500 border-b border-gray-800">
              <th className="text-left py-2 pr-4">Used for</th>
              <th className="text-left px-2 min-w-[11rem]">Model</th>
              <th className="text-left px-2 min-w-[8rem]">Effort</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(info.roles).map(([role, meta]) => {
              const c = draft[role] ?? { model: null, effort: null };
              return (
                <tr key={role} className="border-b border-gray-800/50 align-top">
                  <td className="py-2 pr-4">
                    <div className="text-gray-200">{meta.label}</div>
                    <div className="text-xs text-gray-500">{meta.description}</div>
                  </td>
                  <td className="px-2 py-2">
                    <ModelSelect info={info} value={c.model} className={CELL}
                      inheritLabel={meta.inheritable ? "Inherit" : undefined}
                      onChange={(model) => set(role, { model })} />
                  </td>
                  <td className="px-2 py-2">
                    <EffortSelect info={info} model={c.model ?? info.defaults.agent?.model ?? null} value={c.effort} className={CELL}
                      onChange={(effort) => set(role, { effort })} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
