import { useState, useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router";
import { api } from "./api";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { AgentDetail } from "./pages/AgentDetail";
import { Discover } from "./pages/Discover";
import { Reviews } from "./pages/Reviews";
import { Settings } from "./pages/Settings";
import { ToastProvider } from "./components/Toast";

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [authMode, setAuthMode] = useState<"local" | "oidc">("local");
  const [sso, setSso] = useState<{ label?: string; loginUrl?: string }>({});

  useEffect(() => {
    api
      .me()
      .then((r) => {
        setAuthed(r.authenticated);
        setAuthMode(r.authMode);
        setSso({ label: r.ssoLabel, loginUrl: r.ssoLoginUrl });
      })
      .catch(() => setAuthed(false));
  }, []);

  if (authed === null) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center text-gray-400">
        Loading...
      </div>
    );
  }

  if (!authed) {
    return <Login onLogin={() => setAuthed(true)} authMode={authMode} ssoLabel={sso.label} ssoLoginUrl={sso.loginUrl} />;
  }

  return (
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "") || "/"}>
      <ErrorBoundary>
        <ToastProvider>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/reviews" element={<Reviews />} />
            <Route path="/agent/:id" element={<AgentDetail />} />
            <Route path="/discover" element={<Discover />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </ToastProvider>
      </ErrorBoundary>
    </BrowserRouter>
  );
}
