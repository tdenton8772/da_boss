import pg from "pg";
import { runMigrations } from "./migrations.js";

// Return timestamp columns as ISO-8601 strings (not JS Date objects) so the rest
// of the app keeps treating created_at/updated_at/etc. as sortable strings, as it
// did under SQLite. Applies to the real pg driver; pg-mem is handled in tests.
pg.types.setTypeParser(
  pg.types.builtins.TIMESTAMPTZ,
  (v) => (v === null ? null : new Date(v).toISOString())
);
pg.types.setTypeParser(
  pg.types.builtins.TIMESTAMP,
  (v) => (v === null ? null : new Date(v).toISOString())
);

let pool: pg.Pool | null = null;

/** The active connection pool. Throws if the DB hasn't been initialized yet. */
export function getPool(): pg.Pool {
  if (!pool) {
    throw new Error("Database not initialized — call initDb() before querying");
  }
  return pool;
}

/**
 * Initialize the pool (from DATABASE_URL) and run migrations. Idempotent: a
 * second call with the pool already set is a no-op. Tests inject a pg-mem pool.
 */
export async function initDb(injected?: pg.Pool): Promise<pg.Pool> {
  if (pool && (!injected || pool === injected)) {
    return pool;
  }
  pool =
    injected ??
    new pg.Pool({
      connectionString:
        process.env.DATABASE_URL ||
        "postgres://daboss:daboss@localhost:5432/daboss",
    });
  await runMigrations(pool);
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Reset the pool singleton — used by tests to swap in a fresh pg-mem pool.
 * Does not close the previous pool (pg-mem pools have nothing to release);
 * production code should use closeDb() instead.
 */
export function resetDb(newPool?: pg.Pool | null): void {
  pool = newPool ?? null;
}

/**
 * Run `fn` inside a transaction on a dedicated client. Commits on success,
 * rolls back on throw. The lease manager (Phase 2) needs this for
 * SELECT ... FOR UPDATE; build it now so it's ready.
 */
export async function withTx<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
