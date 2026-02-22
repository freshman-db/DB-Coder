import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import type { BuildResult } from './safeBuild.js';

interface RunProcessOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  input?: string;
}

interface RunProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface SafeBuildMockDeps {
  runProcess: (command: string, args: string[], options?: RunProcessOptions) => Promise<RunProcessResult>;
  rename: (fromPath: string, toPath: string) => Promise<void>;
  rm: (targetPath: string, options?: { recursive?: boolean; force?: boolean }) => Promise<void>;
  cp: (sourcePath: string, targetPath: string, options?: { recursive?: boolean }) => Promise<void>;
  existsSync: (path: string) => boolean;
  log: {
    info: (message: string) => void;
    warn: (message: string, meta?: unknown) => void;
    debug: (message: string, meta?: unknown) => void;
  };
}

interface SafeBuildMockEnvironment {
  deps: SafeBuildMockDeps;
  existingPaths: Set<string>;
  operationLog: string[];
  runProcessCalls: Array<{ command: string; args: string[]; options: RunProcessOptions | undefined }>;
  renameCalls: Array<[string, string]>;
  rmCalls: Array<[string, { recursive?: boolean; force?: boolean } | undefined]>;
  cpCalls: Array<[string, string, { recursive?: boolean } | undefined]>;
}

const SAFE_BUILD_REGISTRY_KEY = '__safeBuildTestRegistry';
let safeBuildMockCounter = 0;

