# DB-Coder

**Autonomous AI Coding Agent** — Continuously scans codebases, plans improvements, executes and reviews code changes automatically.

[中文文档](./README.zh-CN.md)

---

## Overview

DB-Coder is a fully autonomous AI coding system that continuously improves target projects through a **scan → plan → execute → review → reflect** loop. It uses Claude (Opus) as the brain for analysis and planning, Claude + Codex as dual execution engines, and cross-reviews all code changes.

### Core Capabilities

- **Autonomous Patrol** — Full scan → plan → execute → review → reflect cycle, started/stopped via Web UI
- **Interactive Plan Chat** — Multi-turn conversational planning with Claude in the Web UI, streaming Markdown responses in real-time
- **Dual Review** — Claude Code + Codex CLI review in parallel, intersection issues are must-fix
- **Self-Evolution** — Extracts lessons from every task, dynamically optimizes prompt templates
- **Meta-Prompt Reflection** — Brain periodically analyzes prompt effectiveness, proposes section-level patches, auto-tracks impact and rolls back degraded versions
- **MCP Integration** — Auto-discovers Claude plugins (Serena, Context7, Playwright, etc.) and routes by phase
- **Dual-Layer Memory** — PostgreSQL (global experience) + claude-mem (project-level context)
- **Web UI** — Real-time task monitoring, log streaming, cost tracking, chat-based planning

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Brain (Opus)                       │
│              scan / plan / reflect / evolve              │
├─────────────┬───────────────────────────┬───────────────┤
│ ClaudeBridge│     PromptRegistry        │  CodexBridge  │
│ (Agent SDK) │  (meta-prompt patches)    │ (codex exec)  │
├─────────────┴───────────────────────────┴───────────────┤
│          MainLoop              PlanWorkflow             │
│   patrol: scan→plan→execute    chat: multi-turn dialog  │
│   →review→reflect→merge        →research→generate plan  │
├──────────────┬──────────────┬───────────────────────────┤
│  TaskStore   │ GlobalMemory │    EvolutionEngine        │
│  (PostgreSQL)│  (PostgreSQL)│  adjustments / trends /   │
│              │              │  meta-reflect / patches    │
├──────────────┴──────────────┴───────────────────────────┤
│              HTTP Server (:18800)                        │
│       REST API + Web SPA + SSE Streaming                │
└─────────────────────────────────────────────────────────┘
```

## Project Structure

```
src/
├── index.ts                 # CLI entry (commander), resolves project path
├── core/
│   ├── Brain.ts             # Scan / plan / reflect (Agent SDK plan mode)
│   ├── MainLoop.ts          # Patrol loop: scan→plan→execute→review→reflect
│   ├── ModeManager.ts       # PatrolManager (patrol start/stop)
│   ├── PlanWorkflow.ts      # Chat-based planning (persistent ChatSession + SSE)
│   └── TaskQueue.ts         # Task queue management
├── bridges/
│   ├── CodingAgent.ts       # AgentResult / ReviewResult interfaces
│   ├── ClaudeBridge.ts      # Agent SDK query() wrapper + createChatSession()
│   ├── CodexBridge.ts       # codex exec subprocess wrapper
│   └── MessageHandler.ts    # Auto-answer AskUserQuestion handler
├── utils/
│   ├── AsyncChannel.ts      # Push-to-pull adapter for Agent SDK streaming
│   ├── cost.ts              # CostTracker (budget guard)
│   ├── git.ts               # Git operations (branch, commit, merge, diff)
│   ├── safeBuild.ts         # Atomic dist/ swap for self-modification
│   └── ...
├── prompts/
│   ├── brain.ts             # Brain prompt templates (scan/plan/reflect) + formatDynamicContext
│   ├── executor.ts          # Executor prompt
│   ├── evaluator.ts         # Pre-execution evaluation prompt
│   ├── reviewer.ts          # Reviewer prompt
│   ├── agents.ts            # Agent guidance builder (plugin-aware)
│   ├── PromptRegistry.ts    # Prompt registry (cache + dynamic patches)
│   └── patchUtils.ts        # Section-level patch utilities (apply/validate)
├── evolution/
│   ├── EvolutionEngine.ts   # Self-evolution: adjustments / trends / meta-reflect
│   ├── TrendAnalyzer.ts     # Health trend analysis
│   └── types.ts             # Evolution system types
├── memory/
│   ├── TaskStore.ts         # PostgreSQL: tasks / logs / scans / plans / chat / adjustments
│   ├── GlobalMemory.ts      # PostgreSQL: global experience memory
│   └── ProjectMemory.ts     # claude-mem: project-level memory
├── mcp/
│   ├── McpDiscovery.ts      # MCP plugin auto-discovery + phase routing
│   ├── SystemDataMcp.ts     # Internal MCP server for meta-reflect data access
│   └── InternalMcpServer.ts # Internal MCP server base
├── plugins/
│   └── PluginMonitor.ts     # Plugin update monitoring
├── server/
│   ├── Server.ts            # HTTP server (API + static files)
│   └── routes.ts            # REST API routes (HttpError pattern)
├── config/
│   ├── Config.ts            # Config loading (global + project-level)
│   └── types.ts             # Config type definitions
├── web/                     # SPA frontend (HTML/CSS/JS + marked.js for Markdown)
└── scripts/
    └── triggerMetaReflect.ts # Manual prompt optimization trigger
