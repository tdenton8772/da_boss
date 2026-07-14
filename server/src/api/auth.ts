import type { Request, Response, NextFunction } from "express";
import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { nanoid } from "nanoid";
import { jwtVerify, importSPKI, createRemoteJWKSet, type JWTPayload, type CryptoKey } from "jose";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import * as queries from "../db/queries.js";
import type { AuthedUser } from "../types/auth.js";
import { resolveBearer, tokenRouteAllowed } from "./tokens.js";

const scryptAsync = promisify(scrypt);

// ── Password hashing (scrypt, Node built-in — no native dep) ──
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(pw, salt, 32)) as Buffer;
  return `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  const derived = (await scryptAsync(pw, salt, expected.length)) as Buffer;
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// ── Login rate limiter (per IP) ──────────────────────────
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

/** Clear all login rate-limit state. Used by tests for isolation. */
export function resetLoginRateLimit(): void {
  loginAttempts.clear();
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + config.loginRateLimitWindowMs });
    return false;
  }
  entry.count++;
  return entry.count > config.loginRateLimitMax;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) if (now > entry.resetAt) loginAttempts.delete(ip);
}, 60_000);

// ── Auth providers (seam) ────────────────────────────────
export interface AuthProvider {
  mode: "local" | "oidc";
  /** Resolve the request's identity, or null if unauthenticated. */
  authenticate(req: Request): Promise<AuthedUser | null>;
}

function toAuthedUser(u: queries.User): AuthedUser {
  return { userId: u.id, email: u.email, name: u.display_name, role: u.role };
}

/** Local accounts: session cookie carries userId; login/register verify passwords. */
class LocalAuthProvider implements AuthProvider {
  mode = "local" as const;
  async authenticate(req: Request): Promise<AuthedUser | null> {
    const userId = req.session?.userId;
    if (!userId) return null;
    const u = await queries.getUserById(userId);
    return u ? toAuthedUser(u) : null;
  }
}

export interface OidcOptions {
  issuer?: string;
  audience?: string;
  publicKey?: string; // static PEM (SPKI)
  jwksUri?: string; // or a JWKS endpoint
  tokenCookie?: string;
  cookieFormat?: string; // "jwt" (raw, default) | "plug_session" (JWT embedded in an Elixir Plug session)
  claims: { subject: string; email: string; name: string; role: string; access?: string };
  allowedRoles?: string[]; // IdP role values allowed in (empty = any). Lowercased.
  adminEmails?: string[]; // these become da_boss admins. Lowercased.
}

/**
 * Cookie adapter: pull an embedded JWT out of an Elixir Plug signed-session cookie
 * (`header.base64url(ETF).signature`). Plug sessions are SIGNED, not encrypted, so
 * we read the payload without the session secret — and we trust the INNER JWT's
 * own RS256 signature, which no session-cookie tampering can forge. Generic to the
 * Plug format (finds the JWT by its BINARY_EXT length prefix; no app/key names).
 * Selected via config so da_boss stays cookie-format-neutral.
 */
function extractJwtFromPlugSession(cookie: string): string | null {
  try {
    const mid = cookie.split(".")[1];
    if (!mid) return null;
    const bytes = Buffer.from(mid, "base64url");
    const p = bytes.indexOf("eyJ"); // a JWT begins with base64url({"alg"...
    if (p < 5 || bytes[p - 5] !== 0x6d) return null; // 0x6d = ETF BINARY_EXT tag
    const len = bytes.readUInt32BE(p - 4); // its 4-byte big-endian length
    if (len <= 0 || p + len > bytes.length) return null;
    return bytes.subarray(p, p + len).toString("latin1");
  } catch {
    return null;
  }
}

/**
 * OIDC passthrough — verify a forwarded RS256 JWT against a configured IdP and
 * map claims → a users row (provisioned on first sight). Provider-neutral:
 * point it at ANY issuer via a static public key (e.g. a shared the app key) or
 * a JWKS URI. Modeled on the app's verify-only token path.
 */
class OidcAuthProvider implements AuthProvider {
  mode = "oidc" as const;
  private keyGetter: CryptoKey | ReturnType<typeof createRemoteJWKSet> | null = null;
  private keyInit: Promise<void> | null = null;

  constructor(private opts: OidcOptions) {}

  private async ensureKey(): Promise<void> {
    if (this.keyGetter) return;
    if (!this.keyInit) {
      this.keyInit = (async () => {
        if (this.opts.jwksUri) {
          this.keyGetter = createRemoteJWKSet(new URL(this.opts.jwksUri));
        } else if (this.opts.publicKey) {
          this.keyGetter = await importSPKI(this.opts.publicKey, "RS256");
        } else {
          throw new Error("OIDC mode requires OIDC_JWKS_URI or OIDC_PUBLIC_KEY");
        }
      })();
    }
    await this.keyInit;
  }

  private extractToken(req: Request): string | null {
    if (this.opts.tokenCookie) {
      const raw = req.headers.cookie || "";
      const m = raw.match(new RegExp(`(?:^|;\\s*)${this.opts.tokenCookie}=([^;]+)`));
      if (m) {
        const val = decodeURIComponent(m[1]);
        return this.opts.cookieFormat === "plug_session" ? extractJwtFromPlugSession(val) : val;
      }
    }
    const h = req.headers.authorization;
    return h && h.startsWith("Bearer ") ? h.slice(7) : null;
  }

  async authenticate(req: Request): Promise<AuthedUser | null> {
    const token = this.extractToken(req);
    if (!token) return null;
    try {
      await this.ensureKey();
      const opts = {
        algorithms: ["RS256"],
        ...(this.opts.issuer ? { issuer: this.opts.issuer } : {}),
        ...(this.opts.audience ? { audience: this.opts.audience } : {}),
      };
      const key = this.keyGetter!;
      // jose splits verification into two overloads (static key vs JWKS getter)
      const { payload } =
        typeof key === "function"
          ? await jwtVerify(token, key, opts)
          : await jwtVerify(token, key, opts);
      return await this.userFromClaims(payload);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "OIDC token verification failed");
      return null;
    }
  }

  private async userFromClaims(payload: JWTPayload): Promise<AuthedUser | null> {
    const c = this.opts.claims;
    const sub = payload[c.subject] ? String(payload[c.subject]) : "";
    if (!sub) return null;
    const email = typeof payload[c.email] === "string" ? (payload[c.email] as string) : null;
    const name = typeof payload[c.name] === "string" ? (payload[c.name] as string) : null;
    const idpRole = typeof payload[c.role] === "string" ? (payload[c.role] as string).toLowerCase() : null;
    // Optional boolean entitlement claim the IdP derives from full group
    // membership (the group list lives on the IdP side, not the token). When the
    // claim is configured AND present, it's authoritative — this is how a user in
    // multiple groups (e.g. SA + manager) is resolved without the lossy role.
    const accessClaimKey = c.access ?? "";
    const rawAccessClaim = accessClaimKey ? payload[accessClaimKey] : undefined;
    const hasAccessClaim = accessClaimKey !== "" && rawAccessClaim !== undefined;
    const grantedByClaim = rawAccessClaim === true || rawAccessClaim === "true";

    // Offboarded identities are denied — don't re-admit or re-provision them.
    if (await queries.isIdentityOffboarded({ externalId: sub, email })) {
      logger.warn({ sub }, "Denied OIDC login for offboarded identity");
      return null;
    }

    // ── Access gate + role mapping (da_boss ≠ the IdP's role model) ──
    const adminEmails = this.opts.adminEmails ?? [];
    const allowedRoles = this.opts.allowedRoles ?? [];
    const isAdmin = !!email && adminEmails.includes(email.toLowerCase());
    // A role in OIDC_ALLOWED_ROLES (e.g. the SA role) auto-grants access. Empty
    // list = any valid token qualifies (dev/default).
    const qualifiesByRole = allowedRoles.length === 0 || (!!idpRole && allowedRoles.includes(idpRole));
    // The entitlement claim wins when present; otherwise fall back to the role
    // gate (so this stays correct before/while the IdP rolls out the claim).
    const qualifies = hasAccessClaim ? grantedByClaim : qualifiesByRole;
    const dabossRole = isAdmin ? "admin" : "developer";

    // Find (or adopt) the user BEFORE gating — an admin may have explicitly
    // approved someone whose IdP role alone wouldn't qualify, and that manual
    // grant must be honored.
    let user = await queries.getUserByExternalId(sub);
    // Migration path: adopt an existing account with the same email that hasn't
    // been linked to an IdP yet (e.g. a local password account before SSO cutover)
    // — the same person keeps their id, credentials, and history.
    if (!user && email) {
      const existing = await queries.getUserByEmail(email);
      if (existing && !existing.external_id) {
        await queries.setUserExternalId(existing.id, sub);
        user = { ...existing, external_id: sub };
        logger.info({ userId: user.id, sub }, "Linked existing account to OIDC identity by email");
      }
    }

    // Access is gated on the persisted access_approved flag (an inspectable
    // allowlist + kill switch), not the raw IdP role. Qualifying by admin or by
    // an access-granting role auto-grants it; a manual admin grant already on the
    // record also counts. Nothing here auto-REVOKES — an admin does that.
    const accessApproved = isAdmin || qualifies || (user?.access_approved ?? false);
    if (!accessApproved) {
      // Provision a PENDING row (access_approved defaults false) for a new identity
      // so an admin can approve them with one toggle in Admin → Users — instead of a
      // DB command. This is the point of the access_approved allowlist: a user in
      // multiple IdP groups (e.g. SA + manager) whose lossy role fails the gate is
      // still visible + one click from access. Then deny THIS login (not yet approved).
      if (!user) {
        user = await queries.createUser({
          id: `usr_${nanoid(8)}`,
          email: email ?? sub,
          display_name: name ?? email ?? sub,
          role: dabossRole,
          external_id: sub,
        });
        logger.info({ userId: user.id, sub }, "Provisioned PENDING user — awaiting admin access approval");
      }
      logger.warn({ sub, idpRole }, "Denied OIDC login — pending access approval");
      return null;
    }

    if (!user) {
      user = await queries.createUser({
        id: `usr_${nanoid(8)}`,
        email: email ?? sub,
        display_name: name ?? email ?? sub,
        role: dabossRole,
        external_id: sub,
      });
      logger.info({ userId: user.id, sub, role: dabossRole }, "Provisioned user from OIDC token");
    } else if (dabossRole !== user.role) {
      // keep the da_boss role in sync (admin allowlist drives it, not the raw IdP role)
      await queries.updateUserRole(user.id, dabossRole);
      user = { ...user, role: dabossRole };
      logger.info({ userId: user.id, role: dabossRole }, "Synced da_boss role");
    }
    // Persist the auto-grant so the allowlist reflects it.
    if (!user.access_approved) {
      await queries.setUserAccessApproved(user.id, true);
      user = { ...user, access_approved: true };
      logger.info({ userId: user.id }, "Granted da_boss access (role/admin qualified)");
    }
    return { userId: user.id, email: user.email, name: user.display_name, role: user.role };
  }
}

/** Exported for testing with an injected config. */
export function makeOidcProvider(opts: OidcOptions): AuthProvider {
  return new OidcAuthProvider(opts);
}

let provider: AuthProvider | null = null;
export function getAuthProvider(): AuthProvider {
  if (!provider) provider = config.authMode === "oidc" ? new OidcAuthProvider(config.oidc) : new LocalAuthProvider();
  return provider;
}
/** Test hook. */
export function setAuthProvider(p: AuthProvider | null): void {
  provider = p;
}

// ── Middleware ───────────────────────────────────────────
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // Try a Bearer API token first (headless callers / the MCP surface). A token is
  // DEFAULT-DENY: honoured only on token-allowed routes with the right scope.
  // Absent/invalid token → fall through to the browser session / OIDC.
  resolveBearer(req)
    .then((tokenUser) => {
      if (tokenUser) {
        const path = req.originalUrl.split("?")[0];
        if (!tokenRouteAllowed(req.method, path, tokenUser.scopes ?? [])) {
          res.status(403).json({ error: "This API token is not permitted for this route or lacks the scope." });
          return;
        }
        req.user = tokenUser;
        next();
        return;
      }
      getAuthProvider()
        .authenticate(req)
        .then((user) => {
          if (!user) {
            res.status(401).json({ error: "Unauthorized" });
            return;
          }
          req.user = { ...user, via: "session" };
          next();
        })
        .catch((err) => {
          logger.error({ err: err instanceof Error ? err.message : String(err) }, "Auth check failed");
          res.status(500).json({ error: "Auth error" });
        });
    })
    .catch((err) => {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, "Token auth check failed");
      res.status(500).json({ error: "Auth error" });
    });
}

/** Gate admin-only routes. Runs after requireAuth (which populates req.user). */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== "admin") {
    res.status(403).json({ error: "Admin only" });
    return;
  }
  next();
}

// ── Handlers ─────────────────────────────────────────────
export async function handleRegister(req: Request, res: Response): Promise<void> {
  if (config.authMode !== "local") {
    res.status(400).json({ error: "Registration is disabled — identity comes from the IdP" });
    return;
  }
  const { email, password, displayName } = req.body as {
    email?: string; password?: string; displayName?: string;
  };
  if (!email || !password) {
    res.status(400).json({ error: "email and password are required" });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: "password must be at least 8 characters" });
    return;
  }
  if (await queries.getUserByEmail(email)) {
    res.status(409).json({ error: "A user with that email already exists" });
    return;
  }
  if (await queries.isIdentityOffboarded({ email })) {
    res.status(403).json({ error: "This account has been offboarded. Contact an admin." });
    return;
  }
  // The very first registered user bootstraps as admin (can offboard others).
  const isFirstUser = (await queries.countUsers()) === 0;
  const user = await queries.createUser({
    id: `usr_${nanoid(8)}`,
    email,
    display_name: displayName || email,
    password_hash: await hashPassword(password),
    role: isFirstUser ? "admin" : "developer",
  });
  req.session.userId = user.id;
  logger.info({ userId: user.id, email }, "User registered");
  res.status(201).json({ user: toAuthedUser(user) });
}

export async function handleLogin(req: Request, res: Response): Promise<void> {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (isRateLimited(ip)) {
    logger.warn({ ip }, "Login rate limited");
    res.status(429).json({ error: "Too many login attempts. Try again in a minute." });
    return;
  }
  if (config.authMode !== "local") {
    res.status(400).json({ error: "Password login is disabled in OIDC mode" });
    return;
  }
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: "email and password are required" });
    return;
  }
  const user = await queries.getUserByEmail(email);
  if (!user || !user.password_hash || !(await verifyPassword(password, user.password_hash))) {
    logger.warn({ ip, email }, "Login failed");
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  req.session.userId = user.id;
  logger.info({ userId: user.id, ip }, "Login successful");
  res.json({ user: toAuthedUser(user) });
}

export function handleLogout(req: Request, res: Response): void {
  req.session.destroy(() => res.json({ ok: true }));
}

export async function handleMe(req: Request, res: Response): Promise<void> {
  const user = await getAuthProvider().authenticate(req);
  res.json({
    authenticated: !!user, user: user || null, authMode: config.authMode,
    ssoLabel: config.ssoLabel, ssoLoginUrl: config.ssoLoginUrl,
  });
}
