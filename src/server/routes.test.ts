import assert from 'node:assert/strict';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import type { Config } from '../config/Config.js';
import type { MainLoop } from '../core/MainLoop.js';
import type { PatrolManager } from '../core/ModeManager.js';
import type { PlanWorkflow } from '../core/PlanWorkflow.js';
import type { GlobalMemory } from '../memory/GlobalMemory.js';
import type { TaskStore } from '../memory/TaskStore.js';
import type { CostTracker } from '../utils/cost.js';
import { createSseStream } from './routes.js';
import { Server } from './Server.js';

type RequestListener = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

interface MockResponseState {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

interface RequestOptions {
  method: 'GET' | 'POST';
  url: string;
  token?: string;
  authorization?: string;
  body?: unknown;
}

interface ServerFixtureOptions {
  apiToken?: string;
  loop?: Partial<MainLoop>;
  taskStore?: Partial<TaskStore>;
  costTracker?: Partial<CostTracker>;
  modeManager?: Partial<PatrolManager>;
  planWorkflow?: Partial<PlanWorkflow>;
}

interface ServerFixture {
  server: Server;
  token: string;
}

function createServerFixture(options: ServerFixtureOptions = {}): ServerFixture {
  const token = options.apiToken ?? 'test-token';

  const loop = {
    getState: () => 'idle',
    getCurrentTaskId: () => null,
    isPaused: () => false,
    isRunning: () => false,
    addStatusListener: () => () => {},
    pause: () => {},
    resume: () => {},
    triggerScan: async () => {},
    ...options.loop,
  } as unknown as MainLoop;

  const taskStore = {
    createTask: async () => ({ id: 'task-1' }),
    listTasksPaged: async () => ({ tasks: [], total: 0, page: 1, pageSize: 20 }),
    getTask: async () => null,
    ...options.taskStore,
  } as unknown as TaskStore;

  const costTracker = {
    getDailySummary: async () => [],
    getSessionCost: () => 0,
    ...options.costTracker,
  } as unknown as CostTracker;

  const modeManager = {
    startPatrol: async () => {},
    stopPatrol: async () => {},
    ...options.modeManager,
  } as unknown as PatrolManager;

  const planWorkflow = {
    createChatSession: async () => 1,
    ...options.planWorkflow,
  } as unknown as PlanWorkflow;

  const config = {
    projectPath: '/workspace/project',
    values: {
      apiToken: token,
      server: { host: '127.0.0.1', port: 18890 },
      brain: { scanInterval: 30 },
      evolution: { goals: [] },
    },
  } as unknown as Config;

  const globalMemory = {} as GlobalMemory;

  return {
    server: new Server(config, loop, taskStore, globalMemory, costTracker, undefined, undefined, modeManager, planWorkflow),
    token,
  };
}

function getRequestListener(server: Server): RequestListener {
  const instance = server as unknown as { server: HttpServer };
  const [listener] = instance.server.listeners('request');
  assert.equal(typeof listener, 'function');
  return async (req, res) => {
    await listener(req, res);
  };
}

function createMockRequest(options: RequestOptions): IncomingMessage {
  const req = new PassThrough() as PassThrough & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };

  req.method = options.method;
  req.url = options.url;

  const headers: Record<string, string> = { host: 'localhost' };
  if (options.token !== undefined) {
    headers.authorization = `Bearer ${options.token}`;
  } else if (options.authorization !== undefined) {
    headers.authorization = options.authorization;
  }

  let bodyText: string | undefined;
  if (options.body !== undefined) {
    bodyText = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(bodyText));
  }

  req.headers = headers;
  if (bodyText === undefined) {
    req.end();
  } else {
    req.end(bodyText);
  }

  return req as unknown as IncomingMessage;
}

function createMockResponse(): {
  response: ServerResponse;
  state: MockResponseState;
} {
  const state: MockResponseState = {
    statusCode: 200,
    headers: {},
    body: '',
  };

  const response = {
    setHeader: (name: string, value: string): void => {
      state.headers[name.toLowerCase()] = value;
    },
    write: (chunk?: string | Buffer): boolean => {
      if (chunk === undefined) {
        return true;
      }
      state.body += Buffer.isBuffer(chunk) ? chunk.toString() : chunk;
      return true;
    },
    writeHead: (statusCode: number, headers?: Record<string, string>): ServerResponse => {
      state.statusCode = statusCode;
      if (headers) {
        for (const [name, value] of Object.entries(headers)) {
          state.headers[name.toLowerCase()] = value;
        }
      }
      return response as unknown as ServerResponse;
    },
    end: (chunk?: string | Buffer): void => {
      if (chunk === undefined) return;
      state.body += Buffer.isBuffer(chunk) ? chunk.toString() : chunk;
    },
  } as unknown as ServerResponse;

  return { response, state };
}

