import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { handleRequest } from './routes.js';

const MAX_REQUEST_BODY_BYTES = 64 * 1024;

interface MockResponseState {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

type RouteContext = Parameters<typeof handleRequest>[2];

function createContext(
  createTask: (projectPath: string, description: string, priority: number) => Promise<unknown> = async (_projectPath, description, priority) => ({ id: 'task-1', description, priority }),
): RouteContext {
  return {
    loop: {} as RouteContext['loop'],
    taskStore: { createTask } as RouteContext['taskStore'],
    globalMemory: {} as RouteContext['globalMemory'],
    costTracker: {} as RouteContext['costTracker'],
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

function createRequest(body?: string): IncomingMessage {
  const req = createStreamRequest();
  if (body === undefined) {
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

async function runPostTasksRequest(req: IncomingMessage, ctx = createContext()): Promise<MockResponseState> {
  const { response, state } = createMockResponse();
  const handled = await handleRequest(req, response, ctx);
  assert.equal(handled, true);
  return state;
}

function parseJsonBody(state: MockResponseState): Record<string, unknown> {
  return JSON.parse(state.body) as Record<string, unknown>;
}

test('POST /api/tasks parses valid JSON body and creates the task', async () => {
  let callCount = 0;
  const ctx = createContext(async (projectPath, description, priority) => {
    callCount += 1;
    assert.equal(projectPath, '/tmp/project');
    assert.equal(description, 'Ship feature');
    assert.equal(priority, 1);
    return { id: 'task-123', description, priority };
  });

  const state = await runPostTasksRequest(createRequest('{"description":"  Ship feature  ","priority":1}'), ctx);

  assert.equal(callCount, 1);
  assert.equal(state.statusCode, 201);
  assert.deepEqual(parseJsonBody(state), { id: 'task-123', description: 'Ship feature', priority: 1 });
});

test('POST /api/tasks treats an empty body as an empty object', async () => {
  const state = await runPostTasksRequest(createRequest());

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
  const state = await runPostTasksRequest(createErroredRequest());

  assert.equal(state.statusCode, 500);
  assert.deepEqual(parseJsonBody(state), { error: 'Failed to read request body.' });
});

test('POST /api/tasks returns 413 when request body exceeds the byte limit', async () => {
  const oversizedDescription = 'a'.repeat(MAX_REQUEST_BODY_BYTES);
  const state = await runPostTasksRequest(createRequest(`{"description":"${oversizedDescription}"}`));

  assert.equal(state.statusCode, 413);
  assert.deepEqual(parseJsonBody(state), {
    error: `Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes.`,
  });
});
