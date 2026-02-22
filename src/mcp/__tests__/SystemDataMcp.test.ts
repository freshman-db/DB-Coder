import assert from 'node:assert/strict';
import test from 'node:test';

import { createSystemDataMcpServer, type SystemDataMcpDeps } from '../SystemDataMcp.js';
import type { EvaluationScore } from '../../core/types.js';
import type { Memory, RecurringIssueCategory, ReviewEvent, ScanResult, Task, TaskStatus } from '../../memory/types.js';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
};

type RegisteredTool = {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult>;
};

type SystemDataMcpRuntimeServer = ReturnType<typeof createSystemDataMcpServer> & {
  instance: {
    _registeredTools: Record<string, RegisteredTool>;
  };
};

type GetRecentScansFn = SystemDataMcpDeps['taskStore']['getRecentScans'];
type GetRecentReviewEventsFn = SystemDataMcpDeps['taskStore']['getRecentReviewEvents'];
type GetRecurringIssueCategoriesFn = SystemDataMcpDeps['taskStore']['getRecurringIssueCategories'];
type ListTasksFn = SystemDataMcpDeps['taskStore']['listTasks'];
type GetRecentEvaluationEventsFn = SystemDataMcpDeps['taskStore']['getRecentEvaluationEvents'];
type SearchMemoriesFn = SystemDataMcpDeps['globalMemory']['search'];
type EvaluationEvent = Awaited<ReturnType<GetRecentEvaluationEventsFn>>[number];

function createScanRecord(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    id: 1,
    project_path: '/repo',
    commit_hash: 'abc123',
    depth: 'normal',
    result: {
      issues: [],
      opportunities: [],
      projectHealth: 85,
      summary: 'Project looks healthy',
    },
    health_score: 85,
    cost_usd: 0.1,
    created_at: new Date('2026-02-01T00:00:00.000Z'),
    ...overrides,
  };
}

function createReviewEvent(overrides: Partial<ReviewEvent> = {}): ReviewEvent {
  return {
    id: 1,
    task_id: 'task-1',
    attempt: 1,
    passed: true,
    must_fix_count: 0,
    should_fix_count: 0,
    issue_categories: ['quality'],
    fix_agent: null,
    duration_ms: 100,
    cost_usd: 0.02,
    created_at: new Date('2026-02-01T00:00:00.000Z'),
    ...overrides,
  };
}

function createTaskRecord(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    project_path: '/repo',
    task_description: 'Investigate issue',
    phase: 'done',
    priority: 2,
    plan: null,
    subtasks: [],
    review_results: [],
    iteration: 0,
    total_cost_usd: 1.5,
    git_branch: null,
    start_commit: null,
    depends_on: [],
    status: 'done',
    created_at: new Date('2026-02-01T00:00:00.000Z'),
    updated_at: new Date('2026-02-01T00:00:00.000Z'),
    ...overrides,
  };
}

function createEvaluationEvent(overrides: Partial<EvaluationEvent> = {}): EvaluationEvent {
  const baseScore: EvaluationScore = {
    problemLegitimacy: 1,
    solutionProportionality: 1,
    expectedComplexity: 1,
    historicalSuccess: 1,
    total: 4,
  };

  return {
    id: 1,
    task_id: 'task-1',
    passed: true,
    score: baseScore,
    reasoning: 'Solid reasoning',
    cost_usd: 0.04,
    duration_ms: 120,
    created_at: new Date('2026-02-01T00:00:00.000Z'),
    ...overrides,
  };
}

function createMemoryRecord(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 1,
    category: 'experience',
    title: 'Retry API calls',
    content: 'Use retries on transient failures.',
    tags: ['reliability'],
    source_project: '/repo',
    confidence: 0.8,
    created_at: new Date('2026-02-01T00:00:00.000Z'),
    updated_at: new Date('2026-02-01T00:00:00.000Z'),
    ...overrides,
  };
}

function getToolHandler(server: ReturnType<typeof createSystemDataMcpServer>, toolName: string): RegisteredTool['handler'] {
  const runtime = server as SystemDataMcpRuntimeServer;
  const tool = runtime.instance._registeredTools[toolName];
  assert.ok(tool, `tool '${toolName}' should be registered`);
  return tool.handler;
}

function readText(result: ToolResult): string {
  return result.content.map(item => item.text).join('\n');
}

