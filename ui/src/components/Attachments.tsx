import { useRef, useState, useCallback, type ClipboardEvent, type DragEvent } from "react";
import { Paperclip, X } from "lucide-react";
import { api } from "../api";

/**
 * Attaching files (screenshots, example inputs, docs) to an agent — shared by the
 * create form and the message box. Files are held locally until the agent exists /
 * the message is sent, then uploaded; the worker puts them in /work/uploads and
 * names them in the agent's prompt on its next turn.
 */

/** A pasted screenshot arrives as "image.png" — give it a recognizable name. */
function named(file: File): File {
  if (file.name && file.name !== "image.png") return file;
  const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return new File([file], `screenshot-${ts}.${ext}`, { type: file.type });
}

export function useAttachments() {
  const [files, setFiles] = useState<File[]>([]);
  const add = useCallback((list: FileList | File[] | null | undefined) => {
    if (!list || !list.length) return;
    setFiles((prev) => [...prev, ...Array.from(list).map(named)]);
  }, []);
  const remove = useCallback((i: number) => setFiles((prev) => prev.filter((_, j) => j !== i)), []);
  const clear = useCallback(() => setFiles([]), []);

  /** onPaste for a text field: files on the clipboard become attachments; text pastes as usual. */
  const onPaste = useCallback((e: ClipboardEvent) => {
    const pasted = Array.from(e.clipboardData?.files ?? []);
    if (pasted.length) {
      e.preventDefault();
      add(pasted);
    }
  }, [add]);

  /** Drag-and-drop props for any container. */
  const [dragging, setDragging] = useState(false);
  const dropProps = {
    onDragOver: (e: DragEvent) => { if (e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); setDragging(true); } },
    onDragLeave: () => setDragging(false),
    onDrop: (e: DragEvent) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      setDragging(false);
      add(e.dataTransfer.files);
    },
  };

  return { files, add, remove, clear, onPaste, dropProps, dragging };
}

/** Upload attachments to an agent; returns the names they were stored under. */
export async function uploadAttachments(agentId: string, files: File[]): Promise<string[]> {
  const names: string[] = [];
  for (const f of files) {
    try {
      names.push((await api.uploadAgentFile(agentId, f)).name);
    } catch (e) {
      throw new Error(`Uploading ${f.name} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return names;
}

export function AttachButton({ onFiles, title = "Attach files (or paste / drop them)" }: { onFiles: (list: FileList | null) => void; title?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" onClick={() => ref.current?.click()} title={title}
        className="px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded border border-gray-700">
        <Paperclip size={16} />
      </button>
      <input ref={ref} type="file" multiple className="hidden"
        onChange={(e) => { onFiles(e.target.files); e.target.value = ""; }} />
    </>
  );
}

export function AttachmentChips({ files, onRemove }: { files: File[]; onRemove: (i: number) => void }) {
  if (!files.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {files.map((f, i) => (
        <span key={`${f.name}-${i}`} className="flex items-center gap-1.5 text-xs bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-200 max-w-full">
          {f.type.startsWith("image/") ? (
            <img src={URL.createObjectURL(f)} alt="" className="w-6 h-6 object-cover rounded" onLoad={(e) => URL.revokeObjectURL((e.target as HTMLImageElement).src)} />
          ) : (
            <Paperclip size={12} className="text-gray-500 shrink-0" />
          )}
          <span className="truncate max-w-[14rem]" title={f.name}>{f.name}</span>
          <span className="text-gray-500 shrink-0">{Math.max(1, Math.round(f.size / 1024))} KB</span>
          <button type="button" onClick={() => onRemove(i)} title="Remove" className="text-gray-500 hover:text-red-400 shrink-0"><X size={12} /></button>
        </span>
      ))}
    </div>
  );
}
