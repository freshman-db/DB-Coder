# Patrol Mode Event-Driven Refactor — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor MainLoop into an event-driven architecture with Guards (reliability), Observers (observability), Strategies (intelligence), and Superpowers skill integration.

**Architecture:** CycleEventBus wraps each MainLoop phase. New functionality is added as event listeners without modifying core control flow. Superpowers skills are used natively by Claude Code sessions — prompts reference skills by name and sessions invoke them via the Skill tool.

**Tech Stack:** TypeScript 5.7+, Node.js 22+, node:test, postgres (porsager)

---

## Task 1: CycleEvents Type Definitions

**Files:**
- Create: `src/core/CycleEvents.ts`
- Test: `src/core/CycleEvents.test.ts`

**Step 1: Write the type file**

```typescript
// src/core/CycleEvents.ts
import type { ReviewIssue } from '../bridges/CodingAgent.js';
import type { SessionResult } from '../bridges/ClaudeCodeSession.js';

export type CyclePhase =
  | 'decide' | 'create-task' | 'execute'
  | 'verify' | 'fix' | 'review'
  | 'reflect' | 'merge' | 'deep-review' | 'maintenance';

export type CycleTiming = 'before' | 'after' | 'error';

export interface CycleEvent {
  phase: CyclePhase;
  timing: CycleTiming;
  taskId?: string;
  data: Record<string, unknown>;
  timestamp: number;
}

export interface CycleContext {
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

export type EventPattern = string; // 'after:execute', 'after:*', '*:verify', '*'

export function matchPattern(pattern: EventPattern, phase: CyclePhase, timing: CycleTiming): boolean {
  if (pattern === '*') return true;
  const [pTiming, pPhase] = pattern.split(':');
  if (!pPhase) return false;
  const timingMatch = pTiming === '*' || pTiming === timing;
  const phaseMatch = pPhase === '*' || pPhase === phase;
  return timingMatch && phaseMatch;
}
```

**Step 2: Write the test**

```typescript
// src/core/CycleEvents.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchPattern } from './CycleEvents.js';

describe('matchPattern', () => {
  it('matches wildcard *', () => {
    assert.equal(matchPattern('*', 'execute', 'after'), true);
    assert.equal(matchPattern('*', 'decide', 'before'), true);
  });

  it('matches exact pattern', () => {
    assert.equal(matchPattern('after:execute', 'execute', 'after'), true);
    assert.equal(matchPattern('after:execute', 'execute', 'before'), false);
    assert.equal(matchPattern('after:execute', 'verify', 'after'), false);
  });

  it('matches timing wildcard', () => {
    assert.equal(matchPattern('*:execute', 'execute', 'after'), true);
    assert.equal(matchPattern('*:execute', 'execute', 'before'), true);
    assert.equal(matchPattern('*:execute', 'verify', 'after'), false);
  });

  it('matches phase wildcard', () => {
    assert.equal(matchPattern('after:*', 'execute', 'after'), true);
    assert.equal(matchPattern('after:*', 'verify', 'after'), true);
    assert.equal(matchPattern('after:*', 'execute', 'before'), false);
  });

  it('rejects malformed patterns', () => {
    assert.equal(matchPattern('execute', 'execute', 'after'), false);
    assert.equal(matchPattern('', 'execute', 'after'), false);
  });
});
```

**Step 3: Build and run tests**

Run: `npm run build && node --test dist/core/CycleEvents.test.js`
Expected: All 5 tests PASS

**Step 4: Commit**

```bash
git add src/core/CycleEvents.ts src/core/CycleEvents.test.ts
git commit -m "feat: add CycleEvent types and matchPattern utility"
```

---

## Task 2: CycleEventBus Implementation

**Files:**
- Create: `src/core/CycleEventBus.ts`
- Test: `src/core/CycleEventBus.test.ts`

**Step 1: Write the failing test**

```typescript
// src/core/CycleEventBus.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CycleEventBus } from './CycleEventBus.js';
import type { CycleEvent } from './CycleEvents.js';

function makeEvent(phase: string, timing: string): CycleEvent {
  return { phase: phase as any, timing: timing as any, data: {}, timestamp: Date.now() };
}

describe('CycleEventBus', () => {
  it('emit calls matching handlers synchronously', () => {
    const bus = new CycleEventBus();
    const calls: string[] = [];
    bus.on('after:execute', () => { calls.push('handler1'); });
    bus.on('before:execute', () => { calls.push('handler2'); });

    bus.emit(makeEvent('execute', 'after'));
    // emit is fire-and-forget but sync handlers run immediately
    assert.deepEqual(calls, ['handler1']);
  });

  it('emitAndWait awaits async handlers', async () => {
    const bus = new CycleEventBus();
    let called = false;
    bus.on('after:verify', async () => {
      await new Promise(r => setTimeout(r, 10));
      called = true;
    });

    const errors = await bus.emitAndWait(makeEvent('verify', 'after'));
    assert.equal(called, true);
    assert.equal(errors.length, 0);
  });

  it('emitAndWait collects handler errors without throwing', async () => {
    const bus = new CycleEventBus();
    bus.on('after:execute', () => { throw new Error('guard failed'); });
    bus.on('after:execute', () => { /* this still runs */ });

    const errors = await bus.emitAndWait(makeEvent('execute', 'after'));
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, 'guard failed');
  });

  it('wildcard * matches all events', () => {
    const bus = new CycleEventBus();
    const calls: string[] = [];
    bus.on('*', (e) => { calls.push(`${e.timing}:${e.phase}`); });

    bus.emit(makeEvent('execute', 'after'));
    bus.emit(makeEvent('decide', 'before'));
    assert.deepEqual(calls, ['after:execute', 'before:decide']);
  });

  it('on() returns unsubscribe function', () => {
    const bus = new CycleEventBus();
    const calls: number[] = [];
    const unsub = bus.on('after:execute', () => { calls.push(1); });

    bus.emit(makeEvent('execute', 'after'));
    unsub();
    bus.emit(makeEvent('execute', 'after'));
    assert.deepEqual(calls, [1]);
  });

  it('NoopBus does nothing', () => {
    const bus = CycleEventBus.noop();
    // Should not throw
    bus.emit(makeEvent('execute', 'after'));
    bus.on('*', () => { throw new Error('should not be called'); });
    bus.emit(makeEvent('execute', 'after'));
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/core/CycleEventBus.test.js`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/core/CycleEventBus.ts
import { matchPattern, type CycleEvent, type EventPattern } from './CycleEvents.js';
import { log } from '../utils/logger.js';

export type EventHandler = (event: CycleEvent) => void | Promise<void>;

interface Registration {
  pattern: EventPattern;
  handler: EventHandler;
}

export class CycleEventBus {
  private registrations: Registration[] = [];

  on(pattern: EventPattern, handler: EventHandler): () => void {
    const reg: Registration = { pattern, handler };
    this.registrations.push(reg);
    return () => {
      const idx = this.registrations.indexOf(reg);
      if (idx >= 0) this.registrations.splice(idx, 1);
    };
  }

  emit(event: CycleEvent): void {
    for (const { pattern, handler } of this.registrations) {
      if (matchPattern(pattern, event.phase, event.timing)) {
        try {
          const result = handler(event);
          // If async, catch but don't await
          if (result && typeof (result as Promise<void>).catch === 'function') {
            (result as Promise<void>).catch(err =>
              log.warn(`EventBus handler error (${pattern})`, { error: err })
            );
          }
        } catch (err) {
          log.warn(`EventBus handler error (${pattern})`, { error: err });
        }
      }
    }
  }

