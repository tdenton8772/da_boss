# da_boss — Agent Manager for Claude Code

A web-based manager for spawning, monitoring, and controlling multiple Claude Code agent instances via the `@anthropic-ai/claude-agent-sdk`.

## Quick Start

```bash
npm run test         # 70 tests (offline, pg-mem)
npm run build        # production build (server tsc + ui vite)
npm run dev          # local dev server (:3847) + vite UI (:3848) — needs PG port-forward (below)
```

Password is in `.env` (`AUTH_PASSWORD`).

### Run in the local kind cluster (preferred — see "k8s-only" below)

```bash
# Postgres (once): applied to docker-desktop cluster, then port-forward for dev
kubectl --context docker-desktop apply -f k8s/postgres.yaml
kubectl --context docker-desktop -n daboss port-forward svc/postgres 5432:5432 &

# control plane: build image (docker-desktop kind shares the local image store),
# deploy, and reach the UI on :8080
docker build -t da-boss:local .
kubectl --context docker-desktop apply -f k8s/daboss.yaml
kubectl --context docker-desktop -n daboss rollout restart deploy/daboss   # :latest-style tag
kubectl --context docker-desktop -n daboss port-forward svc/daboss 8080:3847 &
```

**k8s-only:** don't run agent execution on the host — the runner's process
management scans the host process table and can kill unrelated `claude` sessions.
Inside a pod's PID namespace it can't. Run da_boss in kind. (Full agent-in-pod
isolation is Phase 1.)

## Architecture

```
UI (React/Vite :3848) → WebSocket + REST → Server (Express :3847) → Claude Agent SDK
                                              ↓
                                    Postgres (via node-pg, async)
                                              ↓
                                        Supervisor (cron 5min)
```

### Server (`server/src/`)

| Module | Purpose |
|---|---|
| `index.ts` | Entry point — Express, session, WebSocket, supervisor, static file serving |
| `config.ts` | Loads `.env` from project root |
| `agent/runner.ts` | **Core**: wraps SDK `query()`, streams messages, tracks tokens, handles lifecycle. One instance per running agent. |
| `agent/manager.ts` | Orchestrates runners — spawn/kill/pause/resume, max 3 concurrent, session restore on restart |
| `agent/permissions.ts` | `canUseTool` callback — auto-approves safe tools (Read/Grep/Glob/Edit within cwd, safe Bash), escalates risky ops to UI. Three policies: `auto`/`ask`/`strict` |
| `tokens/budget.ts` | Token budget enforcement — priority tiers (high/med/low), daily/monthly limits, pause agents when thresholds hit |
| `supervisor/index.ts` | Cron runner (every 5 min) |
| `supervisor/checks.ts` | Stuck detection, budget enforcement, stale permissions. Uses Claude call to evaluate completed/idle agents against `supervisor_instructions`. |
| `notifications/ntfy.ts` | Push notifications via ntfy.sh |
| `api/router.ts` | REST endpoints — agents CRUD, start/pause/resume/kill/input/fresh-start/compact/trim, permissions, budget |
| `api/discovery.ts` | Session discovery — scans `~/.claude/projects/`, lists sessions, imports into da_boss |
| `api/websocket.ts` | WebSocket server — subscription-based event broadcasting to UI |
| `api/auth.ts` | Session-based password auth |
| `db/index.ts` | Postgres pool (node-pg) — `getPool()`, async `initDb()`, `withTx()`, `resetDb()` for tests |
| `db/migrations.ts` | Postgres schema (3 migrations), async runner |
| `db/queries.ts` | All DB operations — **async**, typed, parameterized (`$1`), no raw SQL elsewhere |
| `utils/state-machine.ts` | Agent state transitions: pending→running→completed/failed/paused/waiting_* |
| `utils/session-trim.ts` | Trims large session JSONL files for resumability |

### UI (`ui/src/`)

| File | Purpose |
|---|---|
| `App.tsx` | Router, auth gate, error boundary |
| `pages/Dashboard.tsx` | Agent cards, budget bars, pending permissions, Import/New Agent buttons |
| `pages/AgentDetail.tsx` | Full message stream, controls, supervisor instructions editor, error recovery (compact/trim/fresh-start) |
| `pages/Discover.tsx` | Browse existing Claude sessions, import with optional compaction |
| `pages/Login.tsx` | Password login |
| `components/AgentCard.tsx` | Status badge, cost, priority, last message preview |
| `components/ControlBar.tsx` | Start/pause/resume/kill/remove + auto-growing textarea input |
| `components/MessageStream.tsx` | Scrollable real-time message list |
| `components/PermissionDialog.tsx` | Approve/deny tool calls from UI |
| `components/TokenBudgetBar.tsx` | Visual daily/monthly budget meters |
| `components/CreateAgentForm.tsx` | Create agent — name, prompt, cwd, priority, model, budget |
| `components/ErrorBoundary.tsx` | Catches React errors with visible stack trace |
| `api.ts` | REST client + all TypeScript types |
| `ws.ts` | WebSocket hook with auto-reconnect, queued sends |

### Database Schema (Postgres)

- `agents` — id, name, prompt, cwd, state, priority, permission_mode/policy, sdk_session_id, model, max_turns, max_budget_usd, supervisor_instructions, error_message, timestamps
- `agent_events` — append-only event log per agent (state_change, message, tool_use, error)
- `token_usage` — per-turn token counts + cost for aggregation
- `permission_requests` — pending/approved/denied tool call permissions
- `budget_config` — singleton daily/monthly budget
- `supervisor_runs` — log of supervisor findings/actions

