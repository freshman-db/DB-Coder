import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TaskQualityEvaluator } from './TaskQualityEvaluator.js';
import { DynamicPriorityStrategy } from './DynamicPriorityStrategy.js';

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
