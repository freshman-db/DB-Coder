import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { safeBuild, type SafeBuildDeps } from './safeBuild.js';

interface SafeBuildMockEnvironment {
  deps: SafeBuildDeps;
  existingPaths: Set<string>;
  operationLog: string[];
  runProcessCalls: Array<{ command: string; args: string[]; options: { cwd?: string; timeout?: number } | undefined }>;
  renameCalls: Array<[string, string]>;
  rmCalls: Array<[string, { recursive?: boolean; force?: boolean } | undefined]>;
  cpCalls: Array<[string, string, { recursive?: boolean } | undefined]>;
}

function removePath(pathSet: Set<string>, targetPath: string): void {
  for (const existingPath of [...pathSet]) {
    if (existingPath === targetPath || existingPath.startsWith(`${targetPath}/`)) {
      pathSet.delete(existingPath);
    }
  }
}

function createMockEnvironment(params: {
  existingPaths: string[];
  runProcessResult: { exitCode: number; stdout: string; stderr: string };
  failRenameOnCall?: number;
}): SafeBuildMockEnvironment {
  const existingPaths = new Set(params.existingPaths);
  const operationLog: string[] = [];
  const runProcessCalls: SafeBuildMockEnvironment['runProcessCalls'] = [];
  const renameCalls: Array<[string, string]> = [];
  const rmCalls: Array<[string, { recursive?: boolean; force?: boolean } | undefined]> = [];
  const cpCalls: Array<[string, string, { recursive?: boolean } | undefined]> = [];
  let renameCallCount = 0;

  const deps: SafeBuildDeps = {
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
    },
  };

  return { deps, existingPaths, operationLog, runProcessCalls, renameCalls, rmCalls, cpCalls };
}

test('safeBuild performs atomic swap when compilation succeeds', async () => {
  const projectPath = '/repo';
  const distDir = join(projectPath, 'dist');
  const tmpDir = join(projectPath, 'dist.tmp');
  const oldDir = join(projectPath, 'dist.old');
  const webSrc = join(projectPath, 'src', 'web');

  const env = createMockEnvironment({
    existingPaths: [distDir, webSrc],
    runProcessResult: { exitCode: 0, stdout: 'ok', stderr: '' },
  });

  const result = await safeBuild(projectPath, env.deps);

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
});

test('safeBuild leaves dist untouched when tsc fails and cleans dist.tmp', async () => {
  const projectPath = '/repo';
  const distDir = join(projectPath, 'dist');
  const tmpDir = join(projectPath, 'dist.tmp');
  const oldDir = join(projectPath, 'dist.old');
  const webSrc = join(projectPath, 'src', 'web');

  const env = createMockEnvironment({
    existingPaths: [distDir, webSrc],
    runProcessResult: { exitCode: 1, stdout: 'Type error', stderr: 'at src/main.ts:1' },
  });

  const result = await safeBuild(projectPath, env.deps);

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
});

test('safeBuild restores dist from dist.old when swap fails mid-way', async () => {
  const projectPath = '/repo';
  const distDir = join(projectPath, 'dist');
  const tmpDir = join(projectPath, 'dist.tmp');
  const oldDir = join(projectPath, 'dist.old');
  const webSrc = join(projectPath, 'src', 'web');

  const env = createMockEnvironment({
    existingPaths: [distDir, webSrc],
    runProcessResult: { exitCode: 0, stdout: '', stderr: '' },
    failRenameOnCall: 2,
  });

  const result = await safeBuild(projectPath, env.deps);

  assert.equal(result.success, false);
  assert.deepEqual(env.renameCalls, [
    [distDir, oldDir],
    [tmpDir, distDir],
    [oldDir, distDir],
  ]);
  assert.ok(env.existingPaths.has(distDir));
  assert.equal(env.existingPaths.has(oldDir), false);
});

test('safeBuild skips web copy when src/web does not exist', async () => {
  const projectPath = '/repo';
  const distDir = join(projectPath, 'dist');

  const env = createMockEnvironment({
    existingPaths: [distDir],
    runProcessResult: { exitCode: 0, stdout: '', stderr: '' },
  });

  const result = await safeBuild(projectPath, env.deps);

  assert.equal(result.success, true);
  assert.deepEqual(env.cpCalls, []);
});

test('safeBuild cleans leftover dist.tmp and dist.old before compiling', async () => {
  const projectPath = '/repo';
  const distDir = join(projectPath, 'dist');
  const tmpDir = join(projectPath, 'dist.tmp');
  const oldDir = join(projectPath, 'dist.old');

  const env = createMockEnvironment({
    existingPaths: [distDir, tmpDir, oldDir],
    runProcessResult: { exitCode: 1, stdout: 'fail', stderr: '' },
  });

  await safeBuild(projectPath, env.deps);

  assert.deepEqual(
    env.rmCalls.slice(0, 2).map(([path]) => path),
    [tmpDir, oldDir],
  );
});
