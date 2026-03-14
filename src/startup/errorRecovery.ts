import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { TaskStore } from "../memory/TaskStore.js";
import { log } from "../utils/logger.js";

const BUILD_ERROR_FILE = "build-error.json";
const STARTUP_ERROR_FILE = "startup-error.json";

interface ErrorFile {
  timestamp: string;
  type: "build" | "startup";
  error: string;
  projectPath?: string;
}

export interface ErrorRecoveryDeps {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: BufferEncoding) => string;
  unlinkSync: (path: string) => void;
  homedir: () => string;
  log: { warn: (message: string) => void; info?: (message: string) => void };
}

const defaultDeps: ErrorRecoveryDeps = {
  existsSync,
  readFileSync,
  unlinkSync,
  homedir,
  log,
};

/**
 * Check for error files left by previous failed builds or startup crashes.
 * Creates P0 recovery tasks for each and removes the files.
 * Returns the number of recovery tasks created.
 */
export async function checkAndRecoverErrors(
  taskStore: TaskStore,
  projectPath: string,
  deps: ErrorRecoveryDeps = defaultDeps,
): Promise<number> {
  const errorDir = join(deps.homedir(), ".db-coder");
  let recovered = 0;

  for (const filename of [BUILD_ERROR_FILE, STARTUP_ERROR_FILE]) {
    const filePath = join(errorDir, filename);
    if (!deps.existsSync(filePath)) continue;

    try {
      const raw = deps.readFileSync(filePath, "utf-8");
      const errorData = JSON.parse(raw) as ErrorFile;

      const errorType =
        errorData.type === "build" ? "Build failure" : "Startup crash";
      const description = `[AUTO-RECOVERY] ${errorType}: ${errorData.error.slice(0, 500)}`;

      await taskStore.createTask(projectPath, description, 0, [], {
        spawnReason: "error-recovery",
      }); // P0 = urgent
      deps.log.warn(`Created P0 recovery task for ${errorType}`);
      recovered++;

      deps.unlinkSync(filePath);
    } catch (err) {
      deps.log.warn(`Failed to process error file ${filename}: ${err}`);
      // Remove corrupt file to avoid infinite loop
      try {
        deps.unlinkSync(filePath);
      } catch {
        /* ignore */
      }
    }
  }

  return recovered;
}
