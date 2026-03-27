import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";

declare module "express-session" {
  interface SessionData {
    authenticated: boolean;
  }
}

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

export function handleLogin(req: Request, res: Response): void {
  const { password } = req.body as { password?: string };
  if (password === config.authPassword) {
    req.session.authenticated = true;
    res.json({ ok: true });
  } else {
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
