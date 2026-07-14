import { useState, useEffect } from "react";
import { Boxes, Save } from "lucide-react";
import { api, type SizePreset } from "../api";
import { useToastHelpers } from "./Toast";

const SIZES = ["s", "m", "l", "xl"] as const;
const LABELS: Record<string, string> = { s: "S — review/docs", m: "M — change+tests", l: "L — builds/deps", xl: "XL — heavy builds" };

type Presets = Record<string, SizePreset>;

export function SizePresetsPanel() {
  const [presets, setPresets] = useState<Presets | null>(null);
  const [saving, setSaving] = useState(false);
  const { success, error } = useToastHelpers();

  useEffect(() => { api.getSizePresets().then(setPresets).catch(() => {}); }, []);

  const set = (size: string, path: "requests" | "limits", field: string, value: string) =>
    setPresets((p) => p && ({ ...p, [size]: { ...p[size], [path]: { ...p[size][path], [field]: value } } }));

  const save = async () => {
    if (!presets) return;
    setSaving(true);
    try { await api.saveSizePresets(presets); success("Pod size presets saved — applies to new dispatches"); }
    catch (e) { error(e instanceof Error ? e.message : "Save failed"); }
    finally { setSaving(false); }
  };

  if (!presets) return null;

  const cell = (v: string, on: (s: string) => void) => (
    <input value={v} onChange={(e) => on(e.target.value)}
      className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-100 text-xs font-mono focus:outline-none focus:border-blue-500" />
  );

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="flex items-center gap-2 text-lg font-medium text-gray-200">
          <Boxes size={20} /> Pod Sizes
        </h2>
        <button onClick={save} disabled={saving}
          className="flex items-center gap-1 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white rounded px-3 py-1.5">
          <Save size={14} /> {saving ? "Saving…" : "Save"}
        </button>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        Resource presets the supervisor applies per t-shirt size. Kubernetes quantities
        (e.g. <code className="text-gray-400">500m</code>, <code className="text-gray-400">2Gi</code>). Applies to new dispatches.
      </p>
      <div className="overflow-x-auto">
        <table className="text-sm text-gray-300 w-full">
          <thead>
            <tr className="text-xs text-gray-500 border-b border-gray-800">
              <th className="text-left py-2 pr-4">Size</th>
              <th className="text-left px-2">cpu req</th>
              <th className="text-left px-2">mem req</th>
              <th className="text-left px-2">mem limit</th>
              <th className="text-left px-2">disk req</th>
              <th className="text-left px-2">disk limit</th>
            </tr>
          </thead>
          <tbody>
            {SIZES.map((s) => {
              const p = presets[s];
              if (!p) return null;
              return (
                <tr key={s} className="border-b border-gray-800/50">
                  <td className="py-2 pr-4 text-gray-200 whitespace-nowrap">{LABELS[s]}</td>
                  <td className="px-2 py-1">{cell(p.requests.cpu, (v) => set(s, "requests", "cpu", v))}</td>
                  <td className="px-2 py-1">{cell(p.requests.memory, (v) => set(s, "requests", "memory", v))}</td>
                  <td className="px-2 py-1">{cell(p.limits.memory, (v) => set(s, "limits", "memory", v))}</td>
                  <td className="px-2 py-1">{cell(p.requests["ephemeral-storage"], (v) => set(s, "requests", "ephemeral-storage", v))}</td>
                  <td className="px-2 py-1">{cell(p.limits["ephemeral-storage"], (v) => set(s, "limits", "ephemeral-storage", v))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
