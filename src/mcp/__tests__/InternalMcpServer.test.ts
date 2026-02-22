import assert from 'node:assert/strict';
import test from 'node:test';

import { createInternalMcpServer, type InternalMcpDeps } from '../InternalMcpServer.js';
import type { Memory, Task, TaskStatus } from '../../memory/types.js';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
};

type RegisteredTool = {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult>;
};

type InternalMcpRuntimeServer = ReturnType<typeof createInternalMcpServer> & {
  instance: {
    _registeredTools: Record<string, RegisteredTool>;
  };
};

type CreateTaskFn = InternalMcpDeps['taskStore']['createTask'];
type ListTasksFn = InternalMcpDeps['taskStore']['listTasks'];
type SearchMemoryFn = InternalMcpDeps['globalMemory']['search'];

function createTaskRecord(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    project_path: '/repo',
    task_description: 'Investigate issue',
    phase: 'planning',
    priority: 2,
    plan: null,
    subtasks: [],
    review_results: [],
    iteration: 0,
    total_cost_usd: 0,
    git_branch: null,
    start_commit: null,
    depends_on: [],
    status: 'queued',
    created_at: new Date('2026-02-01T00:00:00.000Z'),
    updated_at: new Date('2026-02-01T00:00:00.000Z'),
    ...overrides,
  };
}

function createMemoryRecord(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 1,
    category: 'experience',
    title: 'Use retries for flaky APIs',
    content: 'Retry transient errors up to 3 times.',
    tags: ['reliability'],
    source_project: '/repo',
    confidence: 0.8,
    created_at: new Date('2026-01-15T00:00:00.000Z'),
    updated_at: new Date('2026-01-15T00:00:00.000Z'),
    ...overrides,
  };
}

function getToolHandler(server: ReturnType<typeof createInternalMcpServer>, toolName: string): RegisteredTool['handler'] {
  const runtime = server as InternalMcpRuntimeServer;
  const tool = runtime.instance._registeredTools[toolName];
  assert.ok(tool, `tool '${toolName}' should be registered`);
  return tool.handler;
}

function readText(result: ToolResult): string {
  return result.content.map(item => item.text).join('\n');
}

function createServer(overrides: {
  projectPath?: string;
  createTask?: CreateTaskFn;
  listTasks?: ListTasksFn;
  searchMemory?: SearchMemoryFn;
} = {}): {
  server: ReturnType<typeof createInternalMcpServer>;
  calls: {
    createTask: Array<{ projectPath: string; description: string; priority: number | undefined }>;
    listTasks: Array<{ projectPath: string; status: TaskStatus | undefined }>;
    searchMemory: Array<{ query: string; limit: number | undefined }>;
  };
} {
  const calls = {
    createTask: [] as Array<{ projectPath: string; description: string; priority: number | undefined }>,
    listTasks: [] as Array<{ projectPath: string; status: TaskStatus | undefined }>,
    searchMemory: [] as Array<{ query: string; limit: number | undefined }>,
  };

  const createTaskImpl: CreateTaskFn = overrides.createTask
    ?? (async (projectPath, description, priority = 2) => createTaskRecord({
      id: 'task-created',
      project_path: projectPath,
      task_description: description,
      priority,
    }));

  const listTasksImpl: ListTasksFn = overrides.listTasks
    ?? (async (_projectPath, status) => [createTaskRecord({ status: status ?? 'queued' })]);

  const searchMemoryImpl: SearchMemoryFn = overrides.searchMemory
    ?? (async (query, _limit = 10) => [createMemoryRecord({ title: `Match for ${query}` })]);

  const deps: InternalMcpDeps = {
    projectPath: overrides.projectPath ?? '/repo',
    taskStore: {
      async createTask(projectPath: string, description: string, priority = 2): Promise<Task> {
        calls.createTask.push({ projectPath, description, priority });
        return createTaskImpl(projectPath, description, priority);
      },
      async listTasks(projectPath: string, status?: TaskStatus): Promise<Task[]> {
        calls.listTasks.push({ projectPath, status });
        return listTasksImpl(projectPath, status);
      },
    },
    globalMemory: {
      async search(query: string, limit = 10): Promise<Memory[]> {
        calls.searchMemory.push({ query, limit });
        return searchMemoryImpl(query, limit);
      },
    },
  };

  return {
    server: createInternalMcpServer(deps),
    calls,
  };
}

test('createInternalMcpServer registers all expected tools', () => {
  const { server } = createServer();
  assert.equal(server.type, 'sdk');
  assert.equal(server.name, 'db-coder-internal');
  assert.ok(server.instance);

  const runtime = server as InternalMcpRuntimeServer;
  const toolNames = Object.keys(runtime.instance._registeredTools).sort();
  assert.deepEqual(toolNames, ['add_task', 'get_status', 'list_tasks', 'search_memory']);
});

test('add_task creates a task with trimmed description and boundary priority', async () => {
  const { server, calls } = createServer();
  const handler = getToolHandler(server, 'add_task');

  const result = await handler({ description: '  Fix flaky tests  ', priority: 0 }, {});
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.createTask, [{ projectPath: '/repo', description: 'Fix flaky tests', priority: 0 }]);

  const payload = result.structuredContent as { task: { description: string; priority: number } };
  assert.equal(payload.task.description, 'Fix flaky tests');
  assert.equal(payload.task.priority, 0);
});

test('add_task uses default priority and returns tool error for empty description', async () => {
  const { server, calls } = createServer();
  const handler = getToolHandler(server, 'add_task');

  const created = await handler({ description: '  Add docs  ' }, {});
  assert.equal(created.isError, undefined);
  assert.deepEqual(calls.createTask, [{ projectPath: '/repo', description: 'Add docs', priority: 2 }]);

  const emptyDescription = await handler({ description: '   ' }, {});
  assert.equal(emptyDescription.isError, true);
  assert.match(readText(emptyDescription), /add_task failed: description cannot be empty/);
});

