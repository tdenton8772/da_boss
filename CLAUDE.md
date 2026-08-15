# da_boss — Control Plane for Claude Code Agent Fleets

Multi-user platform that runs Claude Code agents in Kubernetes pods (one pod per agent, per-user credentials) and drives their work through a test → review → merge → deploy pipeline. Built on `@anthropic-ai/claude-agent-sdk`. Domain-neutral: target repos declare toolchain + pipeline in their own `.daboss/` directory.

**Public repo.** Everything committed must be publishable. Deployment specifics (`k8s/` manifests except the two tracked `.md` files, `cloudbuild.daboss.yaml`, `INFRA_HANDOFF.md`) are gitignored — they exist locally but must never be committed.

## Quick Start

```bash
npm run test         # 287 tests, 35 files (offline, pg-mem)
npm run build        # production build (server tsc + ui vite)
npm run dev          # local dev server (:3847) + vite UI (:3848) — needs PG port-forward (below)
```

Auth is per-user (register in the UI; first registered user becomes admin). `.env` needs `DATABASE_URL`, `SESSION_SECRET`, and `DABOSS_CIPHER_KEY` (see `.env.example`).

### Run in the local kind cluster (preferred — see "k8s-only" below)

```bash
# Postgres (once): applied to docker-desktop cluster, then port-forward for dev
kubectl --context docker-desktop apply -f k8s/postgres.yaml
kubectl --context docker-desktop -n daboss port-forward svc/postgres 5432:5432 &

# control plane: build image (docker-desktop kind shares the local image store), deploy, UI on :8080
docker build -t da-boss:<tag> .        # tag must match BOTH the Deployment image AND its WORKER_IMAGE env
kubectl --context docker-desktop apply -f k8s/daboss.yaml
kubectl --context docker-desktop -n daboss rollout restart deploy/daboss
kubectl --context docker-desktop -n daboss port-forward svc/daboss 8080:3847 &
```

**k8s-only:** don't run agent execution on the host — the in-process runner scans the host process table and can kill unrelated `claude` sessions. Inside a pod's PID namespace it can't. `AGENT_EXECUTION=pod` in cluster manifests.

