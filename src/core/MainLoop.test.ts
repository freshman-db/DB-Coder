import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import type { Config } from '../config/Config.js';
import type { ClaudeBridge } from '../bridges/ClaudeBridge.js';
import type { CodexBridge } from '../bridges/CodexBridge.js';
import type { TaskStore } from '../memory/TaskStore.js';
import type { GlobalMemory } from '../memory/GlobalMemory.js';
import type { CostTracker } from '../utils/cost.js';
import type { Brain } from './Brain.js';
import type { TaskQueue } from './TaskQueue.js';
import type { PromptRegistry } from '../prompts/PromptRegistry.js';
import { MainLoop, extractIssueCategories } from './MainLoop.js';
import type { StatusSnapshot } from './types.js';
import type { ReviewIssue } from '../bridges/CodingAgent.js';

/** Helper to build a minimal ReviewIssue for testing */
function issue(
  description: string,
  severity: ReviewIssue['severity'] = 'medium',
  suggestion?: string,
): ReviewIssue {
  return { description, severity, source: 'claude', suggestion };
}

type MainLoopInternals = {
  setState(state: StatusSnapshot['state']): void;
  setCurrentTaskId(taskId: string | null): void;
  setPaused(paused: boolean): void;
  setRunning(running: boolean): void;
};

function createMainLoop(): MainLoop {
  const config = {
    projectPath: '/tmp/db-coder-main-loop-test',
  } as unknown as Config;

  return new MainLoop(
    config,
    {} as unknown as Brain,
    {} as unknown as TaskQueue,
    {} as unknown as ClaudeBridge,
    {} as unknown as CodexBridge,
    {} as unknown as TaskStore,
    {} as unknown as GlobalMemory,
    {} as unknown as CostTracker,
  );
}

function getMainLoopInternals(loop: MainLoop): MainLoopInternals {
  return loop as unknown as MainLoopInternals;
}

type PromptDeltaInternals = {
  updatePromptVersionEffectiveness(passed: boolean): Promise<void>;
};

function getPromptDeltaInternals(loop: MainLoop): PromptDeltaInternals {
  return loop as unknown as PromptDeltaInternals;
}

function createMainLoopForPromptDelta(taskStore: TaskStore): MainLoop {
  const config = {
    projectPath: '/tmp/db-coder-main-loop-test',
  } as unknown as Config;

  return new MainLoop(
    config,
    {} as unknown as Brain,
    {} as unknown as TaskQueue,
    {} as unknown as ClaudeBridge,
    {} as unknown as CodexBridge,
    taskStore,
    {} as unknown as GlobalMemory,
    {} as unknown as CostTracker,
  );
}

describe('extractIssueCategories', () => {
  test('matches known patterns', () => {
    const cats = extractIssueCategories([
      issue('type mismatch in return value'),
      issue('missing null check leads to crash'),
      issue('potential XSS vulnerability in template', 'high'),
    ]);
    assert.ok(cats.includes('type-error'));
    assert.ok(cats.includes('null-safety'));
    assert.ok(cats.includes('security'));
  });

  test('uses severity fallback when no pattern matches', () => {
    const cats = extractIssueCategories([
      issue('this code looks off', 'low'),
    ]);
    assert.ok(cats.includes('severity-low'));
    assert.equal(cats.length, 1);
  });

  test('per-issue fallback: unmatched issue gets severity even when earlier issues matched', () => {
    // This is the exact scenario that the global-check bug would miss:
    // first issue matches a pattern, second doesn't — second must still get a fallback.
    const cats = extractIssueCategories([
      issue('type error in function signature', 'high'),
      issue('this code looks off', 'low'),
    ]);
    assert.ok(cats.includes('type-error'), 'first issue should match type-error');
    assert.ok(cats.includes('severity-low'), 'second issue should get severity fallback');
  });

  test('returns empty array for empty input', () => {
    const cats = extractIssueCategories([]);
    assert.deepEqual(cats, []);
  });

  test('includes suggestion text in pattern matching', () => {
    const cats = extractIssueCategories([
      issue('fix this function', 'medium', 'add try catch to handle errors'),
    ]);
    assert.ok(cats.includes('error-handling'));
  });

  test('single issue matching multiple patterns produces multiple categories', () => {
    const cats = extractIssueCategories([
      issue('null check missing which causes a type error', 'high'),
    ]);
    assert.ok(cats.includes('null-safety'));
    assert.ok(cats.includes('type-error'));
    assert.ok(!cats.some(c => c.startsWith('severity-')), 'matched issue should not get fallback');
  });
});