```

## Quick Start

### Prerequisites

- Node.js >= 22
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
# Run as service (relative paths are resolved automatically)
node dist/index.js serve --project .

# Or with absolute path
db-coder serve --project /path/to/your/project

# Production: use the supervisor script for auto-restart and crash recovery
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

The Web UI provides:

- **Dashboard** — System status, patrol control, quick actions
- **Patrol** — Start/stop patrol via topbar button; real-time state display (scanning, planning, executing, etc.)
- **Plan Chat** — Multi-turn conversational planning with Claude; streaming Markdown responses; generate executable plans from chat
- **Task List** — View, filter, and manage tasks with pagination
- **Logs** — Real-time SSE log streaming with level filtering
- **Settings** — Current project, system status, cost tracking, configuration (read-only)

## API

The server runs on `http://127.0.0.1:18800`. All APIs require Bearer Token authentication.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/status` | Service status (includes projectPath) |
| GET/POST | `/api/tasks` | List / Create tasks |
| GET | `/api/tasks/:id` | Task details |
| POST | `/api/control/pause` | Pause loop |
| POST | `/api/control/resume` | Resume loop |
| POST | `/api/control/scan` | Trigger scan |
| POST | `/api/patrol/start` | Start patrol |
| POST | `/api/patrol/stop` | Stop patrol |
| GET | `/api/logs?follow=true` | SSE log stream |
| GET | `/api/memory?q=...` | Search memory |
| GET | `/api/cost` | Cost details |
| **Plan Chat** | | |
| POST | `/api/plans/chat` | Create new chat session |
| POST | `/api/plans/:id/message` | Send user message |
| GET | `/api/plans/:id/messages` | Get chat history |
| GET | `/api/plans/:id/stream` | SSE stream (real-time updates) |
| POST | `/api/plans/:id/generate` | Generate plan from chat |
| POST | `/api/plans/:id/close` | Close chat session |
| GET | `/api/plans` | List plan drafts |
| POST | `/api/plans/:id/approve` | Approve plan |
| POST | `/api/plans/:id/reject` | Reject plan |
| POST | `/api/plans/:id/execute` | Execute approved plan |
| GET | `/api/metrics` | Operational metrics (task stats, costs, health) |
| **Evolution** | | |
| GET | `/api/evolution/summary` | Evolution summary |
| GET | `/api/evolution/prompt-versions` | Prompt versions |
| POST | `/api/evolution/prompt-versions/:id/activate` | Activate patch |
| POST | `/api/evolution/prompt-versions/:id/rollback` | Rollback patch |

## Evolution Feedback Loop

DB-Coder continuously learns from execution outcomes. The evolution system connects execution → review → reflection → future execution:

```
executeSubtask() ← evolution context injected (patterns, anti-patterns, adjustments)
        ↓
  dualReview() → structured mustFix/shouldFix issues
        ↓
  reflectOnTask() ← enriched review details (not just summary)
        ↓
  processAdjustments() → causal attribution (only applied adjustments updated)
        ↓
  smartTruncate() → tool summaries or tail-truncated output (not head)
```

Key mechanisms:
- **Executor sees evolution context**: `synthesizePromptContext()` injects learned patterns, anti-patterns, and active adjustments into every executor prompt
- **Structured review → reflect**: Full `mustFix`/`shouldFix` issue details (severity, file, line, suggestion) flow to reflection, not just a summary string
- **Causal effectiveness attribution**: Records which adjustments were active when a task executed; only those adjustments get effectiveness updates on success/failure
- **Smart truncation**: Prefers free SDK `tool_use_summary` metadata; falls back to tail-truncated output (1500 chars) instead of head-truncated (which captures useless preamble)

## Meta-Prompt Reflection System

After every N completed tasks, the Brain analyzes prompt template effectiveness using an internal MCP data server and proposes optimizations.

```
Task completed → counter++ → trigger metaReflect()
                                    ↓
                   SystemDataMcp provides data query tools
                                    ↓
                   Brain (Opus) autonomously explores data & proposes 0-3 patches
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
| Web UI | Vanilla HTML/CSS/JS SPA + marked.js (Markdown rendering) |
| HTTP Server | Node.js `http` module |

## License

MIT