  async emitAndWait(event: CycleEvent): Promise<Error[]> {
    const errors: Error[] = [];
    for (const { pattern, handler } of this.registrations) {
      if (matchPattern(pattern, event.phase, event.timing)) {
        try {
          await handler(event);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          errors.push(error);
          log.warn(`EventBus handler error (${pattern})`, { error });
        }
      }
    }
    return errors;
  }

  static noop(): CycleEventBus {
    return new NoopBus();
  }
}

class NoopBus extends CycleEventBus {
  override on(): () => void { return () => {}; }
  override emit(): void {}
  override async emitAndWait(): Promise<Error[]> { return []; }
}
```

**Step 4: Run tests**

Run: `npm run build && node --test dist/core/CycleEventBus.test.js`
Expected: All 6 tests PASS

**Step 5: Commit**

```bash
git add src/core/CycleEventBus.ts src/core/CycleEventBus.test.ts
git commit -m "feat: add CycleEventBus with pattern matching and NoopBus"
```

---

## Task 3: MainLoop Event Integration

**Files:**
- Modify: `src/core/MainLoop.ts` (constructor + runCycle)
- Modify: `src/index.ts` (inject EventBus)
- Test: `src/core/MainLoop.test.ts` (existing — verify no regression)

**Step 1: Run existing tests to establish baseline**

Run: `npm run build && npm test`
Expected: All existing tests PASS — record exact count

**Step 2: Add EventBus to MainLoop constructor**

In `src/core/MainLoop.ts`:
- Add import: `import { CycleEventBus } from './CycleEventBus.js';`
- Add import: `import type { CycleEvent, CycleContext } from './CycleEvents.js';`
- Change constructor to accept optional 6th parameter:
  ```typescript
  constructor(
    private config: Config,
    private taskQueue: TaskQueue,
    private codex: CodexBridge,
    private taskStore: TaskStore,
    private costTracker: CostTracker,
    private eventBus: CycleEventBus = CycleEventBus.noop(),
  )
  ```
- Add helper method:
  ```typescript
  private makeEvent(phase: CyclePhase, timing: CycleTiming, data: Record<string, unknown> = {}): CycleEvent {
    return { phase, timing, taskId: this.currentTaskId ?? undefined, data, timestamp: Date.now() };
  }
  ```

**Step 3: Wrap runCycle phases with events**

In `runCycle()`, add event emissions at key points. Do NOT change logic — only add `emit`/`emitAndWait` calls around existing code:

1. Before/after `brainDecide()` (lines ~235-254):
   ```typescript
   this.eventBus.emit(this.makeEvent('decide', 'before'));
   // ... existing brainDecide code ...
   this.eventBus.emit(this.makeEvent('decide', 'after', { taskDescription: decision.taskDescription }));
   ```

2. Before/after `workerExecute()` (lines ~305-317):
   ```typescript
   await this.eventBus.emitAndWait(this.makeEvent('execute', 'before', { taskDescription: task.task_description }));
   // ... existing workerExecute code ...
   this.eventBus.emit(this.makeEvent('execute', 'after', { result: workerResult }));
   ```

3. Before/after `hardVerify()` (lines ~320-338):
   ```typescript
   // ... existing hardVerify code ...
   this.eventBus.emit(this.makeEvent('verify', 'after', { verification }));
   ```

4. After workerFix (if triggered):
   ```typescript
   this.eventBus.emit(this.makeEvent('fix', 'after', { verification: reVerification }));
   ```

5. After codexReview:
   ```typescript
   this.eventBus.emit(this.makeEvent('review', 'after', { passed: codexReviewPassed }));
   ```

6. After brainReflect:
   ```typescript
   this.eventBus.emit(this.makeEvent('reflect', 'after'));
   ```

7. After merge/cleanup:
   ```typescript
   this.eventBus.emit(this.makeEvent('merge', 'after', { merged: shouldMerge }));
   ```

8. On error (catch block):
   ```typescript
   this.eventBus.emit(this.makeEvent(currentPhase, 'error', { error: String(err) }));
   ```

**Step 4: Update index.ts**

In `src/index.ts`, create and inject EventBus:
```typescript
import { CycleEventBus } from './core/CycleEventBus.js';

// In serve command action, after creating costTracker:
const eventBus = new CycleEventBus();
const mainLoop = new MainLoop(config, taskQueue, codexBridge, taskStore, costTracker, eventBus);
```

**Step 5: Run all tests**

Run: `npm run build && npm test`
Expected: Same test count, all PASS (no behavior change, just added events)

**Step 6: Commit**

```bash
git add src/core/MainLoop.ts src/index.ts
git commit -m "feat: integrate CycleEventBus into MainLoop phases"
```

---

## Task 4: EmptyDiffGuard

**Files:**
- Create: `src/core/guards/EmptyDiffGuard.ts`
- Test: `src/core/guards/EmptyDiffGuard.test.ts`

**Step 1: Write the failing test**

```typescript
// src/core/guards/EmptyDiffGuard.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EmptyDiffGuard } from './EmptyDiffGuard.js';
import type { CycleEvent } from '../CycleEvents.js';