function createServer(overrides: {
  projectPath?: string;
  getRecentScans?: GetRecentScansFn;
  getRecentReviewEvents?: GetRecentReviewEventsFn;
  getRecurringIssueCategories?: GetRecurringIssueCategoriesFn;
  listTasks?: ListTasksFn;
  getRecentEvaluationEvents?: GetRecentEvaluationEventsFn;
  searchMemories?: SearchMemoriesFn;
} = {}): {
  server: ReturnType<typeof createSystemDataMcpServer>;
  calls: {
    getRecentScans: Array<{ projectPath: string; limit: number }>;
    getRecentReviewEvents: Array<{ projectPath: string; limit: number }>;
    getRecurringIssueCategories: Array<{ projectPath: string; limit: number }>;
    listTasks: Array<{ projectPath: string; status: TaskStatus | undefined }>;
    getRecentEvaluationEvents: Array<{ projectPath: string; limit: number }>;
    searchMemories: Array<{ query: string; limit: number }>;
  };
} {
  const calls = {
    getRecentScans: [] as Array<{ projectPath: string; limit: number }>,
    getRecentReviewEvents: [] as Array<{ projectPath: string; limit: number }>,
    getRecurringIssueCategories: [] as Array<{ projectPath: string; limit: number }>,
    listTasks: [] as Array<{ projectPath: string; status: TaskStatus | undefined }>,
    getRecentEvaluationEvents: [] as Array<{ projectPath: string; limit: number }>,
    searchMemories: [] as Array<{ query: string; limit: number }>,
  };

  const getRecentScansImpl: GetRecentScansFn = overrides.getRecentScans
    ?? (async (_projectPath, limit = 10) => [createScanRecord()].slice(0, limit));

  const getRecentReviewEventsImpl: GetRecentReviewEventsFn = overrides.getRecentReviewEvents
    ?? (async (_projectPath, limit = 20) => [createReviewEvent()].slice(0, limit));

  const getRecurringIssueCategoriesImpl: GetRecurringIssueCategoriesFn = overrides.getRecurringIssueCategories
    ?? (async (_projectPath, _limit = 10) => [{ category: 'quality', count: 1 }]);

  const listTasksImpl: ListTasksFn = overrides.listTasks
    ?? (async (_projectPath, status) => [createTaskRecord({ status: status ?? 'done' })]);

  const getRecentEvaluationEventsImpl: GetRecentEvaluationEventsFn = overrides.getRecentEvaluationEvents
    ?? (async (_projectPath, limit = 20) => [createEvaluationEvent()].slice(0, limit));

  const searchMemoriesImpl: SearchMemoriesFn = overrides.searchMemories
    ?? (async (_query, limit = 10) => [createMemoryRecord()].slice(0, limit));

  const taskStore: SystemDataMcpDeps['taskStore'] = {
    async getRecentScans(projectPath: string, limit = 10): Promise<ScanResult[]> {
      calls.getRecentScans.push({ projectPath, limit });
      return getRecentScansImpl(projectPath, limit);
    },
    async getRecentReviewEvents(projectPath: string, limit = 20): Promise<ReviewEvent[]> {
      calls.getRecentReviewEvents.push({ projectPath, limit });
      return getRecentReviewEventsImpl(projectPath, limit);
    },
    async getRecurringIssueCategories(projectPath: string, limit = 10): Promise<RecurringIssueCategory[]> {
      calls.getRecurringIssueCategories.push({ projectPath, limit });
      return getRecurringIssueCategoriesImpl(projectPath, limit);
    },
    async listTasks(projectPath: string, status?: TaskStatus): Promise<Task[]> {
      calls.listTasks.push({ projectPath, status });
      return listTasksImpl(projectPath, status);
    },
    async getRecentEvaluationEvents(projectPath: string, limit = 20): Promise<EvaluationEvent[]> {
      calls.getRecentEvaluationEvents.push({ projectPath, limit });
      return getRecentEvaluationEventsImpl(projectPath, limit);
    },
  } as unknown as SystemDataMcpDeps['taskStore'];

  const globalMemory: SystemDataMcpDeps['globalMemory'] = {
    async search(query: string, limit = 10): Promise<Memory[]> {
      calls.searchMemories.push({ query, limit });
      return searchMemoriesImpl(query, limit);
    },
  } as unknown as SystemDataMcpDeps['globalMemory'];

  return {
    server: createSystemDataMcpServer({
      projectPath: overrides.projectPath ?? '/repo',
      taskStore,
      globalMemory,
    }),
    calls,
  };
}

