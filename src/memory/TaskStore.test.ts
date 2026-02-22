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

function createSqlMock(responder?: (call: TaggedCall) => unknown[]): {
  sql: SqlMock;
  taggedCalls: TaggedCall[];
  unsafeCalls: UnsafeCall[];
  jsonCalls: unknown[];
} {
  const taggedCalls: TaggedCall[] = [];
  const unsafeCalls: UnsafeCall[] = [];
  const jsonCalls: unknown[] = [];

  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const call = {
      text: buildParameterizedText(strings, values.length),
      values: [...values],
    };
    taggedCalls.push(call);
    return responder ? responder(call) : [];
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

describe('TaskStore.getOperationalMetrics', () => {
  test('aggregates metrics from parallel SQL queries and helper methods', async () => {
    const { sql, taggedCalls } = createSqlMock(call => {
      if (call.text.includes('AS cycle_count')) {
        return [{ cycle_count: '4', avg_cycle_duration_ms: '1250.5' }];
      }
      if (call.text.includes('AS done_count')) {
        return [{ done_count: 8, failed_count: 2 }];
      }
      if (call.text.includes('AS queue_depth')) {
        return [{ queue_depth: '3' }];
      }
      if (call.text.startsWith('SELECT status, COUNT(*)::int AS count')) {
        return [
          { status: 'done', count: '8' },
          { status: 'failed', count: 2 },
          { status: 'queued', count: '3' },
        ];
      }
      return [];
    });
    const store = createTaskStore(sql);

    let dailyCostCalls = 0;
    store.getDailyCost = async () => {
      dailyCostCalls += 1;
      return { total_cost_usd: 4.75 as number, task_count: 2 };
    };

    const recentScansArgs: Array<string | number> = [];
    store.getRecentScans = async (projectPath: string, limit = 10) => {
      recentScansArgs.push(projectPath, limit);
      return [
        { health_score: 95 },
        { health_score: null },
        { health_score: 88 },
      ] as any;
    };

    const metrics = await store.getOperationalMetrics('/repo');

    assert.equal(dailyCostCalls, 1);
    assert.deepEqual(recentScansArgs, ['/repo', 10]);
    assert.equal(taggedCalls.length, 4);
    assert.equal(
      taggedCalls[0].text,
      "SELECT COUNT(*)::int AS cycle_count, COALESCE(AVG(cycle_duration_ms), 0) AS avg_cycle_duration_ms FROM ( SELECT t.id, COALESCE(EXTRACT(EPOCH FROM (MAX(tl.created_at) - MIN(tl.created_at))) * 1000, 0) AS cycle_duration_ms FROM tasks t LEFT JOIN task_logs tl ON tl.task_id = t.id WHERE t.project_path = $1 AND t.status = 'done' GROUP BY t.id ) AS completed_cycles",
    );
    assert.equal(
      taggedCalls[1].text,
      "SELECT COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0)::int AS done_count, COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)::int AS failed_count FROM tasks WHERE project_path = $1 AND status IN ('done', 'failed')",
    );
    assert.equal(
      taggedCalls[2].text,
      "SELECT COUNT(*)::int AS queue_depth FROM tasks WHERE project_path = $1 AND status = 'queued'",
    );
    assert.equal(
      taggedCalls[3].text,
      'SELECT status, COUNT(*)::int AS count FROM tasks WHERE project_path = $1 GROUP BY status',
    );
    assert.deepEqual(taggedCalls.map(call => call.values), [['/repo'], ['/repo'], ['/repo'], ['/repo']]);
    assert.deepEqual(metrics, {
      cycleCount: 4,
      avgCycleDurationMs: 1250.5,
      taskPassRate: 0.8,
      dailyCostUsd: 4.75,
      queueDepth: 3,
      tasksByStatus: {
        done: 8,
        failed: 2,
        queued: 3,
      },
      recentHealthScores: [95, 88],
    });
  });

  test('returns zero-safe defaults when aggregation queries and helper methods return no data', async () => {
    const { sql, taggedCalls } = createSqlMock(() => []);
    const store = createTaskStore(sql);

    store.getDailyCost = async () => ({ total_cost_usd: 0, task_count: 0 });
    store.getRecentScans = async () => [];

    const metrics = await store.getOperationalMetrics('/repo');

    assert.equal(taggedCalls.length, 4);
    assert.equal(metrics.cycleCount, 0);
    assert.equal(metrics.avgCycleDurationMs, 0);
    assert.equal(metrics.taskPassRate, 0);
    assert.equal(metrics.dailyCostUsd, 0);
    assert.equal(metrics.queueDepth, 0);
    assert.deepEqual(metrics.tasksByStatus, {});
    assert.deepEqual(metrics.recentHealthScores, []);
  });
});

describe('TaskStore.saveConfigProposal', () => {
  test('serializes current and proposed config values with sql.json', async () => {
    const { sql, taggedCalls, jsonCalls } = createSqlMock();
    const store = createTaskStore(sql);

    const currentValue = { evolution: { maxActiveAdjustments: 3 } };
    const proposedValue = { evolution: { maxActiveAdjustments: 5 } };

    await store.saveConfigProposal({
      project_path: '/repo',
      field_path: 'evolution.maxActiveAdjustments',
      current_value: currentValue,
      proposed_value: proposedValue,
      reason: 'Allow more concurrent experiments',
      confidence: 0.82,
    });

    assert.equal(jsonCalls.length, 2);
    assert.equal(jsonCalls[0], currentValue);
    assert.equal(jsonCalls[1], proposedValue);
    assert.equal(
      taggedCalls[0].text,
      'INSERT INTO config_proposals (project_path, field_path, current_value, proposed_value, reason, confidence) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    );
    assert.deepEqual(taggedCalls[0].values[2], { __json: currentValue });
    assert.deepEqual(taggedCalls[0].values[3], { __json: proposedValue });
  });

  test('supports primitive JSON boundary values', async () => {
    const { sql, jsonCalls } = createSqlMock();
    const store = createTaskStore(sql);

    await store.saveConfigProposal({
      project_path: '/repo',
      field_path: 'evolution.retryLimit',
      current_value: 0,
      proposed_value: false,
      reason: 'Disable retries temporarily',
      confidence: 0.5,
    });

    assert.deepEqual(jsonCalls, [0, false]);
  });
});

describe('TaskStore.savePromptVersion', () => {
  test('serializes patches and baseline metrics JSON payloads', async () => {
    const { sql, taggedCalls, jsonCalls } = createSqlMock();
    const store = createTaskStore(sql);

    const patches = [{
      op: 'append',
      section: '## Guardrails',
      content: 'Validate parser output',
      reason: 'Reduce malformed responses',
    }] as const;
    const baseline = {
      passRate: 0.91,
      avgCostUsd: 1.1,
      issueCount: 2,
      tasksEvaluated: 14,
    };

    await store.savePromptVersion({
      project_path: '/repo',
      prompt_name: 'plan',
      version: 2,
      patches: [...patches],
      rationale: 'Harden planning output contract',
      confidence: 0.77,
      baseline_metrics: baseline,
    });

    assert.equal(jsonCalls.length, 2);
    assert.deepEqual(jsonCalls, [[...patches], baseline]);
    assert.deepEqual(taggedCalls[0].values[3], { __json: [...patches] });
    assert.deepEqual(taggedCalls[0].values[6], { __json: baseline });
  });

  test('writes null baseline metrics without json serialization', async () => {
    const { sql, taggedCalls, jsonCalls } = createSqlMock();
    const store = createTaskStore(sql);

    await store.savePromptVersion({
      project_path: '/repo',
      prompt_name: 'scan',
      version: 1,
      patches: [{ op: 'append', content: 'Be concise', reason: 'cost' }],
      rationale: 'First pass',
      confidence: 0.6,
      baseline_metrics: null,
    });

    assert.equal(jsonCalls.length, 1);
    assert.equal(taggedCalls[0].values[6], null);
  });
});

describe('TaskStore plan draft JSONB columns', () => {
  test('serializes plan payloads for save and update operations', async () => {
    const { sql, taggedCalls, jsonCalls } = createSqlMock();
    const store = createTaskStore(sql);

    const plan = {
      tasks: [{
        id: 'T1',
        description: 'Add type-safe JSONB schemas',
        priority: 1,
        executor: 'codex' as const,
        subtasks: [{ id: 'S1', description: 'Wire schema imports', executor: 'codex' as const }],
        dependsOn: [],
        estimatedComplexity: 'low' as const,
        type: 'refactor' as const,
      }],
      reasoning: 'Improve persistence type safety',
    };

    await store.savePlanDraft({
      project_path: '/repo',
      plan,
      analysis_summary: 'analysis',
      reasoning: 'reasoning',
      markdown: 'markdown',
      cost_usd: 0.4,
    });
    await store.updatePlanDraftPlan(11, {
      plan,
      markdown: 'updated markdown',
      reasoning: 'updated reasoning',
      cost_usd: 0.9,
    });

    assert.equal(jsonCalls.length, 2);
    assert.equal(jsonCalls[0], plan);
    assert.equal(jsonCalls[1], plan);
    assert.deepEqual(taggedCalls[0].values[1], { __json: plan });
    assert.deepEqual(taggedCalls[1].values[0], { __json: plan });
  });

  test('serializes annotations when provided and skips serialization when omitted', async () => {
    const { sql, taggedCalls, jsonCalls } = createSqlMock();
    const store = createTaskStore(sql);

    await store.updatePlanDraftStatus(21, 'approved', []);
    await store.updatePlanDraftStatus(21, 'rejected');

    assert.equal(jsonCalls.length, 1);
    assert.deepEqual(jsonCalls[0], []);
    assert.equal(
      taggedCalls[0].text,
      'UPDATE plan_drafts SET status = $1, annotations = $2, reviewed_at = NOW() WHERE id = $3',
    );
    assert.equal(
      taggedCalls[1].text,
      'UPDATE plan_drafts SET status = $1, reviewed_at = NOW() WHERE id = $2',
    );
  });

  test('uses empty object metadata boundary when chat metadata is omitted', async () => {
    const { sql, taggedCalls, jsonCalls } = createSqlMock();
    const store = createTaskStore(sql);

    await store.addChatMessage(8, 'assistant', 'Ready to generate');

    assert.equal(jsonCalls.length, 1);
    assert.deepEqual(jsonCalls[0], {});
    assert.deepEqual(taggedCalls[0].values[3], { __json: {} });
  });
});