describe('EmptyDiffGuard', () => {
  it('throws when diff is empty', async () => {
    const guard = new EmptyDiffGuard(async () => ({ filesChanged: 0, insertions: 0, deletions: 0 }));
    const event: CycleEvent = {
      phase: 'execute', timing: 'after',
      data: { startCommit: 'abc123' },
      timestamp: Date.now(),
    };
    await assert.rejects(() => guard.handle(event), /no code changes/i);
  });

  it('passes when diff has changes', async () => {
    const guard = new EmptyDiffGuard(async () => ({ filesChanged: 3, insertions: 10, deletions: 2 }));
    const event: CycleEvent = {
      phase: 'execute', timing: 'after',
      data: { startCommit: 'abc123' },
      timestamp: Date.now(),
    };
    await guard.handle(event); // should not throw
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/core/guards/EmptyDiffGuard.test.js`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/core/guards/EmptyDiffGuard.ts
import type { CycleEvent } from '../CycleEvents.js';
import { log } from '../../utils/logger.js';

export interface DiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export type GetDiffStatsFn = (startCommit: string) => Promise<DiffStats>;

export class EmptyDiffGuard {
  constructor(private getDiffStats: GetDiffStatsFn) {}

  async handle(event: CycleEvent): Promise<void> {
    const startCommit = event.data.startCommit as string | undefined;
    if (!startCommit) return;

    const stats = await this.getDiffStats(startCommit);
    if (stats.filesChanged === 0) {
      log.warn('EmptyDiffGuard: worker produced no code changes', { startCommit });
      throw new Error('Worker produced no code changes');
    }
    log.info('EmptyDiffGuard: diff OK', { files: stats.filesChanged, ins: stats.insertions, del: stats.deletions });
  }
}
```

**Step 4: Run tests**

Run: `npm run build && node --test dist/core/guards/EmptyDiffGuard.test.js`
Expected: All 2 tests PASS

**Step 5: Commit**

```bash
git add src/core/guards/EmptyDiffGuard.ts src/core/guards/EmptyDiffGuard.test.ts
git commit -m "feat: add EmptyDiffGuard to reject zero-change tasks"
```

---

## Task 5: StructuredOutputGuard

**Files:**
- Create: `src/core/guards/StructuredOutputGuard.ts`
- Test: `src/core/guards/StructuredOutputGuard.test.ts`

**Step 1: Write the failing test**

```typescript
// src/core/guards/StructuredOutputGuard.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StructuredOutputGuard } from './StructuredOutputGuard.js';
import type { CycleEvent } from '../CycleEvents.js';

function makeDecideEvent(text: string): CycleEvent {
  return { phase: 'decide', timing: 'after', data: { rawText: text }, timestamp: Date.now() };
}

describe('StructuredOutputGuard', () => {
  it('accepts valid JSON task', async () => {
    const guard = new StructuredOutputGuard();
    const event = makeDecideEvent('{"task": "Fix bug in auth", "priority": 1}');
    await guard.handle(event); // no throw
  });

  it('accepts plain text that looks like a task description', async () => {
    const guard = new StructuredOutputGuard();
    const event = makeDecideEvent('Refactor the auth module to use JWT tokens instead of sessions');
    await guard.handle(event); // no throw
  });

  it('rejects conversational text', async () => {
    const guard = new StructuredOutputGuard();
    const event = makeDecideEvent('Sure, I think the codebase looks great!');
    await assert.rejects(() => guard.handle(event), /conversational/i);
  });

  it('rejects short text', async () => {
    const guard = new StructuredOutputGuard();
    const event = makeDecideEvent('OK');
    await assert.rejects(() => guard.handle(event), /too short/i);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/core/guards/StructuredOutputGuard.test.js`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/core/guards/StructuredOutputGuard.ts
import type { CycleEvent } from '../CycleEvents.js';
import { log } from '../../utils/logger.js';

const CONVERSATIONAL_PREFIXES = [
  'sure', 'i think', 'i believe', 'great', 'ok', 'okay',
  'absolutely', 'of course', 'no problem', 'let me',
  'i\'ll', 'i will', 'i can', 'well,',
];

const MIN_TASK_LENGTH = 20;

export class StructuredOutputGuard {
  async handle(event: CycleEvent): Promise<void> {
    const rawText = event.data.rawText as string | undefined;
    if (!rawText) return;

    const trimmed = rawText.trim();

    // Try JSON first
    try {
      JSON.parse(trimmed);
      return; // valid JSON, accept
    } catch {
      // not JSON, check as plain text
    }

    if (trimmed.length < MIN_TASK_LENGTH) {
      log.warn('StructuredOutputGuard: text too short', { length: trimmed.length });
      throw new Error(`Brain output too short (${trimmed.length} chars)`);
    }

    const lower = trimmed.toLowerCase();
    for (const prefix of CONVERSATIONAL_PREFIXES) {
      if (lower.startsWith(prefix)) {
        log.warn('StructuredOutputGuard: conversational text detected', { prefix, text: trimmed.slice(0, 80) });
        throw new Error(`Brain output looks conversational (starts with "${prefix}")`);
      }
    }
  }
}
```

**Step 4: Run tests**

Run: `npm run build && node --test dist/core/guards/StructuredOutputGuard.test.js`
Expected: All 4 tests PASS

**Step 5: Commit**

```bash
git add src/core/guards/StructuredOutputGuard.ts src/core/guards/StructuredOutputGuard.test.ts
git commit -m "feat: add StructuredOutputGuard to reject conversational brain output"
```

---

## Task 6: BudgetGuard + WorkerFixResultGuard + ConcurrencyGuard

**Files:**
- Create: `src/core/guards/BudgetGuard.ts`
- Create: `src/core/guards/WorkerFixResultGuard.ts`
- Create: `src/core/guards/ConcurrencyGuard.ts`
- Create: `src/core/guards/index.ts`
- Test: `src/core/guards/guards.test.ts`

**Step 1: Write BudgetGuard test + implementation**

```typescript
// src/core/guards/BudgetGuard.ts
import type { CycleEvent } from '../CycleEvents.js';
import { log } from '../../utils/logger.js';

export interface BudgetInfo {
  remainingUsd: number;
  avgTaskCostUsd: number;
}

export type GetBudgetInfoFn = () => Promise<BudgetInfo>;

export class BudgetGuard {
  constructor(private getBudgetInfo: GetBudgetInfoFn) {}

  async handle(event: CycleEvent): Promise<void> {
    const info = await this.getBudgetInfo();
    if (info.avgTaskCostUsd > 0 && info.remainingUsd < info.avgTaskCostUsd) {
      log.warn('BudgetGuard: insufficient budget', info);
      throw new Error(`Insufficient budget: $${info.remainingUsd.toFixed(2)} remaining, avg task costs $${info.avgTaskCostUsd.toFixed(2)}`);
    }
  }
}
```

**Step 2: Write WorkerFixResultGuard**

```typescript
// src/core/guards/WorkerFixResultGuard.ts
import type { CycleEvent } from '../CycleEvents.js';
import { log } from '../../utils/logger.js';

export class WorkerFixResultGuard {
  async handle(event: CycleEvent): Promise<void> {
    const verification = event.data.verification as { passed: boolean; reason?: string } | undefined;
    if (!verification) return;
    if (!verification.passed) {
      log.warn('WorkerFixResultGuard: workerFix did not resolve verification failure', {
        reason: verification.reason,
      });
    }
  }
}
```

**Step 3: Write ConcurrencyGuard**

```typescript
// src/core/guards/ConcurrencyGuard.ts
import type { CycleEvent } from '../CycleEvents.js';
import { existsSync, readFileSync } from 'node:fs';
import { log } from '../../utils/logger.js';

export class ConcurrencyGuard {
  constructor(private lockFile: string) {}

  async handle(event: CycleEvent): Promise<void> {
    if (!existsSync(this.lockFile)) return;
    try {
      const pid = parseInt(readFileSync(this.lockFile, 'utf-8'), 10);
      if (pid !== process.pid) {
        process.kill(pid, 0); // check if process exists
        throw new Error(`Another db-coder process (pid ${pid}) holds the lock`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('holds the lock')) throw err;
      // stale lock or parse error — ignore
    }
  }
}
```

**Step 4: Write guards index (registers all guards on EventBus)**

```typescript
// src/core/guards/index.ts
import type { CycleEventBus } from '../CycleEventBus.js';
import { EmptyDiffGuard, type GetDiffStatsFn } from './EmptyDiffGuard.js';
import { StructuredOutputGuard } from './StructuredOutputGuard.js';
import { BudgetGuard, type GetBudgetInfoFn } from './BudgetGuard.js';
import { WorkerFixResultGuard } from './WorkerFixResultGuard.js';
import { ConcurrencyGuard } from './ConcurrencyGuard.js';

export interface GuardDeps {
  getDiffStats: GetDiffStatsFn;
  getBudgetInfo: GetBudgetInfoFn;
  lockFile: string;
}

export function registerGuards(bus: CycleEventBus, deps: GuardDeps): void {
  const emptyDiff = new EmptyDiffGuard(deps.getDiffStats);
  const structuredOutput = new StructuredOutputGuard();
  const budget = new BudgetGuard(deps.getBudgetInfo);
  const workerFix = new WorkerFixResultGuard();
  const concurrency = new ConcurrencyGuard(deps.lockFile);

  bus.on('after:execute', (e) => emptyDiff.handle(e));
  bus.on('after:decide', (e) => structuredOutput.handle(e));
  bus.on('before:execute', (e) => budget.handle(e));
  bus.on('after:fix', (e) => workerFix.handle(e));
  bus.on('before:decide', (e) => concurrency.handle(e));
}

export { EmptyDiffGuard, StructuredOutputGuard, BudgetGuard, WorkerFixResultGuard, ConcurrencyGuard };
```

**Step 5: Write combined test**

```typescript
// src/core/guards/guards.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BudgetGuard } from './BudgetGuard.js';
import { WorkerFixResultGuard } from './WorkerFixResultGuard.js';
import type { CycleEvent } from '../CycleEvents.js';

describe('BudgetGuard', () => {
  it('passes when budget sufficient', async () => {
    const guard = new BudgetGuard(async () => ({ remainingUsd: 10, avgTaskCostUsd: 2 }));
    await guard.handle({ phase: 'execute', timing: 'before', data: {}, timestamp: Date.now() });
  });

  it('throws when budget insufficient', async () => {
    const guard = new BudgetGuard(async () => ({ remainingUsd: 0.5, avgTaskCostUsd: 2 }));
    await assert.rejects(
      () => guard.handle({ phase: 'execute', timing: 'before', data: {}, timestamp: Date.now() }),
      /insufficient budget/i,
    );
  });

  it('passes when no cost history', async () => {
    const guard = new BudgetGuard(async () => ({ remainingUsd: 10, avgTaskCostUsd: 0 }));
    await guard.handle({ phase: 'execute', timing: 'before', data: {}, timestamp: Date.now() });
  });
});

describe('WorkerFixResultGuard', () => {
  it('logs warning when fix did not resolve', async () => {
    const guard = new WorkerFixResultGuard();
    // Should not throw, just log
    await guard.handle({
      phase: 'fix', timing: 'after',
      data: { verification: { passed: false, reason: 'still broken' } },
      timestamp: Date.now(),
    });
  });

  it('does nothing when fix resolved', async () => {
    const guard = new WorkerFixResultGuard();
    await guard.handle({
      phase: 'fix', timing: 'after',
      data: { verification: { passed: true } },
      timestamp: Date.now(),
    });
  });
});
```

**Step 6: Run all guard tests**

Run: `npm run build && node --test dist/core/guards/`
Expected: All tests PASS

**Step 7: Commit**

```bash
git add src/core/guards/
git commit -m "feat: add BudgetGuard, WorkerFixResultGuard, ConcurrencyGuard, and guard registry"
```

---

## Task 7: StructuredCycleLogger Observer

**Files:**
- Create: `src/core/observers/StructuredCycleLogger.ts`
- Test: `src/core/observers/StructuredCycleLogger.test.ts`

**Step 1: Write the failing test**

```typescript
// src/core/observers/StructuredCycleLogger.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StructuredCycleLogger } from './StructuredCycleLogger.js';
import type { CycleEvent } from '../CycleEvents.js';

describe('StructuredCycleLogger', () => {
  it('records events and exposes log entries', () => {
    const logger = new StructuredCycleLogger();
    const event: CycleEvent = {
      phase: 'execute', timing: 'after',
      taskId: 'task-1',
      data: { files: 3 },
      timestamp: 1000,
    };
    logger.handle(event);

    const entries = logger.getEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].phase, 'execute');
    assert.equal(entries[0].timing, 'after');
    assert.equal(entries[0].taskId, 'task-1');
  });

  it('limits buffer to maxEntries', () => {
    const logger = new StructuredCycleLogger(5);
    for (let i = 0; i < 10; i++) {
      logger.handle({ phase: 'execute', timing: 'after', data: { i }, timestamp: i });
    }
    assert.equal(logger.getEntries().length, 5);
    assert.equal(logger.getEntries()[0].data.i, 5); // oldest dropped
  });
});
```

**Step 2: Write implementation**

```typescript
// src/core/observers/StructuredCycleLogger.ts
import type { CycleEvent } from '../CycleEvents.js';
import { log } from '../../utils/logger.js';

export interface CycleLogEntry {
  phase: string;
  timing: string;
  taskId?: string;
  data: Record<string, unknown>;
  timestamp: number;
}

export class StructuredCycleLogger {
  private entries: CycleLogEntry[] = [];
  private maxEntries: number;

  constructor(maxEntries = 1000) {
    this.maxEntries = maxEntries;
  }

  handle(event: CycleEvent): void {
    const entry: CycleLogEntry = {
      phase: event.phase,
      timing: event.timing,
      taskId: event.taskId,
      data: event.data,
      timestamp: event.timestamp,
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
    log.info(`[cycle] ${event.timing}:${event.phase}`, {
      taskId: event.taskId,
      ...this.summarizeData(event.data),
    });
  }

  getEntries(): CycleLogEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
  }

  private summarizeData(data: Record<string, unknown>): Record<string, unknown> {
    const summary: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string' && v.length > 100) {
        summary[k] = v.slice(0, 100) + '...';
      } else {
        summary[k] = v;
      }
    }
    return summary;
  }
}
```

**Step 3: Run tests**

Run: `npm run build && node --test dist/core/observers/StructuredCycleLogger.test.js`
Expected: All 2 tests PASS

**Step 4: Commit**

```bash
git add src/core/observers/StructuredCycleLogger.ts src/core/observers/StructuredCycleLogger.test.ts
git commit -m "feat: add StructuredCycleLogger observer"
```

---

## Task 8: CycleMetricsCollector Observer

**Files:**
- Create: `src/core/observers/CycleMetricsCollector.ts`
- Test: `src/core/observers/CycleMetricsCollector.test.ts`

**Step 1: Write the failing test**

```typescript
// src/core/observers/CycleMetricsCollector.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CycleMetricsCollector } from './CycleMetricsCollector.js';

describe('CycleMetricsCollector', () => {
  it('tracks cycle success rate', () => {
    const collector = new CycleMetricsCollector();
    collector.recordCycleEnd(true, 5000);
    collector.recordCycleEnd(true, 6000);
    collector.recordCycleEnd(false, 3000);

    const metrics = collector.getMetrics();
    assert.equal(metrics.totalCycles, 3);
    assert.ok(Math.abs(metrics.successRate - 2/3) < 0.01);
    assert.equal(metrics.consecutiveFailures, 1);
  });

  it('resets consecutive failures on success', () => {
    const collector = new CycleMetricsCollector();
    collector.recordCycleEnd(false, 1000);
    collector.recordCycleEnd(false, 1000);
    collector.recordCycleEnd(true, 5000);

    assert.equal(collector.getMetrics().consecutiveFailures, 0);
  });

  it('tracks average duration', () => {
    const collector = new CycleMetricsCollector();
    collector.recordCycleEnd(true, 4000);
    collector.recordCycleEnd(true, 6000);

    assert.equal(collector.getMetrics().avgCycleDurationMs, 5000);
  });

  it('respects sliding window', () => {
    const collector = new CycleMetricsCollector(3);
    collector.recordCycleEnd(false, 1000);
    collector.recordCycleEnd(true, 2000);
    collector.recordCycleEnd(true, 3000);
    collector.recordCycleEnd(true, 4000); // pushes out first false

    assert.equal(collector.getMetrics().totalCycles, 3);
    assert.equal(collector.getMetrics().successRate, 1.0);
  });

  it('tracks phase durations', () => {
    const collector = new CycleMetricsCollector();
    collector.recordPhaseDuration('execute', 10000);
    collector.recordPhaseDuration('execute', 20000);
    collector.recordPhaseDuration('verify', 500);

    const breakdown = collector.getMetrics().phaseAvgDurationMs;
    assert.equal(breakdown.execute, 15000);
    assert.equal(breakdown.verify, 500);
  });
});
```

**Step 2: Write implementation**

```typescript
// src/core/observers/CycleMetricsCollector.ts
import type { CycleEvent } from '../CycleEvents.js';

export interface CycleMetrics {
  totalCycles: number;
  successRate: number;
  avgCycleDurationMs: number;
  consecutiveFailures: number;
  phaseAvgDurationMs: Record<string, number>;
}

interface CycleRecord {
  productive: boolean;
  durationMs: number;
}

export class CycleMetricsCollector {
  private cycles: CycleRecord[] = [];
  private phaseDurations: Map<string, number[]> = new Map();
  private maxCycles: number;
  private _consecutiveFailures = 0;

  constructor(maxCycles = 100) {
    this.maxCycles = maxCycles;
  }

  handle(event: CycleEvent): void {
    // Track phase start/end via timestamps for duration calculation
    if (event.timing === 'after' || event.timing === 'error') {
      const durationMs = event.data.durationMs as number | undefined;
      if (typeof durationMs === 'number') {
        this.recordPhaseDuration(event.phase, durationMs);
      }
    }
  }

  recordCycleEnd(productive: boolean, durationMs: number): void {
    this.cycles.push({ productive, durationMs });
    if (this.cycles.length > this.maxCycles) this.cycles.shift();
    if (productive) {
      this._consecutiveFailures = 0;
    } else {
      this._consecutiveFailures++;
    }
  }

  recordPhaseDuration(phase: string, durationMs: number): void {
    if (!this.phaseDurations.has(phase)) this.phaseDurations.set(phase, []);
    const arr = this.phaseDurations.get(phase)!;
    arr.push(durationMs);
    if (arr.length > this.maxCycles) arr.shift();
  }

  getMetrics(): CycleMetrics {
    const total = this.cycles.length;
    const successes = this.cycles.filter(c => c.productive).length;
    const avgDuration = total > 0
      ? this.cycles.reduce((sum, c) => sum + c.durationMs, 0) / total
      : 0;

    const phaseAvg: Record<string, number> = {};
    for (const [phase, durations] of this.phaseDurations) {
      phaseAvg[phase] = durations.reduce((a, b) => a + b, 0) / durations.length;
    }

    return {
      totalCycles: total,
      successRate: total > 0 ? successes / total : 0,
      avgCycleDurationMs: avgDuration,
      consecutiveFailures: this._consecutiveFailures,
      phaseAvgDurationMs: phaseAvg,
    };
  }
}
```

**Step 3: Run tests**

Run: `npm run build && node --test dist/core/observers/CycleMetricsCollector.test.js`
Expected: All 5 tests PASS

**Step 4: Commit**

```bash
git add src/core/observers/CycleMetricsCollector.ts src/core/observers/CycleMetricsCollector.test.ts
git commit -m "feat: add CycleMetricsCollector with sliding window metrics"
```

---

## Task 9: NotificationObserver + WebUIRealtimeObserver + Observer Registry

**Files:**
- Create: `src/core/observers/NotificationObserver.ts`
- Create: `src/core/observers/WebUIRealtimeObserver.ts`
- Create: `src/core/observers/index.ts`
- Test: `src/core/observers/NotificationObserver.test.ts`

**Step 1: Write NotificationObserver**

```typescript
// src/core/observers/NotificationObserver.ts
import type { CycleEvent } from '../CycleEvents.js';
import { log } from '../../utils/logger.js';

export interface NotificationConfig {
  webhookUrl?: string;
  notifyOnMerge?: boolean;       // default true
  notifyOnFailStreak?: number;   // default 3
  notifyOnBudgetLow?: boolean;   // default true
}

export class NotificationObserver {
  private config: Required<NotificationConfig>;

  constructor(config: NotificationConfig = {}) {
    this.config = {
      webhookUrl: config.webhookUrl ?? '',
      notifyOnMerge: config.notifyOnMerge ?? true,
      notifyOnFailStreak: config.notifyOnFailStreak ?? 3,
      notifyOnBudgetLow: config.notifyOnBudgetLow ?? true,
    };
  }

  async handle(event: CycleEvent): Promise<void> {
    if (!this.config.webhookUrl) return;

    const message = this.formatMessage(event);
    if (!message) return;

    try {
      await fetch(this.config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message, event: `${event.timing}:${event.phase}`, taskId: event.taskId }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      log.warn('NotificationObserver: webhook failed', { error: err });
    }
  }

  formatMessage(event: CycleEvent): string | null {
    if (event.timing === 'after' && event.phase === 'merge' && event.data.merged && this.config.notifyOnMerge) {
      return `Task merged: ${event.taskId ?? 'unknown'}`;
    }
    if (event.timing === 'error') {
      return `Error in ${event.phase}: ${event.data.error ?? 'unknown'}`;
    }
    return null;
  }
}
```

**Step 2: Write WebUIRealtimeObserver**

```typescript
// src/core/observers/WebUIRealtimeObserver.ts
import type { CycleEvent } from '../CycleEvents.js';

export type SSEBroadcastFn = (eventType: string, data: unknown) => void;

export class WebUIRealtimeObserver {
  constructor(private broadcast: SSEBroadcastFn) {}

  handle(event: CycleEvent): void {
    this.broadcast('cycle-event', {
      phase: event.phase,
      timing: event.timing,
      taskId: event.taskId,
      timestamp: event.timestamp,
      data: event.data,
    });
  }
}
```

**Step 3: Write observer index**

```typescript
// src/core/observers/index.ts
import type { CycleEventBus } from '../CycleEventBus.js';
import { StructuredCycleLogger } from './StructuredCycleLogger.js';
import { CycleMetricsCollector } from './CycleMetricsCollector.js';
import { NotificationObserver, type NotificationConfig } from './NotificationObserver.js';
import { WebUIRealtimeObserver, type SSEBroadcastFn } from './WebUIRealtimeObserver.js';

export interface ObserverDeps {
  sseBroadcast?: SSEBroadcastFn;
  notificationConfig?: NotificationConfig;
}

export interface RegisteredObservers {
  logger: StructuredCycleLogger;
  metrics: CycleMetricsCollector;
}

export function registerObservers(bus: CycleEventBus, deps: ObserverDeps = {}): RegisteredObservers {
  const logger = new StructuredCycleLogger();
  const metrics = new CycleMetricsCollector();
  const notification = new NotificationObserver(deps.notificationConfig);

  bus.on('*', (e) => logger.handle(e));
  bus.on('*', (e) => metrics.handle(e));
  bus.on('after:merge', (e) => notification.handle(e));
  bus.on('error:*', (e) => notification.handle(e));

  if (deps.sseBroadcast) {
    const webui = new WebUIRealtimeObserver(deps.sseBroadcast);
    bus.on('*', (e) => webui.handle(e));
  }

  return { logger, metrics };
}

export { StructuredCycleLogger, CycleMetricsCollector, NotificationObserver, WebUIRealtimeObserver };
```

**Step 4: Write NotificationObserver test**

```typescript
// src/core/observers/NotificationObserver.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NotificationObserver } from './NotificationObserver.js';
import type { CycleEvent } from '../CycleEvents.js';

describe('NotificationObserver', () => {
  it('formats merge message', () => {
    const observer = new NotificationObserver({ webhookUrl: 'http://test' });
    const msg = observer.formatMessage({
      phase: 'merge', timing: 'after', taskId: 'abc',
      data: { merged: true }, timestamp: Date.now(),
    });
    assert.ok(msg?.includes('merged'));
    assert.ok(msg?.includes('abc'));
  });

  it('formats error message', () => {
    const observer = new NotificationObserver({ webhookUrl: 'http://test' });
    const msg = observer.formatMessage({
      phase: 'execute', timing: 'error',
      data: { error: 'timeout' }, timestamp: Date.now(),
    });
    assert.ok(msg?.includes('execute'));
    assert.ok(msg?.includes('timeout'));
  });

  it('returns null for non-notable events', () => {
    const observer = new NotificationObserver({ webhookUrl: 'http://test' });
    const msg = observer.formatMessage({
      phase: 'decide', timing: 'before', data: {}, timestamp: Date.now(),
    });
    assert.equal(msg, null);
  });

  it('does nothing without webhookUrl', async () => {
    const observer = new NotificationObserver();
    // Should not throw or make network calls
    await observer.handle({
      phase: 'merge', timing: 'after', taskId: 'abc',
      data: { merged: true }, timestamp: Date.now(),
    });
  });
});
```

**Step 5: Run all observer tests**

Run: `npm run build && node --test dist/core/observers/`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/core/observers/
git commit -m "feat: add NotificationObserver, WebUIRealtimeObserver, and observer registry"
```

---

## Task 10: Superpowers Prompt Integration (Native Plugin Access)

**Files:**
- Modify: `src/core/MainLoop.ts` (workerExecute, workerFix, brainReflect prompts)

The superpowers plugin is installed at `~/.claude/plugins/` and automatically loaded by
every `claude` CLI session. No custom SkillInjector needed — sessions invoke skills
natively via the Skill tool. We just add skill references to the task prompts.

**Step 1: Update workerExecute prompt (line ~603)**

Change the prompt and appendSystemPrompt to reference superpowers skills:

```typescript
private async workerExecute(task: Task): Promise<SessionResult> {
  const prompt = `Execute this coding task:

${task.task_description}

Read CLAUDE.md for project context and environment rules.

## Process
1. Use superpowers:test-driven-development — write a failing test first, verify it fails, then implement.
2. After making changes, run the test suite to verify.
3. Use superpowers:verification-before-completion before claiming done — show evidence, not assumptions.
4. Commit with a descriptive message.
Do NOT modify CLAUDE.md — only the brain does that.`;

  return this.workerSession.run(prompt, {
    permissionMode: 'bypassPermissions',
    maxTurns: 30,
    maxBudget: this.config.values.claude.maxTaskBudget,
    cwd: this.config.projectPath,
    timeout: this.config.values.autonomy.subtaskTimeout * 1000,
    model: this.config.values.claude.model === 'opus' ? 'claude-opus-4-6' : 'claude-sonnet-4-6',
    appendSystemPrompt: 'You are a coding worker. Execute the task precisely. You have access to superpowers skills — use them when instructed. Read CLAUDE.md for project context.',
  });
}
```

**Step 2: Update workerFix prompt (line ~622)**

```typescript
private async workerFix(sessionId: string, errors: string, task: Task): Promise<SessionResult> {
  return this.workerSession.run(
    `The previous changes failed verification:
${errors}

Use superpowers:systematic-debugging to investigate the root cause.
Follow all 4 phases: investigate → analyze → hypothesize → implement.
Do NOT guess or "try changing X". Find the actual root cause first.

The original task was: ${task.task_description}`,
    {
      permissionMode: 'bypassPermissions',
      maxTurns: 15,
      maxBudget: this.config.values.claude.maxTaskBudget / 2,
      cwd: this.config.projectPath,
      timeout: 120_000,
      resumeSessionId: sessionId,
      model: this.config.values.claude.model === 'opus' ? 'claude-opus-4-6' : 'claude-sonnet-4-6',
    },
  );
}
```

**Step 3: Update brainReflect prompt (line ~675)**

```typescript
private async brainReflect(
  task: Task,
  outcome: string,
  verification: { passed: boolean; reason?: string },
  projectPath: string,
): Promise<void> {
  const prompt = `Reflect on this completed task:

Task: ${task.task_description}
Outcome: ${outcome}
Verification: ${verification.passed ? 'PASSED' : `FAILED — ${verification.reason}`}

Use superpowers:requesting-code-review to review the code changes if the task was merged.

1. What went well? What could be improved?
2. If there are lessons learned, update CLAUDE.md "踩过的坑" section.
3. Use claude-mem to save important experiences for future reference.
4. If you notice patterns (recurring issues, good practices), add them to CLAUDE.md.

Keep CLAUDE.md concise — only add genuinely useful rules.`;
  // ... rest unchanged
}
```

**Step 4: Run existing tests to verify no regression**

Run: `npm run build && npm test`
Expected: All existing tests PASS (prompt changes don't affect test behavior)

**Step 5: Commit**

```bash
git add src/core/MainLoop.ts
git commit -m "feat: integrate superpowers skills into worker/brain session prompts"
```

---

## Task 11: FailureLearningStrategy

**Files:**
- Create: `src/core/strategies/FailureLearningStrategy.ts`
- Test: `src/core/strategies/FailureLearningStrategy.test.ts`

**Step 1: Write the failing test**

```typescript
// src/core/strategies/FailureLearningStrategy.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FailureLearningStrategy } from './FailureLearningStrategy.js';
import type { CycleEvent } from '../CycleEvents.js';

describe('FailureLearningStrategy', () => {
  it('records failure and returns it in context', () => {
    const strategy = new FailureLearningStrategy();
    strategy.recordFailure({
      phase: 'verify', timing: 'after',
      data: { verification: { passed: false, reason: 'tsc errors increased' }, taskDescription: 'refactor auth' },
      timestamp: Date.now(),
    });

    const context = strategy.getContextForBrain();
    assert.ok(context.includes('refactor'));
    assert.ok(context.includes('tsc errors'));
  });

  it('tracks consecutive same-type failures', () => {
    const strategy = new FailureLearningStrategy();
    for (let i = 0; i < 3; i++) {
      strategy.recordFailure({
        phase: 'verify', timing: 'after',
        data: { verification: { passed: false, reason: 'tsc errors' }, taskDescription: 'refactor module X' },
        timestamp: Date.now(),
      });
    }

    assert.equal(strategy.shouldLowerPriority('refactor'), true);
  });

  it('resets on success', () => {
    const strategy = new FailureLearningStrategy();
    strategy.recordFailure({
      phase: 'verify', timing: 'after',
      data: { verification: { passed: false }, taskDescription: 'refactor X' },
      timestamp: Date.now(),
    });
    strategy.recordSuccess('refactor X');

    assert.equal(strategy.shouldLowerPriority('refactor'), false);
  });

  it('computes exponential cooldown', () => {
    const strategy = new FailureLearningStrategy();
    assert.equal(strategy.getCooldownCycles(0), 1);
    assert.equal(strategy.getCooldownCycles(1), 2);
    assert.equal(strategy.getCooldownCycles(2), 4);
    assert.equal(strategy.getCooldownCycles(5), 16); // capped at 16
  });
});
```

**Step 2: Write implementation**

```typescript
// src/core/strategies/FailureLearningStrategy.ts
import type { CycleEvent } from '../CycleEvents.js';
import { log } from '../../utils/logger.js';

interface FailureRecord {
  taskDescription: string;
  reason: string;
  timestamp: number;
  consecutiveCount: number;
}

const MAX_COOLDOWN = 16;
const FAILURE_THRESHOLD = 3;

export class FailureLearningStrategy {
  private failures: FailureRecord[] = [];
  private failureCounts: Map<string, number> = new Map(); // keyword → count

  recordFailure(event: CycleEvent): void {
    const description = (event.data.taskDescription as string) ?? '';
    const reason = (event.data.verification as { reason?: string })?.reason
      ?? (event.data.error as string) ?? 'unknown';
    const keyword = this.extractKeyword(description);

    const count = (this.failureCounts.get(keyword) ?? 0) + 1;
    this.failureCounts.set(keyword, count);

    this.failures.push({ taskDescription: description, reason, timestamp: event.timestamp, consecutiveCount: count });
    if (this.failures.length > 50) this.failures.shift();

    log.info('FailureLearning: recorded failure', { keyword, count, reason: reason.slice(0, 80) });
  }

  recordSuccess(taskDescription: string): void {
    const keyword = this.extractKeyword(taskDescription);
    this.failureCounts.delete(keyword);
  }

  shouldLowerPriority(taskDescription: string): boolean {
    const keyword = this.extractKeyword(taskDescription);
    return (this.failureCounts.get(keyword) ?? 0) >= FAILURE_THRESHOLD;
  }

  getCooldownCycles(failureCount: number): number {
    return Math.min(2 ** failureCount, MAX_COOLDOWN);
  }

  getContextForBrain(): string {
    if (this.failures.length === 0) return '';
    const recent = this.failures.slice(-5);
    const lines = recent.map(f =>
      `- "${f.taskDescription.slice(0, 60)}" failed: ${f.reason.slice(0, 60)} (${f.consecutiveCount}x)`
    );
    return `## Recent Failures\n${lines.join('\n')}\nConsider different approaches for similar tasks.`;
  }

  private extractKeyword(description: string): string {
    const lower = description.toLowerCase();
    const keywords = ['refactor', 'test', 'fix', 'add', 'remove', 'update', 'optimize', 'simplify'];
    for (const kw of keywords) {
      if (lower.includes(kw)) return kw;
    }
    return lower.slice(0, 20);
  }
}
```

**Step 3: Run tests**

Run: `npm run build && node --test dist/core/strategies/FailureLearningStrategy.test.js`
Expected: All 4 tests PASS

**Step 4: Commit**

```bash
git add src/core/strategies/FailureLearningStrategy.ts src/core/strategies/FailureLearningStrategy.test.ts
git commit -m "feat: add FailureLearningStrategy with exponential cooldown"
```

---

## Task 12: TaskQualityEvaluator + DynamicPriorityStrategy + Strategy Registry

**Files:**
- Create: `src/core/strategies/TaskQualityEvaluator.ts`
- Create: `src/core/strategies/DynamicPriorityStrategy.ts`
- Create: `src/core/strategies/index.ts`
- Test: `src/core/strategies/strategies.test.ts`

**Step 1: Write TaskQualityEvaluator**

```typescript
// src/core/strategies/TaskQualityEvaluator.ts
import type { CycleEvent } from '../CycleEvents.js';
import { log } from '../../utils/logger.js';

