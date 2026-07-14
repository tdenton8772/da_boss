# da_boss Phase 0 — Foundations (scope)

Grounded scoping of Phase 0 from `da_boss-distributed-plan.md` §12, cross-checked
against the **actual current code** and the real infra in `INFRA_HANDOFF.md`.

Phase 0 = **foundations, no distribution yet**:
1. SQLite → Postgres — **DONE** (branch `phase0-postgres`; async `queries.ts`, `pg` + `pg-mem` tests, PG in the local docker-desktop cluster via `k8s/postgres.yaml`)
2. Per-user identity + audit — **SCHEMA DONE** (migration v4: `users`, `agents.created_by_user_id`, `audit_log.user_id`). Auth *mechanism* still deferred (§3.3); identity not yet threaded through session/routes.
3. Domain-neutral core schema (§5.4 — the only expensive-to-unwind decision) — **DONE** (migration v4: `leases`, `intents`, `dev_delta_materialization`; neutrality enforced by `test/neutrality.test.ts`)
4. Infra plumbing: Helm chart, Workload Identity, Secret Manager, GitHub App — TODO (now the on-ramp to running in kind)

**Decision (2026-07-06):** da_boss goes **k8s-only** — not run on the host until it's deployed in the kind cluster. This makes the host-process-kill footgun moot (a pod's PID namespace can't see host `claude` sessions). Develop headless (vitest/pg-mem + tsc) meanwhile.

