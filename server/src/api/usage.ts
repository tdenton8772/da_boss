import { Router } from "express";
import { execSync } from "node:child_process";
import { logger } from "../utils/logger.js";

const OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_SCOPES = "user:inference user:profile user:sessions:claude_code";

interface OAuthCreds {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  subscriptionType: string | null;
  rateLimitTier: string | null;
}

interface UsageData {
  five_hour: { utilization: number; resets_at: string } | null;
  seven_day: { utilization: number; resets_at: string } | null;
  seven_day_sonnet: { utilization: number; resets_at: string } | null;
  extra_usage: {
    is_enabled: boolean;
    monthly_limit: number | null;
    used_credits: number | null;
    utilization: number | null;
  } | null;
  account: {
    email: string | null;
    subscriptionType: string | null;
    rateLimitTier: string | null;
  };
  fetched_at: string;
}

let cachedUsage: UsageData | null = null;
let lastFetchAt = 0;
const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes

function readKeychainCreds(): OAuthCreds | null {
  try {
    const raw = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w',
      { encoding: "utf-8", timeout: 5000 }
    ).trim();
    const creds = JSON.parse(raw);
    const oauth = creds.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt || 0,
      subscriptionType: oauth.subscriptionType || null,
      rateLimitTier: oauth.rateLimitTier || null,
    };
  } catch {
    return null;
  }
}

function writeKeychainCreds(creds: OAuthCreds): void {
  try {
    // Read existing, update oauth section, write back
    const raw = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w',
      { encoding: "utf-8", timeout: 5000 }
    ).trim();
    const existing = JSON.parse(raw);
    existing.claudeAiOauth = {
      ...existing.claudeAiOauth,
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      expiresAt: creds.expiresAt,
      subscriptionType: creds.subscriptionType,
      rateLimitTier: creds.rateLimitTier,
    };
    const updated = JSON.stringify(existing);
    // Delete old and re-add
    execSync('security delete-generic-password -s "Claude Code-credentials" 2>/dev/null || true', { timeout: 5000 });
    execSync(
      `security add-generic-password -s "Claude Code-credentials" -w '${updated.replace(/'/g, "'\\''")}'`,
      { timeout: 5000 }
    );
    logger.info("Keychain credentials updated after token refresh");
  } catch (err) {
    logger.error({ err }, "Failed to update keychain credentials");
  }
}

async function refreshOAuthToken(refreshToken: string): Promise<OAuthCreds | null> {
  try {
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
        scope: OAUTH_SCOPES,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      logger.error({ status: res.status }, "Token refresh failed");
      return null;
    }

    const data = await res.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    };

    const newCreds: OAuthCreds = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
      subscriptionType: null,
      rateLimitTier: null,
    };

    logger.info({ expiresIn: data.expires_in }, "OAuth token refreshed");
    return newCreds;
  } catch (err) {
    logger.error({ err }, "Token refresh request failed");
    return null;
  }
}

async function getValidToken(): Promise<{ token: string; creds: OAuthCreds } | null> {
  const creds = readKeychainCreds();
  if (!creds) return null;

  // Token still valid (with 5 min buffer)
  if (creds.expiresAt > Date.now() + 5 * 60 * 1000) {
    return { token: creds.accessToken, creds };
  }

  // Token expired or expiring soon — refresh it
  logger.info("OAuth token expired/expiring, refreshing...");
  const refreshed = await refreshOAuthToken(creds.refreshToken);
  if (!refreshed) return null;

  // Preserve subscription info from old creds
  refreshed.subscriptionType = creds.subscriptionType;
  refreshed.rateLimitTier = creds.rateLimitTier;

  // Write back to keychain so Claude CLI also gets the fresh token
  writeKeychainCreds(refreshed);

  return { token: refreshed.accessToken, creds: refreshed };
}

function getAccountInfo(creds: OAuthCreds): UsageData["account"] {
  return {
    email: null,
    subscriptionType: creds.subscriptionType,
    rateLimitTier: creds.rateLimitTier,
  };
}

// Cache the email so we don't call auth status every time
let cachedEmail: string | null = null;

async function fetchUsage(): Promise<UsageData | null> {
  // Return cache if fresh
  if (cachedUsage && Date.now() - lastFetchAt < CACHE_TTL_MS) {
    return cachedUsage;
  }

  const auth = await getValidToken();
  if (!auth) {
    logger.warn("No valid OAuth token available for usage fetch");
    return cachedUsage;
  }

  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      logger.warn({ status: res.status }, "Usage API returned non-OK");
      return cachedUsage;
    }

    const data = await res.json();
    const account = getAccountInfo(auth.creds);

    // Get email once
    if (!cachedEmail) {
      try {
        const authRaw = execSync(
          `${process.env.CLAUDE_PATH || "claude"} auth status`,
          { encoding: "utf-8", timeout: 5000 }
        ).trim();
        const authData = JSON.parse(authRaw);
        cachedEmail = authData.email || null;
      } catch { /* ignore */ }
    }
    account.email = cachedEmail;

    cachedUsage = {
      five_hour: data.five_hour || null,
      seven_day: data.seven_day || null,
      seven_day_sonnet: data.seven_day_sonnet || null,
      extra_usage: data.extra_usage || null,
      account,
      fetched_at: new Date().toISOString(),
    };
    lastFetchAt = Date.now();

    logger.info({
      five_hour: data.five_hour?.utilization,
      seven_day: data.seven_day?.utilization,
      extra_usage: data.extra_usage?.utilization,
    }, "Usage data fetched");

    return cachedUsage;
  } catch (err) {
    logger.error({ err }, "Failed to fetch usage data");
    return cachedUsage;
  }
}

export function createUsageRouter(): Router {
  const router = Router();

  router.get("/api/usage", async (_req, res) => {
    const usage = await fetchUsage();
    if (!usage) {
      res.json({
        error: "No usage data available — OAuth token may be missing or expired",
      });
      return;
    }
    res.json(usage);
  });

  // Force refresh (bypasses cache)
  router.post("/api/usage/refresh", async (_req, res) => {
    lastFetchAt = 0;
    const usage = await fetchUsage();
    res.json(usage || { error: "Failed to fetch" });
  });

  return router;
}
