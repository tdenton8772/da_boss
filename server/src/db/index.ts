import Database from "better-sqlite3";
import path from "node:path";
import { runMigrations } from "./migrations.js";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = path.resolve(
      process.env.DB_PATH || path.join(process.cwd(), "..", "da_boss.db")
    );
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
