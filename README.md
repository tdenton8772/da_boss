# da_boss

A web-based manager for spawning, monitoring, and controlling multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) agent instances. Built on the `@anthropic-ai/claude-agent-sdk`.

## What it does

- **Spawn agents** with a prompt, working directory, model, priority, and budget
- **Real-time streaming** of agent messages via WebSocket
- **Permission control** — auto-approves safe tool calls (reads, greps, edits within cwd), escalates risky ones (bash, writes outside cwd) to the UI for approval
- **Token budget management** — daily/monthly limits with priority-based enforcement (high/medium/low)
- **Supervisor** — checks agents every 5 minutes for stuck/idle states, evaluates completeness via Claude
- **Session discovery** — find and import existing Claude Code sessions from any repo on your machine
- **Session compaction & trimming** — shrink large transcripts so agents can resume without hitting context limits
- **Push notifications** via [ntfy.sh](https://ntfy.sh)
- **Runs as a macOS service** — survives terminal closes, starts on login

## Quick start

Requires Node.js 22+ (use `nvm use 22`).

```bash
git clone <repo-url> da_boss
cd da_boss
npm install
npm run install-service
```

The installer builds the project, generates a `.env` with a random password, and installs a launchd service.

```bash
# Start the service
npm run service:start

# Open the dashboard
open http://localhost:3847

# View logs
npm run service:logs
```

### Development mode

```bash
npm run dev    # server on :3847, vite UI on :3848
npm run test   # 67 tests
```

## Service management

```bash
npm run service:start   # launchctl load
npm run service:stop    # launchctl unload
npm run service:logs    # tail stderr log

# Or directly
launchctl list | grep daboss
```

The service auto-restarts on crash and starts on login.

## Configuration

All config lives in `.env` at the project root:

| Variable | Default | Description |
|---|---|---|
| `AUTH_PASSWORD` | (generated) | Dashboard login password |
| `SESSION_SECRET` | (generated) | Express session secret |
| `PORT` | `3847` | Server port |
| `NTFY_TOPIC` | (empty) | ntfy.sh topic for push notifications |
| `ANTHROPIC_ADMIN_API_KEY` | (empty) | For org-level usage tracking |
| `CLAUDE_PATH` | `~/.local/bin/claude` | Path to claude CLI binary |

## Architecture

```
Browser (React) ──WebSocket + REST──> Express (:3847) ──> Claude Agent SDK
                                          |
                                       SQLite
                                          |
                                    Supervisor (5min cron)
```

- **Server** (`server/src/`) — Express 5, WebSocket, SQLite, agent lifecycle management
- **UI** (`ui/src/`) — React, Tailwind v4, Vite
- **Agent runner** — wraps SDK `query()`, streams messages, tracks tokens, handles pause/resume/kill
- **Permission system** — three policies: `auto` (approve safe ops), `ask` (prompt for everything), `strict` (deny by default)
- **Budget enforcement** — priority tiers, daily/monthly caps, auto-pauses agents at threshold

See [CLAUDE.md](CLAUDE.md) for detailed module-by-module documentation.

## Agent states

```
PENDING -> RUNNING -> COMPLETED
               |          |
          WAITING_*    (restart)
               |
            PAUSED -> RUNNING (resume)

Any -> ABORTED (kill)
FAILED -> RUNNING (retry)
```

## License

MIT
