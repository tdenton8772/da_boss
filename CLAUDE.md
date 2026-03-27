# da_boss — Agent Manager for Claude Code

A web-based manager for spawning, monitoring, and controlling multiple Claude Code agent instances via the `@anthropic-ai/claude-agent-sdk`.

## Quick Start

```bash
nvm use 22
npm run dev          # starts server (:3847) + vite UI (:3848)
npm run test         # 67 tests
npm run build        # production build
npm run install-service  # install as macOS launchd service
```

Password is in `.env` (`AUTH_PASSWORD`).

## Architecture

```
UI (React/Vite :3848) → WebSocket + REST → Server (Express :3847) → Claude Agent SDK
                                              ↓
                                           SQLite (da_boss.db)
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
| `db/migrations.ts` | SQLite schema (2 migrations) |
| `db/queries.ts` | All DB operations — typed, no raw SQL elsewhere |
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

### Database Schema (SQLite)

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

- **Node 22 required** — `nvm use 22`
- **npm workspaces** — `server/` and `ui/` are workspace packages
- **ESM throughout** — all imports use `.js` extensions
- **TypeScript strict mode** — both server and UI
- **Express 5** — uses `/{*splat}` for wildcards (not `*`)
- **Vite proxies** `/api` and `/ws` to server in dev mode
- **Tests**: `vitest` with in-memory SQLite per test via `resetDb()`
- **Tailwind v4** — CSS-first config, dark theme (gray-950/900/800)
- **react-router v7** — `useParams()` returns `Record<string, string | undefined>`, no generic

## Environment Variables (`.env`)

```
AUTH_PASSWORD=...        # login password
SESSION_SECRET=...       # express-session secret
NTFY_TOPIC=              # ntfy.sh topic for push notifications (optional)
PORT=3847                # server port
ANTHROPIC_ADMIN_API_KEY= # for org-level usage tracking (optional)
CLAUDE_PATH=             # path to claude CLI (default: ~/.local/bin/claude)
```

## What's Working

- Create agents via UI with priority, model, budget, turn limits
- Real-time message streaming via WebSocket
- Smart permission auto-approval (Edit/Write in cwd, safe Bash patterns)
- Token budget management with priority-based enforcement
- Session discovery — find and import existing Claude sessions from any repo
- Session compaction and trimming for large transcripts
- Supervisor cron with Claude-powered agent evaluation
- Supervisor instructions per agent (editable in UI)
- Push notifications via ntfy.sh
- macOS launchd service install
- 67 passing tests

## What's In Progress / Known Issues

- Supervisor is hybrid (rules + single Claude call) — could be upgraded to a full agent with tool access to inspect work, run tests, verify output
- Session compaction costs $1-2 per run on large sessions
- Can't import a live session (the one you're currently talking to)
- UI could use a Settings page for budget config and notification preferences
- No agent templates yet (predefined roles like "code reviewer", "implementer")
