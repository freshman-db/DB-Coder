import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FailureLearningStrategy } from './FailureLearningStrategy.js';

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
    assert.equal(strategy.getCooldownCycles(5), 16);
  });
});