async function dispatch(server: Server, options: RequestOptions): Promise<MockResponseState> {
  const listener = getRequestListener(server);
  const { response, state } = createMockResponse();
  await listener(createMockRequest(options), response);
  return state;
}

function parseJson<T>(state: MockResponseState): T {
  return JSON.parse(state.body) as T;
}

test('GET /api/tasks returns paginated task list JSON', async () => {
  let listArgs:
    | {
      projectPath: string;
      page: number | undefined;
      pageSize: number | undefined;
      status: unknown;
    }
    | undefined;

  const expected = {
    tasks: [
      {
        id: 'task-1',
        task_description: 'Write routes integration tests',
        priority: 1,
        status: 'queued',
      },
    ],
    total: 1,
    page: 2,
    pageSize: 10,
  } as unknown as Awaited<ReturnType<TaskStore['listTasksPaged']>>;

  const { server, token } = createServerFixture({
    taskStore: {
      listTasksPaged: async (projectPath, page, pageSize, status) => {
        listArgs = { projectPath, page, pageSize, status };
        return expected;
      },
    },
  });

  const state = await dispatch(server, {
    method: 'GET',
    url: '/api/tasks?page=2&pageSize=10&status=queued,active',
    token,
  });

  assert.equal(state.statusCode, 200);
  assert.deepEqual(parseJson<typeof expected>(state), expected);
  assert.deepEqual(listArgs, {
    projectPath: '/workspace/project',
    page: 2,
    pageSize: 10,
    status: ['queued', 'active'],
  });
});

test('POST /api/tasks with valid body creates task and returns 201', async () => {
  let createArgs:
    | {
      projectPath: string;
      description: string;
      priority: number | undefined;
    }
    | undefined;

  const createdTask = {
    id: 'task-99',
    task_description: 'Ship API coverage',
    priority: 1,
    status: 'queued',
  } as unknown as Awaited<ReturnType<TaskStore['createTask']>>;

  const { server, token } = createServerFixture({
    taskStore: {
      createTask: async (projectPath, description, priority) => {
        createArgs = { projectPath, description, priority };
        return createdTask;
      },
    },
  });

  const state = await dispatch(server, {
    method: 'POST',
    url: '/api/tasks',
    token,
    body: {
      description: '  Ship API coverage  ',
      priority: 1,
    },
  });

  assert.equal(state.statusCode, 201);
  assert.deepEqual(parseJson<typeof createdTask>(state), createdTask);
  assert.deepEqual(createArgs, {
    projectPath: '/workspace/project',
    description: 'Ship API coverage',
    priority: 1,
  });
});

test('POST /api/tasks with invalid body returns 400', async () => {
  let createCalls = 0;

  const { server, token } = createServerFixture({
    taskStore: {
      createTask: async () => {
        createCalls += 1;
        return {} as Awaited<ReturnType<TaskStore['createTask']>>;
      },
    },
  });

  const state = await dispatch(server, {
    method: 'POST',
    url: '/api/tasks',
    token,
    body: {
      description: '   ',
    },
  });

  assert.equal(state.statusCode, 400);
  assert.deepEqual(parseJson<{ error: string }>(state), {
    error: 'description is required and must be a non-empty string.',
  });
  assert.equal(createCalls, 0);
});

test('POST /api/patrol/start returns 200 and calls mode manager startPatrol', async () => {
  let startCalls = 0;

  const { server, token } = createServerFixture({
    modeManager: {
      startPatrol: async () => {
        startCalls += 1;
      },
    },
  });

  const state = await dispatch(server, {
    method: 'POST',
    url: '/api/patrol/start',
    token,
  });

  assert.equal(state.statusCode, 200);
  assert.deepEqual(parseJson<{ ok: boolean; patrolling: boolean }>(state), {
    ok: true,
    patrolling: true,
  });
  assert.equal(startCalls, 1);
});

test('POST /api/patrol/stop returns 200', async () => {
  let stopCalls = 0;

  const { server, token } = createServerFixture({
    modeManager: {
      stopPatrol: async () => {
        stopCalls += 1;
      },
    },
  });

  const state = await dispatch(server, {
    method: 'POST',
    url: '/api/patrol/stop',
    token,
  });

  assert.equal(state.statusCode, 200);
  assert.deepEqual(parseJson<{ ok: boolean; patrolling: boolean }>(state), {
    ok: true,
    patrolling: false,
  });
  assert.equal(stopCalls, 1);
});

