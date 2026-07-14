import { useState, useEffect } from "react";
import { Users } from "lucide-react";
import { api, type UserSummary } from "../api";
import { useToastHelpers } from "./Toast";

/**
 * Admin roster — lists users and offboards them. Renders nothing for non-admins
 * (the endpoints are admin-gated server-side too). Offboarding tears down the
 * user's agents, remote branches, workspace shard, and credentials, then removes
 * the user.
 */
export function AdminUsersPanel() {
  const toast = useToastHelpers();
  const [isAdmin, setIsAdmin] = useState(false);
  const [me, setMe] = useState<string | null>(null);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = () => api.listUsers().then(setUsers).catch(() => {});

  useEffect(() => {
    api.me().then((res) => {
      if (res.user?.role === "admin") {
        setIsAdmin(true);
        setMe(res.user.userId);
        refresh();
      }
    }).catch(() => {});
  }, []);

  if (!isAdmin) return null;

  const toggleAccess = async (u: UserSummary) => {
    const label = u.email || u.id;
    const grant = !u.access_approved;
    if (!grant && !confirm(
      `Revoke da_boss access for ${label}?\n\nThey'll be blocked on their next request. Note: if they still hold an access-granting role in the IdP, they'll be re-granted on next login — offboard to keep them out permanently.`
    )) return;
    setBusy(u.id);
    try {
      await api.setUserAccess(u.id, grant);
      toast.success(`${grant ? "Granted" : "Revoked"} access for ${label}`);
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Access change failed");
    } finally {
      setBusy(null);
    }
  };

  const offboard = async (u: UserSummary) => {
    const label = u.email || u.id;
    if (!confirm(
      `Offboard ${label}?\n\nThis permanently deletes their ${u.agent_count} agent(s), their remote branches, their workspace storage, and their stored credentials. This cannot be undone.`
    )) return;
    setBusy(u.id);
    try {
      const r = await api.offboardUser(u.id);
      toast.success(`Offboarded ${label} — removed ${r.agentsRemoved} agent(s), ${r.branchesDeleted} branch(es)`);
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Offboard failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
      <h2 className="text-lg font-semibold text-gray-100 mb-2 flex items-center gap-2">
        <Users size={18} /> Users
      </h2>
      <p className="text-gray-400 text-sm mb-4">
        Offboarding removes a departing user and everything tied to them —
        agents, branches, workspace storage, and credentials. Audit history is kept.
      </p>

      <div className="divide-y divide-gray-800">
        {users.map((u) => (
          <div key={u.id} className="flex items-center justify-between py-3">
            <div className="min-w-0">
              <div className="text-gray-200 text-sm truncate">
                {u.display_name || u.email || u.id}
                {u.role === "admin" && (
                  <span className="ml-2 text-xs text-amber-400 border border-amber-700/50 rounded px-1.5 py-0.5">admin</span>
                )}
                {u.access_approved ? (
                  <span className="ml-2 text-xs text-emerald-400 border border-emerald-700/50 rounded px-1.5 py-0.5">access</span>
                ) : (
                  <span className="ml-2 text-xs text-gray-500 border border-gray-700 rounded px-1.5 py-0.5">no access</span>
                )}
                {u.id === me && <span className="ml-2 text-xs text-gray-500">(you)</span>}
              </div>
              <div className="text-gray-500 text-xs truncate">
                {u.email} · {u.agent_count} agent{u.agent_count === 1 ? "" : "s"}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => toggleAccess(u)}
                disabled={(u.id === me && u.access_approved) || busy === u.id}
                className="bg-gray-800 hover:bg-gray-700 disabled:opacity-40 disabled:hover:bg-gray-800 text-gray-300 text-sm rounded px-3 py-1.5"
                title={u.id === me && u.access_approved ? "You can't revoke your own access" : u.access_approved ? "Revoke da_boss access" : "Grant da_boss access"}
              >
                {busy === u.id ? "…" : u.access_approved ? "Revoke" : "Grant"}
              </button>
              <button
                onClick={() => offboard(u)}
                disabled={u.id === me || busy === u.id}
                className="bg-gray-800 hover:bg-red-700 disabled:opacity-40 disabled:hover:bg-gray-800 text-gray-300 text-sm rounded px-3 py-1.5"
                title={u.id === me ? "You can't offboard yourself" : "Offboard user"}
              >
                {busy === u.id ? "Offboarding…" : "Offboard"}
              </button>
            </div>
          </div>
        ))}
        {users.length === 0 && <div className="text-gray-500 text-sm py-3">No users.</div>}
      </div>
    </div>
  );
}
