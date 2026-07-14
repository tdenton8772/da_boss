/**
 * API tokens — headless auth for a non-human caller (the MCP surface's auth).
 * A Bearer token resolves to a principal (a users row) and is DEFAULT-DENY: it is
 * honoured only on an explicit allow-list of (method, path, scope), so a leaked
 * review token cannot create agents, change budgets, or mint more tokens. Session
 * (browser) auth is unaffected and unscoped. Only the sha256 hash is stored; the
 * plaintext is shown once at creation.
 */
import { randomBytes, createHash } from "node:crypto";
import type { Request, Response } from "express";
import * as queries from "../db/queries.js";
import type { AuthedUser } from "../types/auth.js";

const TOKEN_PREFIX = "dbt_";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateToken(): { token: string; hash: string } {
  const token = TOKEN_PREFIX + randomBytes(24).toString("base64url");
  return { token, hash: hashToken(token) };
}

// Default-deny allow-list. A Bearer token may hit ONLY these (method, path) pairs,
// and only if it carries the required scope — everything else is 403, even for an
// admin's token. /api/tokens is deliberately absent: you cannot mint or revoke a
// token using a token (that needs a browser session).
const TOKEN_ROUTES: Array<{ method: string; re: RegExp; scope: string }> = [
  { method: "POST", re: /^\/mcp$/, scope: "mcp" }, // the MCP surface
  { method: "POST", re: /^\/api\/agents$/, scope: "agent:create" }, // create + dispatch an agent
  { method: "POST", re: /^\/api\/agents\/[^/]+\/review$/, scope: "review:create" },
  { method: "GET", re: /^\/api\/agents\/[^/]+$/, scope: "review:read" },
  { method: "GET", re: /^\/api\/agents$/, scope: "review:read" },
];

export const KNOWN_SCOPES = ["agent:create", "review:create", "review:read", "mcp", "*"] as const;

export function tokenRouteAllowed(method: string, path: string, scopes: string[]): boolean {
  const match = TOKEN_ROUTES.find((r) => r.method === method && r.re.test(path));
  if (!match) return false;
  return scopes.includes("*") || scopes.includes(match.scope);
}

/** Resolve a Bearer token to a principal, or null if absent/malformed/invalid. */
export async function resolveBearer(req: Request): Promise<AuthedUser | null> {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return null;
  const token = h.slice(7).trim();
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const row = await queries.getActiveApiTokenByHash(hashToken(token));
  if (!row) return null;
  const u = await queries.getUserById(row.user_id);
  if (!u) return null;
  void queries.touchApiToken(row.id).catch(() => {});
  const scopes = row.scopes ? row.scopes.split(",").map((s) => s.trim()).filter(Boolean) : [];
  return { userId: u.id, email: u.email, name: u.display_name, role: u.role, via: "token", scopes };
}

// ── Handlers (session-only via default-deny) ─────────────────────────
const DEFAULT_SCOPES = "review:create,review:read";

export async function handleCreateToken(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as { name?: string; scopes?: string[] };
  let scopeStr = DEFAULT_SCOPES;
  if (Array.isArray(body.scopes) && body.scopes.length) {
    const bad = body.scopes.filter((s) => !(KNOWN_SCOPES as readonly string[]).includes(s));
    if (bad.length) { res.status(400).json({ error: `Unknown scope(s): ${bad.join(", ")}` }); return; }
    scopeStr = body.scopes.join(",");
  }
  const { token, hash } = generateToken();
  const row = await queries.createApiToken({
    user_id: req.user!.userId, name: body.name ?? "api token", token_hash: hash, scopes: scopeStr,
  });
  await queries.insertAuditLog(req.ip || null, "token.create", "user", req.user!.userId, `${row.id} [${scopeStr}]`, req.user!.userId);
  // Shown ONCE — never retrievable again.
  res.status(201).json({ id: row.id, name: row.name, scopes: scopeStr, token });
}

export async function handleListTokens(req: Request, res: Response): Promise<void> {
  res.json(await queries.listApiTokensForUser(req.user!.userId));
}

export async function handleRevokeToken(req: Request, res: Response): Promise<void> {
  const tokenId = String(req.params.id);
  const ok = await queries.revokeApiToken(tokenId, req.user!.userId);
  if (!ok) { res.status(404).json({ error: "Token not found" }); return; }
  await queries.insertAuditLog(req.ip || null, "token.revoke", "user", req.user!.userId, tokenId, req.user!.userId);
  res.json({ ok: true });
}
