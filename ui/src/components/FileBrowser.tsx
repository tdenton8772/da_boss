import { useState } from "react";
import { api } from "../api";
import {
  FolderOpen,
  File,
  Download,
  Eye,
  X,
  ChevronUp,
  Search,
} from "lucide-react";

interface FileEntry {
  name: string;
  path: string;
  size: number;
  modified: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

export function FileBrowser({ defaultDir }: { defaultDir?: string }) {
  const [dir, setDir] = useState(defaultDir || "/tmp");
  const [dirInput, setDirInput] = useState(defaultDir || "/tmp");
  const [pattern, setPattern] = useState("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [viewContent, setViewContent] = useState<{
    path: string;
    name: string;
    content: string;
    size: number;
  } | null>(null);

  const browse = async (targetDir?: string) => {
    const d = targetDir || dirInput;
    setLoading(true);
    try {
      const result = await api.listFiles(d, pattern || undefined);
      setFiles(result.files);
      setDir(result.dir);
      setDirInput(result.dir);
    } catch {
      setFiles([]);
    } finally {
      setLoading(false);
    }
  };

  const viewFile = async (path: string) => {
    try {
      const result = await api.viewFile(path);
      setViewContent({
        path: result.path,
        name: result.name,
        content: result.content,
        size: result.size,
      });
    } catch {
      // ignore
    }
  };

  const goUp = () => {
    const parent = dir.split("/").slice(0, -1).join("/") || "/";
    setDirInput(parent);
    browse(parent);
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-800">
        <FolderOpen size={14} className="text-gray-500 shrink-0" />
        <span className="text-xs text-gray-400 shrink-0">Files</span>

        <button
          onClick={goUp}
          className="p-1 hover:bg-gray-700 rounded text-gray-500"
          title="Parent directory"
        >
          <ChevronUp size={14} />
        </button>

        <input
          type="text"
          value={dirInput}
          onChange={(e) => setDirInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") browse();
          }}
          className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-blue-600"
          placeholder="/path/to/directory"
        />

        <input
          type="text"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") browse();
          }}
          className="w-24 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-blue-600"
          placeholder="filter"
        />

        <button
          onClick={() => browse()}
          disabled={loading}
          className="px-2 py-1 bg-blue-700 hover:bg-blue-600 disabled:bg-gray-700 text-white rounded text-xs"
        >
          <Search size={12} />
        </button>
      </div>

      {/* File list */}
      {files.length > 0 && (
        <div className="max-h-48 overflow-y-auto">
          {files.map((f) => (
            <div
              key={f.path}
              className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-800/50 border-b border-gray-800/30 text-xs"
            >
              <File size={12} className="text-gray-600 shrink-0" />
              <span className="text-gray-300 truncate flex-1" title={f.path}>
                {f.name}
              </span>
              <span className="text-gray-600 shrink-0">{formatSize(f.size)}</span>
              <button
                onClick={() => viewFile(f.path)}
                className="p-1 hover:bg-gray-700 rounded text-blue-400"
                title="View"
              >
                <Eye size={12} />
              </button>
              <a
                href={api.downloadFileUrl(f.path)}
                className="p-1 hover:bg-gray-700 rounded text-green-400"
                title="Download"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Download size={12} />
              </a>
            </div>
          ))}
        </div>
      )}

      {files.length === 0 && dir && (
        <div className="px-3 py-3 text-xs text-gray-600 text-center">
          {loading ? "Loading..." : "Click search to browse files"}
        </div>
      )}

      {/* File viewer modal */}
      {viewContent && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-4xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-2 border-b border-gray-700">
              <div className="flex items-center gap-2">
                <File size={14} className="text-gray-400" />
                <span className="text-sm text-gray-200 font-mono">{viewContent.name}</span>
                <span className="text-xs text-gray-500">{formatSize(viewContent.size)}</span>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={api.downloadFileUrl(viewContent.path)}
                  className="px-2 py-1 bg-green-700 hover:bg-green-600 text-white rounded text-xs flex items-center gap-1"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Download size={12} />
                  Download
                </a>
                <button
                  onClick={() => setViewContent(null)}
                  className="p-1 hover:bg-gray-700 rounded text-gray-400"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
            <pre className="flex-1 overflow-auto p-4 text-xs text-gray-300 font-mono whitespace-pre-wrap break-words bg-gray-950">
              {viewContent.content}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