export type QualityLevel = 'high' | 'medium' | 'low';

export interface QualityScore {
  level: QualityLevel;
  diffSize: number;
  touchesCore: boolean;
  tscErrorDelta: number;
  hasTests: boolean;
}

export class TaskQualityEvaluator {
  private recentScores: QualityScore[] = [];

  evaluate(event: CycleEvent): QualityScore {
    const data = event.data;
    const diffSize = (data.filesChanged as number) ?? 0;
    const tscDelta = (data.tscErrorDelta as number) ?? 0;
    const hasTests = (data.hasTests as boolean) ?? false;
    const touchesCore = (data.touchesCore as boolean) ?? false;

    let points = 0;
    if (diffSize >= 3) points++;
    if (touchesCore) points++;
    if (tscDelta < 0) points++; // reduced errors
    if (hasTests) points++;

    const level: QualityLevel = points >= 3 ? 'high' : points >= 2 ? 'medium' : 'low';
    const score: QualityScore = { level, diffSize, touchesCore, tscErrorDelta: tscDelta, hasTests };

    this.recentScores.push(score);
    if (this.recentScores.length > 20) this.recentScores.shift();

    log.info('TaskQuality: evaluated', { level, points, diffSize, tscDelta, hasTests });
    return score;
  }

  getRecentLowValueCount(n = 5): number {
    return this.recentScores.slice(-n).filter(s => s.level === 'low').length;
  }

