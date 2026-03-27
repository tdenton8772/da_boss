import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router";
import { api } from "../api";
import type { DiscoveredProject, DiscoveredSession } from "../api";
import {
  FolderSearch,
  ChevronRight,
  ChevronDown,
  Clock,
  HardDrive,
  Import,
  Lock,
  FileText,
  ArrowLeft,
  Loader,
  AlertCircle,
} from "lucide-react";

export function Discover() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<DiscoveredProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedProject, setExpandedProject] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Record<string, DiscoveredSession[]>>({});
  const [sessionsLoading, setSessionsLoading] = useState<string | null>(null);
  const [importingSession, setImportingSession] = useState<{
    projectKey: string;
    sessionId: string;
  } | null>(null);
  const [importName, setImportName] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const fetchProjects = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .discoverProjects()
      .then(setProjects)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  const toggleProject = (projectKey: string) => {
    if (expandedProject === projectKey) {
      setExpandedProject(null);
      return;
    }
    setExpandedProject(projectKey);
    if (!sessions[projectKey]) {
      setSessionsLoading(projectKey);
      api
        .discoverSessions(projectKey)
        .then((s) => setSessions((prev) => ({ ...prev, [projectKey]: s })))
        .catch(() =>
          setSessions((prev) => ({ ...prev, [projectKey]: [] }))
        )
        .finally(() => setSessionsLoading(null));
    }
  };

  const openImportForm = (projectKey: string, sessionId: string) => {
    setImportingSession({ projectKey, sessionId });
    setImportName("");
    setImportError(null);
  };

  const handleImport = async () => {
    if (!importingSession || !importName.trim()) return;
    setImportBusy(true);
    setImportError(null);
    try {
      const result = await api.importSession({
        projectKey: importingSession.projectKey,
        sessionId: importingSession.sessionId,
        name: importName.trim(),
      });
      setImportingSession(null);
      navigate(`/agent/${result.id}`);
    } catch (e: unknown) {
      setImportError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setImportBusy(false);
    }
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString();
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const truncateId = (id: string) => id.slice(0, 8) + "...";

  return (
    <div className="min-h-screen bg-gray-950 p-4 md:p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={() => navigate("/")}
          className="text-gray-400 hover:text-gray-200 transition-colors"
        >
          <ArrowLeft size={20} />
        </button>
        <FolderSearch size={24} className="text-blue-400" />
        <h1 className="text-2xl font-bold text-gray-100">
          Discover Sessions
        </h1>
      </div>

      <p className="text-gray-400 text-sm mb-6">
        Find existing Claude Code sessions on this machine and import them into
        da_boss for monitoring and management.
      </p>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-16 text-gray-400">
          <Loader size={20} className="animate-spin mr-2" />
          Scanning for sessions...
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-900/30 border border-red-800 rounded-lg p-4 mb-6 flex items-center gap-3">
          <AlertCircle size={18} className="text-red-400 shrink-0" />
          <p className="text-red-300 text-sm">{error}</p>
          <button
            onClick={fetchProjects}
            className="ml-auto text-sm text-red-300 hover:text-red-100 underline"
          >
            Retry
          </button>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && projects.length === 0 && (
        <div className="text-center text-gray-600 py-16">
          No Claude Code sessions found on this machine.
        </div>
      )}

      {/* Project cards */}
      <div className="space-y-3">
        {projects.map((project) => (
          <div
            key={project.projectKey}
            className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden"
          >
            {/* Project header */}
            <button
              onClick={() => toggleProject(project.projectKey)}
              className="w-full flex items-center gap-3 p-4 text-left hover:bg-gray-800/50 transition-colors"
            >
              {expandedProject === project.projectKey ? (
                <ChevronDown size={16} className="text-gray-500 shrink-0" />
              ) : (
                <ChevronRight size={16} className="text-gray-500 shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-gray-100 font-medium truncate font-mono text-sm">
                  {project.path}
                </p>
                <div className="flex items-center gap-4 mt-1 text-xs text-gray-500">
                  <span className="flex items-center gap-1">
                    <FileText size={12} />
                    {project.sessionCount}{" "}
                    {project.sessionCount === 1 ? "session" : "sessions"}
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock size={12} />
                    {formatDate(project.latestModified)}
                  </span>
                </div>
              </div>
            </button>

            {/* Sessions list */}
            {expandedProject === project.projectKey && (
              <div className="border-t border-gray-800">
                {sessionsLoading === project.projectKey ? (
                  <div className="flex items-center justify-center py-8 text-gray-500">
                    <Loader size={16} className="animate-spin mr-2" />
                    Loading sessions...
                  </div>
                ) : sessions[project.projectKey]?.length === 0 ? (
                  <div className="text-center text-gray-600 py-8 text-sm">
                    No sessions found.
                  </div>
                ) : (
                  <div className="divide-y divide-gray-800">
                    {sessions[project.projectKey]?.map((session) => (
                      <div
                        key={session.sessionId}
                        className="px-4 py-3 flex items-start gap-3 hover:bg-gray-800/30"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-gray-300 font-mono text-xs">
                              {truncateId(session.sessionId)}
                            </span>
                            {session.isLocked && (
                              <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-green-900/40 text-green-400 border border-green-800/50">
                                <Lock size={10} />
                                Active
                              </span>
                            )}
                          </div>
                          {session.firstPrompt && (
                            <p className="text-gray-400 text-sm line-clamp-2 mb-1">
                              {session.firstPrompt}
                            </p>
                          )}
                          <div className="flex items-center gap-3 text-xs text-gray-600">
                            <span className="flex items-center gap-1">
                              <Clock size={10} />
                              {formatDate(session.modified)}
                            </span>
                            <span className="flex items-center gap-1">
                              <HardDrive size={10} />
                              {formatSize(session.sizeBytes)}
                            </span>
                          </div>
                        </div>
                        <button
                          onClick={() =>
                            openImportForm(
                              project.projectKey,
                              session.sessionId
                            )
                          }
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded shrink-0 transition-colors"
                        >
                          <Import size={14} />
                          Import
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Import Modal */}
      {importingSession && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-lg p-6 w-full max-w-md">
            <h2 className="text-lg font-semibold text-gray-100 mb-4">
              Import Session
            </h2>
            <p className="text-gray-400 text-sm mb-4">
              Session{" "}
              <span className="font-mono text-gray-300">
                {truncateId(importingSession.sessionId)}
              </span>{" "}
              will be imported as a new agent.
            </p>
            <label className="block text-sm text-gray-300 mb-1">
              Agent Name
            </label>
            <input
              type="text"
              value={importName}
              onChange={(e) => setImportName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleImport();
              }}
              placeholder="e.g. refactor-auth-module"
              autoFocus
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-gray-100 text-sm placeholder-gray-600 focus:outline-none focus:border-blue-500 mb-4"
            />
            {importError && (
              <p className="text-red-400 text-sm mb-3">{importError}</p>
            )}
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setImportingSession(null)}
                className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleImport}
                disabled={!importName.trim() || importBusy}
                className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 disabled:cursor-not-allowed text-white text-sm font-medium rounded transition-colors"
              >
                {importBusy ? (
                  <Loader size={14} className="animate-spin" />
                ) : (
                  <Import size={14} />
                )}
                {importBusy ? "Importing..." : "Import"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