test('createSystemDataMcpServer registers all expected tools', () => {
  const { server } = createServer();
  assert.equal(server.type, 'sdk');
  assert.equal(server.name, 'db-coder-system-data');

  const runtime = server as SystemDataMcpRuntimeServer;
  const toolNames = Object.keys(runtime.instance._registeredTools).sort();
  assert.deepEqual(toolNames, [
    'get_evaluation_scores',
    'get_health_trend',
    'get_recurring_issues',
    'get_review_history',
    'get_task_outcomes',
    'search_memories',
  ]);
});

test('get_health_trend maps trend rows and respects default/custom limits', async () => {
  const scans = [
    createScanRecord({
      id: 1,
      created_at: new Date('2026-02-03T00:00:00.000Z'),
      health_score: 95,
      result: {
        issues: [{ type: 'bug', severity: 'high', description: 'Issue A' }],
        opportunities: [
          { type: 'improvement', severity: 'low', description: 'Opportunity A' },
          { type: 'improvement', severity: 'low', description: 'Opportunity B' },
        ],
        projectHealth: 95,
        summary: 'Healthy',
      },
    }),
    createScanRecord({
      id: 2,
      created_at: '2026-02-02T12:00:00.000Z' as unknown as Date,
      health_score: 87,
      result: {
        issues: [],
        opportunities: [{ type: 'improvement', severity: 'medium', description: 'Opportunity C' }],
        projectHealth: 87,
        summary: 'Stable',
      },
    }),
    createScanRecord({
      id: 3,
      created_at: new Date('2026-02-01T00:00:00.000Z'),
      health_score: null,
      result: {
        issues: [
          { type: 'quality', severity: 'medium', description: 'Issue B' },
          { type: 'quality', severity: 'low', description: 'Issue C' },
        ],
        opportunities: [],
        projectHealth: 70,
        summary: 'Needs attention',
      },
    }),
  ];

  const { server, calls } = createServer({
    getRecentScans: async (_projectPath, limit = 10) => scans.slice(0, limit),
  });
  const handler = getToolHandler(server, 'get_health_trend');

  const defaultResult = await handler({}, {});
  assert.equal(defaultResult.isError, undefined);
  assert.deepEqual(calls.getRecentScans, [{ projectPath: '/repo', limit: 10 }]);

  const defaultPayload = defaultResult.structuredContent as {
    trend: Array<{ date: string; healthScore: number | null; issueCount: number; opportunityCount: number }>;
  };
  assert.deepEqual(defaultPayload.trend, [
    {
      date: '2026-02-03T00:00:00.000Z',
      healthScore: 95,
      issueCount: 1,
      opportunityCount: 2,
    },
    {
      date: '2026-02-02T12:00:00.000Z',
      healthScore: 87,
      issueCount: 0,
      opportunityCount: 1,
    },
    {
      date: '2026-02-01T00:00:00.000Z',
      healthScore: null,
      issueCount: 2,
      opportunityCount: 0,
    },
  ]);

  const customResult = await handler({ limit: 2 }, {});
  assert.equal(customResult.isError, undefined);
  assert.deepEqual(calls.getRecentScans, [
    { projectPath: '/repo', limit: 10 },
    { projectPath: '/repo', limit: 2 },
  ]);

  const customPayload = customResult.structuredContent as {
    trend: Array<{ date: string }>;
  };
  assert.equal(customPayload.trend.length, 2);
});

test('get_health_trend handles empty scan results', async () => {
  const { server } = createServer({
    getRecentScans: async () => [],
  });
  const handler = getToolHandler(server, 'get_health_trend');

  const result = await handler({}, {});
  assert.equal(result.isError, undefined);
  assert.match(readText(result), /Found 0 scan\(s\)\./);

  const payload = result.structuredContent as { trend: unknown[] };
  assert.deepEqual(payload.trend, []);
});

