# da_boss

An open-source control plane for fleets of [Claude Code](https://docs.anthropic.com/en/docs/claude-code) agents. Built on the `@anthropic-ai/claude-agent-sdk`.

da_boss runs each agent in its own Kubernetes pod on the dispatching user's own Claude credentials, then shepherds the agent's work through a full change lifecycle: branch → draft PR → tests → agent-driven code review → gated merge → gated deploy. A supervisor watches everything, unsticks stuck agents, sizes pods, heals dead ones, and re-tests `main` when it moves.

It is domain-neutral: da_boss knows nothing about your application. Target repos declare their own toolchain and pipeline in a `.daboss/` directory, and deploy identity is injected via service accounts — never baked in.

## How it works

```
Browser (React)  ──REST + WebSocket──▶  Boss (Express :3847)  ──▶  Kubernetes API
MCP clients      ──POST /mcp────────▶       │                        ├─ agent pods (1 per agent, per-user creds + workspace PVC)
                                            │                        ├─ pipeline pods (tests, deploys)
                                        Postgres  ◀──LISTEN/NOTIFY── ├─ kaniko pods (image builds)
                                            │                        └─ optional native sidecar (heartbeat, git telemetry, leases)
                                       Supervisor (cron + dispatch queue)
```

- **One pod per agent.** The worker (`server/src/worker/`) clones the target repo into a per-user workspace volume, runs the SDK loop, and on each turn end auto-commits, pushes, and opens/updates a draft PR. Permissions, steering commands, and live events flow between pod and boss exclusively through Postgres LISTEN/NOTIFY — no shared memory.
- **Per-user everything.** Each user stores their own Claude credential (API key or OAuth token) and git token, encrypted at rest (AES-256-GCM). Agents run and bill on the credentials of whoever dispatched them.
- **The pipeline is the repo's contract.** A repo declares phases in `.daboss/pipeline.yaml` (exit code = verdict, stdout streamed, artifact file for human review). da_boss just runs them.

## Features

**Agents**
- Create agents with a prompt, repo/ref, model, priority, budget, turn limit, and pod size — or adopt an existing PR/branch
- Built-in templates: PR Adopter, Code Reviewer, Test Writer, Bug Fixer, Refactorer, Doc Writer
- Real-time message streaming, tool-permission dialogs, plan-mode review (approve/reject with feedback), file upload into the pod, activity traces linking every related run and child agent
- T-shirt pod sizes (s/m/l/xl) with supervisor auto-sizing and automatic size bump-up after OOM kills
- Input queue: messages sent while an agent is busy combine and deliver on the next turn

**Change lifecycle**
- Auto-commit + draft PR per agent branch; PR-gating test phases run on demand or on completion (opt-in)
- On-demand review agents that read the diff and return a verdict: `merge`, `fix`, or `hold` — with a merge-anyway override guard in the UI
- Land gate: merge rebases the branch on `main`, re-runs tests, and merges only on green (409 on conflict — the agent resolves it)
- Branch deploys to staging that bypass the main-only gate, run by a conversable deploy agent whose outcome feeds back to the originating change
- Main watcher: re-runs test phases when `main` moves outside da_boss (manual merges included)
- Scheduled (`nightly`) phases with artifact seeding — e.g. a nightly DB snapshot whose artifact seeds test phases and agent pods

**Governance & safety**
- Tool policy shared by boss and pod worker: auto-approves safe tools, escalates risky ones to the UI (`auto`/`ask`/`strict` per agent)
- Advisory semantic freeze-leases: a native sidecar computes the symbol-level blast radius of each agent's edits (git diff + universal-ctags + git grep) and flags agents that trample each other's functions
- Token budgets (daily/monthly) with priority-tier enforcement; per-agent USD budgets and turn limits
- Audit log of all agent actions with user and IP

**Multi-user**
- Local auth (scrypt, first registered user becomes admin) or provider-neutral OIDC (JWKS or static key, configurable claims, role/access gates, pending-approval holding pen)
- Encrypted per-user credential vaults plus named secrets that pipeline phases request by name
- One-click offboarding: kills agents, deletes remote branches and the workspace volume, wipes credentials, tombstones the identity

**Operations**
- Supervisor cron: stuck detection, stale permission resolution, Claude-powered evaluation of idle/completed agents, steer/block of off-track agents
- Self-healing: heartbeat reaper for dead pods, OOM reason capture, lost-volume recovery with graceful fresh-resume
- MCP server (20 tools) so other agents can drive da_boss; scoped API tokens for headless access
- Push notifications via [ntfy.sh](https://ntfy.sh); Claude account usage widget (5h/7d windows)
- 287 offline tests (vitest + pg-mem in-memory Postgres)

## Quick start (local development)

Requires Node 22, Postgres, and a Claude credential (Claude subscription OAuth token or Anthropic API key).

```bash
git clone <repo-url> da_boss && cd da_boss
npm install
cp .env.example .env
# In .env, set at minimum:
#   DATABASE_URL=postgres://daboss:daboss@localhost:5432/daboss
#   SESSION_SECRET=$(openssl rand -base64 32)
#   DABOSS_CIPHER_KEY=$(openssl rand -base64 32)   # encrypts user credentials at rest

npm run dev     # server on :3847, Vite UI on :3848
npm run test    # 287 tests, fully offline (pg-mem)
npm run build   # production build (server tsc + ui vite)
```

Open the UI, register — the **first registered user becomes admin** — then add your Claude credential and git token under Settings. Agents run on *your* stored credentials.

In dev mode agents execute in-process on the host (`AGENT_EXECUTION=inprocess`). This is fine for trying it out, but the in-process runner manages `claude` processes via the host process table and can interfere with unrelated Claude sessions. **Run agents in Kubernetes for real use.**

## Deploying to Kubernetes

The `Dockerfile` builds a single image containing the boss, the pod worker, the sidecar, and the supervisor — pods differ only by `command`. A deployment needs:

1. **Postgres** (StatefulSet or managed).
2. **The boss Deployment** with `AGENT_EXECUTION=pod`, `AGENT_SIDECAR=on`, `WORKER_IMAGE=<this image>`, `POD_NAMESPACE`, and a ServiceAccount allowed to create/delete pods, secrets (ephemeral per-agent credentials), and PVCs (per-user workspaces) in its namespace.
3. Optionally the **supervisor as its own Deployment** (`command: node dist/orchestrator/index.js`).
4. For repo-declared image builds, a **kaniko build identity** with push access to your registry (`DABOSS_BUILD_SERVICE_ACCOUNT`); without it, agents fall back to the generic base image.

Cluster manifests are environment-specific and not committed, but **[`k8s/gke/RUNBOOK.md`](k8s/gke/RUNBOOK.md)** walks an end-to-end GKE deployment — Artifact Registry, secrets, Postgres, control plane, network policies, reverse-proxy wiring, and the least-privilege build/deploy identities. [`k8s/gke/deploy-manager-prompt.md`](k8s/gke/deploy-manager-prompt.md) documents the deploy-agent setup.

## Configuring a target repo

Everything a repo needs lives in its own `.daboss/` directory.

### `.daboss/agent.Dockerfile` — agent toolchain

Declare what agents working on this repo need installed:

```dockerfile
FROM ${DABOSS_BASE}
# daboss-hash-include: mix.lock
RUN apt-get update && apt-get install -y elixir ...
```

da_boss builds it once with kaniko, content-addressed by hash of the base image + Dockerfile (+ any `daboss-hash-include` files), and runs the repo's agents in it. Named build targets in the same file act as per-agent **toolchain flavors**. Falls back to the generic base image on any failure.

### `.daboss/pipeline.yaml` — phases

```yaml
phases:
  test:                      # "test" / "test-*" phases gate PRs
    command: mix test
    image: daboss-elixir-test:1.18
    services:                # backing services as localhost sidecars
      - image: postgres:16
        port: 5432
        env: { POSTGRES_PASSWORD: postgres }
  deploy:
    command: ./deploy.sh
    only_ref: main           # main-only
    gate: human              # requires approval in the UI
    agent: true              # approval dispatches a managed agent (streams live, can roll back)
    service_account: deployer  # Workload-Identity-bound KSA — identity is injected, never baked in
    requires: [gcp-sa]       # named vault secrets injected as env
```

Other phase fields: `build` (kaniko-build the image from the repo), `params`, `adapter`, `lease` (phase concurrency, e.g. terraform state), `schedule: nightly`, `artifact_from` (inject another phase's latest passed artifact at `$DABOSS_SEED`), `expose_to_agents` (deliver that artifact into every agent pod for the repo).

The runner contract is deliberately dumb: env in, **exit code = verdict**, stdout streamed to the UI, and a file at `$DABOSS_ARTIFACT` becomes the human-review artifact. A live-validated builder for this file is in the UI (Settings → Pipeline).

## The change lifecycle

```
agent works on branch ──▶ draft PR ──▶ test phases ──▶ review agent ──▶ verdict: merge | fix | hold
                                                                            │
        merge (land gate): rebase on main ──▶ re-test ──▶ merge on green ◀──┘ (hold/fix require explicit override)
                                                │
                     deploy phase on main (gate: human) ──▶ deploy agent ──▶ outcome fed back to the change
```

The Reviews page is the shared queue across all developers: deploys awaiting approval and changes awaiting merge, grouped by repo. Branch deploys to staging are available per-agent when you need to validate before merging.

## MCP server

`POST /mcp` (Streamable HTTP) exposes da_boss to other agents — an agent in one Claude session can spawn, steer, review, and deploy through it:

`create_agent`, `get_agent`, `list_agents`, `start_agent`, `pause_agent`, `resume_agent`, `kill_agent`, `send_input`, `get_agent_events`, `resize_agent`, `list_reviewable_changes`, `request_review`, `get_verdict`, `run_checks`, `sync_main`, `deploy_branch`, `list_deploys`, `get_deploy_verdict`, `list_pending_permissions`, `resolve_permission`

Mint a scoped API token (`dbt_…`) in Settings; tokens are default-deny with scopes like `mcp`, `agent:create`, `review:create`, `review:read`.

## Configuration

All config is environment variables (see `.env.example`). The important ones:

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgres://daboss:daboss@localhost:5432/daboss` | Postgres connection (required) |
| `SESSION_SECRET` | dev value | Express session secret — set it |
| `DABOSS_CIPHER_KEY` | — | **Required.** Key for the AES-256-GCM credential vault |
| `PORT` | `3847` | Server HTTP port |
| `AGENT_EXECUTION` | `inprocess` | `pod` (Kubernetes, recommended) or `inprocess` (host, dev only) |
| `AGENT_SIDECAR` | `off` | `on` enables the native sidecar (heartbeat, telemetry, leases) |
| `WORKER_IMAGE` | `da-boss:local` | Image for agent pods (keep in sync with the deployed boss image) |
| `POD_NAMESPACE` | `daboss` | Namespace for agent/pipeline/build pods |
| `WORKSPACE_PVC_SIZE` | `20Gi` | Per-user workspace volume size |
| `MAX_CONCURRENT_AGENTS` | `3` | Dispatch-queue slot count |
| `AUTH_MODE` | `local` | `local` or `oidc` (see `OIDC_*` vars in `.env.example`) |
| `SUPERVISOR_INTERVAL_MINUTES` | `5` | Supervisor cron cadence |
| `SUPERVISOR_CREDENTIAL_USER` | — | Whose Claude credential powers headless supervisor/review calls (also settable in the admin UI) |
| `LEASE_MODE` | `advisory` | Freeze-leases: `advisory`, `enforce`, or `off` |
| `DABOSS_AUTO_TEST` | `false` | Auto-run test phases when an agent completes |
| `DABOSS_BUILD_SERVICE_ACCOUNT` | — | KSA for kaniko pushes (with `DABOSS_KANIKO_*` resource knobs) |
| `NTFY_TOPIC` | — | ntfy.sh topic for push notifications |
| `TRUST_PROXY` | — | Set behind a load balancer so rate limiting and audit IPs see the real client |
| `DABOSS_SIZE_PRESETS` | built-in s/m/l/xl | JSON override of pod size presets (also editable in the admin UI) |

## Architecture notes

- **Server** (`server/src/`): `agent/` (manager, pod dispatcher, image builders, sizing, tool policy), `pipeline/` (config, phase runner, review agents, deploy agents, main-watch, scheduler), `worker/` (pod-side agent loop), `sidecar/` (heartbeat + leases), `supervisor/` (checks, dispatch queue, reaper), `leasing/` (freeze-set computation), `forge/` (GitHub REST), `api/` (REST router, MCP, auth, tokens, WebSocket, PG live relay), `db/` (33 migrations, all SQL in `queries.ts`), `crypto/` (cipher seam — `local` AES-GCM today, KMS/Vault pluggable).
- **UI** (`ui/src/`): Dashboard, Agent detail (stream, plans, files, activity trace, size/merge/deploy controls), Reviews queue, Discover (import existing local Claude sessions), Settings (credentials, secrets, tokens, admin panels, pipeline builder).
- **Statuses** roll up agent + pipeline + review + deploy state into one canonical value: `pending → queued → running → … → testing → reviewing → ready → landing → merged → deploying → deployed/done`, with `waiting_*`, `fix`, `hold`, `paused`, `failed` along the way.
- **Design docs**: [`da_boss-distributed-plan.md`](da_boss-distributed-plan.md) is the architecture rationale (leases, intents, merge queue, neutrality seams); the phase-0 and review-platform plans are historical design records.

## Legacy single-machine mode

The original macOS launchd service (`npm run install-service`, `service:start|stop|logs`) still works and runs agents in-process on the host. It predates the Kubernetes architecture: no pods, no per-user isolation, and host-level `claude` process management that can interfere with other Claude sessions on the machine. Prefer the Kubernetes deployment for anything beyond a quick trial.

## License

MIT