  getContextForBrain(): string {
    const lowCount = this.getRecentLowValueCount();
    if (lowCount >= 3) {
      return '## Quality Alert\nRecent tasks have been low-value. Focus on tasks that: fix bugs, reduce tsc errors, add tests, or modify core modules.';
    }
    return '';
  }
}
```

**Step 2: Write DynamicPriorityStrategy**

```typescript
// src/core/strategies/DynamicPriorityStrategy.ts
import type { CycleEvent } from '../CycleEvents.js';
import { log } from '../../utils/logger.js';

export interface ProjectHealth {
  tscErrors: number;
  recentSuccessRate: number;
  blockedTaskCount: number;
}

export type GetProjectHealthFn = () => Promise<ProjectHealth>;

export class DynamicPriorityStrategy {
  constructor(private getHealth: GetProjectHealthFn) {}

  async getContextForBrain(): Promise<string> {
    const health = await this.getHealth();
    const suggestions: string[] = [];

    if (health.tscErrors > 10) {
      suggestions.push(`TypeScript has ${health.tscErrors} errors — prioritize bug fixes`);
    }
    if (health.recentSuccessRate < 0.5) {
      suggestions.push(`Recent success rate is ${(health.recentSuccessRate * 100).toFixed(0)}% — try simpler tasks`);
    }
    if (health.blockedTaskCount > 3) {
      suggestions.push(`${health.blockedTaskCount} tasks are blocked — try to unblock them`);
    }

    if (suggestions.length === 0) return '';
    return `## Priority Suggestions\n${suggestions.map(s => `- ${s}`).join('\n')}`;
  }
}
```

**Step 3: Write strategy index**

```typescript
// src/core/strategies/index.ts
import type { CycleEventBus } from '../CycleEventBus.js';
import { FailureLearningStrategy } from './FailureLearningStrategy.js';
import { TaskQualityEvaluator } from './TaskQualityEvaluator.js';
import { DynamicPriorityStrategy, type GetProjectHealthFn } from './DynamicPriorityStrategy.js';

