import { useState, useEffect } from "react";
import { GitBranch } from "lucide-react";
import { api } from "../api";
import { useToastHelpers } from "./Toast";

/**
 * Admin control: the default repo + ref that new agents are prefilled with. Stored
 * server-side (app_settings); the create form reads it via /settings and prefills
 * (only when the user hasn't typed their own). Renders nothing for non-admins.
 */
export function DefaultRepoPanel() {
  const toast = useToastHelpers();
  const [isAdmin, setIsAdmin] = useState(false);
  const [repoUrl, setRepoUrl] = useState("");
  const [repoRef, setRepoRef] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.me().then((res) => {
      if (res.user?.role === "admin") setIsAdmin(true);
    }).catch(() => {});
    api.getSettings().then((s) => {
      setRepoUrl(s.default_repo_url || "");
      setRepoRef(s.default_repo_ref || "");
    }).catch(() => {});
  }, []);

  if (!isAdmin) return null;

  const save = async () => {
    setSaving(true);
    try {
      await api.setDefaultRepo(repoUrl.trim(), repoRef.trim());
      toast.success(repoUrl.trim() ? "Default repo saved" : "Default repo cleared");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
      <h2 className="text-lg font-semibold text-gray-100 mb-2 flex items-center gap-2">
        <GitBranch size={18} /> Default repository
      </h2>
      <p className="text-gray-400 text-sm mb-4">
        New agents are prefilled with this repo + base ref. Leave blank to clear.
        A user can still override it per agent.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          placeholder="https://github.com/org/repo.git"
          className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-100 text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono"
        />
        <input
          value={repoRef}
          onChange={(e) => setRepoRef(e.target.value)}
          placeholder="main"
          className="w-full sm:w-40 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-100 text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono"
        />
        <button
          onClick={save}
          disabled={saving}
          className="bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white text-sm rounded px-4 py-2"
        >{saving ? "Saving…" : "Save"}</button>
      </div>
    </div>
  );
}
