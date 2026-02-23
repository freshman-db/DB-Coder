import assert from 'node:assert/strict';
import test from 'node:test';

import { createSystemDataMcpServer, type SystemDataMcpDeps } from '../SystemDataMcp.js';
import type { EvaluationScore } from '../../core/types.js';
import type { Memory, RecurringIssueCategory, ReviewEvent, ScanResult, Task, TaskLog, TaskStatus } from '../../memory/types.js';
import type { Adjustment, GoalProgress, PromptVersion } from '../../evolution/types.js';

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
type GetTaskFn = SystemDataMcpDeps['taskStore']['getTask'];
type GetTaskLogsFn = SystemDataMcpDeps['taskStore']['getTaskLogs'];
type GetReviewEventsFn = SystemDataMcpDeps['taskStore']['getReviewEvents'];
type GetActiveAdjustmentsFn = SystemDataMcpDeps['taskStore']['getActiveAdjustments'];
type GetActivePromptVersionsFn = SystemDataMcpDeps['taskStore']['getActivePromptVersions'];
type GetPromptVersionHistoryFn = SystemDataMcpDeps['taskStore']['getPromptVersionHistory'];
type GetRecentCostsFn = SystemDataMcpDeps['taskStore']['getRecentCosts'];
type GetLatestGoalProgressFn = SystemDataMcpDeps['taskStore']['getLatestGoalProgress'];
type GetGoalProgressHistoryFn = SystemDataMcpDeps['taskStore']['getGoalProgressHistory'];
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

function createTaskLogRecord(overrides: Partial<TaskLog> = {}): TaskLog {
  return {
    id: 1,
    task_id: 'task-1',
    phase: 'execute',
    agent: 'claude',
    input_summary: 'Fix the bug',
    output_summary: 'Bug fixed',
    cost_usd: 0.5,
    duration_ms: 3000,
    created_at: new Date('2026-02-01T00:00:00.000Z'),
    ...overrides,
  };
}

function createAdjustmentRecord(overrides: Partial<Adjustment> = {}): Adjustment {
  return {
    id: 1,
    project_path: '/repo',
    task_id: null,
    text: 'Always validate inputs',
    category: 'standard',
    effectiveness: 0.5,
    status: 'active',
    created_at: new Date('2026-02-01T00:00:00.000Z'),
    updated_at: new Date('2026-02-01T00:00:00.000Z'),
    ...overrides,
  };
}

function createPromptVersionRecord(overrides: Partial<PromptVersion> = {}): PromptVersion {
  return {
    id: 1,
    project_path: '/repo',
    prompt_name: 'scan',
    version: 1,
    patches: [{ op: 'append', content: 'Check nulls.', reason: 'Safety.' }],
    rationale: 'Improve safety',
    confidence: 0.8,
    effectiveness: 0.1,
    status: 'active',
    baseline_metrics: null,
    current_metrics: null,
    tasks_evaluated: 5,
    activated_at: new Date('2026-02-01T00:00:00.000Z'),
    created_at: new Date('2026-01-15T00:00:00.000Z'),
    updated_at: new Date('2026-02-01T00:00:00.000Z'),
    ...overrides,
  };
}

