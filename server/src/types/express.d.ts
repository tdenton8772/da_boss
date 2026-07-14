import type { AuthedUser } from "./auth.js";

declare global {
  namespace Express {
    interface Request {
      user?: AuthedUser; // set by requireAuth
    }
  }
}

export {};
