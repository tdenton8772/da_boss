import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";


// ── Simple in-memory rate limiter for login ──────────────
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);

  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + config.loginRateLimitWindowMs });
    return false;
  }

  entry.count++;
  if (entry.count > config.loginRateLimitMax) {
    return true;
  }
  return false;
}

// Clean up old entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now > entry.resetAt) loginAttempts.delete(ip);
  }
}, 60_000);

// ── Middleware ────────────────────────────────────────────
export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (req.session?.authenticated) {
    next();
    return;
  }
  res.status(401).json({ error: "Unauthorized" });
}

// ── Handlers ─────────────────────────────────────────────
export function handleLogin(req: Request, res: Response): void {
  const ip = req.ip || req.socket.remoteAddress || "unknown";

  if (isRateLimited(ip)) {
    logger.warn({ ip }, "Login rate limited");
    res.status(429).json({ error: "Too many login attempts. Try again in a minute." });
    return;
  }

  const { password } = req.body as { password?: string };
  if (password === config.authPassword) {
    req.session.authenticated = true;
    logger.info({ ip }, "Login successful");
    res.json({ ok: true });
  } else {
    logger.warn({ ip }, "Login failed — wrong password");
    res.status(401).json({ error: "Invalid password" });
  }
}

export function handleLogout(req: Request, res: Response): void {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
}

export function handleMe(req: Request, res: Response): void {
  res.json({ authenticated: !!req.session?.authenticated });
}
