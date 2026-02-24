# db-coder Comprehensive Architecture Analysis

## Project Overview
**db-coder** is an autonomous AI coding agent (TypeScript, Node.js 22+, ~18K lines) with a brain/worker dual-session architecture. It autonomously runs cycles to improve a target project (often itself) through structured decision-making, execution, verification, and reflection.

**Key Stats**: 107 TS files, 18K+ LOC, v2 architecture using Claude Code CLI (stream-json mode) instead of Agent SDK

---

## Core Architecture

### High-Level Flow
```
MainLoop (編排器, ~1450 lines)
├── Brain Session (只讀, 決策+反思)
│   ├── brainDecide() → 1 task + metadata (persona, taskType, subtasks)
│   ├── brainDecideDirective() → fallback when no task
│   ├── brainReflect() → learn, update CLAUDE.md, evolve personas
│   ├── specReview() → Stage 1 compliance check
│   ├── deepChainReview() → periodic (every 5 tasks)
│   └── claudeMdMaintenance() → periodic (every 15 tasks)
│
├── Worker Session (读写, 執行任務)
│   ├── workerExecute(task) → run prompt with persona + skills
│   ├── executeSubtasks() → per-subtask loop with HALT retry
│   └── workerFix(sessionId) → systematic debugging retry
│
├── Hard Verify (tsc 错误计数对比)
│   └── countTscErrors() → pure function, exported for testing
│
├── Codex Review (GPT-5.3-codex diff审查)
│   └── CodexBridge.review() → adversarial review
│
├── Guard System (前置检查)
│   ├── ConcurrencyGuard
│   ├── BudgetGuard
│   ├── StructuredOutputGuard
│   ├── EmptyDiffGuard
│   └── WorkerFixResultGuard
│
└── State Transitions
    idle → scanning → planning → executing → reviewing → reflecting → idle/paused
```

### Session Configuration
- **Brain**: `disallowedTools=['Edit','Write','NotebookEdit']`, maxTurns=20, timeout=5min
- **Worker**: `bypassPermissions=true`, maxTurns=30, timeout=10min, can use all tools
- **Codex**: GPT-5.3-codex, code review LLM (external, not Claude Code)

---

## Key Components

### 1. **PersonaLoader** (166 lines, recent addition)
- **Purpose**: Load persona templates from Markdown files, apply them to workers
- **Data Flow**:
  - Seed files in `personas/*.md` parsed at startup
  - Each persona has YAML frontmatter (name, role, taskTypes, focusAreas)
  - Brain outputs `persona` field → Worker loads persona content
  - Persona stats (usage_count, success_rate) tracked in DB
- **Skill Mapping**: `SKILL_MAP` (hardcoded) maps taskType → Superpowers skill references
- **Global Rules**: `GLOBAL_WORKER_RULES` injected into every worker prompt (17 rules)
- **Status**: ✅ Fully integrated, persona evolution via brainReflect PERSONA_UPDATE blocks

### 2. **ClaudeCodeSession** (339 lines, wrapper around Claude Code CLI)
- **Design**: Spawn `claude -p --output-format stream-json` subprocess
- **Stream Parsing**: Line-delimited JSON events
  - Accumulates assistant text blocks
  - Captures session_id, cost_usd, num_turns, exit_code
  - Extracts structured_output if --json-schema used
- **Resume Support**: `--resume <sessionId>` for multi-turn HALT retry
- **Error Handling**: Timeout handling, stderr capture, result text fallback
- **Exports**: `buildArgs()` (pure, tested), `SessionResult` interface
- **Status**: ✅ Fully functional, tested, ready for nested session support

### 3. **MainLoop Cycle** (runCycle method, ~350 lines)
**Step-by-step**:
1. Check task queue (priority over brain)
2. If no queued task: brainDecide() → Layer 2 fallback directive → Layer 3 retry loop
3. Dedup check + cooldown for similar tasks
4. Budget check
5. Create git branch, record startCommit & baselineErrors
6. **Execute Phase**:
   - If subtasks: executeSubtasks loop (per-subtask worker session, per-subtask verify)
   - Else: single workerExecute() → hard verify → HALT retry loop (up to maxRetries)
7. **Verify Phase**: hardVerify (tsc errors)
8. **Review Phase**: specReview (Stage 1) → codexReview (Stage 2, if spec passed)
9. **Merge Decision**: all three passed? → merge + log + self-build (if self-project)
10. **Reflect Phase**: brainReflect (learn + update CLAUDE.md + evolve persona)
11. **Periodic Tasks**:
    - Every 5 tasks: deepChainReview
    - Every 15 tasks: claudeMdMaintenance

### 4. **Task Store** (1200+ lines, PostgreSQL CRUD)
**Active Tables**:
- `tasks`: id(uuid), description, phase, priority, plan(jsonb), subtasks(jsonb), review_results(jsonb), status, git_branch, start_commit, total_cost_usd, created_at
- `task_logs`: task_id(fk), phase, agent(brain/claude-code/tsc/codex), input/output_summary, cost_usd, duration_ms
- `daily_costs`: date(pk), total_cost_usd, task_count
- `personas`: name(pk), role, content, task_types[], focus_areas[], usage_count, success_rate
- `plan_drafts`, `plan_chat_messages`: for disabled plan chat feature

**Deprecated Tables** (not deleted, not written to): adjustments, memories, scan_modules, evaluation_events, goal_progress

