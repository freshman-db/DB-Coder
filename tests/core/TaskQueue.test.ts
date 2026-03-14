import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskStore } from '../../src/memory/TaskStore.js';
import type { Task, TaskStatus } from '../../src/memory/types.js';
import { log } from '../../src/utils/logger.js';
import { TaskQueue } from '../../src/core/TaskQueue.js';
import type { PlanTask, TaskPlan } from '../../src/core/types.js';

type SimilarTaskMatcher = (projectPath: string, description: string) => Task | null | Promise<Task | null>;
type CooldownMatcher = (projectPath: string, description: string) => boolean | Promise<boolean>;

interface StoreMockOptions {
  initialTasks?: Task[];
  findSimilarTask?: SimilarTaskMatcher;
  findSimilarCompletedTask?: SimilarTaskMatcher;
  hasRecentlyFailedSimilar?: CooldownMatcher;
  emptyNextValue?: Task | null | undefined;
}

interface CreateTaskCall {
  projectPath: string;
  description: string;
  priority: number;
  dependsOn: string[];
}

interface UpdateTaskCall {
  taskId: string;
  updates: unknown;
}

interface ListTasksCall {
  projectPath: string;
  status: TaskStatus | undefined;
}

interface StoreMockFixture {
  store: TaskStore;
  createTaskCalls: CreateTaskCall[];
  updateTaskCalls: UpdateTaskCall[];
  listTasksCalls: ListTasksCall[];
  getNextTaskCalls: string[];
  findSimilarTaskCalls: Array<{ projectPath: string; description: string }>;
  findSimilarCompletedTaskCalls: Array<{ projectPath: string; description: string }>;
  hasRecentlyFailedSimilarCalls: Array<{ projectPath: string; description: string }>;
}

