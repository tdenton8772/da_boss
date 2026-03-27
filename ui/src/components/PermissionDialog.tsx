import { api, type PermissionReq } from "../api";
import { ShieldQuestion, Check, X } from "lucide-react";

export function PermissionDialog({
  permissions,
  onResolved,
}: {
  permissions: PermissionReq[];
  onResolved: () => void;
}) {
  if (permissions.length === 0) return null;

  const handleResolve = async (id: number, decision: "approved" | "denied") => {
    await api.resolvePermission(id, decision);
    onResolved();
  };

  return (
    <div className="bg-amber-950/30 border border-amber-800/50 rounded-lg p-4">
      <h3 className="flex items-center gap-2 text-sm font-medium text-amber-300 mb-3">
        <ShieldQuestion size={16} />
        Pending Approvals ({permissions.length})
      </h3>
      <div className="space-y-2">
        {permissions.map((perm) => {
          let inputPreview = "";
          try {
            const parsed = JSON.parse(perm.tool_input);
            inputPreview =
              parsed.command ||
              parsed.file_path ||
              parsed.content?.substring(0, 100) ||
              JSON.stringify(parsed).substring(0, 120);
          } catch {
            inputPreview = perm.tool_input.substring(0, 120);
          }

          return (
            <div
              key={perm.id}
              className="bg-gray-900 border border-gray-800 rounded p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm text-gray-200 font-mono">
                    {perm.tool_name}
                  </div>
                  <div className="text-xs text-gray-500 truncate mt-1">
                    {inputPreview}
                  </div>
                  <div className="text-xs text-gray-600 mt-1">
                    Agent: {perm.agent_id}
                  </div>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <button
                    onClick={() => handleResolve(perm.id, "approved")}
                    className="p-1.5 bg-green-900/50 hover:bg-green-800/50 text-green-400 rounded"
                    title="Approve"
                  >
                    <Check size={16} />
                  </button>
                  <button
                    onClick={() => handleResolve(perm.id, "denied")}
                    className="p-1.5 bg-red-900/50 hover:bg-red-800/50 text-red-400 rounded"
                    title="Deny"
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
