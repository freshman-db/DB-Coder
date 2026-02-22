import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { TaskStore } from './TaskStore.js';

interface TaggedCall {
  text: string;
  values: unknown[];
}

interface UnsafeCall {
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

function createSqlMock(): {
  sql: SqlMock;
  taggedCalls: TaggedCall[];
  unsafeCalls: UnsafeCall[];
  jsonCalls: unknown[];
} {
  const taggedCalls: TaggedCall[] = [];
  const unsafeCalls: UnsafeCall[] = [];
  const jsonCalls: unknown[] = [];

  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    taggedCalls.push({
      text: buildParameterizedText(strings, values.length),
      values: [...values],
    });
    return [];
  }) as unknown as SqlMock;

  sql.unsafe = async (query: string, values: unknown[] = []) => {
    unsafeCalls.push({ text: normalizeSql(query), values: [...values] });
    return { count: 0 };
  };

  sql.json = (value: unknown) => {
    jsonCalls.push(value);
    return { __json: value };
  };

  return { sql, taggedCalls, unsafeCalls, jsonCalls };
}

function createTaskStore(sql: SqlMock): TaskStore {
  const store = Object.create(TaskStore.prototype) as TaskStore;
  (store as unknown as { sql: SqlMock }).sql = sql;
  (store as unknown as { isClosed: boolean }).isClosed = false;
  return store;
}

describe('TaskStore.updateTask', () => {
  test('skips query when update payload is empty', async () => {
    const { sql, unsafeCalls } = createSqlMock();
    const store = createTaskStore(sql);

    await store.updateTask('task-1', {});

    assert.equal(unsafeCalls.length, 0);
  });

  test('rejects non-whitelisted columns when no valid fields are present', async () => {
    const { sql, unsafeCalls } = createSqlMock();
    const store = createTaskStore(sql);

    await store.updateTask('task-1', { project_path: '/tmp/hack', priority: 0 } as any);

    assert.equal(unsafeCalls.length, 0);
  });

  test('ignores non-whitelisted columns when valid columns are present', async () => {
    const { sql, unsafeCalls } = createSqlMock();
    const store = createTaskStore(sql);

    await store.updateTask('task-1', {
      phase: 'executing',
      task_description: 'try-to-overwrite-description',
    } as any);

    assert.equal(unsafeCalls.length, 1);
    assert.equal(unsafeCalls[0].text, 'UPDATE tasks SET phase = $1, updated_at = NOW() WHERE id = $2');
    assert.deepEqual(unsafeCalls[0].values, ['executing', 'task-1']);
    assert.ok(!unsafeCalls[0].text.includes('task_description'));
  });

  test('builds SET clause in whitelist order with scalar fields', async () => {
    const { sql, unsafeCalls } = createSqlMock();
    const store = createTaskStore(sql);

    await store.updateTask('task-2', {
      status: 'done',
      phase: 'reviewing',
      iteration: 3,
    });

    assert.equal(unsafeCalls.length, 1);
    assert.equal(
      unsafeCalls[0].text,
      'UPDATE tasks SET phase = $1, status = $2, iteration = $3, updated_at = NOW() WHERE id = $4',
    );
    assert.deepEqual(unsafeCalls[0].values, ['reviewing', 'done', 3, 'task-2']);
  });

  test('casts JSONB fields with ::jsonb and preserves input objects', async () => {
    const { sql, unsafeCalls } = createSqlMock();
    const store = createTaskStore(sql);

    const plan = { steps: ['scan', 'fix'] };
    const subtasks = [{ id: 's-1', status: 'done' }];
    const reviewResults = [{ passed: false }];

    await store.updateTask('task-3', {
      plan,
      subtasks: subtasks as any,
      review_results: reviewResults as any,
    });

    assert.equal(
      unsafeCalls[0].text,
      'UPDATE tasks SET plan = $1::jsonb, subtasks = $2::jsonb, review_results = $3::jsonb, updated_at = NOW() WHERE id = $4',
    );
    assert.deepEqual(unsafeCalls[0].values, [plan, subtasks, reviewResults, 'task-3']);
  });

  test('skips fields with undefined values', async () => {
    const { sql, unsafeCalls } = createSqlMock();
    const store = createTaskStore(sql);

    await store.updateTask('task-4', {
      phase: undefined,
      status: 'active',
    });

    assert.equal(unsafeCalls[0].text, 'UPDATE tasks SET status = $1, updated_at = NOW() WHERE id = $2');
    assert.deepEqual(unsafeCalls[0].values, ['active', 'task-4']);
  });
});

