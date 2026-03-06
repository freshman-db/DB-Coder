/**
 * runtimeFactory — Create RuntimeAdapter instances from configuration.
 *
 * Handles alias normalization ("codex" -> "codex-sdk", "claude" -> "claude-sdk")
 * and runtime registration for future extensibility.
 */

import type { RuntimeAdapter } from "./RuntimeAdapter.js";
import { log } from "../utils/logger.js";

// --- Alias normalization ---

const RUNTIME_ALIASES: Record<string, string> = {
  claude: "claude-sdk",
  codex: "codex-sdk",
};

/**
 * Normalize a runtime name: resolve aliases to canonical form.
 * Unknown names pass through unchanged (validated later by registry).
 */
export function normalizeRuntimeName(name: string): string {
  const canonical = RUNTIME_ALIASES[name];
  if (canonical) {
    log.info(`Runtime alias normalized: "${name}" -> "${canonical}"`);
    return canonical;
  }
  return name;
}

// --- Registry ---

export type RuntimeFactory = (name: string) => RuntimeAdapter;

const registry = new Map<string, RuntimeAdapter>();

/** Register a runtime instance under a canonical name. */
export function registerRuntime(name: string, runtime: RuntimeAdapter): void {
  registry.set(name, runtime);
}

/** Get a registered runtime by canonical name. Throws if not found. */
export function getRuntime(name: string): RuntimeAdapter {
  const canonical = normalizeRuntimeName(name);
  const runtime = registry.get(canonical);
  if (!runtime) {
    throw new Error(
      `Runtime "${canonical}" not registered. Available: ${[...registry.keys()].join(", ")}`,
    );
  }
  return runtime;
}

/** Get all registered runtimes. */
export function getAllRuntimes(): ReadonlyMap<string, RuntimeAdapter> {
  return registry;
}

/** Clear all registered runtimes (for testing). */
export function clearRuntimes(): void {
  registry.clear();
}

/**
 * Find a runtime that supports the given model.
 * Returns undefined if no registered runtime supports it.
 */
export function findRuntimeForModel(
  modelId: string,
): RuntimeAdapter | undefined {
  for (const runtime of registry.values()) {
    if (runtime.supportsModel(modelId)) {
      return runtime;
    }
  }
  return undefined;
}
