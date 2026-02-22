import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import type { Config } from '../config/Config.js';
import type { TaskStore } from '../memory/TaskStore.js';
import type { GlobalMemory } from '../memory/GlobalMemory.js';
import type { RecurringIssueCategory, ReviewEvent, Task } from '../memory/types.js';
import type { HealthTrend, PromptVersion } from './types.js';
import type { TrendAnalyzer } from './TrendAnalyzer.js';
import { EvolutionEngine } from './EvolutionEngine.js';

type MetaReflectData = {
  reviewEvents: ReviewEvent[];
  recentTasks: Task[];
  healthTrend: HealthTrend | null;
  activeVersions: PromptVersion[];
  passRate: number;
  avgCost: number;
  issueCategories: RecurringIssueCategory[];
};

type EvolutionEngineInternals = {
  collectMetaReflectData(projectPath: string): Promise<MetaReflectData>;
  buildMetaReflectPrompt(data: MetaReflectData): string;
};

function makeTask(index: number, cost: number): Task {
  return {
    id: `task-${index}`,
    project_path: '/repo',
    task_description: `Task ${index}`,
    phase: 'done',
    priority: 2,
    plan: null,
    subtasks: [],
    review_results: [],
    iteration: 1,
    total_cost_usd: cost,
    git_branch: null,
    start_commit: null,
    depends_on: [],
    status: 'done',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function createEvolutionEngine(taskStore: Partial<TaskStore>, trendAnalyzer: Partial<TrendAnalyzer>): EvolutionEngine {
  return new EvolutionEngine(
    taskStore as TaskStore,
    {} as GlobalMemory,
    { values: {} } as Config,
    trendAnalyzer as TrendAnalyzer,
  );
}

describe('EvolutionEngine.collectMetaReflectData', () => {
  test('collects review/task metrics and returns the composed payload', async () => {
    const reviewEvents: ReviewEvent[] = [
      {
        id: 1,
        task_id: 'task-1',
        attempt: 1,
        passed: true,
        must_fix_count: 0,
        should_fix_count: 1,
        issue_categories: ['style'],
        fix_agent: null,
        duration_ms: 100,
        cost_usd: 0.03,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        id: 2,
        task_id: 'task-2',
        attempt: 1,
        passed: false,
        must_fix_count: 2,
        should_fix_count: 0,
        issue_categories: ['null-safety'],
        fix_agent: 'codex',
        duration_ms: 200,
        cost_usd: 0.04,
        created_at: new Date('2026-01-01T00:01:00.000Z'),
      },
      {
        id: 3,
        task_id: 'task-3',
        attempt: 2,
        passed: true,
        must_fix_count: 0,
        should_fix_count: 0,
        issue_categories: [],
        fix_agent: 'claude',
        duration_ms: 150,
        cost_usd: 0.05,
        created_at: new Date('2026-01-01T00:02:00.000Z'),
      },
    ];

    const recentTasks = Array.from({ length: 25 }, (_, index) => makeTask(index + 1, index + 1));

    const healthTrend: HealthTrend = {
      current: 84,
      previous: 80,
      delta: 4,
      direction: 'improving',
      dataPoints: 10,
    };

    const activeVersions: PromptVersion[] = [
      {
        id: 7,
        project_path: '/repo',
        prompt_name: 'scan',
        version: 2,
        patches: [{ op: 'append', content: 'Add one checklist item.', reason: 'Reduce missed issues.' }],
        rationale: 'Improve scan consistency',
        confidence: 0.82,
        effectiveness: 0.15,
        status: 'active',
        baseline_metrics: { passRate: 0.6, avgCostUsd: 1.2, issueCount: 12, tasksEvaluated: 10 },
        current_metrics: { passRate: 0.75, avgCostUsd: 1.1, issueCount: 9, tasksEvaluated: 8 },
        tasks_evaluated: 8,
        activated_at: new Date('2026-01-02T00:00:00.000Z'),
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        updated_at: new Date('2026-01-02T00:00:00.000Z'),
      },
    ];

    const issueCategories: RecurringIssueCategory[] = [
      { category: 'null-safety', count: 4 },
      { category: 'type-error', count: 3 },
    ];

    const taskStore: Partial<TaskStore> = {
      getRecentReviewEvents: async (projectPath: string, limit = 20) => {
        assert.equal(projectPath, '/repo');
        assert.equal(limit, 20);
        return reviewEvents;
      },
      listTasks: async (projectPath: string, status) => {
        assert.equal(projectPath, '/repo');
        assert.equal(status, 'done');
        return recentTasks;
      },
      getActivePromptVersions: async (projectPath: string) => {
        assert.equal(projectPath, '/repo');
        return activeVersions;
      },
      getRecurringIssueCategories: async (projectPath: string, limit = 10) => {
        assert.equal(projectPath, '/repo');
        assert.equal(limit, 10);
        return issueCategories;
      },
    };

    const trendAnalyzer: Partial<TrendAnalyzer> = {
      getHealthTrend: async (projectPath: string) => {
        assert.equal(projectPath, '/repo');
        return healthTrend;
      },
    };

    const engine = createEvolutionEngine(taskStore, trendAnalyzer);
    const internals = engine as unknown as EvolutionEngineInternals;
    const result = await internals.collectMetaReflectData('/repo');

    const expectedPassRate = reviewEvents.filter(event => event.passed).length / reviewEvents.length;
    const expectedAvgCost = recentTasks.slice(-20).reduce((sum, task) => sum + task.total_cost_usd, 0) / 20;

    assert.deepEqual(result.reviewEvents, reviewEvents);
    assert.deepEqual(result.recentTasks, recentTasks);
    assert.deepEqual(result.healthTrend, healthTrend);
    assert.deepEqual(result.activeVersions, activeVersions);
    assert.equal(result.passRate, expectedPassRate);
    assert.equal(result.avgCost, expectedAvgCost);
    assert.deepEqual(result.issueCategories, issueCategories);
  });

  test('throws when projectPath is nullish or empty', async () => {
    const engine = createEvolutionEngine({}, {});
    const internals = engine as unknown as EvolutionEngineInternals;

    await assert.rejects(
      internals.collectMetaReflectData(undefined as unknown as string),
      /projectPath is required for meta-reflection/,
    );

    await assert.rejects(
      internals.collectMetaReflectData(null as unknown as string),
      /projectPath is required for meta-reflection/,
    );

    await assert.rejects(
      internals.collectMetaReflectData('   '),
      /projectPath is required for meta-reflection/,
    );
  });
});

describe('EvolutionEngine.buildMetaReflectPrompt', () => {
  test('builds a prompt with metrics, active patches, and recent failures', () => {
    const data: MetaReflectData = {
      reviewEvents: [
        {
          id: 1,
          task_id: 'task-12345678',
          attempt: 1,
          passed: false,
          must_fix_count: 2,
          should_fix_count: 1,
          issue_categories: ['null-safety', 'types'],
          fix_agent: null,
          duration_ms: 50,
          cost_usd: 0.02,
          created_at: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          id: 2,
          task_id: 'task-99999999',
          attempt: 1,
          passed: true,
          must_fix_count: 0,
          should_fix_count: 0,
          issue_categories: [],
          fix_agent: null,
          duration_ms: 40,
          cost_usd: 0.01,
          created_at: new Date('2026-01-01T00:01:00.000Z'),
        },
      ],
      recentTasks: [makeTask(1, 1.11), makeTask(2, 2.22)],
      healthTrend: {
        current: 77,
        previous: 80,
        delta: -3,
        direction: 'degrading',
        dataPoints: 10,
      },
      activeVersions: [
        {
          id: 10,
          project_path: '/repo',
          prompt_name: 'scan',
          version: 3,
          patches: [{ op: 'append', content: 'Validate nulls.', reason: 'Reduce runtime errors.' }],
          rationale: 'Guard null access',
          confidence: 0.74,
          effectiveness: 0.236,
          status: 'active',
          baseline_metrics: null,
          current_metrics: null,
          tasks_evaluated: 5,
          activated_at: new Date('2026-01-02T00:00:00.000Z'),
          created_at: new Date('2026-01-01T00:00:00.000Z'),
          updated_at: new Date('2026-01-02T00:00:00.000Z'),
        },
      ],
      passRate: 0.5,
      avgCost: 0.6789,
      issueCategories: [{ category: 'null-safety', count: 4 }],
    };

    const engine = createEvolutionEngine({}, {});
    const internals = engine as unknown as EvolutionEngineInternals;
    const prompt = internals.buildMetaReflectPrompt(data);

    assert.match(prompt, /Review pass rate: 50\.0%/);
    assert.match(prompt, /Average task cost: \$0\.6789/);
    assert.match(prompt, /Health trend: degrading \(77\/100\)/);
    assert.match(prompt, /Recurring issue categories: null-safety\(4\)/);
    assert.match(prompt, /Total completed tasks: 2/);
    assert.match(prompt, /- scan v3: effectiveness=0\.24, tasks=5/);
    assert.match(prompt, /Task task-123: must_fix=2, should_fix=1, categories=\["null-safety","types"\]/);
  });

  test('throws when data is nullish', () => {
    const engine = createEvolutionEngine({}, {});
    const internals = engine as unknown as EvolutionEngineInternals;

    assert.throws(
      () => internals.buildMetaReflectPrompt(undefined as unknown as MetaReflectData),
      /meta-reflect data is required to build prompt/,
    );

    assert.throws(
      () => internals.buildMetaReflectPrompt(null as unknown as MetaReflectData),
      /meta-reflect data is required to build prompt/,
    );
  });
});
