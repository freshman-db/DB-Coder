# DB-Coder

**Autonomous AI Coding Agent** — Continuously scans codebases, plans improvements, executes and reviews code changes automatically.

[中文文档](./README.zh-CN.md)

---

## Overview

DB-Coder is a fully autonomous AI coding system that continuously improves target projects through a **brain decide → [analyze M/L/XL] → worker execute → hard verify → code review → brain decision → reflect** loop. It uses a read-only "brain" session for decision-making, a RuntimeAdapter-based worker for execution, and an automatically selected cross-reviewer for quality gating. Each phase can independently select its runtime and model via the `routing` configuration.

### Core Capabilities

- **Autonomous Patrol** — Full brain decide → [analyze M/L/XL] → worker execute → hard verify → code review → brain decision → reflect cycle, started/stopped via Web UI
- **Multi-Runtime Architecture** — RuntimeAdapter interface with pluggable implementations (ClaudeSdkRuntime, CodexSdkRuntime, CodexCliRuntime); each phase independently configurable via `routing`
- **Brain-Driven Decisions** — Brain outputs free-form `directive` directly to worker (no template restructuring), with `resource_request` for budget/timeout, `verification_plan`, and `strategy_note`
- **Hard Verification** — TypeScript error count comparison against baseline prevents merging degraded code
- **Natural Evolution** — Brain reflects by writing lessons to claude-mem (experience); CLAUDE.md is maintained by a separate periodic `claudeMdMaintenance` phase, no numeric scoring
- **Web UI** — Real-time task monitoring, log streaming, cost tracking, patrol control
- **Git Safety** — All changes on isolated `db-coder/*` branches, verified before merge to main

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    MainLoop Orchestrator                      │
│  brainDecide → [analyze M/L/XL] → workerExecute → hardVerify │
│    → codeReview → brainReviewDecision → [fix loop] → merge   │
├──────────────────────────────────────────────────────────────┤
│                    RuntimeAdapter Layer                       │
│  ┌─────────────────┐ ┌───────────────┐ ┌──────────────────┐ │
│  │ ClaudeSdkRuntime │ │ CodexSdkRuntime│ │ CodexCliRuntime  │ │
│  │ (Agent SDK)      │ │ (@openai/codex)│ │ (codex exec)    │ │
│  └─────────────────┘ └───────────────┘ └──────────────────┘ │
├──────────────────────────────────────────────────────────────┤
│  Phase Routing (routing config)                              │
│  brain / plan / execute / review / reflect / scan            │
│  Each phase → independent runtime + model selection          │
├──────────────────────────────────────────────────────────────┤
│  CLAUDE.md + claude-mem          TaskStore (PostgreSQL)       │
│  (rules / experience)           (tasks / logs / costs)       │
├──────────────────────────────────────────────────────────────┤
│                HTTP Server (:18801)                           │
│         REST API + Web SPA + SSE Streaming                   │
└──────────────────────────────────────────────────────────────┘
```

## Project Structure

```
src/
├── index.ts                         # CLI entry (commander)
├── core/
│   ├── MainLoop.ts                  # Orchestration loop
│   ├── phases/                      # BrainPhase, WorkerPhase, ReviewPhase, MaintenancePhase
│   ├── PersonaLoader.ts             # Persona loading + worker prompt building
│   ├── CycleEventBus.ts             # Typed event bus for cycle lifecycle
│   ├── ModeManager.ts               # PatrolManager (patrol start/stop)
│   ├── TaskQueue.ts                 # Task queue from DB
│   ├── guards/                      # BudgetGuard, ConcurrencyGuard, EmptyDiffGuard, etc.
│   ├── observers/                   # CycleMetricsCollector, NotificationObserver, etc.
│   └── strategies/                  # DynamicPriority, FailureLearning, TaskQuality
├── runtime/
│   ├── RuntimeAdapter.ts            # Interface + capabilities + RunOptions / RunResult
│   ├── ClaudeSdkRuntime.ts          # Claude Code Agent SDK wrapper
│   ├── CodexSdkRuntime.ts           # @openai/codex-sdk Thread API wrapper
│   ├── CodexCliRuntime.ts           # Codex CLI subprocess wrapper
│   └── runtimeFactory.ts           # Config → runtime instance registry
├── bridges/
│   ├── ClaudeCodeSession.ts         # Claude Code Agent SDK query() wrapper
│   ├── sdkMessageCollector.ts       # SDK stream event collection + error synthesis
│   ├── buildSdkOptions.ts           # SDK options builder
│   ├── hooks.ts                     # Programmatic PreToolUse/PostToolUse hooks
│   ├── pluginDiscovery.ts           # Auto-discover plugins from ~/.claude/plugins/cache
│   ├── ReviewTypes.ts               # ReviewResult / ReviewIssue interfaces
│   └── CodexBridge.ts               # Codex CLI subprocess (used by CodexCliRuntime)
├── memory/
│   ├── TaskStore.ts                 # PostgreSQL: tasks / logs / costs / plans / personas
│   ├── GlobalMemory.ts              # PostgreSQL: global memory (legacy, phasing out)
│   └── ProjectMemory.ts             # claude-mem HTTP client
├── server/
│   ├── Server.ts                    # HTTP server (API + static files + security headers)
│   ├── routes.ts                    # REST API routes
│   └── rateLimit.ts                 # Rate limiting
├── config/
│   ├── Config.ts                    # Config loading (global + project-level)
│   └── types.ts                     # Config types (PhaseRouting, RoutingConfig, etc.)
├── utils/                           # Git, cost tracking, process, logging, validation, etc.
└── web/                             # SPA frontend (HTML/CSS/JS + marked.js)
```

## Quick Start

### Prerequisites

- Node.js >= 22
- PostgreSQL (recommended via Docker)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (installed globally)
- [Codex CLI](https://github.com/openai/codex) (optional, for cross-model review)

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
  "routing": {
    "brain":   { "runtime": "claude-sdk", "model": "claude-opus-4-6" },
    "plan":    { "runtime": "claude-sdk", "model": "claude-opus-4-6" },
    "execute": { "runtime": "claude-sdk", "model": "claude-opus-4-6" },
    "review":  { "runtime": "codex-cli",  "model": "gpt-5.3-codex" },
    "reflect": { "runtime": "claude-sdk", "model": "claude-opus-4-6" },
    "scan":    { "runtime": "claude-sdk", "model": "claude-opus-4-6" }
  },
  "claude": { "maxTaskBudget": 10.0, "maxTurns": 200 },
  "codex": { "tokenPricing": { "inputPerMillion": 1.75, "cachedInputPerMillion": 0.175, "outputPerMillion": 14 } },
  "budget": { "maxPerTask": 20.0, "maxPerDay": 300.0 },
  "memory": {
    "pgConnectionString": "postgresql://db:db@localhost:5432/db_coder"
  },
  "server": { "port": 18801, "host": "127.0.0.1" }
}
```

