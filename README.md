# DB-Coder

**Autonomous AI Coding Agent** — Continuously scans codebases, plans improvements, executes and reviews code changes automatically.

[中文文档](./README.zh-CN.md)

---

## Overview

DB-Coder is a fully autonomous AI coding system that continuously improves target projects through a **scan → plan → execute → review → reflect** loop. It uses Claude (Opus) as the brain for analysis and planning, Claude + Codex as dual execution engines, and cross-reviews all code changes.

### Core Capabilities

- **Autonomous Loop** — Full scan → plan → execute → review → reflect cycle without manual intervention
- **Dual Review** — Claude Code + Codex CLI review in parallel, intersection issues are must-fix
- **Self-Evolution** — Extracts lessons from every task, dynamically optimizes prompt templates
- **Meta-Prompt Reflection** — Brain periodically analyzes prompt effectiveness, proposes section-level patches, auto-tracks impact and rolls back degraded versions
- **MCP Integration** — Auto-discovers Claude plugins (Serena, Context7, Playwright, etc.) and routes by phase
- **Dual-Layer Memory** — PostgreSQL (global experience) + claude-mem (project-level context)
- **Web UI** — Real-time task monitoring, log streaming, cost tracking

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Brain (Opus)                       │
│              scan / plan / reflect / evolve              │
├─────────────┬───────────────────────────┬───────────────┤
│ ClaudeBridge│     PromptRegistry        │  CodexBridge  │
│ (Agent SDK) │  (meta-prompt patches)    │ (codex exec)  │
├─────────────┴───────────────────────────┴───────────────┤
│                      MainLoop                           │
│     execute subtasks → dual review → reflect → merge    │
├──────────────┬──────────────┬───────────────────────────┤
│  TaskStore   │ GlobalMemory │    EvolutionEngine        │
│  (PostgreSQL)│  (PostgreSQL)│  adjustments / trends /   │
│              │              │  meta-reflect / patches    │
├──────────────┴──────────────┴───────────────────────────┤
│              HTTP Server (:18800)                        │
│         REST API + Web SPA + SSE Logs                   │
└─────────────────────────────────────────────────────────┘
```

## Project Structure

```
src/
├── index.ts                 # CLI entry (commander)
├── core/
│   ├── Brain.ts             # Scan / plan / reflect (Agent SDK plan mode)
│   ├── MainLoop.ts          # Main loop: scan→plan→execute→review→reflect
│   └── TaskQueue.ts         # Task queue management
├── bridges/
│   ├── ClaudeBridge.ts      # Agent SDK query() wrapper with MCP support
│   └── CodexBridge.ts       # codex exec subprocess wrapper
├── prompts/
│   ├── brain.ts             # Brain prompt templates (scan/plan/reflect)
│   ├── executor.ts          # Executor prompt
│   ├── reviewer.ts          # Reviewer prompt
│   ├── PromptRegistry.ts    # Prompt registry (cache + dynamic patches)
│   └── patchUtils.ts        # Section-level patch utilities (apply/validate)
├── evolution/
│   ├── EvolutionEngine.ts   # Self-evolution: adjustments / trends / meta-reflect
│   ├── TrendAnalyzer.ts     # Health trend analysis
│   └── types.ts             # Evolution system types
├── memory/
│   ├── TaskStore.ts         # PostgreSQL: tasks / logs / scans / prompt versions
│   ├── GlobalMemory.ts      # PostgreSQL: global experience memory
│   └── ProjectMemory.ts     # claude-mem: project-level memory
├── mcp/
│   └── McpDiscovery.ts      # MCP plugin auto-discovery + phase routing
├── plugins/
│   └── PluginMonitor.ts     # Plugin update monitoring
├── server/
│   ├── Server.ts            # HTTP server (API + static files)
│   └── routes.ts            # REST API routes
├── config/
│   ├── Config.ts            # Config loading (global + project-level)
│   └── types.ts             # Config type definitions
├── web/                     # SPA frontend (HTML/CSS/JS)
└── scripts/
    └── triggerMetaReflect.ts # Manual prompt optimization trigger
```

## Quick Start

### Prerequisites

- Node.js >= 20
- PostgreSQL (recommended via Docker)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`@anthropic-ai/claude-agent-sdk`)
- [Codex CLI](https://github.com/openai/codex) (optional, for dual execution)

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
  "evolution": {
    "metaReflectInterval": 5,
    "promptPatchAutoApply": true,
    "maxActivePromptPatches": 3,
    "goals": [
      { "description": "Improve code quality", "priority": 1, "status": "active" }
    ]
  }
}
```

Project-level override: `<project>/.db-coder.json`

### Start

```bash
# Run as service
node dist/index.js serve --project /path/to/your/project

# Or use CLI
db-coder serve --project .
```

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

## API

The server runs on `http://127.0.0.1:18800`. All APIs require Bearer Token authentication.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/status` | Service status |
| GET/POST | `/api/tasks` | List / Create tasks |
| GET | `/api/tasks/:id` | Task details |
| POST | `/api/control/pause` | Pause loop |
| POST | `/api/control/resume` | Resume loop |
| POST | `/api/control/scan` | Trigger scan |
| GET | `/api/logs?follow=true` | SSE log stream |
| GET | `/api/memory?q=...` | Search memory |
| GET | `/api/cost` | Cost details |
| GET | `/api/evolution/summary` | Evolution summary |
| GET | `/api/evolution/prompt-versions` | Prompt versions |
| POST | `/api/evolution/prompt-versions/:id/activate` | Activate patch |
| POST | `/api/evolution/prompt-versions/:id/rollback` | Rollback patch |

## Meta-Prompt Reflection System

One of DB-Coder's core innovations: after every N completed tasks, the Brain automatically analyzes prompt template effectiveness and proposes optimizations.

```
Task completed → counter++ → trigger metaReflect()
                                    ↓
                   Collect review events / trends / logs
                                    ↓
                   Brain (Opus) analyzes & proposes 0-3 patches
                                    ↓
                candidate (confidence ≥ 0.7) → active
                                    ↓
              effectiveness tracking (success +0.1 / failure -0.15)
                                    ↓
                effectiveness < -0.3 → auto rollback
```

**Patch Operations**: `prepend` | `append` | `replace_section` | `remove_section`

**Safety Guards**:
- JSON format guard: validates patched prompts still contain required output format markers
- Auto rollback: effectiveness < -0.3 with ≥ 3 evaluations
- Pass rate rollback: pass rate drops > 15% with ≥ 5 evaluations
- Concurrency cap: max 3 active patches at a time
- Patch failure fallback: returns to original base template

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript / Node.js (ESM) |
| Brain | Claude Opus via `@anthropic-ai/claude-agent-sdk` |
| Executor | Claude Code (Agent SDK) + Codex CLI (`gpt-5.3-codex`) |
| Database | PostgreSQL + `pg_trgm` via `postgres` (porsager) |
| Project Memory | claude-mem HTTP API |
| MCP | Auto-discovered plugins (Serena, Context7, Playwright, etc.) |
| Web UI | Vanilla HTML/CSS/JS SPA |
| HTTP Server | Node.js `http` module |

## License

MIT