function createTaskRecord(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-default',
    project_path: '/repo',
    task_description: 'Default task',
    phase: 'init',
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

function createPlanTask(
  overrides: Partial<PlanTask> & Pick<PlanTask, 'id' | 'description'>,
): PlanTask {
  const { id, description, ...rest } = overrides;
  return {
    id,
    description,
    priority: 2,
    executor: 'codex',
    subtasks: [],
    dependsOn: [],
    estimatedComplexity: 'low',
    ...rest,
  };
}

function createStoreMock(options: StoreMockOptions = {}): StoreMockFixture {
  const tasks: Task[] = [...(options.initialTasks ?? [])];
  const createTaskCalls: CreateTaskCall[] = [];
  const updateTaskCalls: UpdateTaskCall[] = [];
  const listTasksCalls: ListTasksCall[] = [];
  const getNextTaskCalls: string[] = [];
  const findSimilarTaskCalls: Array<{ projectPath: string; description: string }> = [];
  const findSimilarCompletedTaskCalls: Array<{ projectPath: string; description: string }> = [];
  const hasRecentlyFailedSimilarCalls: Array<{ projectPath: string; description: string }> = [];
  const hasCustomEmptyNextValue = Object.prototype.hasOwnProperty.call(options, 'emptyNextValue');

  let nextTaskIndex = 1;

  const store = {
    hasRecentlyFailedSimilar: async (projectPath: string, description: string) => {
      hasRecentlyFailedSimilarCalls.push({ projectPath, description });
      if (!options.hasRecentlyFailedSimilar) return false;
      return options.hasRecentlyFailedSimilar(projectPath, description);
    },
    findSimilarTask: async (projectPath: string, description: string) => {
      findSimilarTaskCalls.push({ projectPath, description });
      if (!options.findSimilarTask) return null;
      return options.findSimilarTask(projectPath, description);
    },
    findSimilarCompletedTask: async (projectPath: string, description: string) => {
      findSimilarCompletedTaskCalls.push({ projectPath, description });
      if (!options.findSimilarCompletedTask) return null;
      return options.findSimilarCompletedTask(projectPath, description);
    },
    createTask: async (
      projectPath: string,
      description: string,
      priority = 2,
      dependsOn: string[] = [],
    ) => {
      createTaskCalls.push({
        projectPath,
        description,
        priority,
        dependsOn: [...dependsOn],
      });

      const task = createTaskRecord({
        id: `task-${nextTaskIndex}`,
        project_path: projectPath,
        task_description: description,
        priority,
        depends_on: [...dependsOn],
        created_at: new Date(`2026-02-01T00:00:0${nextTaskIndex}.000Z`),
        updated_at: new Date(`2026-02-01T00:00:0${nextTaskIndex}.000Z`),
      });
      nextTaskIndex += 1;
      tasks.push(task);
      return task;
    },
    updateTask: async (taskId: string, updates: unknown) => {
      updateTaskCalls.push({ taskId, updates });
      const task = tasks.find(candidate => candidate.id === taskId);
      if (!task) return;
      Object.assign(task, updates as Partial<Task>, { updated_at: new Date('2026-02-01T00:01:00.000Z') });
    },
    getNextTask: async (projectPath: string) => {
      getNextTaskCalls.push(projectPath);

      const queued = tasks
        .filter(task => task.project_path === projectPath && task.status === 'queued')
        .filter(task =>
          task.depends_on.every(depId =>
            tasks.some(candidate => candidate.id === depId && candidate.status === 'done'),
          ))
        .sort((left, right) =>
          left.priority - right.priority
          || left.created_at.getTime() - right.created_at.getTime());

      if (queued.length > 0) return queued[0];
      if (hasCustomEmptyNextValue) return options.emptyNextValue;
      return null;
    },
    listTasks: async (projectPath: string, status?: TaskStatus) => {
      listTasksCalls.push({ projectPath, status });
      return tasks
        .filter(task => task.project_path === projectPath && (status === undefined || task.status === status))
        .sort((left, right) =>
          left.priority - right.priority
          || left.created_at.getTime() - right.created_at.getTime());
    },
  } as unknown as TaskStore;

  return {
    store,
    createTaskCalls,
    updateTaskCalls,
    listTasksCalls,
    getNextTaskCalls,
    findSimilarTaskCalls,
    findSimilarCompletedTaskCalls,
    hasRecentlyFailedSimilarCalls,
  };
}

async function withCapturedInfoLogs<T>(fn: (messages: string[]) => Promise<T>): Promise<T> {
  const messages: string[] = [];
  const originalInfo = log.info;
  log.info = (message: string) => {
    messages.push(message);
  };

  try {
    return await fn(messages);
  } finally {
    log.info = originalInfo;
  }
}

async function withCapturedWarnLogs<T>(fn: (messages: string[]) => Promise<T>): Promise<T> {
  const messages: string[] = [];
  const originalWarn = log.warn;
  log.warn = (message: string) => {
    messages.push(message);
  };

  try {
    return await fn(messages);
  } finally {
    log.warn = originalWarn;
  }
}

test('enqueue adds task and logs', async () => {
  const fixture = createStoreMock();
  const queue = new TaskQueue(fixture.store);
  const plan: TaskPlan = {
    reasoning: 'Queue by priority and dependencies',
    tasks: [
      createPlanTask({
        id: 'T-merge',
        description: 'Merge branches',
        priority: 0,
        dependsOn: ['T-left', 'T-right'],
      }),
      createPlanTask({
        id: 'T-cycle-a',
        description: 'Cycle task A',
        priority: 3,
        dependsOn: ['T-cycle-b'],
      }),
      createPlanTask({
        id: 'T-right',
        description: 'Implement right branch',
        priority: 1,
        dependsOn: ['T-root'],
      }),
      createPlanTask({
        id: 'T-root',
        description: 'Build shared utility',
        priority: 2,
        subtasks: [{ id: 'S-1', description: 'Create utility module', executor: 'codex' }],
      }),
      createPlanTask({
        id: 'T-left',
        description: 'Implement left branch',
        priority: 1,
        dependsOn: ['T-root'],
      }),
      createPlanTask({
        id: 'T-cycle-b',
        description: 'Cycle task B',
        priority: 3,
        dependsOn: ['T-cycle-a'],
      }),
    ],
  };

  let capturedLogs: string[] = [];
  const taskIds = await withCapturedInfoLogs(async messages => {
    capturedLogs = messages;
    return queue.enqueue('/repo', plan);
  });

  assert.deepEqual(taskIds, ['task-1', 'task-2', 'task-3', 'task-4', 'task-5', 'task-6']);
  assert.deepEqual(
    fixture.createTaskCalls.map(call => call.description),
    [
      'Build shared utility',
      'Implement left branch',
      'Implement right branch',
      'Merge branches',
      'Cycle task B',
      'Cycle task A',
    ],
  );
  assert.deepEqual(
    fixture.createTaskCalls.map(call => call.dependsOn),
    [
      [],
      ['task-1'],
      ['task-1'],
      ['task-2', 'task-3'],
      [],
      ['task-5'],
    ],
  );
  assert.equal(fixture.updateTaskCalls.length, 6);
  assert.deepEqual(fixture.updateTaskCalls[0], {
    taskId: 'task-1',
    updates: {
      plan: { ...plan.tasks[3], recurrence: undefined },
      subtasks: [
        { id: 'S-1', description: 'Create utility module', executor: 'codex', status: 'pending' },
      ],
    },
  });
  assert.equal(capturedLogs.filter(message => message.startsWith('Queued task')).length, 6);
});

test('enqueue dedup — queued/active task still hard-blocks', async () => {
  const similarTask = createTaskRecord({
    id: 'existing-1',
    task_description: 'Build shared utility',
    status: 'active',
  });
  const fixture = createStoreMock({
    findSimilarTask: async (_projectPath, description) =>
      description === 'Build shared utility' ? similarTask : null,
  });
  const queue = new TaskQueue(fixture.store);
  const plan: TaskPlan = {
    reasoning: 'Deduplicate repeated work',
    tasks: [
      createPlanTask({ id: 'T-dedup', description: 'Build shared utility' }),
    ],
  };

  let capturedLogs: string[] = [];
  const taskIds = await withCapturedInfoLogs(async messages => {
    capturedLogs = messages;
    return queue.enqueue('/repo', plan);
  });

  assert.deepEqual(taskIds, []);
  assert.equal(fixture.hasRecentlyFailedSimilarCalls.length, 1);
  assert.equal(fixture.findSimilarTaskCalls.length, 1);
  assert.equal(fixture.findSimilarCompletedTaskCalls.length, 0);
  assert.equal(fixture.createTaskCalls.length, 0);
  assert.equal(fixture.updateTaskCalls.length, 0);
  assert.equal(capturedLogs.some(message => message.includes('Skipping duplicate task:')), true);
});

test('enqueue recurrence — similar done task exists, new task created with metadata', async () => {
  const completedTask = createTaskRecord({
    id: 'done-1',
    task_description: 'Fix flaky migration',
    status: 'done',
    updated_at: new Date('2026-02-02T12:00:00.000Z'),
  });
  const fixture = createStoreMock({
    findSimilarCompletedTask: async (_projectPath, description) =>
      description === 'Fix flaky migration' ? completedTask : null,
  });
  const queue = new TaskQueue(fixture.store);
  const plan: TaskPlan = {
    reasoning: 'Allow recurrence while recording context',
    tasks: [
      createPlanTask({ id: 'T-repeat', description: 'Fix flaky migration' }),
    ],
  };

  let capturedWarnLogs: string[] = [];
  const taskIds = await withCapturedWarnLogs(async messages => {
    capturedWarnLogs = messages;
    return queue.enqueue('/repo', plan);
  });

  assert.deepEqual(taskIds, ['task-1']);
  assert.equal(fixture.hasRecentlyFailedSimilarCalls.length, 1);
  assert.equal(fixture.findSimilarTaskCalls.length, 1);
  assert.equal(fixture.findSimilarCompletedTaskCalls.length, 1);
  assert.equal(fixture.createTaskCalls.length, 1);
  assert.deepEqual(fixture.updateTaskCalls[0], {
    taskId: 'task-1',
    updates: {
      plan: {
        ...plan.tasks[0],
        recurrence: {
          previousTaskId: 'done-1',
          completedAt: completedTask.updated_at,
        },
      },
      subtasks: [],
    },
  });
  assert.equal(capturedWarnLogs.length, 1);
  assert.equal(capturedWarnLogs[0]?.includes('Recurring issue detected: "Fix flaky migration" — similar to completed task done-1'), true);
});

test('enqueue dedup — done task no longer hard-blocks', async () => {
  const completedTask = createTaskRecord({
    id: 'done-2',
    task_description: 'Investigate latency regression',
    status: 'done',
    updated_at: new Date('2026-02-03T09:30:00.000Z'),
  });
  const fixture = createStoreMock({
    findSimilarTask: async () => null,
    findSimilarCompletedTask: async (_projectPath, description) =>
      description === 'Investigate latency regression' ? completedTask : null,
  });
  const queue = new TaskQueue(fixture.store);
  const plan: TaskPlan = {
    reasoning: 'Completed tasks should no longer block recurrence',
    tasks: [
      createPlanTask({ id: 'T-reopen', description: 'Investigate latency regression' }),
    ],
  };

  const taskIds = await queue.enqueue('/repo', plan);

  assert.deepEqual(taskIds, ['task-1']);
  assert.equal(fixture.hasRecentlyFailedSimilarCalls.length, 1);
  assert.equal(fixture.findSimilarTaskCalls.length, 1);
  assert.equal(fixture.findSimilarCompletedTaskCalls.length, 1);
  assert.equal(fixture.createTaskCalls.length, 1);
  assert.equal(fixture.updateTaskCalls.length, 1);
});

test('enqueue cooldown — hasRecentlyFailedSimilar returns true and task is skipped', async () => {
  const fixture = createStoreMock({
    hasRecentlyFailedSimilar: async () => true,
  });
  const queue = new TaskQueue(fixture.store);
  const plan: TaskPlan = {
    reasoning: 'Avoid immediate retries',
    tasks: [
      createPlanTask({ id: 'T-cooldown', description: 'Retry flaky migration' }),
    ],
  };

  let capturedLogs: string[] = [];
  const taskIds = await withCapturedInfoLogs(async messages => {
    capturedLogs = messages;
    return queue.enqueue('/repo', plan);
  });

  assert.deepEqual(taskIds, []);
  assert.equal(fixture.hasRecentlyFailedSimilarCalls.length, 1);
  assert.equal(fixture.findSimilarTaskCalls.length, 0);
  assert.equal(fixture.findSimilarCompletedTaskCalls.length, 0);
  assert.equal(fixture.createTaskCalls.length, 0);
  assert.equal(fixture.updateTaskCalls.length, 0);
  assert.equal(capturedLogs.some(message => message.includes('Skipping task (cooldown):')), true);
});

test('getNext returns highest-priority queued task', async () => {
  const fixture = createStoreMock({
    initialTasks: [
      createTaskRecord({
        id: 'done-dependency',
        status: 'done',
        priority: 3,
      }),
      createTaskRecord({
        id: 'queued-blocked',
        status: 'queued',
        priority: 0,
        depends_on: ['missing-dependency'],
      }),
      createTaskRecord({
        id: 'queued-ready-high',
        status: 'queued',
        priority: 1,
        depends_on: ['done-dependency'],
        created_at: new Date('2026-02-01T00:00:02.000Z'),
      }),
      createTaskRecord({
        id: 'queued-ready-low',
        status: 'queued',
        priority: 2,
        created_at: new Date('2026-02-01T00:00:03.000Z'),
      }),
    ],
  });
  const queue = new TaskQueue(fixture.store);

  const nextTask = await queue.getNext('/repo');

  assert.equal(nextTask?.id, 'queued-ready-high');
  assert.deepEqual(fixture.getNextTaskCalls, ['/repo']);
});

test('getNext with empty queue returns undefined', async () => {
  const fixture = createStoreMock({ emptyNextValue: undefined });
  const queue = new TaskQueue(fixture.store);

  const nextTask = await queue.getNext('/repo');

  assert.equal(nextTask, undefined);
  assert.deepEqual(fixture.getNextTaskCalls, ['/repo']);
});

test('getAll returns combined queued+blocked tasks', async () => {
  const fixture = createStoreMock({
    initialTasks: [
      createTaskRecord({
        id: 'queued-task',
        status: 'queued',
        priority: 0,
      }),
      createTaskRecord({
        id: 'blocked-task',
        status: 'blocked',
        priority: 1,
      }),
      createTaskRecord({
        id: 'other-project-task',
        project_path: '/other',
        status: 'queued',
        priority: 0,
      }),
    ],
  });
  const queue = new TaskQueue(fixture.store);

  const tasks = await queue.getAll('/repo');

  assert.deepEqual(tasks.map(task => task.id), ['queued-task', 'blocked-task']);
  assert.deepEqual(fixture.listTasksCalls, [{ projectPath: '/repo', status: undefined }]);
});

test('getQueued filters by status=queued', async () => {
  const fixture = createStoreMock({
    initialTasks: [
      createTaskRecord({ id: 'queued-p0', status: 'queued', priority: 0 }),
      createTaskRecord({ id: 'blocked-p0', status: 'blocked', priority: 0 }),
      createTaskRecord({ id: 'queued-p2', status: 'queued', priority: 2 }),
    ],
  });
  const queue = new TaskQueue(fixture.store);

  const queuedTasks = await queue.getQueued('/repo');

  assert.deepEqual(queuedTasks.map(task => task.id), ['queued-p0', 'queued-p2']);
  assert.deepEqual(fixture.listTasksCalls, [{ projectPath: '/repo', status: 'queued' }]);
});

test('getBlocked filters by status=blocked', async () => {
  const fixture = createStoreMock({
    initialTasks: [
      createTaskRecord({ id: 'queued-p0', status: 'queued', priority: 0 }),
      createTaskRecord({
        id: 'blocked-dependency',
        status: 'blocked',
        priority: 1,
        depends_on: ['queued-p0'],
      }),
      createTaskRecord({ id: 'blocked-standalone', status: 'blocked', priority: 2 }),
    ],
  });
  const queue = new TaskQueue(fixture.store);

  const blockedTasks = await queue.getBlocked('/repo');

  assert.deepEqual(blockedTasks.map(task => task.id), ['blocked-dependency', 'blocked-standalone']);
  assert.deepEqual(fixture.listTasksCalls, [{ projectPath: '/repo', status: 'blocked' }]);
});