Runtime aliases: `"claude"` normalizes to `"claude-sdk"`, `"codex"` to `"codex-sdk"` (with CLI fallback).

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

Open `http://127.0.0.1:18801` in a browser. The API token is shown in startup logs or found in `~/.db-coder/config.json`.

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

The server runs on `http://127.0.0.1:18801`. All APIs require Bearer Token authentication.

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

### Brain-Driven + RuntimeAdapter Pattern

The orchestrator (MainLoop) drives a brain session, a RuntimeAdapter-based worker, and a cross-runtime reviewer. Each phase selects its runtime and model via the `routing` config.

1. **Brain Decision** (read-only) — Brain explores the codebase freely using its own tools, outputs a structured `directive` (free-form instructions for the worker), `resource_request` (budget/timeout), `verification_plan`, and `strategy_note`. No template restructuring — the directive goes through to the worker as-is.

2. **Analysis Phase** (M/L/XL tasks only) — Worker performs read-only code analysis → Cross-runtime reviewer checks the proposal → Brain synthesizes and approves/rejects the plan. S tasks skip this phase.

3. **Worker Execution** (via RuntimeAdapter) — Executes the task on an isolated Git branch using the runtime configured in `routing.execute`. The worker receives the brain's directive directly, supplemented by project rules and verification plan.

4. **Hard Verification** — Runs `tsc` and compares error count against baseline. New errors trigger a fix cycle.

5. **Code Review** (cross-runtime) — Review uses the runtime from `routing.review`, which should differ from `routing.execute` to avoid self-validation bias.

6. **Brain Decision** — Brain analyzes review results and makes a 5-way decision: **fix** (send to worker for repair), **ignore** (merge despite issues), **block** (stop), **rewrite** (new approach), or **split** (merge partial + create follow-up tasks).

7. **Brain Reflection** — Brain outputs multi-paragraph `reflection`, `strategy_update`, `retrieval_lesson`, and optional `orchestrator_feedback`. Saves lessons to claude-mem for future reference (does **not** edit CLAUDE.md; that is handled by a separate periodic `claudeMdMaintenance` phase).

### Natural Evolution

Instead of numeric scoring (which proved ineffective in v1), the system evolves through:

- **CLAUDE.md maintenance**: A periodic `claudeMdMaintenance` phase audits and updates CLAUDE.md against actual code, keeping rules accurate and concise
- **claude-mem writes**: Brain reflection saves lessons as semantic experience, retrieved by relevance in future decisions
- **Git history**: `git log CLAUDE.md` shows the complete evolution timeline

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript / Node.js (ESM) |
| Runtime Layer | RuntimeAdapter interface (ClaudeSdkRuntime, CodexSdkRuntime, CodexCliRuntime) |
| Brain | Claude Code Agent SDK (read-only, structured output) |
| Worker | Configurable per-phase via `routing.execute` |
| Reviewer | Configurable per-phase via `routing.review` (cross-runtime by default) |
| Database | PostgreSQL + `pg_trgm` via `postgres` (porsager) |
| Experience | CLAUDE.md + claude-mem HTTP API |
| Web UI | Vanilla HTML/CSS/JS SPA + marked.js |
| HTTP Server | Node.js `http` module |

## License

MIT
