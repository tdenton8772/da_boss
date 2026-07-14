import { beforeEach, afterEach } from "vitest";
import { newDb } from "pg-mem";
import type { Pool } from "pg";
import { runMigrations } from "../src/db/migrations.js";
import { resetDb } from "../src/db/index.js";
import { resetLoginRateLimit } from "../src/api/auth.js";

beforeEach(async () => {
  // Fresh in-memory Postgres (pg-mem) for each test
  const mem = newDb();
  const { Pool: MemPool } = mem.adapters.createPg();
  const pool = new MemPool() as unknown as Pool;
  await runMigrations(pool);
  resetDb(pool);
  // Login rate-limit state is module-level; clear it so api tests don't leak counts
  resetLoginRateLimit();
});

afterEach(() => {
  resetDb();
});
