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

  // Collect phases that reference codex runtimes.
  // "codex" alias normalizes to "codex-sdk" (SDK-first, CLI fallback at runtime).
  const CODEX_SDK_NAMES = new Set(["codex", "codex-sdk"]);
  const codexCliPhases: string[] = [];
  const codexSdkPhases: string[] = [];
  for (const [phase, pr] of Object.entries(routing)) {
    if (pr && typeof pr === "object" && "runtime" in pr) {
      const rt = (pr as { runtime: string }).runtime;
      if (rt === "codex-cli") codexCliPhases.push(phase);
      if (CODEX_SDK_NAMES.has(rt)) codexSdkPhases.push(phase);
    }
  }

  // Any codex runtime (CLI or SDK) needs the codex binary.
  // SDK spawns CLI internally, so CLI is always a hard dependency.
  const needsCodexCli = codexCliPhases.length > 0 || codexSdkPhases.length > 0;
  // Always probe CLI: even without explicit codex phases, codex-cli is registered
  // globally for dynamic cross-runtime routing (findRuntimeForModel).
  const cliOk = await checkCodexCli();

  if (needsCodexCli && !cliOk) {
    // CLI missing → hard error for phases that explicitly require codex
    const allPhases = [...codexCliPhases, ...codexSdkPhases];
    issues.push(
      `codex CLI is not available (codex --version failed) but is required for phases: ${allPhases.join(", ")}`,
    );
    return issues; // No point checking SDK if CLI is missing
  }

  // Always probe SDK package when CLI is available — dynamic cross-runtime
  // routing (resource_request.model → findRuntimeForModel) may need codex-sdk
  // at runtime even if no phase explicitly configures it.
  if (cliOk) {
    const sdkPkgOk = await checkCodexSdkPackage();
    if (!sdkPkgOk && codexSdkPhases.length > 0) {
      // Only warn if phases explicitly request codex-sdk
      log.warn(
        `@openai/codex-sdk not installed — phases [${codexSdkPhases.join(", ")}] will fall back to codex-cli`,
      );
    }
  }

  return issues;
}

function checkCodexCli(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("codex", ["--version"], { timeout: 5000 }, (err, _stdout) => {
      _codexCliAvailable = !err;
      resolve(!err);
    });
  });
}

/** Cached result of codex CLI binary availability check. */
let _codexCliAvailable: boolean | null = null;

/** Cached result of codex-sdk package availability check. */
let _codexSdkAvailable: boolean | null = null;

async function checkCodexSdkPackage(): Promise<boolean> {
  try {
    await import("@openai/codex-sdk");
    _codexSdkAvailable = true;
    return true;
  } catch {
    _codexSdkAvailable = false;
    return false;
  }
}

/**
 * Returns the cached codex CLI binary availability from startup validation.
 * Must be called after validateRuntimeAvailability() has run.
 */
export function isCodexCliAvailable(): boolean {
  return _codexCliAvailable === true;
}

/**
 * Returns the cached codex-sdk availability result from startup validation.
 * Must be called after validateRuntimeAvailability() has run.
 */
export function isCodexSdkAvailable(): boolean {
  return _codexSdkAvailable === true;
}
