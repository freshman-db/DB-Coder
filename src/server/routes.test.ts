import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { log, type LogEntry } from '../utils/logger.js';
import { handleRequest, safeSseWrite } from './routes.js';

const MAX_REQUEST_BODY_BYTES = 64 * 1024;

interface MockResponseState {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

type RouteContext = Parameters<typeof handleRequest>[2];

const defaultCreateTask = async (
  _projectPath: string,
  description: string,
  priority: number,
): Promise<unknown> => ({ id: 'task-1', description, priority });

function createContext(
  createTask: (projectPath: string, description: string, priority: number) => Promise<unknown> = defaultCreateTask,
  getTask: (taskId: string) => Promise<{ task_description: string } | null> = async () => null,
): RouteContext {
  return {
    loop: {
      getState: () => 'idle',
      getCurrentTaskId: () => null,
      isPaused: () => false,
      isRunning: () => false,
      addStatusListener: () => () => {},
    } as unknown as RouteContext['loop'],
    taskStore: { createTask, getTask } as RouteContext['taskStore'],
    globalMemory: {} as RouteContext['globalMemory'],
    costTracker: {
      getDailySummary: async () => [],
      getSessionCost: () => 0,
    } as unknown as RouteContext['costTracker'],
    config: {
      projectPath: '/tmp/project',
      values: {
        brain: { scanInterval: 30 },
        evolution: { goals: [] },
      },
    } as unknown as RouteContext['config'],
  };
}

function createStreamRequest(): PassThrough & {
  method: string;
  url: string;
  headers: Record<string, string>;
} {
  const req = new PassThrough() as PassThrough & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = 'POST';
  req.url = '/api/tasks';
  req.headers = { host: 'localhost' };
  return req;
}

function createRequest(body?: string | string[]): IncomingMessage {
  const req = createStreamRequest();
  if (body === undefined) {
    req.end();
  } else if (Array.isArray(body)) {
    for (const chunk of body) {
      req.write(chunk);
    }
    req.end();
  } else {
    req.end(body);
  }
  return req as unknown as IncomingMessage;
}

function createErroredRequest(): IncomingMessage {
  const req = createStreamRequest();
  setImmediate(() => {
    req.destroy(new Error('socket failure'));
  });
  return req as unknown as IncomingMessage;
}

function createGetRequest(url: string): PassThrough & {
  method: string;
  url: string;
  headers: Record<string, string>;
} {
  const req = createStreamRequest();
  req.method = 'GET';
  req.url = url;
  req.end();
  return req;
}

function createMockResponse(): { response: ServerResponse; state: MockResponseState } {
  const state: MockResponseState = {
    statusCode: 200,
    headers: {},
    body: '',
  };

  const response = {
    setHeader: (name: string, value: string): void => {
      state.headers[name] = value;
    },
    writeHead: (statusCode: number, headers?: Record<string, string>): ServerResponse => {
      state.statusCode = statusCode;
      if (headers) {
        Object.assign(state.headers, headers);
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

interface MockSseResponseState extends MockResponseState {
  writes: string[];
}

function createSseResponse(options: { throwOnWrite?: boolean } = {}): {
  response: ServerResponse & { writableEnded: boolean; destroyed: boolean };
  state: MockSseResponseState;
} {
  const state: MockSseResponseState = {
    statusCode: 200,
    headers: {},
    body: '',
    writes: [],
  };

  const response = {
    writableEnded: false,
    destroyed: false,
    setHeader: (name: string, value: string): void => {
      state.headers[name] = value;
    },
    writeHead: (statusCode: number, headers?: Record<string, string>): ServerResponse => {
      state.statusCode = statusCode;
      if (headers) {
        Object.assign(state.headers, headers);
      }
      return response as unknown as ServerResponse;
    },
    write: (chunk: string | Buffer): boolean => {
      if (options.throwOnWrite) {
        throw new Error('write failure');
      }
      const text = Buffer.isBuffer(chunk) ? chunk.toString() : chunk;
      state.writes.push(text);
      return true;
    },
    end: (chunk?: string | Buffer): void => {
      if (chunk !== undefined) {
        state.body += Buffer.isBuffer(chunk) ? chunk.toString() : chunk;
      }
      response.writableEnded = true;
    },
  } as unknown as ServerResponse & { writableEnded: boolean; destroyed: boolean };

  return { response, state };
}

async function runRequest(req: IncomingMessage, ctx = createContext()): Promise<MockResponseState> {
  const { response, state } = createMockResponse();
  const handled = await handleRequest(req, response, ctx);
  assert.equal(handled, true);
  return state;
}

async function runPostTasksRequest(req: IncomingMessage, ctx = createContext()): Promise<MockResponseState> {
  return runRequest(req, ctx);
}

function parseJsonBody(state: MockResponseState): Record<string, unknown> {
  return JSON.parse(state.body) as Record<string, unknown>;
}

function stubHeartbeatInterval(): {
  trigger: () => void;
  getClearCallCount: () => number;
  restore: () => void;
} {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let callback: (() => void) | undefined;
  let clearCallCount = 0;

  globalThis.setInterval = (((fn: TimerHandler): ReturnType<typeof setInterval> => {
    callback = (): void => {
      if (typeof fn === 'function') {
        fn();
      }
    };
    return { token: 'interval' } as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval);

  globalThis.clearInterval = (() => {
    clearCallCount += 1;
  }) as typeof clearInterval;

  return {
    trigger: (): void => {
      assert.ok(callback, 'expected heartbeat callback to be registered');
      callback();
    },
    getClearCallCount: () => clearCallCount,
    restore: (): void => {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    },
  };
}

interface StatusSsePayload {
  state: string;
  currentTaskId: string | null;
  currentTaskTitle: string | null;
  patrolling: boolean;
  paused: boolean;
}

function parseStatusSsePayload(writeChunk: string | undefined): StatusSsePayload {
  assert.ok(writeChunk, 'expected SSE write chunk');
  const eventLine = writeChunk.split('\n').find(line => line.startsWith('event: '));
  assert.equal(eventLine, 'event: status');
  const dataLine = writeChunk.split('\n').find(line => line.startsWith('data: '));
  assert.ok(dataLine, 'expected SSE data line');
  return JSON.parse(dataLine.slice('data: '.length)) as StatusSsePayload;
}

async function waitForSseWrite(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

test('safeSseWrite returns true and writes data when response is open', () => {
  let writes = '';
  const response = {
    writableEnded: false,
    destroyed: false,
    write: (data: string): boolean => {
      writes += data;
      return true;
    },
  } as unknown as ServerResponse;

  const result = safeSseWrite(response, 'data: ping\n\n');

  assert.equal(result, true);
  assert.equal(writes, 'data: ping\n\n');
});

test('safeSseWrite returns false when response is already destroyed', () => {
  let writeCalled = false;
  const response = {
    writableEnded: false,
    destroyed: true,
    write: (): boolean => {
      writeCalled = true;
      return true;
    },
  } as unknown as ServerResponse;

  const result = safeSseWrite(response, 'data: ping\n\n');

  assert.equal(result, false);
  assert.equal(writeCalled, false);
});

test('safeSseWrite returns false when response is already ended', () => {
  let writeCalled = false;
  const response = {
    writableEnded: true,
    destroyed: false,
    write: (): boolean => {
      writeCalled = true;
      return true;
    },
  } as unknown as ServerResponse;

  let result = true;
  assert.doesNotThrow(() => {
    result = safeSseWrite(response, 'data: ping\n\n');
  });

  assert.equal(result, false);
  assert.equal(writeCalled, false);
});

test('safeSseWrite returns false when response.write throws', () => {
  const response = {
    writableEnded: false,
    destroyed: false,
    write: (): boolean => {
      throw new Error('socket closed');
    },
  } as unknown as ServerResponse;

  const result = safeSseWrite(response, 'data: ping\n\n');

  assert.equal(result, false);
});

test('GET /api/status includes currentTaskTitle when currentTaskId exists', async () => {
  let requestedTaskId = '';
  const ctx = {
    ...createContext(defaultCreateTask, async (taskId) => {
      requestedTaskId = taskId;
      return { task_description: '修复 dashboard 状态冲突' };
    }),
    loop: {
      getState: () => 'executing',
      getCurrentTaskId: () => 'task-123',
      isPaused: () => false,
      isRunning: () => true,
    } as unknown as RouteContext['loop'],
  };

  const state = await runRequest(createGetRequest('/api/status') as unknown as IncomingMessage, ctx);

  assert.equal(requestedTaskId, 'task-123');
  assert.equal(state.statusCode, 200);
  assert.deepEqual(parseJsonBody(state), {
    state: 'executing',
    currentTaskId: 'task-123',
    currentTaskTitle: '修复 dashboard 状态冲突',
    paused: false,
    patrolling: true,
    scanInterval: 30,
    projectPath: '/tmp/project',
    dailyCosts: [],
  });
});

test('GET /api/status skips task lookup and returns null title when no current task id', async () => {
  let getTaskCalled = false;
  const ctx = {
    ...createContext(defaultCreateTask, async () => {
      getTaskCalled = true;
      return { task_description: 'should-not-be-called' };
    }),
    loop: {
      getState: () => 'idle',
      getCurrentTaskId: () => null,
      isPaused: () => false,
      isRunning: () => false,
    } as unknown as RouteContext['loop'],
  };

  const state = await runRequest(createGetRequest('/api/status') as unknown as IncomingMessage, ctx);

  assert.equal(getTaskCalled, false);
  assert.equal(state.statusCode, 200);
  assert.equal(parseJsonBody(state).currentTaskTitle, null);
});

test('GET /api/status returns null currentTaskTitle when task lookup misses', async () => {
  const ctx = {
    ...createContext(defaultCreateTask, async (_taskId) => null),
    loop: {
      getState: () => 'executing',
      getCurrentTaskId: () => 'task-missing',
      isPaused: () => true,
      isRunning: () => true,
    } as unknown as RouteContext['loop'],
  };

  const state = await runRequest(createGetRequest('/api/status') as unknown as IncomingMessage, ctx);

  assert.equal(state.statusCode, 200);
  assert.equal(parseJsonBody(state).currentTaskTitle, null);
});

test('GET /api/status/stream sends initial and subsequent status events with task titles', async () => {
  const req = createGetRequest('/api/status/stream');
  const { response, state } = createSseResponse();
  const intervalStub = stubHeartbeatInterval();
  const requestedTaskIds: string[] = [];
  let removeCalls = 0;
  let listener: ((snapshot: {
    state: string;
    currentTaskId: string | null;
    patrolling: boolean;
    paused: boolean;
  }) => void) | undefined;

  const ctx = {
    ...createContext(defaultCreateTask, async (taskId) => {
      requestedTaskIds.push(taskId);
      return { task_description: `Title for ${taskId}` };
    }),
    loop: {
      getState: () => 'scanning',
      getCurrentTaskId: () => 'task-1',
      isPaused: () => false,
      isRunning: () => true,
      addStatusListener: (statusListener: (snapshot: {
        state: string;
        currentTaskId: string | null;
        patrolling: boolean;
        paused: boolean;
      }) => void): (() => void) => {
        listener = statusListener;
        return () => {
          removeCalls += 1;
        };
      },
    } as unknown as RouteContext['loop'],
  };

  try {
    const handled = await handleRequest(req as unknown as IncomingMessage, response, ctx);
    assert.equal(handled, true);
    assert.equal(state.statusCode, 200);
    assert.equal(state.headers['Content-Type'], 'text/event-stream');
    assert.ok(listener, 'expected status listener registration');

    assert.deepEqual(parseStatusSsePayload(state.writes[0]), {
      state: 'scanning',
      currentTaskId: 'task-1',
      currentTaskTitle: 'Title for task-1',
      patrolling: true,
      paused: false,
    });

    listener!({
      state: 'executing',
      currentTaskId: 'task-2',
      patrolling: true,
      paused: false,
    });
    await waitForSseWrite();

    assert.deepEqual(parseStatusSsePayload(state.writes[1]), {
      state: 'executing',
      currentTaskId: 'task-2',
      currentTaskTitle: 'Title for task-2',
      patrolling: true,
      paused: false,
    });
    assert.deepEqual(requestedTaskIds, ['task-1', 'task-2']);

    req.emit('close');
    assert.equal(intervalStub.getClearCallCount(), 1);
    assert.equal(removeCalls, 1);
  } finally {
    intervalStub.restore();
  }
});

test('GET /api/status/stream returns null title when task lookup throws', async () => {
  const req = createGetRequest('/api/status/stream');
  const { response, state } = createSseResponse();
  const intervalStub = stubHeartbeatInterval();
  let listener: ((snapshot: {
    state: string;
    currentTaskId: string | null;
    patrolling: boolean;
    paused: boolean;
  }) => void) | undefined;

  const ctx = {
    ...createContext(defaultCreateTask, async () => {
      throw new Error('task lookup failed');
    }),
    loop: {
      getState: () => 'planning',
      getCurrentTaskId: () => 'task-1',
      isPaused: () => false,
      isRunning: () => true,
      addStatusListener: (statusListener: (snapshot: {
        state: string;
        currentTaskId: string | null;
        patrolling: boolean;
        paused: boolean;
      }) => void): (() => void) => {
        listener = statusListener;
        return () => {};
      },
    } as unknown as RouteContext['loop'],
  };

  try {
    const handled = await handleRequest(req as unknown as IncomingMessage, response, ctx);
    assert.equal(handled, true);
    assert.ok(listener, 'expected status listener registration');

    assert.equal(parseStatusSsePayload(state.writes[0]).currentTaskTitle, null);

    listener!({
      state: 'executing',
      currentTaskId: 'task-2',
      patrolling: true,
      paused: false,
    });
    await waitForSseWrite();

    assert.equal(parseStatusSsePayload(state.writes[1]).currentTaskTitle, null);
    req.emit('close');
  } finally {
    intervalStub.restore();
  }
});

test('GET /api/status/stream skips task lookup when currentTaskId is null', async () => {
  const req = createGetRequest('/api/status/stream');
  const { response, state } = createSseResponse();
  const intervalStub = stubHeartbeatInterval();
  let getTaskCalls = 0;
  let listener: ((snapshot: {
    state: string;
    currentTaskId: string | null;
    patrolling: boolean;
    paused: boolean;
  }) => void) | undefined;

  const ctx = {
    ...createContext(defaultCreateTask, async () => {
      getTaskCalls += 1;
      return { task_description: 'should-not-be-called' };
    }),
    loop: {
      getState: () => 'idle',
      getCurrentTaskId: () => null,
      isPaused: () => false,
      isRunning: () => false,
      addStatusListener: (statusListener: (snapshot: {
        state: string;
        currentTaskId: string | null;
        patrolling: boolean;
        paused: boolean;
      }) => void): (() => void) => {
        listener = statusListener;
        return () => {};
      },
    } as unknown as RouteContext['loop'],
  };

  try {
    const handled = await handleRequest(req as unknown as IncomingMessage, response, ctx);
    assert.equal(handled, true);
    assert.ok(listener, 'expected status listener registration');

    assert.equal(parseStatusSsePayload(state.writes[0]).currentTaskTitle, null);
    assert.equal(getTaskCalls, 0);

    listener!({
      state: 'idle',
      currentTaskId: null,
      patrolling: false,
      paused: false,
    });
    await waitForSseWrite();

    assert.equal(parseStatusSsePayload(state.writes[1]).currentTaskTitle, null);
    assert.equal(getTaskCalls, 0);
    req.emit('close');
  } finally {
    intervalStub.restore();
  }
});

test('GET /api/status/stream cleans up heartbeat and status listener when heartbeat write is unsafe', async () => {
  const req = createGetRequest('/api/status/stream');
  const { response } = createSseResponse();
  const intervalStub = stubHeartbeatInterval();
  let removeCalls = 0;

  const ctx = {
    ...createContext(),
    loop: {
      getState: () => 'idle',
      getCurrentTaskId: () => null,
      isPaused: () => false,
      isRunning: () => false,
      addStatusListener: (_statusListener: (snapshot: {
        state: string;
        currentTaskId: string | null;
        patrolling: boolean;
        paused: boolean;
      }) => void): (() => void) => {
        return () => {
          removeCalls += 1;
        };
      },
    } as unknown as RouteContext['loop'],
  };

  try {
    const handled = await handleRequest(req as unknown as IncomingMessage, response, ctx);
    assert.equal(handled, true);

    response.destroyed = true;
    intervalStub.trigger();

    assert.equal(intervalStub.getClearCallCount(), 1);
    assert.equal(removeCalls, 1);

    req.emit('close');
    assert.equal(intervalStub.getClearCallCount(), 1);
    assert.equal(removeCalls, 1);
  } finally {
    intervalStub.restore();
  }
});

test('POST /api/tasks parses valid JSON from streamed chunks and creates the task', async () => {
  let callCount = 0;
  const ctx = createContext(async (projectPath, description, priority) => {
    callCount += 1;
    assert.equal(projectPath, '/tmp/project');
    assert.equal(description, 'Ship feature');
    assert.equal(priority, 1);
    return { id: 'task-123', description, priority };
  });

  const state = await runPostTasksRequest(
    createRequest(['{"description":"  Ship', ' feature  ","priority":1}']),
    ctx,
  );

  assert.equal(callCount, 1);
  assert.equal(state.statusCode, 201);
  assert.deepEqual(parseJsonBody(state), { id: 'task-123', description: 'Ship feature', priority: 1 });
});

test('POST /api/tasks treats an empty body as an empty object', async () => {
  let callCount = 0;
  const ctx = createContext(async () => {
    callCount += 1;
    return {};
  });

  const state = await runPostTasksRequest(createRequest(), ctx);

  assert.equal(callCount, 0);
  assert.equal(state.statusCode, 400);
  assert.deepEqual(parseJsonBody(state), {
    error: 'description is required and must be a non-empty string.',
  });
});

test('POST /api/tasks handles explicit JSON null body', async () => {
  const state = await runPostTasksRequest(createRequest('null'));

  assert.equal(state.statusCode, 400);
  assert.deepEqual(parseJsonBody(state), {
    error: 'Request body must be a JSON object.',
  });
});

test('POST /api/tasks returns 400 for malformed JSON', async () => {
  let callCount = 0;
  const ctx = createContext(async () => {
    callCount += 1;
    return {};
  });

  const state = await runPostTasksRequest(createRequest('{"description":"broken"'), ctx);

  assert.equal(callCount, 0);
  assert.equal(state.statusCode, 400);
  assert.deepEqual(parseJsonBody(state), { error: 'Invalid JSON' });
});

test('POST /api/tasks returns 500 when request stream fails', async () => {
  let callCount = 0;
  const ctx = createContext(async () => {
    callCount += 1;
    return {};
  });

  const state = await runPostTasksRequest(createErroredRequest(), ctx);

  assert.equal(callCount, 0);
  assert.equal(state.statusCode, 500);
  assert.deepEqual(parseJsonBody(state), { error: 'Failed to read request body.' });
});

test('POST /api/tasks returns 413 when request body exceeds the byte limit', async () => {
  let callCount = 0;
  const ctx = createContext(async () => {
    callCount += 1;
    return {};
  });
  const oversizedDescription = 'a'.repeat(MAX_REQUEST_BODY_BYTES);
  const state = await runPostTasksRequest(createRequest(`{"description":"${oversizedDescription}"}`), ctx);

  assert.equal(callCount, 0);
  assert.equal(state.statusCode, 413);
  assert.deepEqual(parseJsonBody(state), {
    error: `Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes.`,
  });
});

test('GET /api/logs follow stream cleans up heartbeat and logger listener when SSE write is unsafe', async () => {
  const req = createGetRequest('/api/logs?follow=true');
  const { response } = createSseResponse();
  const intervalStub = stubHeartbeatInterval();

  const loggerWithMutableListener = log as unknown as {
    addListener: (listener: (entry: LogEntry) => void) => () => void;
  };
  const originalAddListener = loggerWithMutableListener.addListener;
  let removeCalls = 0;
  loggerWithMutableListener.addListener = (_listener: (entry: LogEntry) => void): (() => void) => {
    return () => {
      removeCalls += 1;
    };
  };

  try {
    const handled = await handleRequest(req as unknown as IncomingMessage, response, createContext());
    assert.equal(handled, true);

    response.destroyed = true;
    intervalStub.trigger();

    assert.equal(intervalStub.getClearCallCount(), 1);
    assert.equal(removeCalls, 1);
  } finally {
    loggerWithMutableListener.addListener = originalAddListener;
    intervalStub.restore();
  }
});

test('GET /api/logs follow stream clears heartbeat interval when heartbeat write throws', async () => {
  const req = createGetRequest('/api/logs?follow=true');
  const { response } = createSseResponse({ throwOnWrite: true });
  const intervalStub = stubHeartbeatInterval();

  const loggerWithMutableListener = log as unknown as {
    addListener: (listener: (entry: LogEntry) => void) => () => void;
  };
  const originalAddListener = loggerWithMutableListener.addListener;
  let removeCalls = 0;
  loggerWithMutableListener.addListener = (_listener: (entry: LogEntry) => void): (() => void) => {
    return () => {
      removeCalls += 1;
    };
  };

  try {
    const handled = await handleRequest(req as unknown as IncomingMessage, response, createContext());
    assert.equal(handled, true);

    intervalStub.trigger();

    assert.equal(intervalStub.getClearCallCount(), 1);
    assert.equal(removeCalls, 1);
  } finally {
    loggerWithMutableListener.addListener = originalAddListener;
    intervalStub.restore();
  }
});

test('GET /api/plans/:id/stream cleans up heartbeat and plan listener when SSE write throws', async () => {
  const req = createGetRequest('/api/plans/7/stream');
  const { response } = createSseResponse({ throwOnWrite: true });
  const intervalStub = stubHeartbeatInterval();
  let removeCalls = 0;
  let listener: ((event: string, data: string) => void) | undefined;

  const ctx = {
    ...createContext(),
    planWorkflow: {
      addSSEListener: (draftId: number, sseListener: (event: string, data: string) => void): (() => void) => {
        assert.equal(draftId, 7);
        listener = sseListener;
        return () => {
          removeCalls += 1;
        };
      },
    } as unknown as NonNullable<RouteContext['planWorkflow']>,
  };

  try {
    const handled = await handleRequest(req as unknown as IncomingMessage, response, ctx);
    assert.equal(handled, true);
    assert.ok(listener, 'expected plan listener registration');

    listener!('status', '{"status":"ready"}');

    assert.equal(intervalStub.getClearCallCount(), 1);
    assert.equal(removeCalls, 1);

    req.emit('close');
    assert.equal(intervalStub.getClearCallCount(), 1);
    assert.equal(removeCalls, 1);
  } finally {
    intervalStub.restore();
  }
});
