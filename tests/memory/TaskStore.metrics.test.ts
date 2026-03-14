import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { TaskStore } from '../../src/memory/TaskStore.js';

interface TaggedCall {
  text: string;
  values: unknown[];
}

type SqlMock = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>) & {
  unsafe: (query: string, values?: unknown[]) => Promise<{ count: number }>;
  json: (value: unknown) => { __json: unknown };
};

function normalizeSql(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function buildParameterizedText(strings: readonly string[], valueCount: number): string {
  let text = '';
  for (let index = 0; index < strings.length; index += 1) {
    text += strings[index];
    if (index < valueCount) {
      text += `$${index + 1}`;
    }
  }
  return normalizeSql(text);
}

function createSqlMock(responder?: (call: TaggedCall) => unknown[]): {
  sql: SqlMock;
  taggedCalls: TaggedCall[];
} {
  const taggedCalls: TaggedCall[] = [];

  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const call = {
      text: buildParameterizedText(strings, values.length),
      values: [...values],
    };
    taggedCalls.push(call);
    return responder ? responder(call) : [];
  }) as unknown as SqlMock;

  sql.unsafe = async () => ({ count: 0 });
  sql.json = (value: unknown) => ({ __json: value });

  return { sql, taggedCalls };
}

function createTaskStore(sql: SqlMock): TaskStore {
  const store = Object.create(TaskStore.prototype) as TaskStore;
  (store as unknown as { sql: SqlMock }).sql = sql;
  (store as unknown as { isClosed: boolean }).isClosed = false;
  return store;
}

describe('TaskStore.getOperationalMetrics', () => {
  test('returns aggregated metrics for a project with completed cycles', async () => {
    const { sql, taggedCalls } = createSqlMock(call => {
      if (call.text.includes('AS cycle_count')) {
        return [{ cycle_count: '7', avg_cycle_duration_ms: '1800.25' }];
      }
      if (call.text.includes('AS done_count')) {
        return [{ done_count: '9', failed_count: '3' }];
      }
      if (call.text.includes('AS queue_depth')) {
        return [{ queue_depth: '5' }];
      }
      if (call.text.startsWith('SELECT status, COUNT(*)::int AS count')) {
        return [
          { status: 'queued', count: '5' },
          { status: 'done', count: '9' },
          { status: 'failed', count: 3 },
          { status: 'active', count: '2' },
        ];
      }
      return [];
    });
    const store = createTaskStore(sql);

    let dailyCostCalls = 0;
    store.getDailyCost = async () => {
      dailyCostCalls += 1;
      return { total_cost_usd: 11.2, task_count: 4 };
    };

    let recentScansArgs: { projectPath: string; limit: number } | null = null;
    store.getRecentScans = async (projectPath, limit = 10) => {
      recentScansArgs = { projectPath, limit };
      return [
        { health_score: 91 },
        { health_score: null },
        { health_score: 87 },
      ] as any;
    };

    const metrics = await store.getOperationalMetrics('/repo');

    assert.equal(dailyCostCalls, 1);
    assert.deepEqual(recentScansArgs, { projectPath: '/repo', limit: 10 });
    assert.equal(taggedCalls.length, 4);
    assert.deepEqual(taggedCalls.map(call => call.values), [['/repo'], ['/repo'], ['/repo'], ['/repo']]);
    assert.deepEqual(metrics, {
      cycleCount: 7,
      avgCycleDurationMs: 1800.25,
      taskPassRate: 0.75,
      dailyCostUsd: 11.2,
      queueDepth: 5,
      tasksByStatus: {
        queued: 5,
        done: 9,
        failed: 3,
        active: 2,
      },
      recentHealthScores: [91, 87],
    });
  });

  test('returns zero-safe defaults for an empty project', async () => {
    const { sql, taggedCalls } = createSqlMock(() => []);
    const store = createTaskStore(sql);

    store.getDailyCost = async () => ({ total_cost_usd: 0, task_count: 0 });
    store.getRecentScans = async () => [] as any;

    const metrics = await store.getOperationalMetrics('/empty-project');

    assert.equal(taggedCalls.length, 4);
    assert.deepEqual(metrics, {
      cycleCount: 0,
      avgCycleDurationMs: 0,
      taskPassRate: 0,
      dailyCostUsd: 0,
      queueDepth: 0,
      tasksByStatus: {},
      recentHealthScores: [],
    });
  });

  test('handles done+failed = 0 without division by zero', async () => {
    const { sql } = createSqlMock(call => {
      if (call.text.includes('AS cycle_count')) {
        return [{ cycle_count: 0, avg_cycle_duration_ms: 0 }];
      }
      if (call.text.includes('AS done_count')) {
        return [{ done_count: 0, failed_count: 0 }];
      }
      if (call.text.includes('AS queue_depth')) {
        return [{ queue_depth: 2 }];
      }
      if (call.text.startsWith('SELECT status, COUNT(*)::int AS count')) {
        return [{ status: 'queued', count: 2 }];
      }
      return [];
    });
    const store = createTaskStore(sql);

    store.getDailyCost = async () => ({ total_cost_usd: 1.75, task_count: 1 });
    store.getRecentScans = async () => [{ health_score: 65 }] as any;

    const metrics = await store.getOperationalMetrics('/repo');

    assert.equal(metrics.taskPassRate, 0);
    assert.equal(Number.isFinite(metrics.taskPassRate), true);
    assert.equal(metrics.queueDepth, 2);
    assert.deepEqual(metrics.tasksByStatus, { queued: 2 });
    assert.deepEqual(metrics.recentHealthScores, [65]);
  });

  test('treats missing task_logs as zero duration while preserving cycle count', async () => {
    const { sql, taggedCalls } = createSqlMock(call => {
      if (call.text.includes('AS cycle_count')) {
        return [{ cycle_count: '3', avg_cycle_duration_ms: null }];
      }
      if (call.text.includes('AS done_count')) {
        return [{ done_count: 3, failed_count: 0 }];
      }
      if (call.text.includes('AS queue_depth')) {
        return [{ queue_depth: 0 }];
      }
      if (call.text.startsWith('SELECT status, COUNT(*)::int AS count')) {
        return [{ status: 'done', count: 3 }];
      }
      return [];
    });
    const store = createTaskStore(sql);

    store.getDailyCost = async () => ({ total_cost_usd: 0, task_count: 0 });
    store.getRecentScans = async () => [] as any;

    const metrics = await store.getOperationalMetrics('/repo-no-logs');

    const cycleQuery = taggedCalls.find(call => call.text.includes('AS cycle_count'));
    assert.ok(cycleQuery);
    assert.equal(cycleQuery.text.includes('LEFT JOIN task_logs tl ON tl.task_id = t.id'), true);
    assert.equal(cycleQuery.text.includes('MAX(tl.created_at) - MIN(tl.created_at)'), true);

    assert.equal(metrics.cycleCount, 3);
    assert.equal(metrics.avgCycleDurationMs, 0);
    assert.equal(metrics.taskPassRate, 1);
    assert.deepEqual(metrics.tasksByStatus, { done: 3 });
  });
});