export interface StrategyDeps {
  getProjectHealth: GetProjectHealthFn;
}

export interface RegisteredStrategies {
  failureLearning: FailureLearningStrategy;
  qualityEvaluator: TaskQualityEvaluator;
  dynamicPriority: DynamicPriorityStrategy;
}

export function registerStrategies(bus: CycleEventBus, deps: StrategyDeps): RegisteredStrategies {
  const failureLearning = new FailureLearningStrategy();
  const qualityEvaluator = new TaskQualityEvaluator();
  const dynamicPriority = new DynamicPriorityStrategy(deps.getProjectHealth);

  bus.on('after:verify', (e) => {
    const v = e.data.verification as { passed: boolean } | undefined;
    if (v && !v.passed) failureLearning.recordFailure(e);
  });
  bus.on('error:execute', (e) => failureLearning.recordFailure(e));
  bus.on('after:merge', (e) => {
    if (e.data.merged) {
      qualityEvaluator.evaluate(e);
      const desc = e.data.taskDescription as string | undefined;
      if (desc) failureLearning.recordSuccess(desc);
    }
  });

  return { failureLearning, qualityEvaluator, dynamicPriority };
}

export { FailureLearningStrategy, TaskQualityEvaluator, DynamicPriorityStrategy };
```

**Step 4: Write combined test**

```typescript
// src/core/strategies/strategies.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TaskQualityEvaluator } from './TaskQualityEvaluator.js';
import { DynamicPriorityStrategy } from './DynamicPriorityStrategy.js';
import type { CycleEvent } from '../CycleEvents.js';