test('API requests without a valid Bearer token return 401', async () => {
  let listCalled = false;
  const { server } = createServerFixture({
    apiToken: 'secret-token',
    taskStore: {
      listTasksPaged: async () => {
        listCalled = true;
        return { tasks: [], total: 0, page: 1, pageSize: 20 };
      },
    },
  });

  const missingToken = await dispatch(server, {
    method: 'GET',
    url: '/api/tasks',
  });

  assert.equal(missingToken.statusCode, 401);
  assert.equal(missingToken.headers['www-authenticate'], 'Bearer');
  assert.deepEqual(parseJson<{ error: string }>(missingToken), {
    error: 'Unauthorized',
  });

  const wrongToken = await dispatch(server, {
    method: 'GET',
    url: '/api/tasks',
    token: 'wrong-token',
  });

  assert.equal(wrongToken.statusCode, 401);
  assert.deepEqual(parseJson<{ error: string }>(wrongToken), {
    error: 'Unauthorized',
  });
  assert.equal(listCalled, false);
});

test('GET /api/status returns health-style status fields', async () => {
  let taskLookupId: string | null = null;
  const dailyCosts = [{ date: '2026-02-22', total_cost_usd: 0.42, task_count: 1 }];

  const { server, token } = createServerFixture({
    loop: {
      getState: () => 'planning',
      getCurrentTaskId: () => 'task-42',
      isPaused: () => true,
      isRunning: () => true,
    },
    taskStore: {
      getTask: async (id) => {
        taskLookupId = id;
        return { task_description: 'Review public API routes' } as Awaited<ReturnType<TaskStore['getTask']>>;
      },
    },
    costTracker: {
      getDailySummary: async () => dailyCosts,
    },
  });

  const state = await dispatch(server, {
    method: 'GET',
    url: '/api/status',
    token,
  });

  assert.equal(state.statusCode, 200);
  assert.equal(taskLookupId, 'task-42');
  assert.deepEqual(parseJson<Record<string, unknown>>(state), {
    state: 'planning',
    currentTaskId: 'task-42',
    currentTaskTitle: 'Review public API routes',
    paused: true,
    patrolling: true,
    scanInterval: 30,
    projectPath: '/workspace/project',
    dailyCosts,
  });
});

test('createSseStream writes SSE headers and event payloads', () => {
  const req = createMockRequest({
    method: 'GET',
    url: '/api/logs',
    token: 'token',
  });
  const { response, state } = createMockResponse();

  const stream = createSseStream(req, response);
  assert.equal(state.statusCode, 200);
  assert.equal(state.headers['content-type'], 'text/event-stream');
  assert.equal(state.headers['cache-control'], 'no-cache');
  assert.equal(state.headers.connection, 'keep-alive');
  assert.equal(state.headers['access-control-allow-origin'], '*');

  const wroteEvent = stream.write('status', { ok: true });
  assert.equal(wroteEvent, true);
  assert.equal(state.body, 'event: status\ndata: {"ok":true}\n\n');

  stream.cleanup();
});

