import type pg from "pg";

interface Migration {
  version: number;
  name: string;
  up: string;
}

// Postgres DDL. Notes on the port from SQLite:
//  - INTEGER PRIMARY KEY AUTOINCREMENT -> SERIAL (int4, so node-pg returns JS
//    numbers, not bigint strings — these tables never approach 2^31 rows)
//  - TEXT DEFAULT (datetime('now'))    -> TIMESTAMPTZ DEFAULT now()
//  - REAL                              -> DOUBLE PRECISION
//  - INSERT OR IGNORE                  -> INSERT ... ON CONFLICT DO NOTHING
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
        max_budget_usd   DOUBLE PRECISION,
        error_message    TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        started_at       TIMESTAMPTZ,
        completed_at     TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS agent_events (
        id          SERIAL PRIMARY KEY,
        agent_id    TEXT NOT NULL REFERENCES agents(id),
        type        TEXT NOT NULL,
        data        TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_agent_events_agent ON agent_events(agent_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_events_type ON agent_events(type, created_at);

      CREATE TABLE IF NOT EXISTS token_usage (
        id                            SERIAL PRIMARY KEY,
        agent_id                      TEXT NOT NULL REFERENCES agents(id),
        input_tokens                  INTEGER NOT NULL DEFAULT 0,
        output_tokens                 INTEGER NOT NULL DEFAULT 0,
        cache_read_input_tokens       INTEGER NOT NULL DEFAULT 0,
        cache_creation_input_tokens   INTEGER NOT NULL DEFAULT 0,
        cost_usd                      DOUBLE PRECISION NOT NULL DEFAULT 0,
        recorded_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_token_usage_agent ON token_usage(agent_id, recorded_at);
      CREATE INDEX IF NOT EXISTS idx_token_usage_time ON token_usage(recorded_at);

      CREATE TABLE IF NOT EXISTS permission_requests (
        id           SERIAL PRIMARY KEY,
        agent_id     TEXT NOT NULL REFERENCES agents(id),
        tool_name    TEXT NOT NULL,
        tool_input   TEXT NOT NULL,
        tool_use_id  TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'pending',
        resolved_at  TIMESTAMPTZ,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_perm_pending ON permission_requests(agent_id, status);

      CREATE TABLE IF NOT EXISTS budget_config (
        id                  INTEGER PRIMARY KEY CHECK (id = 1),
        daily_budget_usd    DOUBLE PRECISION NOT NULL DEFAULT 10.0,
        monthly_budget_usd  DOUBLE PRECISION NOT NULL DEFAULT 200.0,
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO budget_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS supervisor_runs (
        id           SERIAL PRIMARY KEY,
        started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at TIMESTAMPTZ,
        findings     TEXT,
        actions      TEXT
      );
    `,
  },
  {
    version: 2,
    name: "add_supervisor_instructions",
    up: `
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS supervisor_instructions TEXT DEFAULT '';
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS permission_policy TEXT DEFAULT 'auto';
    `,
  },
  {
    version: 3,
    name: "add_audit_log_and_fleet",
    up: `
      CREATE TABLE IF NOT EXISTS audit_log (
        id          SERIAL PRIMARY KEY,
        user_ip     TEXT,
        action      TEXT NOT NULL,
        target_type TEXT,
        target_id   TEXT,
        details     TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_audit_log_time ON audit_log(created_at);
      CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action, created_at);

      CREATE TABLE IF NOT EXISTS fleet_nodes (
        id               TEXT PRIMARY KEY,
        hostname         TEXT NOT NULL,
        url              TEXT NOT NULL,
        role             TEXT NOT NULL DEFAULT 'worker',
        status           TEXT NOT NULL DEFAULT 'offline',
        last_heartbeat   TIMESTAMPTZ,
        agent_capacity   INTEGER NOT NULL DEFAULT 3,
        agent_count      INTEGER NOT NULL DEFAULT 0,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      ALTER TABLE agents ADD COLUMN IF NOT EXISTS node_id TEXT;
    `,
  },
  {
    // Domain-neutral core (distributed-plan §5.4) + per-user identity.
    // SCHEMA ONLY — no lease/intent logic yet; authored now because a Postgres
    // schema threaded through a live system is the one expensive-to-unwind thing.
    //
    // Neutrality boundary (§9.1 Axis 2): the CORE tables `leases` and `intents`
    // must contain NO software-development-workflow vocabulary (git/PR/branch/
    // merge/diff/file). That vocabulary lives ONLY in the adapter table
    // `dev_delta_materialization`. Enforced by test/neutrality.test.ts.
    version: 4,
    name: "domain_neutral_core_and_identity",
    up: `
      -- ── Identity ────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        external_id   TEXT UNIQUE,        -- IdP subject (e.g. Okta); null until auth is wired
        email         TEXT,
        display_name  TEXT,
        role          TEXT NOT NULL DEFAULT 'developer',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- who dispatched the agent / performed the action (nullable until identity is wired)
      ALTER TABLE agents    ADD COLUMN IF NOT EXISTS created_by_user_id TEXT REFERENCES users(id);
      ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS user_id            TEXT REFERENCES users(id);

      -- ── Lease (CORE, abstract) ──────────────────────────
      -- resource_ref is opaque: today a dir/module path, but the core doesn't know that.
      -- Overlap is computed in code from predicate_kind, NOT a path-prefix column here.
      CREATE TABLE IF NOT EXISTS leases (
        id               TEXT PRIMARY KEY,
        holder_agent_id  TEXT NOT NULL REFERENCES agents(id),
        resource_ref     TEXT NOT NULL,
        predicate_kind   TEXT NOT NULL DEFAULT 'path_prefix',
        exclusive        BOOLEAN NOT NULL DEFAULT false,
        state            TEXT NOT NULL DEFAULT 'active',   -- active | released | reclaimed
        acquired_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at       TIMESTAMPTZ,                      -- TTL
        heartbeat_at     TIMESTAMPTZ,                      -- liveness
        released_at      TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_leases_active ON leases(state, resource_ref);
      CREATE INDEX IF NOT EXISTS idx_leases_holder ON leases(holder_agent_id);

      -- ── Intent / core object (CORE, abstract) ───────────
      -- Carries a proposed_delta HANDLE and an abstract delta_state — never a pr_id.
      -- affected_scope is a set of opaque resource_refs, not "intended_files".
      CREATE TABLE IF NOT EXISTS intents (
        id                  TEXT PRIMARY KEY,
        agent_id            TEXT NOT NULL REFERENCES agents(id),
        goal                TEXT NOT NULL,
        plan                TEXT,
        affected_scope      JSONB NOT NULL DEFAULT '[]',
        semantic_edit_list  JSONB NOT NULL DEFAULT '[]',
        proposed_delta      TEXT UNIQUE,                   -- opaque handle
        delta_state         TEXT NOT NULL DEFAULT 'PROPOSED',
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_intents_agent ON intents(agent_id);
      CREATE INDEX IF NOT EXISTS idx_intents_delta_state ON intents(delta_state);

      -- ── Dev materialization (ADAPTER — the ONLY place git/PR appears) ──
      -- Maps the abstract delta_state to opened -> merged -> deployed -> health-confirmed.
      CREATE TABLE IF NOT EXISTS dev_delta_materialization (
        delta_handle         TEXT PRIMARY KEY,   -- = intents.proposed_delta
        repo                 TEXT,
        branch               TEXT,
        pr_number            INTEGER,
        opened_at            TIMESTAMPTZ,         -- delta_state PROPOSED
        merged_at            TIMESTAMPTZ,         -- ACCEPTED
        deployed_at          TIMESTAMPTZ,        -- REALIZED
        health_confirmed_at  TIMESTAMPTZ         -- CONFIRMED
      );
    `,
  },
  {
    // Multi-tenant identity + per-user credential vault. Each user supplies their
    // own Claude token (bills to their subscription); the token is stored
    // encrypted (SecretCipher seam) and injected into the pods THEY dispatch.
    version: 5,
    name: "user_credentials_and_local_auth",
    up: `
      -- local-auth password (null for OIDC users)
      ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

      -- one Claude credential per user, encrypted at rest. The core stores only
      -- opaque ciphertext + which key sealed it; the plaintext token never lands here.
      CREATE TABLE IF NOT EXISTS user_credentials (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id),
        kind         TEXT NOT NULL,   -- 'claude_oauth_token' | 'anthropic_api_key'
        ciphertext   TEXT NOT NULL,
        nonce        TEXT NOT NULL,
        key_ref      TEXT NOT NULL,   -- which cipher/key sealed it (e.g. local:v1)
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_id)
      );
    `,
  },
  {
    // SEAM 1 (first cut): bring source INTO the agent pod. The worker git-clones
    // repo_url@repo_ref into /work before running — data arrives over the network,
    // never mounted from node/local storage.
    version: 6,
    name: "agent_repo_source",
    up: `
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS repo_url TEXT;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS repo_ref TEXT;
    `,
  },
  {
    // Per-user git credential (PAT) — encrypted, injected into the pods a user
    // dispatches so their agents clone/push private repos AS them. Separate table
    // from user_credentials (which holds the Claude token) to keep it simple.
    version: 7,
    name: "user_git_credentials",
    up: `
      CREATE TABLE IF NOT EXISTS user_git_credentials (
        user_id     TEXT PRIMARY KEY REFERENCES users(id),
        kind        TEXT NOT NULL DEFAULT 'github_pat',
        ciphertext  TEXT NOT NULL,
        nonce       TEXT NOT NULL,
        key_ref     TEXT NOT NULL,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
  {
    // The agent's branch belongs to the WORK, not the ephemeral agent id. Stable,
    // convention-named (type/username/issue-description), continued across turns.
    version: 8,
    name: "agent_branch",
    up: `
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS branch TEXT;
    `,
  },
  {
    version: 9,
    name: "permission_resolution_answer",
    up: `
      ALTER TABLE permission_requests ADD COLUMN IF NOT EXISTS resolution_answer TEXT;
    `,
  },
  {
    // Ensure there's always an admin (to offboard others). New deployments get one
    // via the first-registration bootstrap; existing ones predate roles, so promote
    // the earliest user if no admin exists yet. Idempotent + no-op on an empty DB.
    version: 10,
    name: "bootstrap_admin_role",
    up: `
      UPDATE users SET role = 'admin'
      WHERE id = (SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin');
    `,
  },
  {
    // Offboard tombstone. We hard-delete the user row (to reclaim storage), but an
    // IdP (Okta) would just re-provision them on the next valid token. This keeps a
    // tiny deny record — keyed by IdP subject AND email — that BOTH auth providers
    // consult before admitting/provisioning, so an offboard actually sticks.
    version: 11,
    name: "offboarded_identities",
    up: `
      CREATE TABLE IF NOT EXISTS offboarded_identities (
        id             SERIAL PRIMARY KEY,
        external_id    TEXT,           -- IdP subject (OIDC/Okta)
        email          TEXT,           -- local login + fallback match
        offboarded_by  TEXT,           -- admin user id (not FK; they may outlive it)
        offboarded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_offboarded_ext ON offboarded_identities(external_id);
      CREATE INDEX IF NOT EXISTS idx_offboarded_email ON offboarded_identities(lower(email));
    `,
  },
  {
    // Generic singleton settings (key/value). First use: which user's vault
    // credential powers the headless supervisor ('supervisor_credential_user_id').
    version: 12,
    name: "app_settings",
    up: `
      CREATE TABLE IF NOT EXISTS app_settings (
        key         TEXT PRIMARY KEY,
        value       TEXT,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
  {
    // Agent sidecar: live command-and-control alongside a running agent.
    // - last_heartbeat_at: the sidecar beats while its pod is alive; a running
    //   agent with a stale beat = hung/dead pod (the orchestrator's blind spot).
    // - agent_commands: durable command log (history) delivered live via NOTIFY;
    //   a listener reads unacked rows on (re)connect so a dropped NOTIFY is never
    //   lost. Steady state is push, not poll.
    version: 13,
    name: "agent_sidecar_c2",
    up: `
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;
      CREATE TABLE IF NOT EXISTS agent_commands (
        id           SERIAL PRIMARY KEY,
        agent_id     TEXT NOT NULL REFERENCES agents(id),
        command      TEXT NOT NULL,
        args         JSONB NOT NULL DEFAULT '{}',
        status       TEXT NOT NULL DEFAULT 'pending',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        handled_at   TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_cmd_pending ON agent_commands(agent_id, status);
    `,
  },
  {
    // The agent's opened pull request. (The "proper" home is
    // dev_delta_materialization once the intents layer is live; until then this
    // is a pragmatic pointer for the UI + idempotency.)
    version: 14,
    name: "agent_pull_request",
    up: `
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS pr_url TEXT;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS pr_number INTEGER;
    `,
  },
  {
    // Advisory strikes: how many times the agent ignored a freeze-lease advisory
    // (edited frozen territory, or forked a frozen symbol). The supervisor blocks
    // an agent that accumulates too many.
    version: 15,
    name: "agent_advisory_strikes",
    up: `
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS advisory_strikes INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // Pipeline runner: arbitrary named secrets (deploy creds etc.) in the same
    // encrypted vault as Claude/git tokens, and a log of pipeline phase runs.
    version: 16,
    name: "pipeline_secrets_and_runs",
    up: `
      CREATE TABLE IF NOT EXISTS user_secrets (
        user_id     TEXT NOT NULL REFERENCES users(id),
        name        TEXT NOT NULL,
        ciphertext  TEXT NOT NULL,
        nonce       TEXT NOT NULL,
        key_ref     TEXT NOT NULL,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, name)
      );
      CREATE TABLE IF NOT EXISTS pipeline_runs (
        id                  TEXT PRIMARY KEY,
        repo_url            TEXT,
        git_ref             TEXT,
        phase               TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'pending',  -- pending|running|passed|failed
        exit_code           INTEGER,
        artifact            TEXT,
        log                 TEXT,
        created_by_user_id  TEXT REFERENCES users(id),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at        TIMESTAMPTZ
      );
    `,
  },
  {
    // Link a pipeline run to the agent whose branch/PR it gates (test agent).
    version: 17,
    name: "pipeline_run_agent",
    up: `
      ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS agent_id TEXT;
      ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS pr_posted BOOLEAN NOT NULL DEFAULT false;
    `,
  },
  {
    // Pre-audited review for the human gate: a reviewing agent's assessment +
    // recommendation, produced before a gated run can be approved.
    version: 18,
    name: "pipeline_run_review",
    up: `
      ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS review TEXT;
      ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS recommendation TEXT;
    `,
  },
  {
    // The report-back verdict for an agent's change: the reviewing agent's
    // recommendation (merge/fix/hold) + assessment, produced after tests, so the
    // agent "comes back to you" with a next step instead of just sitting on a PR.
    version: 19,
    name: "agent_review",
    up: `
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS review TEXT;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS recommendation TEXT;
    `,
  },
  {
    // Land gate: a test run flagged land_on_pass is the pre-merge retest (after
    // rebasing on main). On green the completion listener merges; on red it blocks.
    version: 20,
    name: "pipeline_run_land",
    up: `
      ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS land_on_pass BOOLEAN NOT NULL DEFAULT false;
    `,
  },
  {
    // An agent can run under a specific k8s ServiceAccount + image — e.g. a
    // deploy-manager agent runs as the Workload-Identity deploy SA with a
    // gcloud/kubectl image, so it can drive a real deploy AND stream it live.
    version: 21,
    name: "agent_service_account_image",
    up: `
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS service_account TEXT;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS worker_image TEXT;
    `,
  },
  {
    // Explicit per-user access flag — the source of truth for who may use
    // da_boss. Auto-granted on login when the IdP presents an access-granting
    // role (config: OIDC_ALLOWED_ROLES), and manually settable by an admin.
    // Gating on this flag (not the raw role) gives an inspectable allowlist +
    // a kill switch, independent of the IdP's coarse role model.
    version: 22,
    name: "user_access_approved",
    up: `
      ALTER TABLE users ADD COLUMN IF NOT EXISTS access_approved BOOLEAN NOT NULL DEFAULT false;
    `,
  },
  {
    // A deploy-manager agent executes a pipeline_run (the deploy). Linking the run
    // on the agent lets its pod carry a RECORDER sidecar tied to that run, so the
    // deploy's real exit code (/work/.daboss/exit) drives the run status through
    // the normal recorder → NOTIFY → completion path — instead of inferring it from
    // the agent's (unreliable) lifecycle.
    version: 23,
    name: "agent_pipeline_run_id",
    up: `
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS pipeline_run_id TEXT;
    `,
  },
  {
    // A review is a first-class AGENT (repo checked out, full tools, uncapped) so
    // it can read the actual code and be as in-depth as it wants. review_of_agent_id
    // links a review agent back to the agent/PR it's reviewing; on completion its
    // RECOMMENDATION is parsed onto that agent.
    version: 24,
    name: "agent_review_of",
    up: `
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS review_of_agent_id TEXT;
    `,
  },
  {
    // Deploy manifest: which deploy shipped a change. Set when a deploy is
    // dispatched — it claims the merged changes currently on main. Gives a two-way
    // link (change → its deploy, deploy → what it shipped) so work→review→deploy
    // reads as one trace.
    version: 25,
    name: "agent_deployed_by",
    up: `
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS deployed_by_agent_id TEXT;
    `,
  },
  {
    // Display-only marker for an agent that ADOPTS an existing PR/branch (the
    // branch override) instead of creating a fresh one — stores the user's
    // original reference ("PR #17" or the branch name) so the UI can show
    // "adopting …". Adoption itself is a pure consequence of agents.branch +
    // findOpenPr; this column changes no pipeline behaviour.
    version: 26,
    name: "agent_adopted_ref",
    up: `
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS adopted_ref TEXT;
    `,
  },
  {
    // A review as a FIRST-CLASS entity (review-platform plan §3.1) instead of a
    // side-effect of an agent carrying review_of_agent_id. Additive: the legacy
    // agents.review_of_agent_id linkage still drives the UI + the worker's
    // no-push gate; this row is the queryable, requestable record of the review.
    // reviewed_agent_id is today's delta handle (becomes delta_id when the delta
    // entity lands); no forge/PR vocabulary here, per §8.
    version: 27,
    name: "reviews_entity",
    up: `
      CREATE TABLE IF NOT EXISTS reviews (
        id                 TEXT PRIMARY KEY,
        reviewed_agent_id  TEXT NOT NULL REFERENCES agents(id),
        review_agent_id    TEXT REFERENCES agents(id),
        requested_by       TEXT REFERENCES users(id),
        runner             TEXT NOT NULL DEFAULT 'pod',
        status             TEXT NOT NULL DEFAULT 'pending',
        recommendation     TEXT,
        rationale          TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at       TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_reviews_reviewed ON reviews(reviewed_agent_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_reviews_review_agent ON reviews(review_agent_id);
    `,
  },
  {
    // API tokens — headless auth for a non-human caller (the MCP surface's auth).
    // A token maps to a principal (a users row; a bot is just a users row created
    // for it, so it gets its own creds naturally). Only the sha256 hash is stored.
    // scopes: comma-separated (TEXT, not TEXT[] — pg-mem-friendly). Default-deny:
    // a token is honoured ONLY on explicitly token-allowed routes (see tokens.ts).
    version: 28,
    name: "api_tokens",
    up: `
      CREATE TABLE IF NOT EXISTS api_tokens (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL REFERENCES users(id),
        name          TEXT,
        token_hash    TEXT NOT NULL UNIQUE,
        scopes        TEXT NOT NULL DEFAULT '',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_used_at  TIMESTAMPTZ,
        revoked_at    TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);
      CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
    `,
  },
  {
    // T-shirt pod sizing. size is null until set — either by the caller (fast
    // path) or by the supervisor's assessment. The dispatcher maps it to a
    // resource preset (agent/sizing.ts). No cluster specifics here.
    version: 29,
    name: "agent_size",
    up: `
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS size TEXT;
    `,
  },
  {
    // Pre-deploy test gate: test-phase runs launched on `main` when a deploy is
    // proposed carry the deploy run's id here, so the completion listener knows
    // when the whole gate batch is done and can trigger the deploy review with
    // the results in hand. Null for every other run.
    version: 30,
    name: "deploy_gate_run_id",
    up: `
      ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS deploy_gate_run_id TEXT;
    `,
  },
  {
    // The agent's plan: the FULL TodoWrite todos JSON, written verbatim by the worker
    // on each TodoWrite. Kept separate from the message trace (which stores only a
    // truncated preview) so the Plan view renders the actual, complete task list.
    version: 31,
    name: "agent_plan",
    up: `
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS plan TEXT;
    `,
  },
  {
    // User-uploaded files for an agent (screenshots, docs, etc.). Stored here because
    // the control plane can't write into the agent's pod; the worker downloads them
    // into /work/uploads on dispatch so the agent can read them — restoring the
    // "hand a file to the agent" workflow that worked when everything ran locally.
    version: 32,
    name: "agent_files",
    up: `
      CREATE TABLE IF NOT EXISTS agent_files (
        id           TEXT PRIMARY KEY,
        agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        mime         TEXT,
        size         INTEGER NOT NULL,
        bytes        BYTEA NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_agent_files_agent ON agent_files(agent_id);
    `,
  },
  {
    // Per-agent toolchain flavor: a Dockerfile build target (multi-stage) in the
    // repo's .daboss/agent.Dockerfile. Lets one repo declare several agent
    // toolchains (e.g. `minimal`, `elixir`) and each agent pick per task — not
    // every agent needs the full bake. Null → the Dockerfile's final stage.
    version: 33,
    name: "agent_toolchain",
    up: `
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS toolchain TEXT;
    `,
  },
  {
    version: 34,
    name: "permission_resolved_by",
    // Who resolved a permission request: a user id (human click via UI/MCP),
    // 'supervisor' (the second-agent auto-approval), or 'timeout' (the worker's
    // own auto-deny). NULL on rows resolved before this migration.
    up: `
      ALTER TABLE permission_requests ADD COLUMN IF NOT EXISTS resolved_by TEXT;
    `,
  },
  {
    version: 35,
    name: "per_user_budgets",
    // Two-tier budgets: agents bill to the DISPATCHING user's own credential, so
    // caps must exist per user (default in budget_config, per-user override on
    // users) alongside the global fleet ceiling. NULL = uncapped at that tier.
    up: `
      ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_budget_usd DOUBLE PRECISION;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_budget_usd DOUBLE PRECISION;
      ALTER TABLE budget_config ADD COLUMN IF NOT EXISTS user_daily_default_usd DOUBLE PRECISION;
      ALTER TABLE budget_config ADD COLUMN IF NOT EXISTS user_monthly_default_usd DOUBLE PRECISION;
    `,
  },
];

export async function runMigrations(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );
    `);

    const res = await client.query<{ v: number | null }>(
      "SELECT MAX(version) as v FROM schema_version"
    );
    const current = res.rows[0]?.v ?? 0;

    for (const migration of migrations) {
      if (migration.version > current) {
        await client.query("BEGIN");
        try {
          await client.query(migration.up);
          await client.query(
            "INSERT INTO schema_version (version) VALUES ($1)",
            [migration.version]
          );
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        }
      }
    }
  } finally {
    client.release();
  }
}
