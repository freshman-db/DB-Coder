# Patrol Mode Event-Driven Refactor

**Date**: 2026-02-23
**Status**: Approved
**Scope**: MainLoop event-driven architecture + Guards + Observers + Strategies

## Problem

MainLoop.ts is 980 lines with reliability gaps, poor observability, and no learning from failures.
Key issues:
- No empty diff guard (worker can "succeed" without changing code)
- Brain can return unstructured text as task description
- workerFix failures are silent
- No structured cycle logging or real-time UI feedback
- No failure learning or dynamic priority adjustment

## Solution: CycleEventBus Architecture

Introduce an event bus that wraps each MainLoop phase. New functionality is added as event listeners (Guards, Observers, Strategies) without modifying core control flow.

### Delivery Batches

| Batch | Content | Files | Depends On |
|-------|---------|-------|------------|
| 0 | CycleEventBus + MainLoop refactor + tests | 3-4 new + 1 modified | None |
| 1 | 5 Guards + tests | 5-6 new | Batch 0 |
| 2 | 4 Observers + Web UI + tests | 5-6 new + 2 modified | Batch 0 |
| 3 | 3 Strategies + tests | 4-5 new | Batch 0+2 |

---

## Batch 0: CycleEventBus Core

### Event Types

```typescript
// src/core/CycleEvents.ts

type CyclePhase =
  | 'decide' | 'create-task' | 'execute'
  | 'verify' | 'fix' | 'review'
  | 'reflect' | 'merge' | 'deep-review' | 'maintenance';

interface CycleEvent {
  phase: CyclePhase;
  timing: 'before' | 'after' | 'error';
  taskId?: string;
  data: Record<string, unknown>;
  timestamp: number;
}

interface CycleContext {
  cycleNumber: number;
  startTime: number;
  taskId?: string;
  taskDescription?: string;
  branch?: string;
  startCommit?: string;
  verification?: { passed: boolean; reason?: string };
  codexReview?: { passed: boolean; issues?: ReviewIssue[] };
  workerResult?: SessionResult;
  merged?: boolean;
}
```

### EventBus

```typescript
// src/core/CycleEventBus.ts

type EventHandler = (event: CycleEvent) => void | Promise<void>;

class CycleEventBus {
  // Pattern matching: 'after:execute', 'after:*', '*:verify', '*'
  on(pattern: string, handler: EventHandler): () => void;

  // Fire-and-forget for observation (non-blocking)
  emit(event: CycleEvent): void;

  // Await all handlers, collect errors (blocking, for guards)
  async emitAndWait(event: CycleEvent): Promise<Error[]>;
}
```

### MainLoop Changes

runCycle() shrinks from ~180 to ~60 lines. Each phase wrapped with:
```
emitAndWait(before) → execute phase → emitAndWait(after)
```

Constructor adds optional `eventBus` parameter. Without it, uses NoopBus (backward compatible).

---

## Batch 1: Guards (Reliability)

Location: `src/core/guards/`

### EmptyDiffGuard
- Listens: `after:execute`
- Checks git diff startCommit..HEAD is non-empty
- Empty → marks verification.passed = false

### StructuredOutputGuard
- Listens: `after:decide`
- Validates brain output is a real task description (not conversational text)
- JSON success → use directly
- JSON fail but looks like task → use with warning
- JSON fail and looks like conversation → reject, trigger Layer 2

### BudgetGuard
- Listens: `before:execute`
- Estimates cost from recent 5 tasks average
- Insufficient → block execution, emit budget-exhausted

### WorkerFixResultGuard
- Listens: `after:fix`
- Compares verification before/after workerFix
- Not resolved → explicit warning log

### ConcurrencyGuard
- Listens: `before:decide`
- Lock file validation (future multi-worker preparation)

---

## Batch 2: Observers (Observability)

Location: `src/core/observers/`

### StructuredCycleLogger
- Listens: `*` (all events)
- Outputs structured JSON log per event
- Writes to `logs/cycles/` (daily rotation) + human-readable log.info()

### WebUIRealtimeObserver
- Listens: `*`
- Pushes cycle events via existing SSE endpoint
- Web UI: new "Cycle Timeline" view with phase timing/status

### NotificationObserver
- Listens: `error:*`, `after:merge`, `budget-exhausted`
- Sends HTTP POST webhook for critical events
- Config: `notifications.webhookUrl` in config.json
- Default triggers: merge success, N consecutive failures, low budget

### CycleMetricsCollector
- Listens: `cycle-start`, `cycle-end`, `after:execute`, `after:verify`
- Collects: cycle_success_rate, avg_cycle_duration, phase_duration_breakdown, consecutive_failures, tasks_per_hour
- Storage: in-memory sliding window (last 100 cycles)
- Enhances existing `/api/metrics` endpoint

---

## Batch 3: Strategies (Intelligence)

Location: `src/core/strategies/`

### FailureLearningStrategy
- Listens: `after:verify` (failed), `after:review` (failed), `error:execute`
- Records failure patterns to claude-mem
- Injects failure history into brainDecide context
- 3 consecutive same-type failures → auto-lower priority
- Cooldown: exponential backoff (1 → 2 → 4 → 8 → 16 cycles)

### TaskQualityEvaluator
- Listens: `after:merge`
- Evaluates task value (pure rules, no LLM):
  - diff size, core vs config modules, tsc error reduction, has tests
- Writes quality score to task metadata
- N consecutive low-value tasks → injects focus suggestion into brain context

### DynamicPriorityStrategy
- Listens: `before:decide`
- Signals: tsc errors, recent success rate, test coverage, blocked task count
- Output: priority suggestion injected into brainDecide context
- Advisory only — brain makes final decision

### Strategy Collaboration Flow

```
FailureLearning → "refactor tasks failing 3x, suggest decomposition"
      ↓
DynamicPriority → "tsc errors rising, suggest bug fix focus"
      ↓
brainDecide context includes both signals
      ↓
Brain produces task → Worker executes → Merge
      ↓
QualityEvaluator → "bug fix reduced 3 tsc errors, quality: high"
      ↓ (feeds back into next cycle)
```

---

## File Structure

```
src/core/
├── MainLoop.ts              (modified: slim, inject EventBus)
├── CycleEventBus.ts         (new)
├── CycleEvents.ts           (new)
├── guards/
│   ├── index.ts
│   ├── EmptyDiffGuard.ts
│   ├── StructuredOutputGuard.ts
│   ├── BudgetGuard.ts
│   ├── WorkerFixResultGuard.ts
│   └── ConcurrencyGuard.ts
├── observers/
│   ├── index.ts
│   ├── StructuredCycleLogger.ts
│   ├── WebUIRealtimeObserver.ts
│   ├── NotificationObserver.ts
│   └── CycleMetricsCollector.ts
├── strategies/
│   ├── index.ts
│   ├── FailureLearningStrategy.ts
│   ├── TaskQualityEvaluator.ts
│   └── DynamicPriorityStrategy.ts
└── ...
```

## Backward Compatibility

- MainLoop constructor: optional `eventBus`, defaults to NoopBus
- All existing API endpoints preserved
- New SSE event type `cycle-event` added to `/api/status/stream`
- Config additions are all optional

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Batch 0 breaks existing functionality | Write integration tests for current behavior first |
| Event system performance overhead | Handlers are lightweight, no queue system |
| Guards block valid tasks | Default warn mode, configurable block mode |
