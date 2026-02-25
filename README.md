# DB-Coder

**Autonomous AI Coding Agent** — Continuously scans codebases, plans improvements, executes and reviews code changes automatically.

[中文文档](./README.zh-CN.md)

---

## Overview

DB-Coder is a fully autonomous AI coding system that continuously improves target projects through a **brain → analyze → execute → verify → review → decide → reflect** loop. It uses a read-only "brain" session for decision-making, a switchable worker (Claude Code or Codex) for execution, and an automatically selected cross-reviewer (mutually exclusive with the worker) for quality gating.

### Core Capabilities

- **Autonomous Patrol** — Full brain decide → [analyze M/L/XL] → worker execute → hard verify → code review → brain decision → reflect cycle, started/stopped via Web UI
- **Switchable Worker** — Claude Code or Codex as executor (`autonomy.worker` config); reviewer auto-selected as the other model (mutual exclusion)
- **Brain Decision** — 5-way decision after review (fix / ignore / block / rewrite / split) replaces binary pass/fail
- **Hard Verification** — TypeScript error count comparison against baseline prevents merging degraded code
- **Natural Evolution** — Brain reflects by editing CLAUDE.md (rules/status) and writing to claude-mem (experience), no numeric scoring
- **Web UI** — Real-time task monitoring, log streaming, cost tracking, patrol control
- **Git Safety** — All changes on isolated `db-coder/*` branches, verified before merge to main

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    MainLoop Orchestrator                      │
│  brainDecide → [analyze M/L/XL] → workerExecute → hardVerify │
│    → codeReview → brainReviewDecision → [fix loop] → merge   │
├──────────────┬──────────────────────┬────────────────────────┤
│ Brain Session│   WorkerAdapter      │    ReviewAdapter        │
│ (read-only   │   (switchable)       │    (mutual exclusion)  │
│  + decision) │ Claude ↔ Codex       │    Codex ↔ Claude      │
├──────────────┴──────────────────────┴────────────────────────┤
│  CLAUDE.md + claude-mem          TaskStore (PostgreSQL)       │
│  (rules / experience)           (tasks / logs / costs)       │
├──────────────────────────────────────────────────────────────┤
│                HTTP Server (:18800)                           │
│         REST API + Web SPA + SSE Streaming                   │
└──────────────────────────────────────────────────────────────┘
```

## Project Structure

```
src/
├── index.ts                         # CLI entry (commander)
├── core/
│   ├── MainLoop.ts                  # Orchestration loop (~3200 lines)
│   ├── WorkerAdapter.ts             # WorkerAdapter + ReviewAdapter interfaces & implementations
│   ├── PersonaLoader.ts             # Persona loading + skill mapping + worker prompt building
│   ├── CycleEventBus.ts             # Typed event bus for cycle lifecycle
│   ├── ModeManager.ts               # PatrolManager (patrol start/stop)
│   ├── TaskQueue.ts                 # Task queue from DB
│   ├── Shutdown.ts                  # Graceful shutdown
│   ├── guards/                      # BudgetGuard, ConcurrencyGuard, EmptyDiffGuard, etc.
│   ├── observers/                   # CycleMetricsCollector, NotificationObserver, etc.
│   └── strategies/                  # DynamicPriority, FailureLearning, TaskQuality
├── bridges/
│   ├── ClaudeCodeSession.ts         # Claude Code Agent SDK query() wrapper (~210 lines)
│   ├── sdkMessageCollector.ts       # SDK stream event collection + error synthesis
│   ├── buildSdkOptions.ts           # SDK options builder
│   ├── hooks.ts                     # Programmatic PreToolUse/PostToolUse hooks
│   ├── pluginDiscovery.ts           # Auto-discover plugins from ~/.claude/plugins/cache
│   ├── CodingAgent.ts               # ReviewResult / ReviewIssue interfaces
│   └── CodexBridge.ts               # Codex CLI subprocess wrapper + token cost estimation
├── memory/
│   ├── TaskStore.ts                 # PostgreSQL: tasks / logs / costs / plans / personas
│   ├── GlobalMemory.ts              # PostgreSQL: global memory (legacy, phasing out)
│   └── ProjectMemory.ts             # claude-mem HTTP client
├── server/
│   ├── Server.ts                    # HTTP server (API + static files + security headers)
│   ├── routes.ts                    # REST API routes (~900 lines)
│   └── rateLimit.ts                 # Rate limiting
├── config/
│   ├── Config.ts                    # Config loading (global + project-level)
│   └── types.ts                     # Config type definitions
├── utils/                           # Git, cost tracking, process, logging, validation, etc.
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
  "brain": { "model": "opus", "scanInterval": 300 },
  "claude": { "model": "opus", "maxTaskBudget": 10.0, "maxTurns": 200 },
  "codex": { "model": "gpt-5.3-codex", "tokenPricing": { "inputPerMillion": 1.75, "cachedInputPerMillion": 0.175, "outputPerMillion": 14 } },
  "autonomy": { "worker": "claude", "maxReviewFixes": 1 },
  "budget": { "maxPerTask": 20.0, "maxPerDay": 300.0 },
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
| GET | `/api/tasks/pending-review` | Tasks pending review |
| POST | `/api/tasks/:id/approve` | Approve task |
| POST | `/api/tasks/:id/skip` | Skip task |
| POST | `/api/control/pause` | Pause loop |
| POST | `/api/control/resume` | Resume loop |
| POST | `/api/control/scan` | Trigger scan |
| POST | `/api/patrol/start` | Start patrol |
| POST | `/api/patrol/stop` | Stop patrol |
| GET | `/api/logs?follow=true` | SSE log stream |
| GET | `/api/cost` | Cost details |
| GET | `/api/cycle/metrics` | Cycle performance metrics |
| GET | `/api/cycle/entries` | Cycle history entries |
| GET | `/api/personas` | List personas |
| PUT | `/api/personas/:name` | Update persona content |
| GET | `/api/plans` | List plan drafts |
| POST | `/api/plans/:id/approve` | Approve plan |
| POST | `/api/plans/:id/reject` | Reject plan |

