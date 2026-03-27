import { useState, useEffect } from "react";
import { Folder, FolderOpen, ChevronUp, Check } from "lucide-react";

interface DirEntry {
  name: string;
  path: string;
}

interface BrowseResult {
  current: string;
  parent: string | null;
  dirs: DirEntry[];
}

export function DirPicker({
  value,
  onChange,
  onClose,
}: {
  value: string;
  onChange: (path: string) => void;
  onClose: () => void;
}) {
  const [current, setCurrent] = useState(value || "");
  const [dirs, setDirs] = useState<DirEntry[]>([]);
  const [parent, setParent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const browse = (dir: string) => {
    setLoading(true);
    fetch(`/api/browse?dir=${encodeURIComponent(dir)}`)
      .then((r) => r.json())
      .then((data: BrowseResult) => {
        setCurrent(data.current);
        setDirs(data.dirs);
        setParent(data.parent);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    browse(value || "/Users");
  }, []);

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg overflow-hidden">
      {/* Current path + select */}
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-900 border-b border-gray-700">
        <FolderOpen size={14} className="text-blue-400 shrink-0" />
        <span className="text-gray-200 text-xs font-mono truncate flex-1">
          {current}
        </span>
        <button
          onClick={() => {
            onChange(current);
            onClose();
          }}
          className="flex items-center gap-1 px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded shrink-0"
        >
          <Check size={12} />
          Select
        </button>
      </div>

      {/* Directory listing */}
      <div className="max-h-48 overflow-y-auto">
        {parent && (
          <button
            onClick={() => browse(parent)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-700/50 text-gray-400 text-sm"
          >
            <ChevronUp size={14} />
            ..
          </button>
        )}
        {loading ? (
          <div className="px-3 py-4 text-gray-500 text-xs text-center">
            Loading...
          </div>
        ) : dirs.length === 0 ? (
          <div className="px-3 py-4 text-gray-600 text-xs text-center">
            No subdirectories
          </div>
        ) : (
          dirs.map((d) => (
            <button
              key={d.path}
              onClick={() => browse(d.path)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-700/50 text-gray-300 text-sm"
            >
              <Folder size={14} className="text-yellow-500/70 shrink-0" />
              {d.name}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
