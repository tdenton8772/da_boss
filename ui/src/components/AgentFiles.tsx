import { useEffect, useState, useCallback, useRef } from "react";
import { api, type AgentFile } from "../api";
import { useToastHelpers } from "./Toast";

// Hand files (screenshots, docs) to an agent. They're stored in da_boss and the worker
// drops them into /work/uploads in the pod on the next turn — restoring the local
// "the agent can see my files" workflow now that agents run in isolated pods.
export function AgentFiles({ agentId }: { agentId: string }) {
  const [files, setFiles] = useState<AgentFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const toast = useToastHelpers();

  const load = useCallback(() => { api.listAgentFiles(agentId).then(setFiles).catch(() => {}); }, [agentId]);
  useEffect(() => { load(); }, [load]);

  const upload = async (list: FileList | null) => {
    if (!list || !list.length) return;
    setBusy(true);
    try {
      for (const f of Array.from(list)) await api.uploadAgentFile(agentId, f);
      toast.success("Uploaded — the agent reads it in /work/uploads on its next turn");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div
      className={`bg-gray-900 border rounded-lg p-4 mb-4 ${drag ? "border-blue-500 bg-blue-950/20" : "border-gray-800"}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); void upload(e.dataTransfer.files); }}
    >
      <div className="flex items-center justify-between mb-2 gap-2">
        <div className="text-sm font-medium text-gray-300">Files <span className="text-gray-500">— dropped into <code className="text-gray-400">/work/uploads</code> for the agent</span></div>
        <button disabled={busy} onClick={() => inputRef.current?.click()} className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-200 rounded px-2 py-1 disabled:opacity-40 shrink-0">
          {busy ? "Uploading…" : "＋ Upload"}
        </button>
        <input ref={inputRef} type="file" multiple className="hidden" onChange={(e) => void upload(e.target.files)} />
      </div>
      {files.length === 0 ? (
        <p className="text-xs text-gray-500">Drop or upload screenshots/docs — the agent reads them at <code>/work/uploads/&lt;name&gt;</code> on its next turn.</p>
      ) : (
        <ul className="space-y-1">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-2 text-sm text-gray-300">
              📎 <span className="truncate flex-1" title={f.name}>{f.name}</span>
              <span className="text-xs text-gray-600 font-mono">/work/uploads/{f.name}</span>
              <span className="text-xs text-gray-600">{Math.max(1, Math.round(f.size / 1024))} KB</span>
              <button onClick={() => api.deleteAgentFile(agentId, f.id).then(load).catch(() => {})} className="text-xs text-gray-500 hover:text-red-400" title="Remove">✕</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
