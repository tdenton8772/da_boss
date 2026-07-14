declare module "express-session" {
  interface SessionData {
    authenticated?: boolean; // legacy single-password flag (unused in per-user mode)
    userId?: string; // local-auth: the logged-in user's id
  }
}

export {};