function createGoalProgressRecord(overrides: Partial<GoalProgress> = {}): GoalProgress {
  return {
    id: 1,
    project_path: '/repo',
    goal_index: 0,
    progress_pct: 45,
    evidence: '3 related tasks done',
    scan_id: 1,
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
  getTask?: GetTaskFn;
  getTaskLogs?: GetTaskLogsFn;
  getReviewEvents?: GetReviewEventsFn;
  getActiveAdjustments?: GetActiveAdjustmentsFn;
  getActivePromptVersions?: GetActivePromptVersionsFn;
  getPromptVersionHistory?: GetPromptVersionHistoryFn;
  getRecentCosts?: GetRecentCostsFn;
  getLatestGoalProgress?: GetLatestGoalProgressFn;
  getGoalProgressHistory?: GetGoalProgressHistoryFn;
} = {}): {
  server: ReturnType<typeof createSystemDataMcpServer>;
  calls: Record<string, unknown[]>;
} {
  const calls: Record<string, unknown[]> = {};
  function track(name: string, args: unknown) {
    if (!calls[name]) calls[name] = [];
    calls[name].push(args);
  }

  const taskStore: SystemDataMcpDeps['taskStore'] = {
    async getRecentScans(projectPath: string, limit = 10) {
      track('getRecentScans', { projectPath, limit });
      return (overrides.getRecentScans ?? (async (_p, l = 10) => [createScanRecord()].slice(0, l)))(projectPath, limit);
    },
    async getRecentReviewEvents(projectPath: string, limit = 20) {
      track('getRecentReviewEvents', { projectPath, limit });
      return (overrides.getRecentReviewEvents ?? (async (_p, l = 20) => [createReviewEvent()].slice(0, l)))(projectPath, limit);
    },
    async getRecurringIssueCategories(projectPath: string, limit = 10) {
      track('getRecurringIssueCategories', { projectPath, limit });
      return (overrides.getRecurringIssueCategories ?? (async () => [{ category: 'quality', count: 1 }]))(projectPath, limit);
    },
    async listTasks(projectPath: string, status?: TaskStatus) {
      track('listTasks', { projectPath, status });
      return (overrides.listTasks ?? (async (_p, s) => [createTaskRecord({ status: s ?? 'done' })]))(projectPath, status);
    },
    async getRecentEvaluationEvents(projectPath: string, limit = 20) {
      track('getRecentEvaluationEvents', { projectPath, limit });
      return (overrides.getRecentEvaluationEvents ?? (async (_p, l = 20) => [createEvaluationEvent()].slice(0, l)))(projectPath, limit);
    },
    async getTask(id: string) {
      track('getTask', { id });
      return (overrides.getTask ?? (async () => createTaskRecord()))(id);
    },
    async getTaskLogs(taskId: string) {
      track('getTaskLogs', { taskId });
      return (overrides.getTaskLogs ?? (async () => [createTaskLogRecord()]))(taskId);
    },
    async getReviewEvents(taskId: string) {
      track('getReviewEvents', { taskId });
      return (overrides.getReviewEvents ?? (async () => [createReviewEvent()]))(taskId);
    },
    async getActiveAdjustments(projectPath: string, limit = 20) {
      track('getActiveAdjustments', { projectPath, limit });
      return (overrides.getActiveAdjustments ?? (async () => [createAdjustmentRecord()]))(projectPath, limit);
    },
    async getActivePromptVersions(projectPath: string) {
      track('getActivePromptVersions', { projectPath });
      return (overrides.getActivePromptVersions ?? (async () => [createPromptVersionRecord()]))(projectPath);
    },
    async getPromptVersionHistory(projectPath: string, promptName: string, limit = 20) {
      track('getPromptVersionHistory', { projectPath, promptName, limit });
      return (overrides.getPromptVersionHistory ?? (async () => [createPromptVersionRecord()]))(projectPath, promptName as any, limit);
    },
    async getRecentCosts(days = 7) {
      track('getRecentCosts', { days });
      return (overrides.getRecentCosts ?? (async () => [{ date: '2026-02-01', total_cost_usd: 1.5, task_count: 3 }]))(days);
    },
    async getLatestGoalProgress(projectPath: string) {
      track('getLatestGoalProgress', { projectPath });
      return (overrides.getLatestGoalProgress ?? (async () => [createGoalProgressRecord()]))(projectPath);
    },
    async getGoalProgressHistory(projectPath: string, goalIndex: number, limit = 10) {
      track('getGoalProgressHistory', { projectPath, goalIndex, limit });
      return (overrides.getGoalProgressHistory ?? (async () => [createGoalProgressRecord()]))(projectPath, goalIndex, limit);
    },
  } as unknown as SystemDataMcpDeps['taskStore'];

  const globalMemory: SystemDataMcpDeps['globalMemory'] = {
    async search(query: string, limit = 10): Promise<Memory[]> {
      track('searchMemories', { query, limit });
      return (overrides.searchMemories ?? (async (_q, l = 10) => [createMemoryRecord()].slice(0, l)))(query, limit);
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
  assert.ok(server.instance);

  const runtime = server as SystemDataMcpRuntimeServer;
  const toolNames = Object.keys(runtime.instance._registeredTools).sort();
  assert.deepEqual(toolNames, [
    'get_adjustment_summary',
    'get_cost_trend',
    'get_evaluation_scores',
    'get_goal_progress',
    'get_health_trend',
    'get_prompt_versions',
    'get_recent_tasks',
    'get_recurring_issues',
    'get_review_details',
    'get_review_history',
    'get_task_detail',
    'get_task_logs',
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
      toolName: 'get_review_history',
      args: {},
      overrides: {
        getRecurringIssueCategories: async () => {
          throw new Error('issue category fetch failed');
        },
      },
      expectedError: /get_review_history failed: issue category fetch failed/,
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
    {
      toolName: 'get_task_detail',
      args: { task_id: 'task-1' },
      overrides: {
        getTask: async () => {
          throw new Error('task lookup failed');
        },
      },
      expectedError: /get_task_detail failed: task lookup failed/,
    },
    {
      toolName: 'get_recent_tasks',
      args: {},
      overrides: {
        listTasks: async () => {
          throw new Error('task list failed');
        },
      },
      expectedError: /get_recent_tasks failed: task list failed/,
    },
    {
      toolName: 'get_task_logs',
      args: { task_id: 'task-1' },
      overrides: {
        getTaskLogs: async () => {
          throw new Error('logs unavailable');
        },
      },
      expectedError: /get_task_logs failed: logs unavailable/,
    },
    {
      toolName: 'get_review_details',
      args: { task_id: 'task-1' },
      overrides: {
        getReviewEvents: async () => {
          throw new Error('review fetch failed');
        },
      },
      expectedError: /get_review_details failed: review fetch failed/,
    },
    {
      toolName: 'get_adjustment_summary',
      args: {},
      overrides: {
        getActiveAdjustments: async () => {
          throw new Error('adjustments unavailable');
        },
      },
      expectedError: /get_adjustment_summary failed: adjustments unavailable/,
    },
    {
      toolName: 'get_prompt_versions',
      args: {},
      overrides: {
        getActivePromptVersions: async () => {
          throw new Error('versions unavailable');
        },
      },
      expectedError: /get_prompt_versions failed: versions unavailable/,
    },
    {
      toolName: 'get_cost_trend',
      args: {},
      overrides: {
        getRecentCosts: async () => {
          throw new Error('costs unavailable');
        },
      },
      expectedError: /get_cost_trend failed: costs unavailable/,
    },
    {
      toolName: 'get_goal_progress',
      args: {},
      overrides: {
        getLatestGoalProgress: async () => {
          throw new Error('goals unavailable');
        },
      },
      expectedError: /get_goal_progress failed: goals unavailable/,
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

// --- New tool tests ---

test('get_task_detail returns full task with logs and reviews', async () => {
  const task = createTaskRecord({
    id: 'task-abc',
    task_description: 'Fix auth bug',
    plan: { steps: ['step1'] },
    subtasks: [{ id: 'sub-1', description: 'Subtask 1', status: 'done', executor: 'claude' }],
  });
  const logs = [createTaskLogRecord({ task_id: 'task-abc', phase: 'execute' })];
  const reviews = [createReviewEvent({ task_id: 'task-abc', passed: false, must_fix_count: 1 })];

  const { server } = createServer({
    getTask: async (id) => id === 'task-abc' ? task : null,
    getTaskLogs: async () => logs,
    getReviewEvents: async () => reviews,
  });
  const handler = getToolHandler(server, 'get_task_detail');

  const result = await handler({ task_id: 'task-abc' }, {});
  assert.equal(result.isError, undefined);
  const payload = result.structuredContent as Record<string, unknown>;
  assert.equal(payload.id, 'task-abc');
  assert.equal(payload.description, 'Fix auth bug');
  assert.deepEqual(payload.plan, { steps: ['step1'] });
  assert.equal((payload.logs as unknown[]).length, 1);
  assert.equal((payload.reviews as unknown[]).length, 1);
});

test('get_task_detail returns null for non-existent task', async () => {
  const { server } = createServer({
    getTask: async () => null,
    getTaskLogs: async () => [],
    getReviewEvents: async () => [],
  });
  const handler = getToolHandler(server, 'get_task_detail');

  const result = await handler({ task_id: 'missing' }, {});
  assert.equal(result.isError, undefined);
  assert.match(readText(result), /not found/);
  assert.equal(result.structuredContent, null);
});

test('get_recent_tasks returns tasks with full descriptions and respects status filter', async () => {
  const tasks = [
    createTaskRecord({ id: 'task-1', task_description: 'First task', status: 'done' }),
    createTaskRecord({ id: 'task-2', task_description: 'Second task', status: 'done' }),
  ];

  const { server, calls } = createServer({
    listTasks: async (_p, status) => status === 'done' ? tasks : [],
  });
  const handler = getToolHandler(server, 'get_recent_tasks');

  const result = await handler({ status: 'done', limit: 1 }, {});
  assert.equal(result.isError, undefined);
  const payload = result.structuredContent as { tasks: Array<{ id: string; description: string }> };
  assert.equal(payload.tasks.length, 1);
  assert.equal(payload.tasks[0].id, 'task-1');
  assert.deepEqual(calls.listTasks, [{ projectPath: '/repo', status: 'done' }]);
});

test('get_task_logs returns mapped log entries', async () => {
  const logs = [
    createTaskLogRecord({ phase: 'plan', agent: 'claude', cost_usd: 0.1 }),
    createTaskLogRecord({ id: 2, phase: 'execute', agent: 'codex', cost_usd: 0.8 }),
  ];

  const { server } = createServer({ getTaskLogs: async () => logs });
  const handler = getToolHandler(server, 'get_task_logs');

  const result = await handler({ task_id: 'task-1' }, {});
  assert.equal(result.isError, undefined);
  const payload = result.structuredContent as { logs: Array<{ phase: string; agent: string; costUsd: number | null }> };
  assert.equal(payload.logs.length, 2);
  assert.equal(payload.logs[0].phase, 'plan');
  assert.equal(payload.logs[1].costUsd, 0.8);
});

test('get_review_details returns all review rounds for a task', async () => {
  const reviews = [
    createReviewEvent({ attempt: 1, passed: false, must_fix_count: 2 }),
    createReviewEvent({ id: 2, attempt: 2, passed: true, must_fix_count: 0 }),
  ];

  const { server, calls } = createServer({ getReviewEvents: async () => reviews });
  const handler = getToolHandler(server, 'get_review_details');

  const result = await handler({ task_id: 'task-1' }, {});
  assert.equal(result.isError, undefined);
  const payload = result.structuredContent as { reviews: Array<{ attempt: number; passed: boolean }> };
  assert.equal(payload.reviews.length, 2);
  assert.equal(payload.reviews[0].passed, false);
  assert.equal(payload.reviews[1].passed, true);
  assert.deepEqual(calls.getReviewEvents, [{ taskId: 'task-1' }]);
});

test('get_adjustment_summary returns active adjustments', async () => {
  const adjustments = [
    createAdjustmentRecord({ text: 'Always validate', effectiveness: 0.7, category: 'standard' }),
    createAdjustmentRecord({ id: 2, text: 'Avoid global state', effectiveness: 0.3, category: 'avoidance' }),
  ];

  const { server } = createServer({ getActiveAdjustments: async () => adjustments });
  const handler = getToolHandler(server, 'get_adjustment_summary');

  const result = await handler({ limit: 5 }, {});
  assert.equal(result.isError, undefined);
  const payload = result.structuredContent as { adjustments: Array<{ text: string; effectiveness: number }> };
  assert.equal(payload.adjustments.length, 2);
  assert.equal(payload.adjustments[0].effectiveness, 0.7);
});

test('get_prompt_versions returns active versions when no prompt_name given', async () => {
  const versions = [createPromptVersionRecord({ prompt_name: 'scan', version: 2, effectiveness: 0.15 })];

  const { server, calls } = createServer({ getActivePromptVersions: async () => versions });
  const handler = getToolHandler(server, 'get_prompt_versions');

  const result = await handler({}, {});
  assert.equal(result.isError, undefined);
  const payload = result.structuredContent as { versions: Array<{ promptName: string }> };
  assert.equal(payload.versions.length, 1);
  assert.equal(payload.versions[0].promptName, 'scan');
  assert.deepEqual(calls.getActivePromptVersions, [{ projectPath: '/repo' }]);
});

test('get_prompt_versions returns history when prompt_name given', async () => {
  const history = [
    createPromptVersionRecord({ version: 2, status: 'active' }),
    createPromptVersionRecord({ id: 2, version: 1, status: 'superseded' }),
  ];

  const { server, calls } = createServer({ getPromptVersionHistory: async () => history });
  const handler = getToolHandler(server, 'get_prompt_versions');

  const result = await handler({ prompt_name: 'scan' }, {});
  assert.equal(result.isError, undefined);
  const payload = result.structuredContent as { versions: Array<{ version: number; status: string }> };
  assert.equal(payload.versions.length, 2);
  assert.equal(payload.versions[0].status, 'active');
  assert.deepEqual(calls.getPromptVersionHistory, [{ projectPath: '/repo', promptName: 'scan', limit: 20 }]);
});

test('get_cost_trend returns daily costs', async () => {
  const costs = [
    { date: '2026-02-03', total_cost_usd: 2.5, task_count: 5 },
    { date: '2026-02-02', total_cost_usd: 1.8, task_count: 3 },
  ];

  const { server, calls } = createServer({ getRecentCosts: async () => costs });
  const handler = getToolHandler(server, 'get_cost_trend');

  const result = await handler({ days: 3 }, {});
  assert.equal(result.isError, undefined);
  const payload = result.structuredContent as { costs: typeof costs };
  assert.equal(payload.costs.length, 2);
  assert.deepEqual(calls.getRecentCosts, [{ days: 3 }]);
});

test('get_goal_progress returns latest progress for all goals', async () => {
  const progress = [
    createGoalProgressRecord({ goal_index: 0, progress_pct: 45 }),
    createGoalProgressRecord({ id: 2, goal_index: 1, progress_pct: 80 }),
  ];

  const { server, calls } = createServer({ getLatestGoalProgress: async () => progress });
  const handler = getToolHandler(server, 'get_goal_progress');

  const result = await handler({}, {});
  assert.equal(result.isError, undefined);
  const payload = result.structuredContent as { goals: Array<{ goalIndex: number; progressPct: number }> };
  assert.equal(payload.goals.length, 2);
  assert.equal(payload.goals[1].progressPct, 80);
  assert.deepEqual(calls.getLatestGoalProgress, [{ projectPath: '/repo' }]);
});

test('get_goal_progress returns history for a specific goal', async () => {
  const history = [
    createGoalProgressRecord({ progress_pct: 60 }),
    createGoalProgressRecord({ id: 2, progress_pct: 45 }),
  ];

  const { server, calls } = createServer({ getGoalProgressHistory: async () => history });
  const handler = getToolHandler(server, 'get_goal_progress');

  const result = await handler({ goal_index: 0 }, {});
  assert.equal(result.isError, undefined);
  const payload = result.structuredContent as { history: Array<{ progressPct: number }> };
  assert.equal(payload.history.length, 2);
  assert.deepEqual(calls.getGoalProgressHistory, [{ projectPath: '/repo', goalIndex: 0, limit: 10 }]);
});
