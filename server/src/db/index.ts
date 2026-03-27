import Database from "better-sqlite3";
import path from "node:path";
import { runMigrations } from "./migrations.js";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = process.env.DB_PATH || path.resolve(process.cwd(), "..", "da_boss.db");
    db = new Database(dbPath);
    runMigrations(db);
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** Reset the DB singleton — used for testing with in-memory databases */
export function resetDb(newDb?: Database.Database): void {
  if (db && db !== newDb) {
    try { db.close(); } catch { /* already closed */ }
  }
  db = newDb ?? null;
}
