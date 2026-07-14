/**
 * Serialize boss-side Claude calls.
 *
 * The Agent SDK spawns the `claude` CLI as a subprocess, and the CLI shares its
 * config/session/OAuth state in one config dir (~/.claude). In the long-lived boss,
 * two Claude calls can run concurrently — a report-back review firing while the
 * supervisor cron is mid-evaluation — and they clobber each other's CLI state, so
 * one intermittently comes back with an empty result. These calls are infrequent
 * and short (maxTurns: 1), so we run them strictly one at a time.
 *
 * This is boss-only; agents run the CLI in their own pods (isolated config dirs).
 */
let chain: Promise<unknown> = Promise.resolve();

export function withClaudeLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  // Keep the chain alive regardless of this call's outcome.
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}