test('add_task returns tool error when task creation fails', async () => {
  const { server } = createServer({
    createTask: async () => {
      throw new Error('database unavailable');
    },
  });
  const handler = getToolHandler(server, 'add_task');

  const result = await handler({ description: 'New task', priority: 2 }, {});
  assert.equal(result.isError, true);
  assert.match(readText(result), /add_task failed: database unavailable/);
});

test('list_tasks forwards optional status filter and maps response payload', async () => {
  const { server, calls } = createServer({
    listTasks: async (_projectPath, status) => [
      createTaskRecord({ id: 'task-filtered', status: status ?? 'queued' }),
    ],
  });
  const handler = getToolHandler(server, 'list_tasks');

  const result = await handler({ status: 'active' }, {});
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.listTasks, [{ projectPath: '/repo', status: 'active' }]);

  const payload = result.structuredContent as {
    count: number;
    status: string | null;
    tasks: Array<{ id: string; status: string; createdAt: string | null; updatedAt: string | null }>;
  };
  assert.equal(payload.count, 1);
  assert.equal(payload.status, 'active');
  assert.equal(payload.tasks[0]?.id, 'task-filtered');
  assert.equal(payload.tasks[0]?.status, 'active');
  assert.equal(payload.tasks[0]?.createdAt, '2026-02-01T00:00:00.000Z');
  assert.equal(payload.tasks[0]?.updatedAt, '2026-02-01T00:00:00.000Z');
});

test('list_tasks returns tool error when TaskStore throws', async () => {
  const { server } = createServer({
    listTasks: async () => {
      throw new Error('cannot list tasks');
    },
  });
  const handler = getToolHandler(server, 'list_tasks');

  const result = await handler({}, {});
  assert.equal(result.isError, true);
  assert.match(readText(result), /list_tasks failed: cannot list tasks/);
});

test('search_memory returns results and normalizes whitespace in query', async () => {
  const { server, calls } = createServer();
  const handler = getToolHandler(server, 'search_memory');

  const result = await handler({ query: '  retry strategy  ' }, {});
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.searchMemory, [{ query: 'retry strategy', limit: 10 }]);

  const payload = result.structuredContent as { query: string; count: number };
  assert.equal(payload.query, 'retry strategy');
  assert.equal(payload.count, 1);
});

test('search_memory maps memory payload fields and handles backend errors', async () => {
  const { server } = createServer({
    searchMemory: async (query, _limit) => [
      createMemoryRecord({
        id: 99,
        title: `Result for ${query}`,
        source_project: null,
        created_at: new Date('2026-01-16T01:02:03.000Z'),
        updated_at: new Date('2026-01-17T04:05:06.000Z'),
      }),
    ],
  });
  const handler = getToolHandler(server, 'search_memory');

  const successResult = await handler({ query: 'memory query' }, {});
  assert.equal(successResult.isError, undefined);

  const successPayload = successResult.structuredContent as {
    memories: Array<{ id: number; title: string; sourceProject: string | null; createdAt: string | null; updatedAt: string | null }>;
  };
  assert.equal(successPayload.memories[0]?.id, 99);
  assert.equal(successPayload.memories[0]?.title, 'Result for memory query');
  assert.equal(successPayload.memories[0]?.sourceProject, null);
  assert.equal(successPayload.memories[0]?.createdAt, '2026-01-16T01:02:03.000Z');
  assert.equal(successPayload.memories[0]?.updatedAt, '2026-01-17T04:05:06.000Z');

  const { server: failingServer } = createServer({
    searchMemory: async () => {
      throw new Error('memory index unavailable');
    },
  });
  const failingHandler = getToolHandler(failingServer, 'search_memory');
  const failedResult = await failingHandler({ query: 'memory query' }, {});
  assert.equal(failedResult.isError, true);
  assert.match(readText(failedResult), /search_memory failed: memory index unavailable/);
});

test('search_memory returns tool error for empty query after trimming', async () => {
  const { server } = createServer();
  const handler = getToolHandler(server, 'search_memory');

  const result = await handler({ query: '   ' }, {});
  assert.equal(result.isError, true);
  assert.match(readText(result), /search_memory failed: query cannot be empty/);
});

test('get_status returns per-status counts and ignores unknown statuses', async () => {
  const { server } = createServer({
    listTasks: async () => [
      createTaskRecord({ id: 'task-queued', status: 'queued' }),
      createTaskRecord({ id: 'task-active', status: 'active' }),
      createTaskRecord({ id: 'task-done', status: 'done' }),
      createTaskRecord({ id: 'task-unknown', status: 'unknown' as TaskStatus }),
    ],
  });
  const handler = getToolHandler(server, 'get_status');

  const result = await handler({}, {});
  assert.equal(result.isError, undefined);

  const payload = result.structuredContent as {
    totalTasks: number;
    counts: Record<TaskStatus, number>;
  };
  assert.equal(payload.totalTasks, 4);
  assert.equal(payload.counts.queued, 1);
  assert.equal(payload.counts.active, 1);
  assert.equal(payload.counts.done, 1);
  assert.equal(payload.counts.failed, 0);
  assert.equal(payload.counts.blocked, 0);
  assert.equal(payload.counts.skipped, 0);
});

test('get_status returns tool error when listing tasks fails', async () => {
  const { server } = createServer({
    listTasks: async () => {
      throw new Error('TaskStore is closed');
    },
  });
  const handler = getToolHandler(server, 'get_status');

  const result = await handler({}, {});
  assert.equal(result.isError, true);
  assert.match(readText(result), /get_status failed: TaskStore is closed/);
});
