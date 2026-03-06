import { execFile } from "node:child_process";
import type { DbCoderConfig, RoutingConfig } from "../config/types.js";
import { log } from "../utils/logger.js";
import {
  ConfigValidationError,
  validateConfig,
} from "../utils/validateConfig.js";

export function validateConfigForStartup(
  config: DbCoderConfig,
  projectPath: string,
): boolean {
  try {
    validateConfig(config, projectPath);
    return true;
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      log.error(err.message);
      return false;
    }
    throw err;
  }
}

/**
 * Check that runtimes referenced in routing config are actually available.
 * Returns an array of issue strings (empty = all good).
 * Currently only codex-cli requires a real check; claude-sdk is always available.
 */
export async function validateRuntimeAvailability(
  routing: RoutingConfig,
): Promise<string[]> {
  const issues: string[] = [];

  // Collect phases that reference codex / codex-cli
  const CODEX_NAMES = new Set(["codex", "codex-cli"]);
  const codexPhases: string[] = [];
  for (const [phase, pr] of Object.entries(routing)) {
    if (pr && typeof pr === "object" && "runtime" in pr) {
      const rt = (pr as { runtime: string }).runtime;
      if (CODEX_NAMES.has(rt)) codexPhases.push(phase);
    }
  }

  if (codexPhases.length === 0) return issues;

  // Check codex CLI availability (mirrors CodexBridge.isAvailable)
  const codexOk = await checkCodexCli();
  if (!codexOk) {
    issues.push(
      `codex-cli is not available (codex --version failed) but is configured for phases: ${codexPhases.join(", ")}`,
    );
  }
  return issues;
}

function checkCodexCli(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("codex", ["--version"], { timeout: 5000 }, (err, _stdout) => {
      resolve(!err);
    });
  });
}
