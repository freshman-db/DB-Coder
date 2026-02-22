import assert from 'node:assert/strict';
import test from 'node:test';

import type { OperationalMetrics } from './types.js';

test('defines operational metrics payload shape', () => {
  const metrics: OperationalMetrics = {
    cycleCount: 42,
    avgCycleDurationMs: 1750,
    taskPassRate: 0.875,
    dailyCostUsd: 12.34,
    queueDepth: 3,
    tasksByStatus: {
      done: 14,
      failed: 2,
      queued: 3,
    },
    recentHealthScores: [94, 92, 96, 91, 90, 95, 97, 93, 94, 96],
  };

  assert.equal(metrics.cycleCount, 42);
  assert.equal(metrics.tasksByStatus.queued, 3);
  assert.equal(metrics.recentHealthScores.length, 10);
});

test('supports empty operational metrics data', () => {
  const metrics: OperationalMetrics = {
    cycleCount: 0,
    avgCycleDurationMs: 0,
    taskPassRate: 0,
    dailyCostUsd: 0,
    queueDepth: 0,
    tasksByStatus: {},
    recentHealthScores: [],
  };

  assert.equal(metrics.queueDepth, 0);
  assert.equal(Object.keys(metrics.tasksByStatus).length, 0);
  assert.equal(metrics.recentHealthScores.length, 0);
});