### Agent State Machine

```
PENDING → RUNNING → COMPLETED → VERIFIED
              ↓ ↑       ↓ ↑
         WAITING_*    RUNNING (restart)
              ↓
           PAUSED → RUNNING (resume)

Any non-terminal → ABORTED (kill)
FAILED → RUNNING (retry)
```

### Key SDK Integration Points

- `query({ prompt, options })` returns `AsyncGenerator<SDKMessage>` — iterated in `runner.ts`
- `options.resume` — resumes an existing session by ID
- `options.canUseTool` — permission callback, our main control point
- `options.includePartialMessages` — enables real-time text streaming to UI
- `options.abortController` — clean agent termination
- `options.maxTurns` / `options.maxBudgetUsd` — resource limits
- `query.interrupt()` — pause agent
- `query.streamInput()` — send user messages to running agent

### Session Discovery & Resume

Sessions live at `~/.claude/projects/{project-key}/{session-uuid}.jsonl`. The discovery system:
1. Scans all project dirs, maps keys to real filesystem paths
2. Reads JSONL to extract first prompt, message count, lock status
3. Imports sessions as paused agents with `sdk_session_id` set
4. For large sessions: compact via `claude -r SESSION -p /compact`, trim JSONL, or fresh start

**Important**: You cannot import a session that is currently being used by a running Claude instance (the file is being actively written to).

## Development Patterns

- **Node 22 preferred** (Node 20 also works — the dev machine currently runs Homebrew Node 20)
- **npm workspaces** — `server/` and `ui/` are workspace packages
- **ESM throughout** — all imports use `.js` extensions
- **TypeScript strict mode** — both server and UI
- **Express 5** — uses `/{*splat}` for wildcards (not `*`)
- **Vite proxies** `/api` and `/ws` to server in dev mode
- **Postgres** — `DATABASE_URL` env. Locally: PG runs in the docker-desktop k8s cluster (`k8s/postgres.yaml`, namespace `daboss`); `kubectl --context docker-desktop -n daboss port-forward svc/postgres 5432:5432`
- **Tests**: `vitest` with **pg-mem** (in-memory Postgres) per test via `resetDb()` — offline, no live DB needed
- **Tailwind v4** — CSS-first config, dark theme (gray-950/900/800)
- **react-router v7** — `useParams()` returns `Record<string, string | undefined>`, no generic

## Environment Variables (`.env`)

```
AUTH_PASSWORD=...        # login password
SESSION_SECRET=...       # express-session secret
DATABASE_URL=            # postgres://daboss:...@localhost:5432/daboss (required)
NTFY_TOPIC=              # ntfy.sh topic for push notifications (optional)
PORT=3847                # server port
ANTHROPIC_ADMIN_API_KEY= # for org-level usage tracking (optional)
CLAUDE_PATH=             # path to claude CLI (default: ~/.local/bin/claude)
```

## What's Working

- Create agents via UI with priority, model, budget, turn limits
- **Agent templates** — 6 built-in templates (PR Adopter, Code Reviewer, Test Writer, Bug Fixer, Refactorer, Doc Writer) with pre-filled prompts and settings
- Real-time message streaming via WebSocket
- **Enhanced permission system** — auto-approves 15+ safe tools including `AskUserQuestion`, `WebFetch`, `Task`, `Skill`, etc. with **beautiful permission dialog** showing formatted tool input (syntax-highlighted Bash commands, file diffs, etc.)
- Token budget management with priority-based enforcement
- **Settings page** — budget configuration, server info, logout, audit log viewer
- **Dashboard search/filter/sort** — search by name/prompt, filter by status, sort by date/name/cost/status
- **Toast notifications** — success/error/warning feedback throughout the UI
- Session discovery — find and import existing Claude sessions from any repo
- Session compaction and trimming for large transcripts
- Supervisor cron with Claude-powered agent evaluation
- Supervisor instructions per agent (editable in UI)
- Push notifications via ntfy.sh
- **Security hardening** — Helmet middleware, rate limiting (5 login attempts/min), input validation, audit logging
- **Audit log** — tracks all agent create/start/kill/delete actions with IP addresses
- **Fleet foundation** — database schema and API endpoints for multi-node management (schema-only)
- macOS launchd service install
- 67 passing tests

## What's In Progress / Known Issues

- **TypeScript build issues** — strict mode and missing type definitions causing build failures, but functionality is complete
- Supervisor is hybrid (rules + single Claude call) — could be upgraded to a full agent with tool access to inspect work, run tests, verify output
- Session compaction costs $1-2 per run on large sessions
- Can't import a live session (the one you're currently talking to)

## Next Steps for Full Fleet Management

### Phase 1: Multi-Machine Foundation ✅
- [x] Fleet node schema and API endpoints
- [x] Node registration and heartbeat system
- [x] Audit logging infrastructure
- [x] Security hardening (rate limiting, input validation, helmet)

### Phase 2: Distributed Execution (TODO)
- Worker node daemon that polls boss for agent assignments
- WebSocket relay for real-time updates from remote agents
- Load balancing across fleet nodes based on capacity
- Centralized session storage (NFS, S3, or database BLOBs)

### Phase 3: Fleet Operations (TODO)
- Node monitoring dashboard with health status
- Automatic failover when nodes go offline
- Fleet-wide agent migration and load rebalancing
- Fleet deployment scripts for rapid scaling
