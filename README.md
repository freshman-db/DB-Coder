# DB-Coder

**Autonomous AI Coding Agent** — Continuously scans codebases, plans improvements, executes and reviews code changes automatically.

[中文文档](./README.zh-CN.md)

---

## Overview

DB-Coder is a fully autonomous AI coding system that continuously improves target projects through a **brain → execute → verify → review → reflect** loop. It uses two independent Claude Code CLI sessions — a read-only "brain" for decision-making and a read-write "worker" for execution — with Codex CLI as a cross-reviewer.

### Core Capabilities

- **Autonomous Patrol** — Full brain decide → worker execute → hard verify → codex review → brain reflect cycle, started/stopped via Web UI
- **Dual Review** — Claude Code + Codex CLI review in parallel; intersection issues are must-fix
- **Hard Verification** — TypeScript error count comparison against baseline prevents merging degraded code
- **Natural Evolution** — Brain reflects by editing CLAUDE.md (rules/status) and writing to claude-mem (experience), no numeric scoring
- **Web UI** — Real-time task monitoring, log streaming, cost tracking, patrol control
- **Git Safety** — All changes on isolated `db-coder/*` branches, verified before merge to main

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  MainLoop Orchestrator                   │
│     brainDecide → workerExecute → hardVerify            │
│       → codexReview → brainReflect → merge              │
├─────────────┬─────────────────────────┬─────────────────┤
│ Brain Session│    Worker Session      │   Codex CLI     │
│ (read-only) │    (read-write)        │   (review)      │
│ Claude Code │    Claude Code         │  gpt-5.3-codex  │
├─────────────┴─────────────────────────┴─────────────────┤
│  CLAUDE.md + claude-mem        TaskStore (PostgreSQL)   │
│  (rules / experience)         (tasks / logs / costs)    │
├─────────────────────────────────────────────────────────┤
│              HTTP Server (:18800)                        │
│       REST API + Web SPA + SSE Streaming                │
└─────────────────────────────────────────────────────────┘
```

## Project Structure

```
src/
├── index.ts                         # CLI entry (commander)
├── core/
│   ├── MainLoop.ts                  # Orchestration loop (~530 lines)
│   ├── ModeManager.ts               # PatrolManager (patrol start/stop)
│   ├── TaskQueue.ts                 # Task queue from DB
│   ├── Shutdown.ts                  # Graceful shutdown
│   └── ModuleScheduler.ts           # Module scan scheduling
├── bridges/
│   ├── ClaudeCodeSession.ts         # Claude Code CLI stream-json wrapper (~230 lines)
│   ├── CodingAgent.ts               # ReviewResult / ReviewIssue interfaces
│   └── CodexBridge.ts               # Codex CLI subprocess wrapper
├── memory/
│   ├── TaskStore.ts                 # PostgreSQL: tasks / logs / costs / plans
│   ├── GlobalMemory.ts              # PostgreSQL: global memory (legacy, phasing out)
│   └── ProjectMemory.ts             # claude-mem HTTP client
├── server/
│   ├── Server.ts                    # HTTP server (API + static files + security headers)
│   ├── routes.ts                    # REST API routes (~600 lines)
│   └── rateLimit.ts                 # Rate limiting
├── config/
│   ├── Config.ts                    # Config loading (global + project-level)
│   └── types.ts                     # Config type definitions
├── utils/                           # Git, cost tracking, process, logging, etc.
└── web/                             # SPA frontend (HTML/CSS/JS + marked.js)
```

## Quick Start

### Prerequisites

- Node.js >= 22
- PostgreSQL (recommended via Docker)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (installed globally)
- [Codex CLI](https://github.com/openai/codex) (optional, for dual review)

### Installation

```bash
# Clone repository
git clone https://github.com/freshman-db/DB-Coder.git
cd DB-Coder

# Install dependencies
npm install

# Start PostgreSQL (Docker)
docker run -d --name dev-postgres \
  -e POSTGRES_USER=db -e POSTGRES_PASSWORD=db -e POSTGRES_DB=db_coder \
  -p 5432:5432 postgres:16

# Enable pg_trgm extension
docker exec -i dev-postgres psql -U db -d db_coder -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"

