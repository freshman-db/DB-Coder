/**
 * runtimeFactory — Runtime registry and alias normalization.
 *
 * Canonical runtimes: "claude-sdk", "codex-cli".
 * Aliases: "claude" -> "claude-sdk", "codex" -> "codex-cli".
 */

import type { RuntimeAdapter } from "./RuntimeAdapter.js";
import { log } from "../utils/logger.js";

// --- Alias normalization ---

const RUNTIME_ALIASES: Record<string, string> = {
  claude: "claude-sdk",
  codex: "codex-cli",
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

/**
 * Get a registered runtime by canonical name.
 * Throws if no matching runtime is found.
 */
export async function getRuntime(name: string): Promise<RuntimeAdapter> {
  const canonical = normalizeRuntimeName(name);
  const runtime = registry.get(canonical);
  if (!runtime) {
    throw new Error(
      `Runtime "${canonical}" not registered. Available: ${[...registry.keys()].join(", ")}`,
    );
  }
  return runtime;
}

/**
 * Get a registered runtime synchronously. No availability check or fallback.
 * Use when async is not possible or runtime is known to be available.
 */
export function getRuntimeSync(name: string): RuntimeAdapter {
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
 * Prefers worker-designated runtimes (names ending in "-worker") over
 * brain/read-only sessions to avoid cross-runtime fallback landing on brain.
 * Returns undefined if no registered runtime supports it.
 */
export function findRuntimeForModel(
  modelId: string,
): RuntimeAdapter | undefined {
  let fallback: RuntimeAdapter | undefined;
  for (const [name, runtime] of registry.entries()) {
    if (runtime.supportsModel(modelId)) {
      if (name.endsWith("-worker")) return runtime;
      fallback ??= runtime;
    }
  }
  return fallback;
}
