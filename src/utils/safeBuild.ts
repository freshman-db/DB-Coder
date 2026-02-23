import { join } from 'node:path';
import { rename as fsRename, rm as fsRm, cp as fsCp } from 'node:fs/promises';
import { existsSync as fsExistsSync } from 'node:fs';
import { runProcess as defaultRunProcess } from './process.js';
import { log as defaultLog } from './logger.js';

export interface BuildResult {
  success: boolean;
  error: string;
  durationMs: number;
}

export interface SafeBuildDeps {
  runProcess: (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  rename: (from: string, to: string) => Promise<void>;
  rm: (target: string, options?: { recursive?: boolean; force?: boolean }) => Promise<void>;
  cp: (source: string, target: string, options?: { recursive?: boolean }) => Promise<void>;
  existsSync: (path: string) => boolean;
  log: { info: (message: string, meta?: unknown) => void; warn: (message: string, meta?: unknown) => void };
}

const defaultDeps: SafeBuildDeps = {
  runProcess: defaultRunProcess,
  rename: fsRename,
  rm: fsRm,
  cp: fsCp,
  existsSync: fsExistsSync,
  log: defaultLog,
};

/**
 * Compile TypeScript to a temporary directory, then atomically swap with dist/.
 * If compilation fails, dist/ remains untouched.
 */
export async function safeBuild(projectPath: string, deps: SafeBuildDeps = defaultDeps): Promise<BuildResult> {
  const { runProcess, rename, rm, cp, existsSync, log } = deps;
  const distDir = join(projectPath, 'dist');
  const tmpDir = join(projectPath, 'dist.tmp');
  const oldDir = join(projectPath, 'dist.old');
  const webSrc = join(projectPath, 'src', 'web');
  const start = Date.now();

  // Clean up any leftover temp dirs from previous failed attempts
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  await rm(oldDir, { recursive: true, force: true }).catch(() => {});

  try {
    // Step 1: Compile to dist.tmp/
    log.info('safeBuild: compiling to dist.tmp/');
    const tscResult = await runProcess('npx', ['tsc', '--outDir', tmpDir], {
      cwd: projectPath,
      timeout: 120_000,
    });

    if (tscResult.exitCode !== 0) {
      const errorOutput = (tscResult.stdout + '\n' + tscResult.stderr).trim();
      log.warn('safeBuild: compilation failed', { exitCode: tscResult.exitCode });
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      return { success: false, error: errorOutput, durationMs: Date.now() - start };
    }

    // Step 2: Copy web assets (not compiled by tsc)
    if (existsSync(webSrc)) {
      await cp(webSrc, join(tmpDir, 'web'), { recursive: true });
    }

    // Step 3: Atomic swap — rename(dist, dist.old) → rename(dist.tmp, dist) → rm(dist.old)
    log.info('safeBuild: swapping dist/ directories');
    if (existsSync(distDir)) {
      await rename(distDir, oldDir);
    }
    await rename(tmpDir, distDir);
    await rm(oldDir, { recursive: true, force: true }).catch(() => {});

    const durationMs = Date.now() - start;
    log.info(`safeBuild: success (${Math.round(durationMs / 1000)}s)`);
    return { success: true, error: '', durationMs };
  } catch (err) {
    // If swap failed mid-way, try to restore from dist.old
    if (!existsSync(distDir) && existsSync(oldDir)) {
      await rename(oldDir, distDir).catch(() => {});
    }
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await rm(oldDir, { recursive: true, force: true }).catch(() => {});

    const error = err instanceof Error ? err.message : String(err);
    return { success: false, error, durationMs: Date.now() - start };
  }
}
