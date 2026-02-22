import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import type { TaskStore } from '../memory/TaskStore.js';

interface ErrorRecoveryMockDeps {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: BufferEncoding) => string;
  unlinkSync: (path: string) => void;
  homedir: () => string;
  log: {
    warn: (message: string) => void;
    info: (message: string) => void;
    error: (message: string) => void;
    debug: (message: string) => void;
  };
}

interface ErrorRecoveryMockEnvironment {
  deps: ErrorRecoveryMockDeps;
  existingPaths: Set<string>;
  existsCalls: string[];
  readCalls: string[];
  unlinkCalls: string[];
  warnLogs: string[];
}

const ERROR_RECOVERY_REGISTRY_KEY = '__errorRecoveryTestRegistry';
let errorRecoveryMockCounter = 0;

function toDataUrl(source: string): string {
  return `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
}

function getErrorRecoveryRegistry(): Record<string, ErrorRecoveryMockDeps> {
  const globalRef = globalThis as typeof globalThis & {
    __errorRecoveryTestRegistry?: Record<string, ErrorRecoveryMockDeps>;
  };
  globalRef.__errorRecoveryTestRegistry ??= {};
  return globalRef.__errorRecoveryTestRegistry;
}

async function loadErrorRecoveryWithMocks(
  deps: ErrorRecoveryMockDeps,
): Promise<{ checkAndRecoverErrors: (taskStore: TaskStore, projectPath: string) => Promise<number>; cleanup: () => void }> {
  const registry = getErrorRecoveryRegistry();
  const mockKey = `error-recovery-${++errorRecoveryMockCounter}`;
  registry[mockKey] = deps;

  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const parentUrl = context.parentURL ?? '';
      if (!parentUrl.includes(`/errorRecovery.js?mock=${mockKey}`)) {
        return nextResolve(specifier, context);
      }

      if (specifier === 'node:fs') {
        return {
          shortCircuit: true,
          url: toDataUrl(
            `export function existsSync(...args){return globalThis.${ERROR_RECOVERY_REGISTRY_KEY}[${JSON.stringify(mockKey)}].existsSync(...args);}
             export function readFileSync(...args){return globalThis.${ERROR_RECOVERY_REGISTRY_KEY}[${JSON.stringify(mockKey)}].readFileSync(...args);}
             export function unlinkSync(...args){return globalThis.${ERROR_RECOVERY_REGISTRY_KEY}[${JSON.stringify(mockKey)}].unlinkSync(...args);}`,
          ),
        };
      }

      if (specifier === 'node:os') {
        return {
          shortCircuit: true,
          url: toDataUrl(
            `export function homedir(...args){return globalThis.${ERROR_RECOVERY_REGISTRY_KEY}[${JSON.stringify(mockKey)}].homedir(...args);}`,
          ),
        };
      }

      if (specifier === '../utils/logger.js') {
        return {
          shortCircuit: true,
          url: toDataUrl(`export const log = globalThis.${ERROR_RECOVERY_REGISTRY_KEY}[${JSON.stringify(mockKey)}].log;`),
        };
      }

      return nextResolve(specifier, context);
    },
  });

  try {
    const moduleUrl = new URL(`./errorRecovery.js?mock=${mockKey}`, import.meta.url).href;
    const moduleRef = await import(moduleUrl) as {
      checkAndRecoverErrors: (taskStore: TaskStore, projectPath: string) => Promise<number>;
    };
    return {
      checkAndRecoverErrors: moduleRef.checkAndRecoverErrors,
      cleanup: () => {
        delete registry[mockKey];
      },
    };
  } finally {
    hooks.deregister();
  }
}

function createErrorRecoveryMockEnvironment(params: {
  homeDir: string;
  files: Record<string, string>;
}): ErrorRecoveryMockEnvironment {
  const existingPaths = new Set(Object.keys(params.files));
  const fileContents = new Map(Object.entries(params.files));
  const existsCalls: string[] = [];
  const readCalls: string[] = [];
  const unlinkCalls: string[] = [];
  const warnLogs: string[] = [];

  const deps: ErrorRecoveryMockDeps = {
    existsSync: (path) => {
      existsCalls.push(path);
      return existingPaths.has(path);
    },
    readFileSync: (path) => {
      readCalls.push(path);
      const contents = fileContents.get(path);
      if (contents === undefined) {
        throw new Error(`ENOENT: missing ${path}`);
      }
      return contents;
    },
    unlinkSync: (path) => {
      unlinkCalls.push(path);
      existingPaths.delete(path);
      fileContents.delete(path);
    },
    homedir: () => params.homeDir,
    log: {
      warn: (message) => {
        warnLogs.push(message);
      },
      info: () => {},
      error: () => {},
      debug: () => {},
    },
  };

  return {
    deps,
    existingPaths,
    existsCalls,
    readCalls,
    unlinkCalls,
    warnLogs,
  };
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
  const env = createErrorRecoveryMockEnvironment({
    homeDir,
    files: {
      [buildErrorPath]: createErrorFile('build', 'TypeScript compilation failed'),
    },
  });
  const createTaskCalls: Array<{ projectPath: string; description: string; priority: number | undefined }> = [];
  const taskStore = {
    createTask: async (projectPath: string, description: string, priority?: number) => {
      createTaskCalls.push({ projectPath, description, priority });
      return {} as Awaited<ReturnType<TaskStore['createTask']>>;
    },
  } as unknown as TaskStore;
  const { checkAndRecoverErrors, cleanup } = await loadErrorRecoveryWithMocks(env.deps);

  try {
    const recovered = await checkAndRecoverErrors(taskStore, '/project');

    assert.equal(recovered, 1);
    assert.equal(createTaskCalls.length, 1);
    assert.equal(createTaskCalls[0]?.projectPath, '/project');
    assert.equal(createTaskCalls[0]?.priority, 0);
    assert.match(createTaskCalls[0]?.description ?? '', /\[AUTO-RECOVERY\] Build failure:/);
    assert.match(createTaskCalls[0]?.description ?? '', /TypeScript compilation failed/);
    assert.deepEqual(env.unlinkCalls, [buildErrorPath]);
  } finally {
    cleanup();
  }
});

test('checkAndRecoverErrors creates a P0 task for startup-error.json and removes the file', async () => {
  const homeDir = '/mock-home';
  const startupErrorPath = getErrorFilePath(homeDir, 'startup-error.json');
  const env = createErrorRecoveryMockEnvironment({
    homeDir,
    files: {
      [startupErrorPath]: createErrorFile('startup', 'Process crashed during boot'),
    },
  });
  const createTaskCalls: Array<{ description: string; priority: number | undefined }> = [];
  const taskStore = {
    createTask: async (_projectPath: string, description: string, priority?: number) => {
      createTaskCalls.push({ description, priority });
      return {} as Awaited<ReturnType<TaskStore['createTask']>>;
    },
  } as unknown as TaskStore;
  const { checkAndRecoverErrors, cleanup } = await loadErrorRecoveryWithMocks(env.deps);

  try {
    const recovered = await checkAndRecoverErrors(taskStore, '/project');

    assert.equal(recovered, 1);
    assert.equal(createTaskCalls[0]?.priority, 0);
    assert.match(createTaskCalls[0]?.description ?? '', /\[AUTO-RECOVERY\] Startup crash:/);
    assert.deepEqual(env.unlinkCalls, [startupErrorPath]);
  } finally {
    cleanup();
  }
});

test('checkAndRecoverErrors removes corrupt JSON files and does not create tasks', async () => {
  const homeDir = '/mock-home';
  const buildErrorPath = getErrorFilePath(homeDir, 'build-error.json');
  const env = createErrorRecoveryMockEnvironment({
    homeDir,
    files: {
      [buildErrorPath]: '{not-json}',
    },
  });
  let createTaskCount = 0;
  const taskStore = {
    createTask: async () => {
      createTaskCount += 1;
      return {} as Awaited<ReturnType<TaskStore['createTask']>>;
    },
  } as unknown as TaskStore;
  const { checkAndRecoverErrors, cleanup } = await loadErrorRecoveryWithMocks(env.deps);

  try {
    const recovered = await checkAndRecoverErrors(taskStore, '/project');

    assert.equal(recovered, 0);
    assert.equal(createTaskCount, 0);
    assert.deepEqual(env.unlinkCalls, [buildErrorPath]);
    assert.ok(env.warnLogs.some((message) => message.includes('Failed to process error file build-error.json')));
  } finally {
    cleanup();
  }
});

test('checkAndRecoverErrors returns 0 when no error files are present', async () => {
  const homeDir = '/mock-home';
  const buildErrorPath = getErrorFilePath(homeDir, 'build-error.json');
  const startupErrorPath = getErrorFilePath(homeDir, 'startup-error.json');
  const env = createErrorRecoveryMockEnvironment({
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
  const { checkAndRecoverErrors, cleanup } = await loadErrorRecoveryWithMocks(env.deps);

  try {
    const recovered = await checkAndRecoverErrors(taskStore, '/project');

    assert.equal(recovered, 0);
    assert.equal(createTaskCount, 0);
    assert.deepEqual(env.readCalls, []);
    assert.deepEqual(env.unlinkCalls, []);
    assert.deepEqual(env.existsCalls, [buildErrorPath, startupErrorPath]);
  } finally {
    cleanup();
  }
});

test('checkAndRecoverErrors logs and still cleans up files when createTask fails', async () => {
  const homeDir = '/mock-home';
  const buildErrorPath = getErrorFilePath(homeDir, 'build-error.json');
  const env = createErrorRecoveryMockEnvironment({
    homeDir,
    files: {
      [buildErrorPath]: createErrorFile('build', 'Compiler panic'),
    },
  });
  const taskStore = {
    createTask: async () => {
      throw new Error('database unavailable');
    },
  } as unknown as TaskStore;
  const { checkAndRecoverErrors, cleanup } = await loadErrorRecoveryWithMocks(env.deps);

  try {
    const recovered = await checkAndRecoverErrors(taskStore, '/project');

    assert.equal(recovered, 0);
    assert.deepEqual(env.unlinkCalls, [buildErrorPath]);
    assert.ok(env.warnLogs.some((message) => message.includes('Failed to process error file build-error.json')));
  } finally {
    cleanup();
  }
});
