import assert from 'node:assert/strict';
import test from 'node:test';

import type { BudgetConfig } from '../config/types.js';
import type { TaskStore } from '../memory/TaskStore.js';
import { CostTracker } from './cost.js';

test('CostTracker.addCost persists cumulative task cost via task-level increments', async () => {
  const dailyCosts: number[] = [];
  const taskCostIncrements: number[] = [];
  let persistedTaskCost = 0;

  const store: Pick<TaskStore, 'addDailyCost' | 'incrementTaskCost'> = {
    addDailyCost: async (costUsd: number): Promise<void> => {
      dailyCosts.push(costUsd);
    },
    incrementTaskCost: async (_taskId: string, amount: number): Promise<void> => {
      taskCostIncrements.push(amount);
      persistedTaskCost += amount;
    },
  };

  const budget: BudgetConfig = {
    maxPerTask: 10,
    maxPerDay: 100,
    warningThreshold: 0.8,
  };

  const tracker = new CostTracker(store as TaskStore, budget);

  await tracker.addCost('task-123', 0.25);
  await tracker.addCost('task-123', 0.75);

  assert.deepEqual(dailyCosts, [0.25, 0.75]);
  assert.deepEqual(taskCostIncrements, [0.25, 0.75]);
  assert.equal(persistedTaskCost, 1);
  assert.equal(tracker.getSessionCost(), 1);
});