Nothing here distributes execution (that's Phase 1). The point of Phase 0 is to
lay a base that Phases 1–4 don't have to re-cut.

---

## 0. Current state (verified in code)

- **DB layer**: `better-sqlite3`, singleton `getDb()` (`server/src/db/index.ts`),
  raw-SQL migrations by version (`migrations.ts`, 3 migrations), all SQL confined
  to `queries.ts` (per CLAUDE.md, holds true).
- **All DB access is synchronous** — `db.prepare(...).get()/.run()/.all()`.
- **~105 `queries.*` call sites across 8 files**: `agent/manager.ts`,
  `agent/permissions.ts`, `agent/runner.ts`, `api/discovery.ts`, `api/router.ts`,
  `supervisor/checks.ts`, `supervisor/index.ts`, `tokens/budget.ts`.
- **Auth**: single shared password (`AUTH_PASSWORD`), session-based
  (`api/auth.ts`). No concept of a user. `audit_log` records `user_ip` only.
- **Tests**: in-memory SQLite per test via `resetDb()`; 67 passing.

---

## 1. SQLite → Postgres — the real cost is sync→async, not SQL dialect

`better-sqlite3` is synchronous; `pg` is async. Converting the driver forces
every one of the ~105 call sites to become `await`-ed, and async has to propagate
up through `manager.ts`, `runner.ts`, the supervisor, and the Express routes.
**This is the actual work of the migration** and the plan's "non-negotiable" line
undersells it. SQL dialect differences (`datetime('now')` → `now()`,
`AUTOINCREMENT` → `GENERATED`/`SERIAL`, `INTEGER PRIMARY KEY` rowids, `INSERT OR
IGNORE` → `ON CONFLICT DO NOTHING`, pragmas gone) are mechanical by comparison.

### Recommended approach
- **Make `queries.ts` async**, backed by `pg` (`Pool`). Each function returns a
  `Promise`. Convert call sites to `await`; propagate `async` up the callgraph.
- **Keep tests fast and offline with `pg-mem`** (in-memory Postgres emulator) so
  the `resetDb()` pattern survives and CI needs no live Postgres. Fall back to a
  disposable Postgres (docker / testcontainers) for anything `pg-mem` can't model.
- **One transaction boundary helper** (`withTx`) since `pg` won't give us
  better-sqlite3's implicit per-statement atomicity for free. The lease manager
  (Phase 2) will *need* real transactions (`SELECT … FOR UPDATE` for
  no-overlapping-lease), so build the helper now.
- **Connection**: `DATABASE_URL` env. In-cluster this points at da_boss's **own**
  Postgres — **not** the app's `app-stg-2` (INFRA_HANDOFF §Databases). If we
  use Cloud SQL, replicate the `cloud-sql-proxy` sidecar and its
  `127.0.0.1:5432`-refused-on-drain retry.

### Migration mechanics
- Rewrite `migrations.ts` runner to execute against `pg` (drop the sqlite
  `pragma` calls; keep the version-table pattern — it's driver-agnostic).
- Port migrations 1–3 to Postgres DDL. One-time data copy from the existing
  `da_boss.db` is optional (dev data) — likely just start fresh in the cluster.

**Est. surface**: `db/index.ts`, `db/migrations.ts`, `db/queries.ts` rewritten;
8 caller files touched for `await`; test harness swapped to `pg-mem`. Medium-large
but mechanical once the async decision is made.

---

## 2. Domain-neutral core schema (§5.4) — do this now

The one decision that's painful to unwind through a live system full of
hibernated agents. The core tables get **abstract** column names now, even though
the only implementation is the dev workflow. Git/PR/branch concepts live **only**
in an adapter side-table.

> Note: leases/intents aren't *used* until Phases 2–3. We author the **schema**
> now (cheap) and leave the logic for later. This is exactly §5.4's instruction:
> "write those columns regardless… the single layer painful to migrate later."

### 2.1 `leases` (core — Axis-2 neutral: no path/file/git vocabulary)
```
id                TEXT PRIMARY KEY
holder_agent_id   TEXT NOT NULL REFERENCES agents(id)
resource_ref      TEXT NOT NULL      -- opaque. today a dir/module path; core doesn't know
predicate_kind    TEXT NOT NULL DEFAULT 'path_prefix'  -- how overlap is computed, in code
exclusive         BOOLEAN NOT NULL DEFAULT false        -- broad lease for cross-cutting changes (§6.2)
state             TEXT NOT NULL DEFAULT 'active'         -- active | released | reclaimed
acquired_at       TIMESTAMPTZ NOT NULL DEFAULT now()
expires_at        TIMESTAMPTZ                            -- TTL
heartbeat_at      TIMESTAMPTZ                            -- liveness (reuse fleet heartbeat)
released_at       TIMESTAMPTZ
```
Overlap is a **predicate over `resource_ref`**, not a `file_path` column with a
glob — the whole point of §5.4's first bullet.

### 2.2 `intents` (core object — carries a delta *handle*, not a `pr_id`)
```
id                  TEXT PRIMARY KEY
agent_id            TEXT NOT NULL REFERENCES agents(id)
goal                TEXT NOT NULL
plan                TEXT                 -- from plan mode
affected_scope      JSONB NOT NULL DEFAULT '[]'   -- set of opaque resource_refs (NOT intended_files)
semantic_edit_list  JSONB NOT NULL DEFAULT '[]'   -- renamed X→Y, sig-change Z, added W
proposed_delta      TEXT                 -- opaque handle (NOT pr_id)
delta_state         TEXT NOT NULL DEFAULT 'PROPOSED'  -- PROPOSED|ACCEPTED|REALIZED|CONFIRMED|KICKED_BACK|TERMINAL
created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
```

### 2.3 `dev_delta_materialization` (ADAPTER — the ONLY place git/PR appears)
```
delta_handle        TEXT PRIMARY KEY     -- = intents.proposed_delta
repo                TEXT
branch              TEXT
pr_number           INTEGER
opened_at           TIMESTAMPTZ          -- maps to delta_state PROPOSED
merged_at           TIMESTAMPTZ          -- ACCEPTED
deployed_at         TIMESTAMPTZ          -- REALIZED
health_confirmed_at TIMESTAMPTZ          -- CONFIRMED
```
The `PROPOSED→ACCEPTED→REALIZED→CONFIRMED` ↔ opened→merged→deployed→health-confirmed
mapping lives **here, in the adapter**, never in the core `delta_state` enum.

### 2.4 Neutrality check (the binary test, §9.1)
Grep the five core tables/modules for `pr`, `branch`, `git`, `merge`, `file_path`,
`phoenix`, `pgvector`, `region`. Any hit outside `dev_delta_materialization` (and
the adapter code) is a coupling bug. Cheap CI lint.

> Not now (§9.2): no plugin loader, no adapter registry, no second implementation.
> Just the vocabulary. Extract an interface only when a second real repo appears.

---

## 3. Per-user identity + audit

Multiple Acme devs log in and dispatch agents; we need to know **who**
dispatched what. Today it's one shared password and IP-only audit.

### 3.1 New `users` table
```
id            TEXT PRIMARY KEY
external_id   TEXT UNIQUE      -- Okta subject (see below)
email         TEXT
display_name  TEXT
role          TEXT NOT NULL DEFAULT 'developer'
created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
```

### 3.2 Wire identity through
- `agents` += `created_by_user_id TEXT REFERENCES users(id)` (who dispatched).
- `audit_log` += `user_id TEXT REFERENCES users(id)` (keep `user_ip` too).
- Session carries `user_id`, not just "authenticated: true".

### 3.3 Auth mechanism — DEFERRED (schema stays, mechanism later)
We are **not** picking an IdP in Phase 0. OIDC/Okta is deferred; how da_boss is
surfaced (standalone vs. embedded as an iframe in a parent app that owns auth) is
a later decision with real work in front of it. Access stays very limited by
other means for now (current shared password + Tailscale).

**What we still do now:** keep the §3.1/§3.2 schema and thread `user_id` through
session → agent creation → audit. Even a tiny seeded/allowlisted set of users
benefits from "who dispatched this agent" in the audit log, and it keeps the
exogenous-actor door open (§6.2). The identity *plumbing* is mechanism-agnostic,
so none of it is wasted whichever way auth lands later.

**Not now:** OIDC, Okta wiring, iframe embedding + its cross-origin session/CSP
changes (`SameSite=None; Secure`, `frame-ancestors`, dropping `X-Frame-Options`).
Revisit when the surfacing decision is actually in front of us.

---

## 4. Infra plumbing (grounded by INFRA_HANDOFF — less code, more provisioning)

Not code-shaped; a provisioning checklist. Do in parallel with §1–3.

- [ ] **Own namespace** `daboss` in `YOUR_CLUSTER` (`YOUR_PROJECT`,
      `us-central1`) — never `app`. Own RBAC + ResourceQuota (the app hit a
      quota ceiling; size for bursty workers).
- [ ] **Own Artifact Registry repo** `us-central1-docker.pkg.dev/YOUR_PROJECT/daboss`.
- [ ] **Own Postgres** in `YOUR_PROJECT` (Cloud SQL instance or in-namespace) —
      separate from `app-stg-2`.
- [ ] **Helm chart** for the control plane. Mirror the app's `scripts/deploy-gke.sh`
      pattern: Cloud Build (native amd64 — no local buildx), migrate-Job-first,
      then `kubectl rollout`, **post-rollout smoke gate fails deploy on 5xx**.
      Images deploy `:latest` → force `kubectl rollout restart`.
- [ ] **Workload Identity** for pod→GCP (Secret Manager, later GCS checkpoints).
- [ ] **External Secrets Operator** — ClusterSecretStore `gcp-secret-store`
      (`projectID: YOUR_PROJECT`); Reloader restarts on secret change. Never bake
      creds into images.
- [ ] **GitHub App** (short-lived installation tokens) for worker branch push / PR
      open — not PATs. Delivered via WI + Secret Manager. (Consumed in Phase 1;
      register the App in Phase 0.)
- [ ] **NetworkPolicies** — cluster is default-deny. Author allows for
      control-plane↔(future)worker, →GCP, →DB as they come online.
- [ ] Use `--project=YOUR_PROJECT` explicitly on any non-Tyler-laptop machine
      (the `cx-sa-lab` default-project gotcha).

---

## 5. Suggested order

1. **Postgres migration first** (§1) — async `queries.ts` + `pg` + `pg-mem` tests +
   `withTx`. Ports migrations 1–3. Everything else lands on this base.
2. **Add the new tables in one migration** (§2 + §3.1) — `users`, `leases`,
   `intents`, `dev_delta_materialization`, plus the `agents`/`audit_log` columns.
   Schema only; no lease/intent logic yet.
3. **Identity wiring** (§3.2/§3.3) — thread `user_id` through session, agent
   creation, audit. Auth mechanism per the §3.3 decision.
4. **Neutrality CI lint** (§2.4) — cheap guard so Axis-2 coupling can't creep in.
5. **Infra** (§4) — parallel track; owned partly outside the code.

## 6. Open decisions to confirm before building
- **Postgres host**: Cloud SQL (+proxy sidecar) vs. in-namespace Postgres.
- **Test DB**: `pg-mem` vs. testcontainers (affects CI shape).
- **Dev-data migration**: copy existing `da_boss.db` or start fresh in-cluster.

_Deferred (not blocking Phase 0 code):_ auth mechanism / OIDC / iframe surfacing
(§3.3) — schema is authored mechanism-agnostically now.