## How It Works

### Brain + Worker + Reviewer Pattern

The orchestrator (MainLoop) drives a brain session, a switchable worker, and a mutually exclusive reviewer:

1. **Brain Session** (read-only) — Reads CLAUDE.md and queries claude-mem to understand project state, then decides which task to work on. Outputs structured JSON decisions including persona, complexity, and subtasks.

2. **Analysis Phase** (M/L/XL tasks only) — Worker performs read-only code analysis → Reviewer checks the proposal → Brain synthesizes and approves/rejects the plan. S tasks skip this phase.

3. **Worker Execution** (switchable: Claude Code or Codex) — Executes the task (with approved plan if analysis phase ran) on an isolated Git branch. Worker type is configured via `autonomy.worker`.

4. **Hard Verification** — Runs `tsc` and compares error count against baseline. New errors trigger a fix cycle via session continuation (Claude) or new session (Codex).

5. **Code Review** (mutual exclusion) — Reviewer is automatically selected as the opposite model from the worker (worker=Claude → Codex reviews, worker=Codex → Claude reviews).

6. **Brain Decision** — Brain analyzes review results and makes a 5-way decision: **fix** (send to worker for repair), **ignore** (merge despite issues), **block** (stop), **rewrite** (new approach), or **split** (merge partial + create follow-up tasks). Fix/rewrite triggers at most one retry round.

7. **Brain Reflection** — Brain analyzes outcomes, edits CLAUDE.md with new rules/lessons, and saves experience to claude-mem for future reference.

### Natural Evolution

Instead of numeric scoring (which proved ineffective in v1), the system evolves through:

- **CLAUDE.md edits**: Brain directly adds/modifies/removes rules based on task outcomes
- **claude-mem writes**: Semantic experience storage, retrieved by relevance in future decisions
- **Git history**: `git log CLAUDE.md` shows the complete evolution timeline

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript / Node.js (ESM) |
| Brain | Claude Code CLI (`--output-format stream-json`, read-only) |
| Worker | Claude Code or Codex CLI (switchable via `autonomy.worker` config) |
| Reviewer | Auto-selected opposite of worker (mutual exclusion) |
| Database | PostgreSQL + `pg_trgm` via `postgres` (porsager) |
| Experience | CLAUDE.md + claude-mem HTTP API |
| Web UI | Vanilla HTML/CSS/JS SPA + marked.js |
| HTTP Server | Node.js `http` module |

## License

MIT
