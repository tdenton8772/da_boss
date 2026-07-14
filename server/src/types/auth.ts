/** A request's resolved identity, regardless of how it was authenticated
 *  (local login or OIDC). The core only ever sees this shape. */
export interface AuthedUser {
  userId: string;
  email: string | null;
  name: string | null;
  role: string;
  /** How the request authenticated. Session = a browser; token = a headless
   *  caller (the MCP surface / an API token). Set by requireAuth. */
  via?: "session" | "token";
  /** Scopes granted to an API token (empty for session auth, which is unscoped). */
  scopes?: string[];
}
