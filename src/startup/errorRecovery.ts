import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { TaskStore } from '../memory/TaskStore.js';
import { log } from '../utils/logger.js';

const ERROR_DIR = join(homedir(), '.db-coder');
const BUILD_ERROR_FILE = 'build-error.json';
const STARTUP_ERROR_FILE = 'startup-error.json';

interface ErrorFile {
  timestamp: string;
  type: 'build' | 'startup';
  error: string;
  projectPath?: string;
}

/**
 * Check for error files left by previous failed builds or startup crashes.
 * Creates P0 recovery tasks for each and removes the files.
 * Returns the number of recovery tasks created.
 */
export async function checkAndRecoverErrors(
  taskStore: TaskStore,
  projectPath: string,
): Promise<number> {
  let recovered = 0;

  for (const filename of [BUILD_ERROR_FILE, STARTUP_ERROR_FILE]) {
    const filePath = join(ERROR_DIR, filename);
    if (!existsSync(filePath)) continue;

    try {
      const raw = readFileSync(filePath, 'utf-8');
      const errorData = JSON.parse(raw) as ErrorFile;

      const errorType = errorData.type === 'build' ? 'Build failure' : 'Startup crash';
      const description = `[AUTO-RECOVERY] ${errorType}: ${errorData.error.slice(0, 500)}`;

      await taskStore.createTask(projectPath, description, 0); // P0 = urgent
      log.warn(`Created P0 recovery task for ${errorType}`);
      recovered++;

      unlinkSync(filePath);
    } catch (err) {
      log.warn(`Failed to process error file ${filename}: ${err}`);
      // Remove corrupt file to avoid infinite loop
      try { unlinkSync(filePath); } catch { /* ignore */ }
    }
  }

  return recovered;
}
