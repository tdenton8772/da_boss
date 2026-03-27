import type Database from "better-sqlite3";

interface Migration {
  version: number;
  name: string;
  up: string;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    up: `
      CREATE TABLE IF NOT EXISTS agents (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        prompt           TEXT NOT NULL,
        cwd              TEXT NOT NULL,
        state            TEXT NOT NULL DEFAULT 'pending',
        priority         TEXT NOT NULL DEFAULT 'medium',
        permission_mode  TEXT NOT NULL DEFAULT 'default',
        sdk_session_id   TEXT,
        model            TEXT DEFAULT 'claude-sonnet-4-6',
        max_turns        INTEGER,
        max_budget_usd   REAL,
        error_message    TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
        started_at       TEXT,
        completed_at     TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id    TEXT NOT NULL REFERENCES agents(id),
        type        TEXT NOT NULL,
        data        TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_agent_events_agent ON agent_events(agent_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_events_type ON agent_events(type, created_at);

      CREATE TABLE IF NOT EXISTS token_usage (
        id                            INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id                      TEXT NOT NULL REFERENCES agents(id),
        input_tokens                  INTEGER NOT NULL DEFAULT 0,
        output_tokens                 INTEGER NOT NULL DEFAULT 0,
        cache_read_input_tokens       INTEGER NOT NULL DEFAULT 0,
        cache_creation_input_tokens   INTEGER NOT NULL DEFAULT 0,
        cost_usd                      REAL NOT NULL DEFAULT 0,
        recorded_at                   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_token_usage_agent ON token_usage(agent_id, recorded_at);
      CREATE INDEX IF NOT EXISTS idx_token_usage_time ON token_usage(recorded_at);

      CREATE TABLE IF NOT EXISTS permission_requests (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id     TEXT NOT NULL REFERENCES agents(id),
        tool_name    TEXT NOT NULL,
        tool_input   TEXT NOT NULL,
        tool_use_id  TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'pending',
        resolved_at  TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_perm_pending ON permission_requests(agent_id, status);

      CREATE TABLE IF NOT EXISTS budget_config (
        id                  INTEGER PRIMARY KEY CHECK (id = 1),
        daily_budget_usd    REAL NOT NULL DEFAULT 10.0,
        monthly_budget_usd  REAL NOT NULL DEFAULT 200.0,
        updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT OR IGNORE INTO budget_config (id) VALUES (1);

      CREATE TABLE IF NOT EXISTS supervisor_runs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at   TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        findings     TEXT,
        actions      TEXT
      );

      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );
    `,
  },
  {
    version: 2,
    name: "add_supervisor_instructions",
    up: `
      ALTER TABLE agents ADD COLUMN supervisor_instructions TEXT DEFAULT '';
      ALTER TABLE agents ADD COLUMN permission_policy TEXT DEFAULT 'auto';
    `,
  },
];

export function runMigrations(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Create schema_version table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );
  `);

  const currentVersion =
    db.prepare("SELECT MAX(version) as v FROM schema_version").get() as
      | { v: number | null }
      | undefined;
  const current = currentVersion?.v ?? 0;

  for (const migration of migrations) {
    if (migration.version > current) {
      db.exec(migration.up);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(
        migration.version
      );
    }
  }
}
