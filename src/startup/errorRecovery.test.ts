import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import type { TaskStore } from '../memory/TaskStore.js';
import { checkAndRecoverErrors, type ErrorRecoveryDeps } from './errorRecovery.js';

function createMockDeps(params: {
  homeDir: string;
  files: Record<string, string>;
}): {
  deps: ErrorRecoveryDeps;
  existsCalls: string[];
  readCalls: string[];
  unlinkCalls: string[];
  warnLogs: string[];
} {
  const existingPaths = new Set(Object.keys(params.files));
  const fileContents = new Map(Object.entries(params.files));
  const existsCalls: string[] = [];
  const readCalls: string[] = [];
  const unlinkCalls: string[] = [];
  const warnLogs: string[] = [];

  const deps: ErrorRecoveryDeps = {
    existsSync: (path) => {
      existsCalls.push(path);
      return existingPaths.has(path);
    },
    readFileSync: (path) => {
      readCalls.push(path);
      const contents = fileContents.get(path);
      if (contents === undefined) throw new Error(`ENOENT: missing ${path}`);
      return contents;
    },
    unlinkSync: (path) => {
      unlinkCalls.push(path);
      existingPaths.delete(path);
      fileContents.delete(path);
    },
    homedir: () => params.homeDir,
    log: {
      warn: (message) => { warnLogs.push(message); },
      info: () => {},
    },
  };

  return { deps, existsCalls, readCalls, unlinkCalls, warnLogs };
}

function createErrorFile(type: 'build' | 'startup', error: string): string {
  return JSON.stringify({
    timestamp: '2026-02-22T00:00:00.000Z',
    type,
    error,
    projectPath: '/from-error-file',
  });
}

function getErrorFilePath(homeDir: string, filename: 'build-error.json' | 'startup-error.json'): string {
  return join(homeDir, '.db-coder', filename);
}

test('checkAndRecoverErrors creates a P0 task for build-error.json and removes the file', async () => {
  const homeDir = '/mock-home';
  const buildErrorPath = getErrorFilePath(homeDir, 'build-error.json');
  const mock = createMockDeps({
    homeDir,
    files: { [buildErrorPath]: createErrorFile('build', 'TypeScript compilation failed') },
  });
  const createTaskCalls: Array<{ projectPath: string; description: string; priority: number | undefined }> = [];
  const taskStore = {
    createTask: async (projectPath: string, description: string, priority?: number) => {
      createTaskCalls.push({ projectPath, description, priority });
      return {} as Awaited<ReturnType<TaskStore['createTask']>>;
    },
  } as unknown as TaskStore;

  const recovered = await checkAndRecoverErrors(taskStore, '/project', mock.deps);

  assert.equal(recovered, 1);
  assert.equal(createTaskCalls.length, 1);
  assert.equal(createTaskCalls[0]?.projectPath, '/project');
  assert.equal(createTaskCalls[0]?.priority, 0);
  assert.match(createTaskCalls[0]?.description ?? '', /\[AUTO-RECOVERY\] Build failure:/);
  assert.match(createTaskCalls[0]?.description ?? '', /TypeScript compilation failed/);
  assert.deepEqual(mock.unlinkCalls, [buildErrorPath]);
});

test('checkAndRecoverErrors creates a P0 task for startup-error.json and removes the file', async () => {
  const homeDir = '/mock-home';
  const startupErrorPath = getErrorFilePath(homeDir, 'startup-error.json');
  const mock = createMockDeps({
    homeDir,
    files: { [startupErrorPath]: createErrorFile('startup', 'Process crashed during boot') },
  });
  const createTaskCalls: Array<{ description: string; priority: number | undefined }> = [];
  const taskStore = {
    createTask: async (_projectPath: string, description: string, priority?: number) => {
      createTaskCalls.push({ description, priority });
      return {} as Awaited<ReturnType<TaskStore['createTask']>>;
    },
  } as unknown as TaskStore;

  const recovered = await checkAndRecoverErrors(taskStore, '/project', mock.deps);

  assert.equal(recovered, 1);
  assert.equal(createTaskCalls[0]?.priority, 0);
  assert.match(createTaskCalls[0]?.description ?? '', /\[AUTO-RECOVERY\] Startup crash:/);
  assert.deepEqual(mock.unlinkCalls, [startupErrorPath]);
});

test('checkAndRecoverErrors removes corrupt JSON files and does not create tasks', async () => {
  const homeDir = '/mock-home';
  const buildErrorPath = getErrorFilePath(homeDir, 'build-error.json');
  const mock = createMockDeps({
    homeDir,
    files: { [buildErrorPath]: '{not-json}' },
  });
  let createTaskCount = 0;
  const taskStore = {
    createTask: async () => {
      createTaskCount += 1;
      return {} as Awaited<ReturnType<TaskStore['createTask']>>;
    },
  } as unknown as TaskStore;

  const recovered = await checkAndRecoverErrors(taskStore, '/project', mock.deps);

  assert.equal(recovered, 0);
  assert.equal(createTaskCount, 0);
  assert.deepEqual(mock.unlinkCalls, [buildErrorPath]);
  assert.ok(mock.warnLogs.some((message) => message.includes('Failed to process error file build-error.json')));
});

test('checkAndRecoverErrors returns 0 when no error files are present', async () => {
  const homeDir = '/mock-home';
  const buildErrorPath = getErrorFilePath(homeDir, 'build-error.json');
  const startupErrorPath = getErrorFilePath(homeDir, 'startup-error.json');
  const mock = createMockDeps({
    homeDir,
    files: {},
  });
  let createTaskCount = 0;
  const taskStore = {
    createTask: async () => {
      createTaskCount += 1;
      return {} as Awaited<ReturnType<TaskStore['createTask']>>;
    },
  } as unknown as TaskStore;

  const recovered = await checkAndRecoverErrors(taskStore, '/project', mock.deps);

  assert.equal(recovered, 0);
  assert.equal(createTaskCount, 0);
  assert.deepEqual(mock.readCalls, []);
  assert.deepEqual(mock.unlinkCalls, []);
  assert.deepEqual(mock.existsCalls, [buildErrorPath, startupErrorPath]);
});

test('checkAndRecoverErrors logs and still cleans up files when createTask fails', async () => {
  const homeDir = '/mock-home';
  const buildErrorPath = getErrorFilePath(homeDir, 'build-error.json');
  const mock = createMockDeps({
    homeDir,
    files: { [buildErrorPath]: createErrorFile('build', 'Compiler panic') },
  });
  const taskStore = {
    createTask: async () => {
      throw new Error('database unavailable');
    },
  } as unknown as TaskStore;

  const recovered = await checkAndRecoverErrors(taskStore, '/project', mock.deps);

  assert.equal(recovered, 0);
  assert.deepEqual(mock.unlinkCalls, [buildErrorPath]);
  assert.ok(mock.warnLogs.some((message) => message.includes('Failed to process error file build-error.json')));
});