describe('TaskStore.saveScanResult', () => {
  test('uses sql.json for the result payload instead of JSON.stringify', async () => {
    const { sql, taggedCalls, jsonCalls } = createSqlMock();
    const store = createTaskStore(sql);

    const result = {
      issues: [{ type: 'null-safety' }],
      opportunities: [],
      projectHealth: 82,
      summary: 'Needs cleanup',
    };

    await store.saveScanResult({
      project_path: '/repo',
      commit_hash: 'abc123',
      depth: 'deep',
      result: result as any,
      health_score: 82,
      cost_usd: 1.25,
    });

    assert.equal(jsonCalls.length, 1);
    assert.equal(jsonCalls[0], result);
    assert.equal(taggedCalls.length, 1);
    assert.equal(
      taggedCalls[0].text,
      'INSERT INTO scan_results (project_path, commit_hash, depth, result, health_score, cost_usd) VALUES ($1, $2, $3, $4, $5, $6)',
    );
    assert.deepEqual(taggedCalls[0].values[3], { __json: result });
    assert.notEqual(taggedCalls[0].values[3], JSON.stringify(result));
  });

  test('passes null health_score and cost_usd through unchanged', async () => {
    const { sql, taggedCalls } = createSqlMock();
    const store = createTaskStore(sql);

    await store.saveScanResult({
      project_path: '/repo',
      commit_hash: 'def456',
      depth: 'quick',
      result: {
        issues: [],
        opportunities: [],
        projectHealth: 100,
        summary: 'Clean',
      } as any,
      health_score: null,
      cost_usd: null,
    });

    assert.equal(taggedCalls[0].values[4], null);
    assert.equal(taggedCalls[0].values[5], null);
  });
});

describe('TaskStore.incrementTaskCost', () => {
  test('builds an atomic COALESCE update statement', async () => {
    const { sql, unsafeCalls } = createSqlMock();
    const store = createTaskStore(sql);

    await store.incrementTaskCost('task-9', 0.75);

    assert.equal(
      unsafeCalls[0].text,
      'UPDATE tasks SET total_cost_usd = COALESCE(total_cost_usd, 0) + $1 WHERE id = $2',
    );
    assert.deepEqual(unsafeCalls[0].values, [0.75, 'task-9']);
  });

  test('keeps parameterized amount for negative adjustments', async () => {
    const { sql, unsafeCalls } = createSqlMock();
    const store = createTaskStore(sql);

    await store.incrementTaskCost('task-10', -0.1);

    assert.deepEqual(unsafeCalls[0].values, [-0.1, 'task-10']);
  });
});

describe('TaskStore.listTasks (getTasksByStatus query construction)', () => {
  test('adds status filter when status is provided', async () => {
    const { sql, taggedCalls } = createSqlMock();
    const store = createTaskStore(sql);

    await store.listTasks('/repo', 'queued');

    assert.equal(
      taggedCalls[0].text,
      'SELECT * FROM tasks WHERE project_path = $1 AND status = $2 ORDER BY priority ASC, created_at ASC',
    );
    assert.deepEqual(taggedCalls[0].values, ['/repo', 'queued']);
  });

  test('omits status filter when status is undefined', async () => {
    const { sql, taggedCalls } = createSqlMock();
    const store = createTaskStore(sql);

    await store.listTasks('/repo');

    assert.equal(
      taggedCalls[0].text,
      'SELECT * FROM tasks WHERE project_path = $1 ORDER BY priority ASC, created_at ASC',
    );
    assert.deepEqual(taggedCalls[0].values, ['/repo']);
  });
});
