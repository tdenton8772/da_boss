# da_boss

A web-based manager for spawning, monitoring, and controlling multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) agent instances. Built on the `@anthropic-ai/claude-agent-sdk`.

## Features

- **Spawn agents** with a prompt, working directory, model, priority, and budget
- **6 built-in agent templates** — Implementer, Code Reviewer, Test Writer, Bug Fixer, Refactorer, Doc Writer
- **Real-time message streaming** via WebSocket
- **Interactive tool permissions** — auto-approves safe tools, escalates risky ones to UI with syntax-highlighted diffs and formatted bash commands
- **AskUserQuestion support** — agents can ask you multiple-choice or free-text questions through the UI
- **Plan mode** — agents propose plans, you review and approve/reject with feedback before they code
- **Task tracking** — agent todos render as checklists, not raw JSON
- **Token budget management** — daily/monthly limits with priority-based enforcement
- **Subagent tracking** — see spawned subagents, their types, and process trees
- **Process management** — PID tracking, SIGKILL entire process trees, Kill All button
- **Input queue** — messages queue when agent is busy, combine into single message on delivery
- **Supervisor** — cron every 5 minutes, auto-resolves stale questions/plans using Claude
- **Session discovery** — find and import existing Claude Code sessions from any repo
- **Push notifications** via [ntfy.sh](https://ntfy.sh) — get notified on your phone when agents need attention
- **Runs as a macOS service** — survives terminal closes, starts on login
- **Dashboard search/filter/sort** — by name, prompt, status, date, cost

## Quick Start

Requires Node.js 22+ and the Claude CLI.

```bash
nvm use 22
git clone <repo-url> da_boss
cd da_boss
npm run install-service
```

The installer builds the project, generates `.env` with a random password, and installs a launchd service.

```bash
# Start the service
npm run service:start

# Open the dashboard
open http://localhost:3847

# View logs
npm run service:logs
```

### Development Mode

```bash
npm run dev    # server on :3847, Vite UI on :3848
npm run test   # 67 tests
npm run build  # production build
```

## Configuration

All config lives in `.env` at the project root:

| Variable | Default | Description |
|---|---|---|
| `AUTH_PASSWORD` | (generated) | Dashboard login password |
| `SESSION_SECRET` | (generated) | Express session secret (min 32 chars) |
| `PORT` | `3847` | Server HTTP port |
| `NTFY_TOPIC` | (empty) | ntfy.sh topic for push notifications |
| `ANTHROPIC_ADMIN_API_KEY` | (empty) | Anthropic admin API key for org-level usage tracking |
| `CLAUDE_PATH` | `~/.local/bin/claude` | Path to claude CLI binary |
| `MAX_CONCURRENT_AGENTS` | `3` | Max agents running simultaneously |
| `SUPERVISOR_INTERVAL_MINUTES` | `5` | How often the supervisor checks agents |
| `PERMISSION_TIMEOUT_MINUTES` | `30` | Tool approval timeout before auto-deny |
| `STUCK_THRESHOLD_MINUTES` | `15` | Time before an idle agent is flagged |
| `DB_PATH` | `../da_boss.db` | SQLite database file location |
| `NODE_ID` | hostname | Fleet node identifier |
| `NODE_ROLE` | `boss` | Fleet role: `boss` or `worker` |

## Service Management

```bash
npm run service:start       # launchctl load
npm run service:stop        # launchctl unload
npm run service:logs        # tail stderr log
npm run install-service     # rebuild and reinstall plist
npm run uninstall-service   # remove plist

# Or directly via launchctl
launchctl kickstart -k gui/$(id -u)/com.daboss.agent-manager  # restart
launchctl list | grep daboss                                    # check status
```

The service auto-restarts on crash (KeepAlive) and starts on login (RunAtLoad). Logs are at `~/Library/Logs/da_boss/`.

## Authentication: Claude Max vs API Key

da_boss works with both Claude Max (interactive login) and Anthropic API keys.

### Claude Max (default)

Run `claude login` on the machine. The CLI stores auth in `~/.claude/`. This is what you use for local development — flat monthly rate, unlimited usage.

### API Key

Set the `ANTHROPIC_API_KEY` environment variable. No login needed. The CLI and agent SDK check for this env var first.

```bash
# In .env
ANTHROPIC_API_KEY=sk-ant-...

# Or export directly
export ANTHROPIC_API_KEY=sk-ant-...
claude  # works without login
```

For the launchd service, add it to the plist's EnvironmentVariables or to `.env`. The server passes the environment to child claude processes automatically.

### Which to use

| | Claude Max | API Key |
|---|---|---|
| Billing | Flat monthly ($100) | Pay per token |
| Auth | Interactive `claude login` per machine | Env var, no login |
| Fleet | One machine only (per-user auth) | Any machine, scalable |
| Best for | Local development, single machine | Fleet workers, CI/CD, cloud deployment |

For **fleet deployment** (Phase 2+), API keys are the only scalable option. You can't run `claude login` on ephemeral workers. Set `ANTHROPIC_API_KEY` in the worker's environment and da_boss works without any code changes.

**Cost consideration**: A single agent running continuously can use significant tokens. Compare your typical daily token usage against API pricing before switching from Max.

## Remote Access with Tailscale

da_boss listens on localhost by default. To access it from your phone or other devices, use [Tailscale](https://tailscale.com):

### Setup

1. Install Tailscale on your Mac and sign in:
   ```bash
   brew install tailscale
   # Or download from https://tailscale.com/download
   ```

2. Install the Tailscale app on your phone/tablet.

3. Expose da_boss via Tailscale Serve (private, only your Tailnet):
   ```bash
   tailscale serve --bg 3847
   ```
   This makes da_boss available at `https://your-machine-name.your-tailnet.ts.net` with automatic HTTPS.

4. To expose publicly (e.g., for webhooks):
   ```bash
   tailscale funnel 3847
   ```

### Verify

```bash
tailscale serve status
# Should show: https://your-machine-name.ts.net -> http://127.0.0.1:3847
```

Now open `https://your-machine-name.ts.net` from any device on your Tailnet. Login with the `AUTH_PASSWORD` from `.env`.

### Tailscale + ntfy for Mobile Monitoring

With Tailscale for remote access and ntfy for push notifications, you can:
- Monitor agent status from your phone via the web UI
- Get push notifications when agents need permission approval or are stuck
- Approve/deny tool calls and answer agent questions from anywhere

## Push Notifications (ntfy)

[ntfy.sh](https://ntfy.sh) sends push notifications to your phone when agents need attention.

### Setup

1. Install the ntfy app on your phone ([iOS](https://apps.apple.com/us/app/ntfy/id1625396347) / [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy))

2. Subscribe to a topic in the app (e.g., `da-boss-tyler`)

3. Set the same topic in `.env`:
   ```
   NTFY_TOPIC=da-boss-tyler
   ```

4. Restart the service:
   ```bash
   launchctl kickstart -k gui/$(id -u)/com.daboss.agent-manager
   ```

### What triggers notifications

- Agent needs attention (supervisor detects stuck/idle state)
- Stale permission requests (agent waiting for approval > 5 min, no supervisor instructions)
- Agent errors that require manual intervention

### Test it

```bash
curl -d "Test notification from da_boss" https://ntfy.sh/your-topic
```

### Private ntfy server (optional)

For sensitive environments, self-host ntfy instead of using the public server:

```bash
docker run -p 8080:80 binwiederhier/ntfy serve
```

Then set `NTFY_TOPIC=http://your-server:8080/your-topic` (the code uses `https://ntfy.sh/{topic}` — you'd need to modify `server/src/notifications/ntfy.ts` to support custom base URLs).

## Architecture

```
Browser (React/Vite :3848) ──WebSocket + REST──> Express (:3847) ──> Claude Agent SDK
                                                      |
                                                   SQLite (da_boss.db)
                                                      |
                                                Supervisor (cron 5min)
                                                      |
                                                ntfy.sh (push notifications)
```

### Key Components

| Module | Purpose |
|---|---|
| `server/src/agent/runner.ts` | Wraps SDK `query()`, streams messages, tracks PIDs, handles lifecycle |
| `server/src/agent/manager.ts` | Orchestrates runners, input queue, max concurrency, session restore |
| `server/src/agent/permissions.ts` | `canUseTool` callback — auto-approves safe tools, routes AskUserQuestion/ExitPlanMode to UI |
| `server/src/tokens/budget.ts` | Token budget enforcement with priority tiers |
| `server/src/supervisor/checks.ts` | Stuck detection, budget enforcement, stale permission auto-resolution |
| `server/src/notifications/ntfy.ts` | Push notifications |
| `server/src/api/router.ts` | REST endpoints |
| `server/src/api/websocket.ts` | Real-time event broadcasting |
| `ui/src/components/PermissionDialog.tsx` | AskUserQuestion cards, ExitPlanMode plan review, standard approve/deny |
| `ui/src/components/MessageStream.tsx` | Scrollable real-time message list |
| `ui/src/pages/AgentDetail.tsx` | Full message stream, subagent panel, controls, queue indicator |

### Agent States

```
PENDING → RUNNING → COMPLETED → VERIFIED
              ↓ ↑       ↓ ↑
         WAITING_*    RUNNING (restart)
              ↓
           PAUSED → RUNNING (resume)

Any non-terminal → ABORTED (kill)
FAILED → RUNNING (retry via queued input)
```

### Permission System

Tools are classified as:

- **Always safe** (auto-approved): Read, Grep, Glob, Edit/Write within cwd, safe Bash, Agent, Task*, WebFetch, WebSearch, Skill, TodoRead/Write, EnterPlanMode, ToolSearch, TaskOutput, TaskStop
- **Interactive** (routed to UI): AskUserQuestion (question card with options), ExitPlanMode (plan review with approve/reject/feedback)
- **Risky** (escalated to UI): Bash with dangerous patterns, Edit/Write outside cwd, Config, KillShell, MCP tools

### Process Management

Every agent tracks the PIDs of claude processes it spawns (including subagents). On kill or error:
- SIGKILL the entire process tree (children first, then parent)
- Orphan cleanup on server startup
- `Kill All` button on dashboard for emergencies
- `/api/agents/kill-all` endpoint
- `/api/processes` endpoint for visibility

### Input Queue

Messages from the user queue per-agent and drain one at a time:
- Only delivers when agent is in `waiting_input` or `completed` state
- Multiple queued messages combine into a single message
- Failed/paused agents auto-transition when input arrives
- Resume drains queued messages immediately
- Prevents duplicate runners (the source of orphaned processes)

### Supervisor

Runs every 5 minutes. For agents with supervisor instructions:
- **Stale AskUserQuestion** (>5 min): Supervisor answers using Claude (Haiku) based on task context
- **Stale ExitPlanMode** (>5 min): Supervisor approves/rejects based on original task alignment
- **Completed agents**: Evaluates if work is actually done or needs continuation
- **Idle waiting_input** (>2 min): Provides input to unblock

Cooldowns prevent runaway loops: 15-minute cooldown between actions, max 3 interventions per agent.

## Deployment Checklist

### Prerequisites

- [ ] macOS (launchd service)
- [ ] Node.js 22 (`nvm install 22`)
- [ ] Claude CLI installed (`~/.local/bin/claude` or specify `CLAUDE_PATH`)
- [ ] Anthropic API access (for the agents to use)

### Install

```bash
nvm use 22
cd da_boss
npm run install-service
```

### Post-Install

- [ ] Verify `.env` has strong `AUTH_PASSWORD` and `SESSION_SECRET`
- [ ] Set `NTFY_TOPIC` if you want push notifications
- [ ] Set `ANTHROPIC_ADMIN_API_KEY` if you want org-level usage tracking
- [ ] Verify service is running: `launchctl list | grep daboss`
- [ ] Open `http://localhost:3847` and log in

### Optional: Remote Access

- [ ] Install Tailscale
- [ ] `tailscale serve --bg 3847`
- [ ] Access from phone: `https://your-machine.ts.net`

### Optional: Mobile Notifications

- [ ] Install ntfy app on phone
- [ ] Subscribe to your topic
- [ ] Set `NTFY_TOPIC` in `.env`
- [ ] Restart service

## API

### Authentication

```bash
# Login
curl -c cookies.txt -X POST http://localhost:3847/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"password":"your-password"}'

# Use cookies for subsequent requests
curl -b cookies.txt http://localhost:3847/api/agents
```

### Key Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/api/agents` | Create agent |
| GET | `/api/agents` | List all agents |
| POST | `/api/agents/:id/start` | Start agent |
| POST | `/api/agents/:id/input` | Send message (queued) |
| POST | `/api/agents/:id/kill` | Kill agent + process tree |
| POST | `/api/agents/kill-all` | Kill everything |
| GET | `/api/processes` | Process tree per agent |
| GET | `/api/queue` | Queued messages per agent |
| POST | `/api/permissions/:id/resolve` | Approve/deny/answer |
| GET | `/api/agents/:id/subagents` | List subagents |
| WS | `/ws` | Real-time event stream |

## License

MIT