**WORKER_IMAGE drift gotcha:** `kubectl set image` updates only the boss container — agent pods launch from the `WORKER_IMAGE` env var, which stays stale. Update both together (the manifests keep them in sync; ad-hoc image bumps don't).

## Architecture

```
Browser (React :3848)  ──REST + WS──▶  Boss (Express :3847)  ──▶  Kubernetes API
MCP clients ──POST /mcp──▶                 │                       ├─ agent pods (worker + optional sidecar)
                                           │                       ├─ pipeline pods (runner + recorder)
                                      Postgres ◀─LISTEN/NOTIFY──── ├─ kaniko build pods
                                           │                       └─ cleanup pods
                              Supervisor (cron + dispatch queue; optional standalone orchestrator pod)
```

**Pod↔boss bus:** pods talk to the boss ONLY via Postgres — LISTEN/NOTIFY channels (`daboss_agent_event`, `daboss_permission`, `daboss_pipeline_done`, `daboss_agent_queued`, `daboss_agent_cmd`) plus row polling. No shared memory. `api/live-relay.ts` re-emits pod events onto the in-process bus.

### Server (`server/src/`)

| Module | Purpose |
|---|---|
| `index.ts` | Entry — Express 5, session, WS, static UI, starts: live relay, pipeline listener, dispatch queue, pod reaper, heartbeat reaper, main-watch, phase scheduler |
| `config.ts` / `models.ts` | Env config; `SUPPORTED_MODELS` + `DEFAULT_MODEL` (opus-5) — UI model picker must stay in sync |
| `agent/manager.ts` | Create/start/pause/resume/kill/input, branch naming, input queues, restore on restart, `offboardUser` |
| `agent/pod-dispatcher.ts` | Pod-per-agent: pod build, ephemeral cred Secret, per-user RWO workspace PVC, reaper, failure reasons, lost-volume recovery, pipeline/cleanup pod launch |
| `agent/runner.ts` | Legacy in-process runner (dev only) — wraps SDK `query()`, host PID tracking |
| `agent/image-builder.ts` | Kaniko in-cluster builds for pipeline `build:` images; single-flight, adopts in-flight pods |
| `agent/agent-image.ts` | Self-provisioning agent images from repo `.daboss/agent.Dockerfile`; content-addressed tags; `daboss-hash-include`; toolchain flavors = build targets |
| `agent/sizing.ts` | T-shirt pod sizes s/m/l/xl; presets overridable via env + admin UI |
| `agent/tool-policy.ts` | Shared safe/escalate tool policy (`auto`/`ask`/`strict`) — single source of truth for boss handler AND pod worker |
| `agent/permissions.ts` | In-process `canUseTool` + permission resolution |
| `agent/templates.ts` | Built-in templates (PR Adopter, Code Reviewer, …) |
| `pipeline/config.ts` | Parses `.daboss/pipeline.yaml` (phases: command/image/build/requires/params/gate/only_ref/adapter/lease/services/service_account/agent/schedule/artifact_from/expose_to_agents) |
| `pipeline/service.ts` | Phase resolution + launch; test phases; deploy-gate tests; artifact seeding (`$DABOSS_SEED`, ≤900KB) |
| `pipeline/runner.ts` / `recorder.ts` | Pipeline pod entrypoint; recorder sidecar writes `/work/.daboss/{exit,log,artifact}` |
| `pipeline/completion.ts` | `LISTEN daboss_pipeline_done` → PR comment, ready-on-green, land-on-pass merge, propose deploy |
| `pipeline/review-agent.ts` / `review-logic.ts` / `review.ts` | Review AGENT dispatch (sonnet-5), verdict extraction → `merge|fix|hold`; fork PRs via `refs/pull/N/head` (untrusted) |
| `pipeline/deploy-agent.ts` | Deploy agent dispatch, branch→staging deploys, deploy-run reconciliation |
| `pipeline/main-watch.ts` | Polls active repos' main HEAD; re-runs test phases when it moves (manual merges bypass da_boss) |
| `pipeline/scheduler.ts` | `schedule: nightly` phase sweeps |
| `worker/index.ts` | Pod-side agent loop: clone, SDK loop, DB-mediated permissions, steer listener, uploads → `/work/uploads`, plan capture from `~/.claude/plans`, auto-commit + push + draft PR per turn, `WORKER_SCRIPT` scripted mode |
| `worker/project-context.ts` / `repo-mcp.ts` | Inject repo CLAUDE.md; load repo `.mcp.json` (skipped for reviewers/untrusted) |
| `worker/cleanup.ts` | State-cleanup pod — prunes deleted agents' transcripts from the user's workspace shard |
| `sidecar/index.ts` | Native sidecar: heartbeat, git telemetry, command channel, freeze-lease cycle + evasion strikes |
| `leasing/freeze-set.ts` | Semantic blast radius: git diff + universal-ctags + git grep (edited fns + 1-hop callers) |
| `orchestrator/index.ts` | Standalone supervisor pod entrypoint |
| `supervisor/checks.ts` | Stuck/stale/budget checks, lease reclamation + overlap alerts, Claude eval of idle/completed agents (steer/block/notify), queue test cycles |
| `supervisor/dispatcher.ts` | The dispatch queue: `LISTEN daboss_agent_queued` + fallback sweep, slot-limited, auto-sizes unsized agents via one Claude call |
| `supervisor/reaper.ts` | Heartbeat reaper (pod mode) — dead pods → paused, unsticks reviews |
| `supervisor/credential.ts` | Headless Claude calls borrow a designated admin's vault credential; degrades to rules-only |
| `forge/github.ts` / `sync-branch.ts` | GitHub REST (PRs, branches, merges, comments, diffs); merge base→head else hand conflict to the agent |
| `api/router.ts` | Main REST router (~1650 lines) — agents, reviews, merge (land gate), deploys, pipeline, files, admin, budget |
| `api/mcp.ts` | MCP Streamable-HTTP server at `POST /mcp` — 20 tools (create/control agents, reviews, deploys, checks) |
| `api/auth.ts` / `tokens.ts` | Local (scrypt, first user = admin) + provider-neutral OIDC; `dbt_` API tokens, scoped, default-deny |
| `api/live-relay.ts` / `websocket.ts` | PG LISTEN → in-process bus → WS broadcast |
| `api/agent-status.ts` | Canonical rolled-up `status` (testing/reviewing/ready/landing/merged/deploying/deployed/…) — server-computed wins in UI |
| `api/discovery.ts` / `usage.ts` | Import host `~/.claude` sessions; Claude account usage widget |
| `db/` | pg pool; **33 migrations** (`migrations.ts`); ALL SQL in `queries.ts` (async, `$N` params, no raw SQL elsewhere) |
| `crypto/cipher.ts` | `SecretCipher` seam — `local` AES-256-GCM today; KMS/Vault are config seams, no provider hardcoding |
| `tokens/budget.ts` | Daily/monthly budgets, priority-tier pause |
| `testing/` | Live-agent scenarios, scripted land-conflict fixture, hidden `usr_test_harness` user |
| `utils/claude-lock.ts` | `withClaudeLock` — see "Serialized Claude calls" below |

### UI (`ui/src/`)

Pages: `Dashboard` (agent grid, search/filter/sort, budget, usage), `AgentDetail` (stream, plans, uploaded files, activity trace, pod size, merge-main, deploy-branch, verdict card with override guard), `Reviews` (shared queue: deploys awaiting approval + changes awaiting merge, per repo), `Discover` (import host sessions), `Settings` (credentials, git token, secrets vault, API tokens, admin: users/supervisor-credential/size-presets/default-repo/scenarios, pipeline builder), `Login` (local or SSO).

Notable components: `PermissionDialog` (per-tool approval incl. AskUserQuestion + ExitPlanMode plan review), `AgentActivity` (linked runs + child agents with inline logs), `PipelineBuilder` (authors `.daboss/pipeline.yaml`, live-validated against the server parser), `CreateAgentForm` (templates, PR/branch adoption, model picker — keep in sync with `server/src/models.ts`). `agentStatus.ts` derives one status everywhere; server-computed `status` wins.

### Database (Postgres, 33 migrations, 23 tables)

`agents`, `agent_events`, `agent_commands`, `agent_files`, `token_usage`, `permission_requests`, `budget_config`, `supervisor_runs`, `audit_log`, `fleet_nodes`, `users`, `user_credentials`, `user_git_credentials`, `user_secrets`, `offboarded_identities`, `app_settings`, `leases`, `intents`, `dev_delta_materialization`, `pipeline_runs`, `reviews`, `api_tokens`, `schema_version`.

### Agent state machine + status

Raw states: `PENDING → QUEUED → RUNNING → COMPLETED/FAILED`, `WAITING_PERMISSION/WAITING_INPUT`, `PAUSED`, `ABORTED`; retry/resume re-enter RUNNING. `api/agent-status.ts` rolls agent + pipeline + review + deploy state into the canonical UI status (`testing`, `reviewing`, `ready`, `fix`, `hold`, `landing`, `merged`, `deploy_gate`, `deploying`, `deployed`, `done`, …).

### Change lifecycle

Agent branch → auto-commit + draft PR each turn → test phases (`test`/`test-*` in pipeline.yaml; on-demand, or on-completion with `DABOSS_AUTO_TEST`) → review agent verdict `merge|fix|hold` → **land gate** (`POST /api/agents/:id/merge`): rebase on main → retest → merge on green; 409 on conflict (agent resolves), hold/fix need `override:true` → deploy phase on main (`gate: human`, `agent: true` = managed deploy agent) with outcome fed back to the origin change. Branch deploys to staging bypass the main-only gate.

## Per-repo contract (`.daboss/` in the TARGET repo)

- `.daboss/agent.Dockerfile` — `FROM ${DABOSS_BASE}` + toolchain; kaniko-built once, content-addressed (base + Dockerfile + `# daboss-hash-include: <paths>`); build targets = per-agent toolchain flavors; falls back to base image on failure.
- `.daboss/pipeline.yaml` — phases (see `pipeline/config.ts`). Runner contract: env in, exit code = verdict, stdout streamed, `$DABOSS_ARTIFACT` = review artifact.
- Runtime scratch `/work/.daboss/{log,exit,artifact}` is git-excluded by the worker.

## Key SDK Integration Points

- `query({ prompt, options })` → `AsyncGenerator<SDKMessage>` — iterated in `worker/index.ts` (pods) and `agent/runner.ts` (legacy)
- `options.resume` (session id), `options.canUseTool` (permission control point), `options.includePartialMessages` (live streaming), `options.abortController`, `options.maxTurns` / `maxBudgetUsd`
- `settingSources: ["project"]` loads repo CLAUDE.md + fires command hooks, but the SDK does NOT auto-load `.mcp.json` — the worker loads it (gated, graceful)
- Plan capture: `ExitPlanMode` input is `{}`; the real plan is the file the agent Writes to `~/.claude/plans/` — worker instructs agents accordingly and captures it

## Development Patterns

- **Node 22** (`.nvmrc`), npm workspaces (`server/`, `ui/`), ESM throughout (`.js` import extensions)
- TypeScript: server builds from `tsconfig.base.json` (**not** strict); UI has its own strict config
- Express 5 (`/{*splat}` wildcards), React 19, react-router 7, Tailwind v4 (CSS-first, dark theme), Vite proxies `/api` + `/ws` in dev
- **Postgres only** — `DATABASE_URL`; locally PG runs in the docker-desktop cluster with a port-forward. Tests use **pg-mem** via `resetDb()`, fully offline
- **Serialized Claude calls:** boss-side reviewer/supervisor/sizing Claude calls MUST use `withClaudeLock` + per-call `options.env` — concurrent claude CLIs share `~/.claude` → empty results + OOM
- All SQL lives in `db/queries.ts`, parameterized. UI base path from `import.meta.env.BASE_URL` (`VITE_BASE` build arg — `/` locally, sub-path behind a reverse proxy)
- Live testing without tokens: `scripts/scenario-collision.sh` (scripted workers + sidecars in kind); admin Scenario panel runs real-agent narrative scenarios

## Environment Variables

See `.env.example` for the documented set. Core: `DATABASE_URL`, `SESSION_SECRET`, `DABOSS_CIPHER_KEY` (required — credential vault key), `PORT` (3847), `AUTH_MODE` (`local`|`oidc` + `OIDC_*` block), `CRYPTO_PROVIDER` (`local`).

Cluster: `AGENT_EXECUTION` (`inprocess`|`pod`), `AGENT_SIDECAR` (`on`|`off`), `WORKER_IMAGE`, `POD_NAMESPACE` (`daboss`), `APP_SECRET_NAME`, `WORKSPACE_PVC_SIZE` (20Gi), `TRUST_PROXY`.

Behavior: `MAX_CONCURRENT_AGENTS` (3), `SUPERVISOR_INTERVAL_MINUTES` (5), `SUPERVISOR_CREDENTIAL_USER`, `PERMISSION_TIMEOUT_MINUTES` (30), `STUCK_THRESHOLD_MINUTES` (15), `DABOSS_AUTO_TEST` (false), `LEASE_MODE` (`advisory`|`enforce`|`off`), `DABOSS_MAIN_WATCH_INTERVAL_SECONDS` (600), `DABOSS_SCHEDULE_SWEEP_INTERVAL_SECONDS` (300), `DABOSS_REAPER_*`, `SIDECAR_*`.

Builds/sizing: `DABOSS_BUILD_SERVICE_ACCOUNT`, `DABOSS_KANIKO_IMAGE`/`_MEMORY`/`_CPU`, `DABOSS_BUILD_TIMEOUT_MS`, `DABOSS_SIZE_PRESETS`, `DABOSS_DEPLOY_AGENT_IMAGE`. Misc: `NTFY_TOPIC`, `ANTHROPIC_ADMIN_API_KEY`, `CLAUDE_PATH`, `DABOSS_PR_DRAFT` (worker, default true).

## Working Conventions

- **App-code review gate only:** the review/test/merge gate covers app code. Agents may author infra PRs, but infra changes are reviewed/merged manually on GitHub — don't wire them into the gate.
- **Route work through da_boss when asked to:** if the workflow is "through daboss", dispatch agents/pipelines rather than doing it by hand, and never write synthetic ledger rows to reconcile out-of-band actions.
- **Never delete shared-repo refs without explicit per-instance approval.**
- Deployment docs that ARE tracked: `k8s/gke/RUNBOOK.md` (sanitized GKE runbook, placeholders only) and `k8s/gke/deploy-manager-prompt.md`. Keep them placeholder-only.

## Known Issues / Current State

- Legacy host mode (`AGENT_EXECUTION=inprocess`, launchd scripts) still exists for dev/trial but is deliberately not the supported path
- `.env.example` lags the full config surface (cluster/build/sizing vars are code-documented only, in `config.ts`)
- Design docs: `da_boss-distributed-plan.md` = still-authoritative architecture rationale; `da_boss-phase0-scope.md` and `da_boss-review-platform-plan.md` = historical records of completed phases
- Committed vendored SDK tarball at repo root (`anthropic-ai-claude-agent-sdk-0.2.85.tgz`)
