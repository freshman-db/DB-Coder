import assert from 'node:assert/strict';
import test from 'node:test';

import type { Config } from '../config/Config.js';
import type { MainLoop } from '../core/MainLoop.js';
import type { GlobalMemory } from '../memory/GlobalMemory.js';
import type { TaskStore } from '../memory/TaskStore.js';
import type { CostTracker } from '../utils/cost.js';
import { Server } from './Server.js';

function createServer(apiToken: string): Server {
  const config = {
    projectPath: process.cwd(),
    values: {
      apiToken,
      server: { host: '127.0.0.1', port: 18800 },
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