function toDataUrl(source: string): string {
  return `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
}

function getSafeBuildRegistry(): Record<string, SafeBuildMockDeps> {
  const globalRef = globalThis as typeof globalThis & {
    __safeBuildTestRegistry?: Record<string, SafeBuildMockDeps>;
  };
  globalRef.__safeBuildTestRegistry ??= {};
  return globalRef.__safeBuildTestRegistry;
}

async function loadSafeBuildWithMocks(
  deps: SafeBuildMockDeps,
): Promise<{ safeBuild: (projectPath: string) => Promise<BuildResult>; cleanup: () => void }> {
  const registry = getSafeBuildRegistry();
  const mockKey = `safe-build-${++safeBuildMockCounter}`;
  registry[mockKey] = deps;

  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const parentUrl = context.parentURL ?? '';
      if (!parentUrl.includes(`/safeBuild.js?mock=${mockKey}`)) {
        return nextResolve(specifier, context);
      }

      if (specifier === './process.js') {
        return {
          shortCircuit: true,
          url: toDataUrl(
            `export function runProcess(...args){return globalThis.${SAFE_BUILD_REGISTRY_KEY}[${JSON.stringify(mockKey)}].runProcess(...args);}`,
          ),
        };
      }

      if (specifier === 'node:fs/promises') {
        return {
          shortCircuit: true,
          url: toDataUrl(
            `export function rename(...args){return globalThis.${SAFE_BUILD_REGISTRY_KEY}[${JSON.stringify(mockKey)}].rename(...args);}
             export function rm(...args){return globalThis.${SAFE_BUILD_REGISTRY_KEY}[${JSON.stringify(mockKey)}].rm(...args);}
             export function cp(...args){return globalThis.${SAFE_BUILD_REGISTRY_KEY}[${JSON.stringify(mockKey)}].cp(...args);}`,
          ),
        };
      }

      if (specifier === 'node:fs') {
        return {
          shortCircuit: true,
          url: toDataUrl(
            `export function existsSync(...args){return globalThis.${SAFE_BUILD_REGISTRY_KEY}[${JSON.stringify(mockKey)}].existsSync(...args);}`,
          ),
        };
      }

      if (specifier === './logger.js') {
        return {
          shortCircuit: true,
          url: toDataUrl(`export const log = globalThis.${SAFE_BUILD_REGISTRY_KEY}[${JSON.stringify(mockKey)}].log;`),
        };
      }

      return nextResolve(specifier, context);
    },
  });

  try {
    const moduleUrl = new URL(`./safeBuild.js?mock=${mockKey}`, import.meta.url).href;
    const moduleRef = await import(moduleUrl) as { safeBuild: (projectPath: string) => Promise<BuildResult> };
    return {
      safeBuild: moduleRef.safeBuild,
      cleanup: () => {
        delete registry[mockKey];
      },
    };
  } finally {
    hooks.deregister();
  }
}

function removePath(pathSet: Set<string>, targetPath: string): void {
  for (const existingPath of [...pathSet]) {
    if (existingPath === targetPath || existingPath.startsWith(`${targetPath}/`)) {
      pathSet.delete(existingPath);
    }
  }
}

function createSafeBuildMockEnvironment(params: {
  existingPaths: string[];
  runProcessResult: RunProcessResult;
  failRenameOnCall?: number;
}): SafeBuildMockEnvironment {
  const existingPaths = new Set(params.existingPaths);
  const operationLog: string[] = [];
  const runProcessCalls: Array<{ command: string; args: string[]; options: RunProcessOptions | undefined }> = [];
  const renameCalls: Array<[string, string]> = [];
  const rmCalls: Array<[string, { recursive?: boolean; force?: boolean } | undefined]> = [];
  const cpCalls: Array<[string, string, { recursive?: boolean } | undefined]> = [];
  let renameCallCount = 0;

  const deps: SafeBuildMockDeps = {
    runProcess: async (command, args, options) => {
      runProcessCalls.push({ command, args: [...args], options });
      if (params.runProcessResult.exitCode === 0) {
        const outDirIndex = args.indexOf('--outDir');
        const outDir = outDirIndex >= 0 ? args[outDirIndex + 1] : undefined;
        if (outDir) {
          existingPaths.add(outDir);
        }
      }
      return params.runProcessResult;
    },
    rename: async (fromPath, toPath) => {
      renameCallCount += 1;
      renameCalls.push([fromPath, toPath]);
      operationLog.push(`rename:${fromPath}->${toPath}`);
      if (params.failRenameOnCall === renameCallCount) {
        throw new Error(`rename failure on call ${renameCallCount}`);
      }
      if (!existingPaths.has(fromPath)) {
        throw new Error(`ENOENT: missing ${fromPath}`);
      }
      existingPaths.delete(fromPath);
      existingPaths.add(toPath);
    },
    rm: async (targetPath, options) => {
      rmCalls.push([targetPath, options]);
      operationLog.push(`rm:${targetPath}`);
      removePath(existingPaths, targetPath);
    },
    cp: async (sourcePath, targetPath, options) => {
      cpCalls.push([sourcePath, targetPath, options]);
      operationLog.push(`cp:${sourcePath}->${targetPath}`);
      if (!existingPaths.has(sourcePath)) {
        throw new Error(`ENOENT: missing ${sourcePath}`);
      }
      existingPaths.add(targetPath);
    },
    existsSync: (path) => existingPaths.has(path),
    log: {
      info: () => {},
      warn: () => {},
      debug: () => {},
    },
  };

  return {
    deps,
    existingPaths,
    operationLog,
    runProcessCalls,
    renameCalls,
    rmCalls,
    cpCalls,
  };
}

test('safeBuild performs atomic swap when compilation succeeds', async () => {
  const projectPath = '/repo';
  const distDir = join(projectPath, 'dist');
  const tmpDir = join(projectPath, 'dist.tmp');
  const oldDir = join(projectPath, 'dist.old');
  const webSrc = join(projectPath, 'src', 'web');

  const env = createSafeBuildMockEnvironment({
    existingPaths: [distDir, webSrc],
    runProcessResult: { exitCode: 0, stdout: 'ok', stderr: '' },
  });
  const { safeBuild, cleanup } = await loadSafeBuildWithMocks(env.deps);

  try {
    const result = await safeBuild(projectPath);

    assert.equal(result.success, true);
    assert.equal(result.error, '');
    assert.equal(env.runProcessCalls.length, 1);
    assert.deepEqual(env.runProcessCalls[0], {
      command: 'npx',
      args: ['tsc', '--outDir', tmpDir],
      options: { cwd: projectPath, timeout: 120_000 },
    });
    assert.deepEqual(env.cpCalls, [
      [webSrc, join(tmpDir, 'web'), { recursive: true }],
    ]);
    assert.deepEqual(env.renameCalls, [
      [distDir, oldDir],
      [tmpDir, distDir],
    ]);

    const swapStart = env.operationLog.indexOf(`rename:${distDir}->${oldDir}`);
    assert.notEqual(swapStart, -1);
    assert.deepEqual(env.operationLog.slice(swapStart, swapStart + 3), [
      `rename:${distDir}->${oldDir}`,
      `rename:${tmpDir}->${distDir}`,
      `rm:${oldDir}`,
    ]);
    assert.ok(env.existingPaths.has(distDir));
    assert.equal(env.existingPaths.has(oldDir), false);
  } finally {
    cleanup();
  }
});

test('safeBuild leaves dist untouched when tsc fails and cleans dist.tmp', async () => {
  const projectPath = '/repo';
  const distDir = join(projectPath, 'dist');
  const tmpDir = join(projectPath, 'dist.tmp');
  const oldDir = join(projectPath, 'dist.old');
  const webSrc = join(projectPath, 'src', 'web');

  const env = createSafeBuildMockEnvironment({
    existingPaths: [distDir, webSrc],
    runProcessResult: { exitCode: 1, stdout: 'Type error', stderr: 'at src/main.ts:1' },
  });
  const { safeBuild, cleanup } = await loadSafeBuildWithMocks(env.deps);

  try {
    const result = await safeBuild(projectPath);

    assert.equal(result.success, false);
    assert.match(result.error, /Type error/);
    assert.match(result.error, /src\/main\.ts:1/);
    assert.deepEqual(env.renameCalls, []);
    assert.deepEqual(env.cpCalls, []);
    assert.deepEqual(
      env.rmCalls.map(([path]) => path),
      [tmpDir, oldDir, tmpDir],
    );
    assert.ok(env.existingPaths.has(distDir));
  } finally {
    cleanup();
  }
});

test('safeBuild restores dist from dist.old when swap fails mid-way', async () => {
  const projectPath = '/repo';
  const distDir = join(projectPath, 'dist');
  const tmpDir = join(projectPath, 'dist.tmp');
  const oldDir = join(projectPath, 'dist.old');
  const webSrc = join(projectPath, 'src', 'web');

  const env = createSafeBuildMockEnvironment({
    existingPaths: [distDir, webSrc],
    runProcessResult: { exitCode: 0, stdout: '', stderr: '' },
    failRenameOnCall: 2,
  });
  const { safeBuild, cleanup } = await loadSafeBuildWithMocks(env.deps);

  try {
    const result = await safeBuild(projectPath);

    assert.equal(result.success, false);
    assert.deepEqual(env.renameCalls, [
      [distDir, oldDir],
      [tmpDir, distDir],
      [oldDir, distDir],
    ]);
    assert.ok(env.existingPaths.has(distDir));
    assert.equal(env.existingPaths.has(oldDir), false);
  } finally {
    cleanup();
  }
});

test('safeBuild skips web copy when src/web does not exist', async () => {
  const projectPath = '/repo';
  const distDir = join(projectPath, 'dist');

  const env = createSafeBuildMockEnvironment({
    existingPaths: [distDir],
    runProcessResult: { exitCode: 0, stdout: '', stderr: '' },
  });
  const { safeBuild, cleanup } = await loadSafeBuildWithMocks(env.deps);

  try {
    const result = await safeBuild(projectPath);

    assert.equal(result.success, true);
    assert.deepEqual(env.cpCalls, []);
  } finally {
    cleanup();
  }
});

test('safeBuild cleans leftover dist.tmp and dist.old before compiling', async () => {
  const projectPath = '/repo';
  const distDir = join(projectPath, 'dist');
  const tmpDir = join(projectPath, 'dist.tmp');
  const oldDir = join(projectPath, 'dist.old');

  const env = createSafeBuildMockEnvironment({
    existingPaths: [distDir, tmpDir, oldDir],
    runProcessResult: { exitCode: 1, stdout: 'fail', stderr: '' },
  });
  const { safeBuild, cleanup } = await loadSafeBuildWithMocks(env.deps);

  try {
    await safeBuild(projectPath);

    assert.deepEqual(
      env.rmCalls.slice(0, 2).map(([path]) => path),
      [tmpDir, oldDir],
    );
  } finally {
    cleanup();
  }
});
