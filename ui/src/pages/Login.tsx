import { useState } from "react";
import { api } from "../api";

export function Login({
  onLogin,
  authMode = "local",
  ssoLabel = "single sign-on",
  ssoLoginUrl = "/",
}: {
  onLogin: () => void;
  authMode?: "local" | "oidc";
  ssoLabel?: string;
  ssoLoginUrl?: string;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (mode === "register") {
        await api.register(email, password, displayName || undefined);
      } else {
        await api.login(email, password);
      }
      onLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  };

  // In OIDC/passthrough mode da_boss doesn't own the login — the IdP (or an
  // upstream proxy) authenticates and forwards the token. Show a hint, not a form.
  if (authMode === "oidc") {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-8 w-full max-w-sm text-center">
          <h1 className="text-2xl font-bold text-gray-100 mb-2">da_boss</h1>
          <p className="text-gray-400 text-sm mb-6">
            Sign in with {ssoLabel}. Access is limited to your team; if you can sign in
            there but not here, ask an admin.
          </p>
          <a
            href={ssoLoginUrl}
            className="block w-full bg-blue-600 hover:bg-blue-500 text-white font-medium rounded px-4 py-2 mb-2"
          >
            Sign in with {ssoLabel}
          </a>
          <button
            onClick={() => window.location.reload()}
            className="text-gray-500 hover:text-gray-300 text-xs"
          >
            already signed in? reload
          </button>
        </div>
      </div>
    );
  }

  const inputCls =
    "w-full bg-gray-800 border border-gray-700 rounded px-4 py-2 text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 mb-4";

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <form
        onSubmit={handleSubmit}
        className="bg-gray-900 border border-gray-800 rounded-lg p-8 w-full max-w-sm"
      >
        <h1 className="text-2xl font-bold text-gray-100 mb-1">da_boss</h1>
        <p className="text-gray-500 text-sm mb-6">
          {mode === "register" ? "Create your account" : "Sign in to your account"}
        </p>

        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          className={inputCls}
          autoFocus
          autoComplete="email"
        />
        {mode === "register" && (
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Display name (optional)"
            className={inputCls}
          />
        )}
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className={inputCls}
          autoComplete={mode === "register" ? "new-password" : "current-password"}
        />

        {error && <p className="text-red-400 text-sm mb-4">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium rounded px-4 py-2"
        >
          {busy ? "…" : mode === "register" ? "Create account" : "Sign in"}
        </button>

        <button
          type="button"
          onClick={() => {
            setError("");
            setMode(mode === "register" ? "login" : "register");
          }}
          className="w-full text-gray-400 hover:text-gray-200 text-sm mt-4"
        >
          {mode === "register" ? "Have an account? Sign in" : "Need an account? Register"}
        </button>
      </form>
    </div>
  );
}
