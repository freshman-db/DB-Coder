import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BudgetGuard } from '../../../src/core/guards/BudgetGuard.js';
import { WorkerFixResultGuard } from '../../../src/core/guards/WorkerFixResultGuard.js';

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