test('get_review_history calculates pass rate and fetches recurring issue categories', async () => {
  const events = Array.from({ length: 10 }, (_, index) => createReviewEvent({
    id: index + 1,
    passed: index < 7,
  }));
  const categories: RecurringIssueCategory[] = [
    { category: 'test', count: 4 },
    { category: 'typing', count: 2 },
  ];

  const { server, calls } = createServer({
    getRecentReviewEvents: async (_projectPath, limit = 20) => events.slice(0, limit),
    getRecurringIssueCategories: async () => categories,
  });
  const handler = getToolHandler(server, 'get_review_history');

  const result = await handler({ limit: 10 }, {});
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.getRecentReviewEvents, [{ projectPath: '/repo', limit: 10 }]);
  assert.deepEqual(calls.getRecurringIssueCategories, [{ projectPath: '/repo', limit: 10 }]);

  const payload = result.structuredContent as {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
    topIssueCategories: RecurringIssueCategory[];
  };
  assert.equal(payload.total, 10);
  assert.equal(payload.passed, 7);
  assert.equal(payload.failed, 3);
  assert.equal(payload.passRate, 0.7);
  assert.deepEqual(payload.topIssueCategories, categories);
});

test('get_task_outcomes aggregates counts, sorts by recency, truncates descriptions, and respects limit', async () => {
  const longDescription = 'x'.repeat(150);

  const doneTask = createTaskRecord({
    id: 'done-task',
    status: 'done',
    task_description: 'Done task',
    updated_at: new Date('2026-02-01T00:00:00.000Z'),
  });
  const failedTask = createTaskRecord({
    id: 'failed-task',
    status: 'failed',
    task_description: longDescription,
    updated_at: '2026-02-04T00:00:00.000Z' as unknown as Date,
  });
  const blockedTask = createTaskRecord({
    id: 'blocked-task',
    status: 'blocked',
    task_description: 'Blocked task',
    updated_at: new Date('2026-02-03T00:00:00.000Z'),
  });
  const skippedTask = createTaskRecord({
    id: 'skipped-task',
    status: 'skipped',
    task_description: 'Skipped task',
    updated_at: new Date('2026-02-02T00:00:00.000Z'),
  });

  const { server, calls } = createServer({
    listTasks: async (_projectPath, status) => {
      switch (status) {
        case 'done':
          return [doneTask];
        case 'failed':
          return [failedTask];
        case 'blocked':
          return [blockedTask];
        case 'skipped':
          return [skippedTask];
        default:
          return [];
      }
    },
  });
  const handler = getToolHandler(server, 'get_task_outcomes');

  const result = await handler({ limit: 3 }, {});
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.listTasks, [
    { projectPath: '/repo', status: 'done' },
    { projectPath: '/repo', status: 'failed' },
    { projectPath: '/repo', status: 'blocked' },
    { projectPath: '/repo', status: 'skipped' },
  ]);

  const payload = result.structuredContent as {
    counts: Record<'done' | 'failed' | 'blocked' | 'skipped', number>;
    recentTasks: Array<{ description: string; status: TaskStatus; priority: number; costUsd: number }>;
  };

  assert.deepEqual(payload.counts, { done: 1, failed: 1, blocked: 1, skipped: 1 });
  assert.equal(payload.recentTasks.length, 3);
  assert.deepEqual(payload.recentTasks.map(task => task.status), ['failed', 'blocked', 'skipped']);
  assert.equal(payload.recentTasks[0]?.description.length, 120);
  assert.ok(payload.recentTasks.every(task => task.description.length <= 120));
});

test('get_evaluation_scores truncates reasoning and formats date values', async () => {
  const longReasoning = 'r'.repeat(260);
  const score: EvaluationScore = {
    problemLegitimacy: 2,
    solutionProportionality: 1,
    expectedComplexity: 0,
    historicalSuccess: 1,
    total: 4,
  };

  const events: EvaluationEvent[] = [
    createEvaluationEvent({
      id: 1,
      passed: true,
      score,
      reasoning: longReasoning,
      created_at: new Date('2026-02-08T00:00:00.000Z'),
    }),
    createEvaluationEvent({
      id: 2,
      passed: false,
      score: { ...score, total: -1 },
      reasoning: 'Needs more validation',
      created_at: '2026-02-07T12:30:00.000Z' as unknown as Date,
    }),
  ];

  const { server, calls } = createServer({
    getRecentEvaluationEvents: async (_projectPath, limit = 20) => events.slice(0, limit),
  });
  const handler = getToolHandler(server, 'get_evaluation_scores');

  const result = await handler({ limit: 2 }, {});
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.getRecentEvaluationEvents, [{ projectPath: '/repo', limit: 2 }]);

  const payload = result.structuredContent as {
    events: Array<{ passed: boolean; score: EvaluationScore; reasoning: string; date: string }>;
  };
  assert.equal(payload.events.length, 2);
  assert.equal(payload.events[0]?.reasoning.length, 200);
  assert.equal(payload.events[0]?.date, '2026-02-08T00:00:00.000Z');
  assert.equal(payload.events[1]?.date, '2026-02-07T12:30:00.000Z');
});