describe('TaskQualityEvaluator', () => {
  it('rates high for core+tests+tsc-reduction+multi-file', () => {
    const evaluator = new TaskQualityEvaluator();
    const score = evaluator.evaluate({
      phase: 'merge', timing: 'after',
      data: { filesChanged: 5, touchesCore: true, tscErrorDelta: -3, hasTests: true },
      timestamp: Date.now(),
    });
    assert.equal(score.level, 'high');
  });

  it('rates low for single config file change', () => {
    const evaluator = new TaskQualityEvaluator();
    const score = evaluator.evaluate({
      phase: 'merge', timing: 'after',
      data: { filesChanged: 1, touchesCore: false, tscErrorDelta: 0, hasTests: false },
      timestamp: Date.now(),
    });
    assert.equal(score.level, 'low');
  });

  it('tracks recent low-value count', () => {
    const evaluator = new TaskQualityEvaluator();
    for (let i = 0; i < 5; i++) {
      evaluator.evaluate({
        phase: 'merge', timing: 'after',
        data: { filesChanged: 1, touchesCore: false, tscErrorDelta: 0, hasTests: false },
        timestamp: Date.now(),
      });
    }
    assert.equal(evaluator.getRecentLowValueCount(5), 5);
    assert.ok(evaluator.getContextForBrain().includes('Quality Alert'));
  });
});