test('createSseStream writes heartbeat comments on interval ticks', () => {
  const req = createMockRequest({
    method: 'GET',
    url: '/api/logs',
    token: 'token',
  });
  const { response, state } = createMockResponse();

  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let heartbeatTick: (() => void) | undefined;
  let heartbeatDelayMs: number | undefined;
  const timerHandle = { id: 'heartbeat-timer' } as unknown as ReturnType<typeof setInterval>;

  globalThis.setInterval = ((callback: (...args: unknown[]) => void, delay?: number): ReturnType<typeof setInterval> => {
    heartbeatDelayMs = delay;
    heartbeatTick = () => callback();
    return timerHandle;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;

  try {
    const stream = createSseStream(req, response);
    assert.equal(heartbeatDelayMs, 15_000);
    assert.equal(typeof heartbeatTick, 'function');

    heartbeatTick?.();
    assert.equal(state.body, ': heartbeat\n\n');

    stream.cleanup();
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test('createSseStream cleanup prevents double-close and write after cleanup returns false', () => {
  const req = createMockRequest({
    method: 'GET',
    url: '/api/logs',
    token: 'token',
  });
  const { response } = createMockResponse();

  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const timerHandle = { id: 'cleanup-timer' } as unknown as ReturnType<typeof setInterval>;
  let clearIntervalCalls = 0;

  globalThis.setInterval = ((callback: (...args: unknown[]) => void): ReturnType<typeof setInterval> => {
    void callback;
    return timerHandle;
  }) as typeof setInterval;
  globalThis.clearInterval = ((timer: ReturnType<typeof setInterval> | undefined): void => {
    if (timer === timerHandle) {
      clearIntervalCalls += 1;
    }
  }) as typeof clearInterval;

  try {
    const stream = createSseStream(req, response);
    assert.equal(req.listenerCount('close'), 1);

    stream.cleanup();
    stream.cleanup();
    req.emit('close');
    req.emit('close');

    assert.equal(req.listenerCount('close'), 0);
    assert.equal(clearIntervalCalls, 1);
    assert.equal(stream.write('status', { ok: false }), false);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test('createSseStream keeps pre-serialized string payloads intact', () => {
  const req = createMockRequest({
    method: 'GET',
    url: '/api/logs',
    token: 'token',
  });
  const { response, state } = createMockResponse();

  const stream = createSseStream(req, response);
  const wroteEvent = stream.write('status', '{"ok":true}');
  assert.equal(wroteEvent, true);
  assert.equal(state.body, 'event: status\ndata: {"ok":true}\n\n');

  stream.cleanup();
});

test('createSseStream validates nullish request and response inputs', () => {
  const req = createMockRequest({
    method: 'GET',
    url: '/api/logs',
    token: 'token',
  });
  const { response } = createMockResponse();

  assert.throws(
    () => createSseStream(undefined as unknown as IncomingMessage, response),
    /IncomingMessage instance\./,
  );
  assert.throws(
    () => createSseStream(req, undefined as unknown as ServerResponse),
    /ServerResponse instance\./,
  );
});

test('GET /api/logs returns SSE headers', async () => {
  const { server, token } = createServerFixture();
  const listener = getRequestListener(server);
  const req = createMockRequest({
    method: 'GET',
    url: '/api/logs',
    token,
  });
  const { response, state } = createMockResponse();

  await listener(req, response);

  assert.equal(state.statusCode, 200);
  assert.equal(state.headers['content-type'], 'text/event-stream');
  assert.equal(state.headers['cache-control'], 'no-cache');
  assert.equal(state.headers.connection, 'keep-alive');

  req.emit('close');
});

test('GET /api/status/stream returns SSE headers and cleans up status listeners', async () => {
  let removeCalls = 0;
  let statusListenerAttached = false;

  const { server, token } = createServerFixture({
    loop: {
      addStatusListener: () => {
        statusListenerAttached = true;
        return () => {
          removeCalls += 1;
        };
      },
    },
  });
  const listener = getRequestListener(server);
  const req = createMockRequest({
    method: 'GET',
    url: '/api/status/stream',
    token,
  });
  const { response, state } = createMockResponse();

  await listener(req, response);

  assert.equal(state.statusCode, 200);
  assert.equal(state.headers['content-type'], 'text/event-stream');
  assert.equal(state.headers['cache-control'], 'no-cache');
  assert.equal(state.headers.connection, 'keep-alive');
  assert.equal(statusListenerAttached, true);
  assert.match(state.body, /event: status/);

  req.emit('close');
  assert.equal(removeCalls, 1);
});

test('GET /api/plans/:id/stream returns SSE headers', async () => {
  let draftId: number | null = null;
  let emit: ((event: string, data: string) => void) | undefined;
  let cleanupCalls = 0;

  const { server, token } = createServerFixture({
    planWorkflow: {
      addSSEListener: (id, listener) => {
        draftId = id;
        emit = listener;
        return () => {
          cleanupCalls += 1;
        };
      },
    },
  });
  const listener = getRequestListener(server);
  const req = createMockRequest({
    method: 'GET',
    url: '/api/plans/42/stream',
    token,
  });
  const { response, state } = createMockResponse();

  await listener(req, response);

  assert.equal(state.statusCode, 200);
  assert.equal(state.headers['content-type'], 'text/event-stream');
  assert.equal(state.headers['cache-control'], 'no-cache');
  assert.equal(state.headers.connection, 'keep-alive');
  assert.equal(draftId, 42);

  emit?.('status', '{"ready":true}');
  assert.equal(state.body, 'event: status\ndata: {"ready":true}\n\n');

  req.emit('close');
  assert.equal(cleanupCalls, 1);
});

test('POST /api/plans/chat returns 201 and creates a chat session', async () => {
  let capturedProjectPath: string | undefined;

  const { server, token } = createServerFixture({
    planWorkflow: {
      createChatSession: async (projectPath) => {
        capturedProjectPath = projectPath;
        return 123;
      },
    },
  });

  const state = await dispatch(server, {
    method: 'POST',
    url: '/api/plans/chat',
    token,
  });

  assert.equal(state.statusCode, 201);
  assert.equal(capturedProjectPath, '/workspace/project');
  assert.deepEqual(parseJson<{ id: number }>(state), { id: 123 });
});

test('POST /api/plans/:id/chat with valid message returns 200', async () => {
  let processArgs:
    | {
      id: number;
      message: string;
    }
    | undefined;

  const { server, token } = createServerFixture({
    planWorkflow: {
      processUserMessage: async (id, message) => {
        processArgs = { id, message };
      },
    },
  });

  const state = await dispatch(server, {
    method: 'POST',
    url: '/api/plans/7/chat',
    token,
    body: {
      message: '  Run dependency audit  ',
    },
  });

  assert.equal(state.statusCode, 200);
  assert.deepEqual(parseJson<{ ok: boolean }>(state), { ok: true });
  assert.deepEqual(processArgs, {
    id: 7,
    message: 'Run dependency audit',
  });
});
