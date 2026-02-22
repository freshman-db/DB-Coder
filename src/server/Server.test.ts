import assert from 'node:assert/strict';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import test from 'node:test';

import type { Config } from '../config/Config.js';
import type { MainLoop } from '../core/MainLoop.js';
import type { GlobalMemory } from '../memory/GlobalMemory.js';
import type { TaskStore } from '../memory/TaskStore.js';
import type { CostTracker } from '../utils/cost.js';
import { Server } from './Server.js';

const MAX_REQUEST_BODY_BYTES = 64 * 1024;
type RequestListener = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

interface MockResponseState {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function createServer(apiToken: string, port = 18800): Server {
  const config = {
    projectPath: process.cwd(),
    values: {
      apiToken,
      server: { host: '127.0.0.1', port },
      evolution: { goals: [] },
    },
  } as unknown as Config;

  const loop = {} as MainLoop;
  const taskStore = {} as TaskStore;
  const globalMemory = {} as GlobalMemory;
  const costTracker = {} as CostTracker;

  return new Server(config, loop, taskStore, globalMemory, costTracker);
}

function authorize(server: Server, req: { method?: string; url?: string; headers?: Record<string, string | string[]> }): boolean {
  const instance = server as unknown as { isAuthorizedApiRequest: (request: unknown) => boolean };
  return instance.isAuthorizedApiRequest(req);
}

function getHttpServer(server: Server): HttpServer {
  const instance = server as unknown as { server: HttpServer };
  return instance.server;
}

function getRequestListener(server: Server): RequestListener {
  const [listener] = getHttpServer(server).listeners('request');
  assert.equal(typeof listener, 'function');
  return async (req, res) => {
    await listener(req, res);
  };
}

function createMockRequest(params: {
  method: string;
  url: string;
  headers: Record<string, string | string[]>;
  resume?: () => void;
}): IncomingMessage {
  const req = {
    method: params.method,
    url: params.url,
    headers: params.headers,
    resume: params.resume ?? (() => {}),
  } as Partial<IncomingMessage>;
  return req as IncomingMessage;
}

function createMockResponse(): { response: ServerResponse & { getHeader: (name: string) => string | undefined }; state: MockResponseState } {
  const state: MockResponseState = {
    statusCode: 200,
    headers: {},
    body: '',
  };

  const normalizeHeaderName = (name: string): string => name.toLowerCase();

  const response = {
    setHeader: (name: string, value: string): void => {
      state.headers[normalizeHeaderName(name)] = value;
    },
    getHeader: (name: string): string | undefined => state.headers[normalizeHeaderName(name)],
    writeHead: (statusCode: number, headers?: Record<string, string>): ServerResponse => {
      state.statusCode = statusCode;
      if (headers) {
        for (const [name, value] of Object.entries(headers)) {
          state.headers[normalizeHeaderName(name)] = value;
        }
      }
      return response as unknown as ServerResponse;
    },
    end: (chunk?: string | Buffer): void => {
      if (chunk === undefined) return;
      state.body += Buffer.isBuffer(chunk) ? chunk.toString() : chunk;
    },
  } as unknown as ServerResponse & { getHeader: (name: string) => string | undefined };

  return { response, state };
}

function assertSecurityHeaders(state: MockResponseState): void {
  assert.equal(state.headers['x-content-type-options'], 'nosniff');
  assert.equal(state.headers['x-frame-options'], 'SAMEORIGIN');
}

test('auth middleware requires bearer token on /api routes', () => {
  const server = createServer('secret-token');

  assert.equal(authorize(server, { method: 'GET', url: '/api/status', headers: {} }), false);
  assert.equal(authorize(server, { method: 'GET', url: '/api/status', headers: { authorization: 'Bearer wrong' } }), false);
  assert.equal(authorize(server, { method: 'GET', url: '/api/status', headers: { authorization: 'Bearer secret-token' } }), true);
  assert.equal(authorize(server, { method: 'GET', url: '/api/status', headers: { authorization: 'bearer secret-token' } }), true);
});

test('auth middleware exempts non-API and OPTIONS requests', () => {
  const server = createServer('secret-token');

  assert.equal(authorize(server, { method: 'GET', url: '/', headers: {} }), true);
  assert.equal(authorize(server, { method: 'OPTIONS', url: '/api/status', headers: {} }), true);
});

test('security headers are set before static routing', async () => {
  const server = createServer('secret-token');
  const listener = getRequestListener(server);
  const { response, state } = createMockResponse();
  const instance = server as unknown as { serveStatic: (req: IncomingMessage, res: ServerResponse) => void };
  let staticServed = false;

  instance.serveStatic = (_req, res) => {
    const inspectableResponse = res as ServerResponse & { getHeader: (name: string) => string | undefined };
    assert.equal(inspectableResponse.getHeader('X-Content-Type-Options'), 'nosniff');
    assert.equal(inspectableResponse.getHeader('X-Frame-Options'), 'SAMEORIGIN');
    staticServed = true;
    res.writeHead(204);
    res.end();
  };

  await listener(
    createMockRequest({ method: 'GET', url: '/', headers: { host: 'localhost' } }),
    response,
  );

  assert.equal(staticServed, true);
  assert.equal(state.statusCode, 204);
  assertSecurityHeaders(state);
});

test('security headers are included on unauthorized API responses', async () => {
  const server = createServer('secret-token');
  const listener = getRequestListener(server);
  const { response, state } = createMockResponse();
  let resumed = false;

  await listener(
    createMockRequest({
      method: 'GET',
      url: '/api/status',
      headers: { host: 'localhost' },
      resume: () => {
        resumed = true;
      },
    }),
    response,
  );

  assert.equal(resumed, true);
  assert.equal(state.statusCode, 401);
  assertSecurityHeaders(state);
});

test('security headers are included when API request exceeds body limit', async () => {
  const server = createServer('secret-token');
  const listener = getRequestListener(server);
  const { response, state } = createMockResponse();
  let resumed = false;

  await listener(
    createMockRequest({
      method: 'POST',
      url: '/api/tasks',
      headers: {
        host: 'localhost',
        authorization: 'Bearer secret-token',
        'content-length': String(MAX_REQUEST_BODY_BYTES + 1),
      },
      resume: () => {
        resumed = true;
      },
    }),
    response,
  );

  assert.equal(resumed, true);
  assert.equal(state.statusCode, 413);
  assert.equal(state.body, 'Payload Too Large');
  assertSecurityHeaders(state);
});

test('security headers are included on API preflight responses', async () => {
  const server = createServer('secret-token');
  const listener = getRequestListener(server);
  const { response, state } = createMockResponse();

  await listener(
    createMockRequest({
      method: 'OPTIONS',
      url: '/api/status',
      headers: { host: 'localhost' },
    }),
    response,
  );

  assert.equal(state.statusCode, 204);
  assertSecurityHeaders(state);
});