describe('MainLoop status listeners', () => {
  test('registers and removes listeners', () => {
    const loop = createMainLoop();
    const internals = getMainLoopInternals(loop);
    const snapshots: StatusSnapshot[] = [];

    const remove = loop.addStatusListener(snapshot => {
      snapshots.push(snapshot);
    });

    internals.setState('scanning');
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.state, 'scanning');

    remove();
    internals.setState('planning');
    assert.equal(snapshots.length, 1);
  });

  test('broadcasts latest state fields to listeners', () => {
    const loop = createMainLoop();
    const internals = getMainLoopInternals(loop);
    const snapshots: StatusSnapshot[] = [];

    loop.addStatusListener(snapshot => {
      snapshots.push(snapshot);
    });

    internals.setRunning(true);
    internals.setState('executing');
    internals.setCurrentTaskId('task-123');
    internals.setPaused(true);

    assert.deepEqual(snapshots.at(-1), {
      state: 'executing',
      currentTaskId: 'task-123',
      patrolling: true,
      paused: true,
    });
  });

  test('does not broadcast when values do not change', () => {
    const loop = createMainLoop();
    const internals = getMainLoopInternals(loop);
    let calls = 0;

    loop.addStatusListener(() => {
      calls++;
    });

    internals.setState('idle');
    internals.setCurrentTaskId(null);
    internals.setPaused(false);
    internals.setRunning(false);

    assert.equal(calls, 0);
  });

  test('continues broadcasting when one listener throws', () => {
    const loop = createMainLoop();
    const internals = getMainLoopInternals(loop);
    let received: StatusSnapshot | undefined;

    loop.addStatusListener(() => {
      throw new Error('listener failed');
    });
    loop.addStatusListener(snapshot => {
      received = snapshot;
    });

    assert.doesNotThrow(() => {
      internals.setState('scanning');
    });

    assert.deepEqual(received, {
      state: 'scanning',
      currentTaskId: null,
      patrolling: false,
      paused: false,
    });
  });
});

describe('MainLoop prompt effectiveness deltas', () => {
  test('applies positive delta to every active prompt version when task passed', async () => {
    const updates: Array<{ id: number; delta: number }> = [];
    const taskStore = {
      getActivePromptVersions: async () => [{ id: 101 }, { id: 202 }],
      updatePromptVersionEffectiveness: async (id: number, delta: number) => {
        updates.push({ id, delta });
      },
    } as unknown as TaskStore;
    const loop = createMainLoopForPromptDelta(taskStore);
    loop.setPromptRegistry({} as PromptRegistry);

    await getPromptDeltaInternals(loop).updatePromptVersionEffectiveness(true);

    assert.deepEqual(updates, [
      { id: 101, delta: 0.1 },
      { id: 202, delta: 0.1 },
    ]);
  });

  test('applies negative delta when task failed', async () => {
    const updates: Array<{ id: number; delta: number }> = [];
    const taskStore = {
      getActivePromptVersions: async () => [{ id: 7 }],
      updatePromptVersionEffectiveness: async (id: number, delta: number) => {
        updates.push({ id, delta });
      },
    } as unknown as TaskStore;
    const loop = createMainLoopForPromptDelta(taskStore);
    loop.setPromptRegistry({} as PromptRegistry);

    await getPromptDeltaInternals(loop).updatePromptVersionEffectiveness(false);

    assert.deepEqual(updates, [{ id: 7, delta: -0.15 }]);
  });

  test('does nothing when there are no active prompt versions', async () => {
    let updateCalls = 0;
    const taskStore = {
      getActivePromptVersions: async () => [],
      updatePromptVersionEffectiveness: async () => {
        updateCalls++;
      },
    } as unknown as TaskStore;
    const loop = createMainLoopForPromptDelta(taskStore);
    loop.setPromptRegistry({} as PromptRegistry);

    await getPromptDeltaInternals(loop).updatePromptVersionEffectiveness(true);

    assert.equal(updateCalls, 0);
  });

  test('returns early when prompt registry is not set', async () => {
    let queried = false;
    const taskStore = {
      getActivePromptVersions: async () => {
        queried = true;
        return [];
      },
      updatePromptVersionEffectiveness: async () => {},
    } as unknown as TaskStore;
    const loop = createMainLoopForPromptDelta(taskStore);

    await getPromptDeltaInternals(loop).updatePromptVersionEffectiveness(true);

    assert.equal(queried, false);
  });

  test('swallows storage errors during prompt effectiveness updates', async () => {
    const taskStore = {
      getActivePromptVersions: async () => {
        throw new Error('db unavailable');
      },
      updatePromptVersionEffectiveness: async () => {},
    } as unknown as TaskStore;
    const loop = createMainLoopForPromptDelta(taskStore);
    loop.setPromptRegistry({} as PromptRegistry);

    await assert.doesNotReject(getPromptDeltaInternals(loop).updatePromptVersionEffectiveness(true));
  });
});