# Build
npm run build
```

### Configuration

Global config: `~/.db-coder/config.json`

```jsonc
{
  "brain": { "model": "opus", "scanInterval": 3600 },
  "claude": { "model": "opus", "maxTaskBudget": 2.0 },
  "budget": { "maxPerTask": 5.0, "maxPerDay": 200.0 },
  "memory": {
    "pgConnectionString": "postgresql://db:db@localhost:5432/db_coder"
  },
  "server": { "port": 18800, "host": "127.0.0.1" }
}
```

Project-level override: `<project>/.db-coder.json`

### Start

```bash
# Run as service (relative paths are resolved automatically)
node dist/index.js serve --project .

# Or with absolute path
db-coder serve --project /path/to/your/project

# Production: use the supervisor script for auto-restart
nohup bash supervisor.sh > logs/nohup.out 2>&1 &
```

Open `http://127.0.0.1:18800` in a browser. The API token is shown in startup logs or found in `~/.db-coder/config.json`.

### CLI Commands

```bash
db-coder serve -p <path>    # Start service
db-coder status              # Show status
db-coder add "description"   # Add a task
db-coder queue               # Show task queue
db-coder scan [--deep]       # Trigger scan
db-coder logs -f             # Follow logs
db-coder cost                # Show costs
db-coder pause / resume      # Pause / Resume
```

## Web UI

- **Dashboard** — System status, patrol control, quick actions
- **Patrol** — Start/stop via topbar button; real-time state display (scanning, executing, reviewing, etc.)
- **Task List** — View, filter, and manage tasks with pagination
- **Logs** — Real-time SSE log streaming with level filtering
- **Settings** — Project info, system status, cost tracking

## API

The server runs on `http://127.0.0.1:18800`. All APIs require Bearer Token authentication.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/status` | Service status |
| GET | `/api/status/stream` | SSE real-time status |
| GET | `/api/metrics` | Operational metrics |
| GET/POST | `/api/tasks` | List / Create tasks |
| GET | `/api/tasks/:id` | Task details |
| POST | `/api/control/pause` | Pause loop |
| POST | `/api/control/resume` | Resume loop |
| POST | `/api/control/scan` | Trigger scan |
| POST | `/api/patrol/start` | Start patrol |
| POST | `/api/patrol/stop` | Stop patrol |
| GET | `/api/logs?follow=true` | SSE log stream |
| GET | `/api/cost` | Cost details |
| GET | `/api/plans` | List plan drafts |
| POST | `/api/plans/:id/approve` | Approve plan |
| POST | `/api/plans/:id/reject` | Reject plan |

## How It Works

### Brain + Worker Pattern

The orchestrator (MainLoop) drives two independent Claude Code CLI sessions:

1. **Brain Session** (read-only) — Reads CLAUDE.md and queries claude-mem to understand project state, then decides which task to work on. Outputs structured JSON decisions.

2. **Worker Session** (read-write) — Executes the chosen task on an isolated Git branch. Uses Claude Code's full tool set to read, write, and test code.

3. **Hard Verification** — Runs `tsc` and compares error count against baseline. New errors trigger a fix cycle via the worker's session continuation.

4. **Codex Review** — Codex CLI reviews the git diff independently. Results are cross-validated with the brain's assessment using `mergeReviews()`.

5. **Brain Reflection** — Brain analyzes outcomes, edits CLAUDE.md with new rules/lessons, and saves experience to claude-mem for future reference.

### Natural Evolution

Instead of numeric scoring (which proved ineffective in v1), the system evolves through:

- **CLAUDE.md edits**: Brain directly adds/modifies/removes rules based on task outcomes
- **claude-mem writes**: Semantic experience storage, retrieved by relevance in future decisions
- **Git history**: `git log CLAUDE.md` shows the complete evolution timeline

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript / Node.js (ESM) |
| Brain / Worker | Claude Code CLI (`--output-format stream-json`) |
| Reviewer | Codex CLI (`gpt-5.3-codex`) |
| Database | PostgreSQL + `pg_trgm` via `postgres` (porsager) |
| Experience | CLAUDE.md + claude-mem HTTP API |
| Web UI | Vanilla HTML/CSS/JS SPA + marked.js |
| HTTP Server | Node.js `http` module |

## License

MIT