test('get_recurring_issues delegates to TaskStore and respects custom limit', async () => {
  const categories: RecurringIssueCategory[] = [
    { category: 'quality', count: 5 },
    { category: 'tests', count: 2 },
  ];

  const { server, calls } = createServer({
    getRecurringIssueCategories: async () => categories,
  });
  const handler = getToolHandler(server, 'get_recurring_issues');

  const result = await handler({ limit: 5 }, {});
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.getRecurringIssueCategories, [{ projectPath: '/repo', limit: 5 }]);

  const payload = result.structuredContent as { categories: RecurringIssueCategory[] };
  assert.deepEqual(payload.categories, categories);
});

test('search_memories maps fields and truncates content to 300 chars', async () => {
  const longContent = 'memory '.repeat(80);

  const { server, calls } = createServer({
    searchMemories: async () => [createMemoryRecord({
      title: 'Resilient retry pattern',
      category: 'framework',
      content: longContent,
      confidence: 0.92,
      tags: ['retry', 'network'],
    })],
  });
  const handler = getToolHandler(server, 'search_memories');

  const result = await handler({ query: 'retry' }, {});
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.searchMemories, [{ query: 'retry', limit: 10 }]);

  const payload = result.structuredContent as {
    memories: Array<{
      title: string;
      category: Memory['category'];
      content: string;
      confidence: number;
      tags: string[];
    }>;
  };

  assert.equal(payload.memories.length, 1);
  assert.deepEqual(payload.memories[0], {
    title: 'Resilient retry pattern',
    category: 'framework',
    content: longContent.slice(0, 300),
    confidence: 0.92,
    tags: ['retry', 'network'],
  });
});

test('all SystemData MCP tools return tool errors when dependencies throw', async () => {
  const cases: Array<{
    toolName: string;
    args: Record<string, unknown>;
    overrides: Parameters<typeof createServer>[0];
    expectedError: RegExp;
  }> = [
    {
      toolName: 'get_health_trend',
      args: {},
      overrides: {
        getRecentScans: async () => {
          throw new Error('scan backend offline');
        },
      },
      expectedError: /get_health_trend failed: scan backend offline/,
    },
    {
      toolName: 'get_review_history',
      args: {},
      overrides: {
        getRecentReviewEvents: async () => {
          throw new Error('review event fetch failed');
        },
      },
      expectedError: /get_review_history failed: review event fetch failed/,
    },
    {
      toolName: 'get_task_outcomes',
      args: {},
      overrides: {
        listTasks: async () => {
          throw new Error('task listing failed');
        },
      },
      expectedError: /get_task_outcomes failed: task listing failed/,
    },
    {
      toolName: 'get_evaluation_scores',
      args: {},
      overrides: {
        getRecentEvaluationEvents: async () => {
          throw new Error('evaluation history unavailable');
        },
      },
      expectedError: /get_evaluation_scores failed: evaluation history unavailable/,
    },
    {
      toolName: 'get_recurring_issues',
      args: {},
      overrides: {
        getRecurringIssueCategories: async () => {
          throw new Error('category aggregation unavailable');
        },
      },
      expectedError: /get_recurring_issues failed: category aggregation unavailable/,
    },
    {
      toolName: 'search_memories',
      args: { query: 'retry' },
      overrides: {
        searchMemories: async () => {
          throw new Error('memory index unavailable');
        },
      },
      expectedError: /search_memories failed: memory index unavailable/,
    },
  ];

  for (const testCase of cases) {
    const { server } = createServer(testCase.overrides);
    const handler = getToolHandler(server, testCase.toolName);

    const result = await handler(testCase.args, {});
    assert.equal(result.isError, true, `${testCase.toolName} should return isError=true`);
    assert.match(readText(result), testCase.expectedError);
  }
});
