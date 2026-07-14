/**
 * Supervisor credential resolution. The headless supervisor (orchestrator pod)
 * has no user of its own, so it borrows a DESIGNATED admin's stored Claude
 * credential — usage bills to that admin. The designated user is picked in the
 * admin UI (app_settings) or overridden by env; we re-resolve every cycle so
 * rotation and offboarding take effect immediately, and degrade LOUDLY (rules
 * only) rather than silently if the credential is gone.
 */
import * as queries from "../db/queries.js";
import { getCipher } from "../crypto/cipher.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

export const SUPERVISOR_CRED_SETTING = "supervisor_credential_user_id";

const CLAUDE_ENV_KEYS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

function envKeyForKind(kind: string): "ANTHROPIC_API_KEY" | "CLAUDE_CODE_OAUTH_TOKEN" {
  return kind === "anthropic_api_key" ? "ANTHROPIC_API_KEY" : "CLAUDE_CODE_OAUTH_TOKEN";
}

/** The user id whose credential powers the supervisor: env override, else the
 *  admin-selected setting. Null if unset. */
export async function resolveSupervisorUserId(): Promise<string | null> {
  if (config.supervisorCredentialUser) return config.supervisorCredentialUser;
  return queries.getAppSetting(SUPERVISOR_CRED_SETTING);
}

export interface SupervisorCredentialStatus {
  ok: boolean;
  userId?: string;
  kind?: string;
  reason?: string;
}

/**
 * Load the designated user's decrypted token into the process env (the shape the
 * SDK reads). Clears both keys first so a removed/rotated credential can't leave
 * a stale token behind. Call at the start of every supervision cycle.
 */
export async function loadSupervisorCredentialIntoEnv(): Promise<SupervisorCredentialStatus> {
  for (const k of CLAUDE_ENV_KEYS) delete process.env[k];

  const userId = await resolveSupervisorUserId();
  if (!userId) return { ok: false, reason: "no supervisor credential configured" };

  const cred = await queries.getUserCredential(userId);
  if (!cred) return { ok: false, reason: "designated user has no Claude credential (offboarded?)", userId };

  try {
    const token = await getCipher().decrypt({
      ciphertext: cred.ciphertext,
      nonce: cred.nonce,
      keyRef: cred.key_ref,
    });
    process.env[envKeyForKind(cred.kind)] = token;
    return { ok: true, userId, kind: cred.kind };
  } catch (err) {
    logger.error(
      { userId, err: err instanceof Error ? err.message : String(err) },
      "Failed to decrypt supervisor credential"
    );
    return { ok: false, reason: "credential decrypt failed", userId };
  }
}

/** Is a Claude credential currently present in the env for the SDK to use? */
export function claudeCredentialPresent(): boolean {
  return CLAUDE_ENV_KEYS.some((k) => !!process.env[k]);
}

export interface SupervisorCredentialEnv extends SupervisorCredentialStatus {
  /** A full env for a single SDK call: process.env with the OTHER Claude key
   *  cleared and ours set. Pass as `options.env` so concurrent boss-side Claude
   *  calls don't race on the shared global `process.env`. */
  env?: Record<string, string | undefined>;
}

/**
 * Resolve the designated user's credential as a PER-CALL env (no global mutation).
 * This is the race-safe path: the long-lived boss runs the supervisor and reviews
 * concurrently, and mutating the shared process.env for credentials lets one call
 * clear another's token mid-flight. Pass the returned `env` to sdkQuery options.
 */
export async function resolveSupervisorCredentialEnv(): Promise<SupervisorCredentialEnv> {
  const userId = await resolveSupervisorUserId();
  if (!userId) return { ok: false, reason: "no supervisor credential configured" };

  const cred = await queries.getUserCredential(userId);
  if (!cred) return { ok: false, reason: "designated user has no Claude credential (offboarded?)", userId };

  try {
    const token = await getCipher().decrypt({ ciphertext: cred.ciphertext, nonce: cred.nonce, keyRef: cred.key_ref });
    const env: Record<string, string | undefined> = { ...process.env };
    for (const k of CLAUDE_ENV_KEYS) env[k] = undefined; // clear the other kind
    env[envKeyForKind(cred.kind)] = token;
    return { ok: true, userId, kind: cred.kind, env };
  } catch (err) {
    logger.error({ userId, err: err instanceof Error ? err.message : String(err) }, "Failed to decrypt supervisor credential");
    return { ok: false, reason: "credential decrypt failed", userId };
  }
}