### 5. **CodexBridge** (360+ lines, subprocess wrapper)
- Spawns `codex exec --full-auto` with GPT-5.3-codex model
- Adversarial review prompt (3-10 issues from 5 categories)
- Returns `ReviewResult` with `passed` flag and `issues[]`
- Cost tracking via `cost_usd` field

### 6. **EventBus & Guards** (~1250 lines distributed)
**Guard Registration** (index.ts):
- `ConcurrencyGuard`: prevents overlapping patrol runs (lock file)
- `BudgetGuard`: pre-execute budget check
- `StructuredOutputGuard`: validates brain JSON schema compliance
- `EmptyDiffGuard`: warns if no actual changes despite task execution
- `WorkerFixResultGuard`: validates fix attempt structure

---

## Memory & Knowledge Systems

### 1. **CLAUDE.md** (Project Root)
- **Purpose**: Single source of truth for project context
- **Maintained by**: Brain reflection + periodic claudeMdMaintenance
- **Sections**: 架构, 当前状态, 环境, DB Schema, 功能链路, 设计原则, 踩过的坑
- **Update Mechanism**: brainReflect reads current, suggests edits, uses Edit/Write tools

### 2. **claude-mem** (External MCP)
- **Purpose**: Semantic memory for past experiences
- **Used by**: brainReflect to save lessons, brainDecide to search context

### 3. **Personas** (Database)
- **Structure**: Markdown frontmatter (name, role, taskTypes, focusAreas) + content body
- **Seed Files**: `personas/{name}.md` (8 templates shipped)
- **Evolution**: Brain can update persona content via PERSONA_UPDATE blocks
- **Stats**: usage_count, success_rate tracked per persona

---

## BMAD Integration Status

### Already Implemented
- ✅ Persona system (Agent-as-Code concept)
- ✅ Global worker rules (17 non-negotiable rules)
- ✅ Adversarial reviews via Codex
- ✅ HALT retry loop (up to maxRetries)
- ✅ Persona evolution (brainReflect PERSONA_UPDATE)

### Key Missing Pieces
**P0 - Task Sharding**: Brain generates subtasks, but worker doesn't split execution per subtask into independent sessions
**P1 - Subagent Pattern**: Should allocate separate worker sessions per complex subtask
**P1 - Skill Validation**: No confirmation SKILL_MAP entries actually activate in worker

---

## Superpowers Usage

**Existing**: test-driven-development, systematic-debugging, verification-before-completion, requesting-code-review
**Not Yet Used**: subagent-driven-development, others in library

---

## API Surface (43 endpoints)

Core endpoints: /api/{status,metrics,tasks,patrol,logs,cost,personas}
Disabled: /api/plans/* (all return 503, awaiting rewrite)

---

## Known Issues

1. **Brain "nothing to do" deadlock**: Fixed with Layer 2 directive, but requires evolution context
2. **Empty git diff**: Guarded but still possible
3. **Nested Claude conflicts**: Solved by clearing CLAUDECODE env vars
4. **Persona stats on HALT**: Shows success=0 (should be mixed)
5. **Plan chat disabled**: All endpoints return 503
6. **Worker context bloat**: Large tasks in single 30-turn session
7. **GlobalMemory unused**: Still initialized but not core path
8. **Subtask execution**: Exists but runs in single worker session (should be per-subtask)

---

## Strengths

✅ Clear Brain/Worker separation  
✅ 3-layer verification gate (hard verify + spec + codex)  
✅ Self-improving (persona evolution + CLAUDE.md maintenance)  
✅ Cost-aware (budget checks, daily limits)  
✅ Testable (pure functions exported, mockable sessions)  
✅ Resilient (HALT retry, session resume, error recovery)  
✅ Observable (EventBus, logs, SSE streams)

---

## Gaps

❌ No task sharding (brain plans subtasks, but single worker session)  
❌ No skill activation validation  
❌ Session context bloat (30 turns for complex tasks)  
❌ Memory fragmentation (CLAUDE.md + claude-mem + GlobalMemory)  
❌ No proactive escalation (failures logged, no auto-recovery)  
❌ Personas static in execution (loaded once, not dynamic)  
❌ Limited modularity (core loop monolithic)

---

## Recommended Next Steps

### High-Impact (1-2 days each)
1. **Subtask Session Isolation** — Per-subtask worker sessions instead of single 30-turn
2. **Persona Selection Heuristics** — Brain chooses persona based on taskType + recent success
3. **Skill Trigger Validation** — Parse worker output for skill markers

### Medium-Impact (0.5-1 day each)
4. **Git Worktree Isolation** — Cleaner failure paths
5. **Plan Chat Rewrite** — Implement disabled endpoints
6. **GlobalMemory Deprecation** — Remove unused component

---

## Critical Files

**Core** (1000+ LOC): MainLoop.ts (1452L), PersonaLoader.ts (166L)  
**Sessions**: ClaudeCodeSession.ts (339L), CodexBridge.ts (360L)  
**Data**: TaskStore.ts (932L), routes.ts (722L)  
**Quality**: guards/ (5 modules), strategies/ (3 modules)  
**Templates**: personas/*.md (8 files), .claude/skills/db-coder-*/*.md (2 files)  
**Tests**: 25+ test files covering MainLoop, ClaudeCodeSession, CodexBridge, TaskStore, guards
