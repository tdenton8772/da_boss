import { useState, useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router";
import { api } from "./api";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { AgentDetail } from "./pages/AgentDetail";

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    api.me().then((r) => setAuthed(r.authenticated)).catch(() => setAuthed(false));
  }, []);

  if (authed === null) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center text-gray-400">
        Loading...
      </div>
    );
  }

  if (!authed) {
    return <Login onLogin={() => setAuthed(true)} />;
  }

  return (
    <BrowserRouter>
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/agent/:id" element={<AgentDetail />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </ErrorBoundary>
    </BrowserRouter>
  );
}
