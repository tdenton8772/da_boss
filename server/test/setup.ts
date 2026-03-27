import { beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../src/db/migrations.js";
import { resetDb } from "../src/db/index.js";

beforeEach(() => {
  // Fresh in-memory DB for each test
  const db = new Database(":memory:");
  runMigrations(db);
  resetDb(db);
});

afterEach(() => {
  resetDb();
});
