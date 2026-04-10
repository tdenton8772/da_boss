import { Router } from "express";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
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
  [key: string]: unknown;
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
  local: ReturnType<typeof buildLocalSummary> | null;
  fetched_at: string;
}

let cachedUsage: UsageData | null = null;
let lastFetchAt = 0;
const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes

// Tokens consumed locally since the last successful OAuth refresh.
// Used for predictive utilization between server-side refreshes.
let tokensSinceRefresh = 0;
// Calibration: tokens per 1% of 5-hour utilization. Learned from observed deltas.
let tokensPerPct5h = 50_000; // initial guess; refined on each refresh via EMA
let prevRefreshSnapshot: { fivehourPct: number; tokensConsumed: number } | null = null;

export function recordTokensConsumed(tokens: number): void {
  if (tokens > 0) tokensSinceRefresh += tokens;
}

/** Effective utilization = cached OAuth value + predicted delta from local consumption. */
export function getEffectiveUtilization(): { fivehour: number; sevenday: number } {
  const cached5h = (cachedUsage?.five_hour as { utilization?: number } | null)?.utilization ?? 0;
  const cached7d = (cachedUsage?.seven_day as { utilization?: number } | null)?.utilization ?? 0;
  if (tokensPerPct5h <= 0) return { fivehour: cached5h, sevenday: cached7d };
  const predictedDeltaPct = tokensSinceRefresh / tokensPerPct5h;
  return {
    fivehour: Math.min(150, cached5h + predictedDeltaPct),
    sevenday: Math.min(150, cached7d + predictedDeltaPct / 35), // 5h ≈ 1/35 of a week
  };
}

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
  // Always attach fresh local stats
  const attachLocal = (data: UsageData | null): UsageData | null => {
    if (!data) return null;
    const localStats = readStatsCache();
    return { ...data, local: localStats ? buildLocalSummary(localStats) : null };
  };

  // Return cache if fresh
  if (cachedUsage && Date.now() - lastFetchAt < CACHE_TTL_MS) {
    return attachLocal(cachedUsage);
  }

  const auth = await getValidToken();
  if (!auth) {
    logger.warn("No valid OAuth token available for usage fetch");
    return attachLocal(cachedUsage);
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
      return attachLocal(cachedUsage);
    }

    const data = await res.json();
    logger.info({ rawUsageKeys: Object.keys(data), rawUsage: JSON.stringify(data).substring(0, 2000) }, "Raw usage API response");
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

    const localStats = readStatsCache();
    cachedUsage = {
      ...data,
      account,
      fetched_at: new Date().toISOString(),
      local: localStats ? buildLocalSummary(localStats) : null,
    };
    lastFetchAt = Date.now();

    // Calibrate tokensPerPct5h: how many tokens did 1% of utilization cost between refreshes?
    const newPct = data.five_hour?.utilization ?? 0;
    if (prevRefreshSnapshot && tokensSinceRefresh > 0) {
      const deltaPct = newPct - prevRefreshSnapshot.fivehourPct;
      if (deltaPct > 0.5) {
        const observed = tokensSinceRefresh / deltaPct;
        // Exponential moving average — weight new observation 30%
        tokensPerPct5h = 0.7 * tokensPerPct5h + 0.3 * observed;
        logger.info({ deltaPct, tokens: tokensSinceRefresh, observed, ema: tokensPerPct5h }, "Calibrated tokensPerPct5h");
      }
    }
    prevRefreshSnapshot = { fivehourPct: newPct, tokensConsumed: tokensSinceRefresh };
    tokensSinceRefresh = 0;

    logger.info({
      five_hour: data.five_hour?.utilization,
      seven_day: data.seven_day?.utilization,
      extra_usage: data.extra_usage?.utilization,
      tokensPerPct5h,
    }, "Usage data fetched");

    return attachLocal(cachedUsage);
  } catch (err) {
    logger.error({ err }, "Failed to fetch usage data");
    return attachLocal(cachedUsage);
  }
}

function readStatsCache(): {
  modelUsage: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>;
  dailyModelTokens: Array<{ date: string; tokensByModel: Record<string, number> }>;
  totalSessions: number;
  totalMessages: number;
} | null {
  try {
    const cachePath = join(homedir(), ".claude", "stats-cache.json");
    logger.info({ cachePath }, "Reading stats cache");
    const raw = readFileSync(cachePath, "utf-8");
    const parsed = JSON.parse(raw);
    logger.info({ keys: Object.keys(parsed), hasModelUsage: "modelUsage" in parsed }, "Stats cache loaded");
    return parsed;
  } catch (err) {
    logger.error({ err }, "Failed to read stats cache");
    return null;
  }
}

function buildLocalSummary(stats: NonNullable<ReturnType<typeof readStatsCache>>) {
  const models: Record<string, { input: number; output: number; cacheRead: number; cacheCreate: number }> = {};
  for (const [model, u] of Object.entries(stats.modelUsage || {})) {
    models[model] = {
      input: u.inputTokens,
      output: u.outputTokens,
      cacheRead: u.cacheReadInputTokens,
      cacheCreate: u.cacheCreationInputTokens,
    };
  }

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const recent = (stats.dailyModelTokens || []).filter(
    (d) => new Date(d.date) >= sevenDaysAgo
  );
  const recentByModel: Record<string, number> = {};
  for (const day of recent) {
    for (const [model, tokens] of Object.entries(day.tokensByModel)) {
      recentByModel[model] = (recentByModel[model] || 0) + tokens;
    }
  }

  return {
    allTime: models,
    last7Days: recentByModel,
    totalSessions: stats.totalSessions,
    totalMessages: stats.totalMessages,
  };
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