describe('DynamicPriorityStrategy', () => {
  it('suggests bug fix when tsc errors high', async () => {
    const strategy = new DynamicPriorityStrategy(async () => ({
      tscErrors: 20, recentSuccessRate: 0.8, blockedTaskCount: 0,
    }));
    const ctx = await strategy.getContextForBrain();
    assert.ok(ctx.includes('bug fix'));
  });

  it('suggests simpler tasks when success rate low', async () => {
    const strategy = new DynamicPriorityStrategy(async () => ({
      tscErrors: 0, recentSuccessRate: 0.3, blockedTaskCount: 0,
    }));
    const ctx = await strategy.getContextForBrain();
    assert.ok(ctx.includes('simpler'));
  });

  it('returns empty when healthy', async () => {
    const strategy = new DynamicPriorityStrategy(async () => ({
      tscErrors: 2, recentSuccessRate: 0.9, blockedTaskCount: 1,
    }));
    const ctx = await strategy.getContextForBrain();
    assert.equal(ctx, '');
  });
});
```

**Step 5: Run all strategy tests**

Run: `npm run build && node --test dist/core/strategies/`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/core/strategies/
git commit -m "feat: add TaskQualityEvaluator, DynamicPriorityStrategy, and strategy registry"
```

---

## Task 13: Wire Everything in index.ts + Integration Test

**Files:**
- Modify: `src/index.ts` (register guards, observers, strategies)
- Test: `src/core/integration.test.ts`

**Step 1: Write integration test**

```typescript
// src/core/integration.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CycleEventBus } from './CycleEventBus.js';
import { registerGuards } from './guards/index.js';
import { registerObservers } from './observers/index.js';
import { registerStrategies } from './strategies/index.js';
import type { CycleEvent } from './CycleEvents.js';

describe('Full EventBus integration', () => {
  it('all registrations work without errors', () => {
    const bus = new CycleEventBus();

    registerGuards(bus, {
      getDiffStats: async () => ({ filesChanged: 1, insertions: 10, deletions: 0 }),
      getBudgetInfo: async () => ({ remainingUsd: 50, avgTaskCostUsd: 2 }),
      lockFile: '/tmp/test-lock',
    });

    registerObservers(bus);

    registerStrategies(bus, {
      getProjectHealth: async () => ({ tscErrors: 5, recentSuccessRate: 0.8, blockedTaskCount: 1 }),
    });

    // Should not throw
    bus.emit({ phase: 'decide', timing: 'before', data: {}, timestamp: Date.now() });
  });

  it('empty diff guard blocks on zero changes', async () => {
    const bus = new CycleEventBus();
    registerGuards(bus, {
      getDiffStats: async () => ({ filesChanged: 0, insertions: 0, deletions: 0 }),
      getBudgetInfo: async () => ({ remainingUsd: 50, avgTaskCostUsd: 2 }),
      lockFile: '/tmp/test-lock',
    });

    const event: CycleEvent = {
      phase: 'execute', timing: 'after',
      data: { startCommit: 'abc' }, timestamp: Date.now(),
    };
    const errors = await bus.emitAndWait(event);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].message.includes('no code changes'));
  });
});
```

**Step 2: Update index.ts to wire all components**

In `src/index.ts`, in the serve command action:

```typescript
import { CycleEventBus } from './core/CycleEventBus.js';
import { registerGuards } from './core/guards/index.js';
import { registerObservers } from './core/observers/index.js';
import { registerStrategies } from './core/strategies/index.js';
import { getDiffStats } from './utils/git.js';

// After creating costTracker, before creating MainLoop:
const eventBus = new CycleEventBus();

registerGuards(eventBus, {
  getDiffStats: (startCommit) => getDiffStats(startCommit, 'HEAD', projectPath),
  getBudgetInfo: async () => {
    const cost = await costTracker.getDailyCost();
    const avgCost = await costTracker.getAvgTaskCost(5);
    return { remainingUsd: config.values.budget.maxPerDay - cost, avgTaskCostUsd: avgCost };
  },
  lockFile: `${process.env.HOME}/.db-coder/patrol.lock`,
});

const { logger: cycleLogger, metrics: cycleMetrics } = registerObservers(eventBus);

const { failureLearning, qualityEvaluator, dynamicPriority } = registerStrategies(eventBus, {
  getProjectHealth: async () => ({
    tscErrors: await countTscErrors(projectPath),
    recentSuccessRate: cycleMetrics.getMetrics().successRate,
    blockedTaskCount: await taskStore.countByStatus('blocked'),
  }),
});

const mainLoop = new MainLoop(config, taskQueue, codexBridge, taskStore, costTracker, eventBus);
```

**Step 3: Run full test suite**

Run: `npm run build && npm test`
Expected: All tests PASS including new integration test

**Step 4: Commit**

```bash
git add src/index.ts src/core/integration.test.ts
git commit -m "feat: wire EventBus with guards, observers, and strategies"
```

---

## Task 14: Final Verification + Run Full Suite

**Step 1: Build**

Run: `npm run build`
Expected: No TypeScript errors

**Step 2: Run all tests**

Run: `npm test`
Expected: All tests PASS

**Step 3: Verify no regressions in existing functionality**

Run: `node --test dist/core/MainLoop.test.js && node --test dist/client/Client.test.js`
Expected: All existing tests still PASS

**Step 4: Commit any remaining fixes**

If any issues found, fix and commit.

**Step 5: Final commit**

```bash
git add -A
git commit -m "chore: patrol event-driven refactor complete — Batch 0-4"
```
