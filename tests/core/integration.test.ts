import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CycleEventBus } from '../../src/core/CycleEventBus.js';
import { registerGuards } from '../../src/core/guards/index.js';
import { registerObservers } from '../../src/core/observers/index.js';
import { registerStrategies } from '../../src/core/strategies/index.js';
import type { CycleEvent } from '../../src/core/CycleEvents.js';

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
