/**
 * runtimeFactory — Runtime registry, alias normalization, fallback, and creation.
 *
 * Canonical runtimes: "claude-sdk", "codex-sdk", "codex-cli".
 * Aliases: "claude" -> "claude-sdk", "codex" -> "codex-sdk".
 * Fallback: codex-sdk -> codex-cli when SDK is unavailable.
 */

import type { RuntimeAdapter } from "./RuntimeAdapter.js";
import type { Config } from "../config/Config.js";
import type { SdkExtras } from "../bridges/buildSdkOptions.js";
import { ClaudeCodeSession } from "../bridges/ClaudeCodeSession.js";
import { ClaudeSdkRuntime } from "./ClaudeSdkRuntime.js";
import { CodexCliRuntime } from "./CodexCliRuntime.js";
import { CodexSdkRuntime } from "./CodexSdkRuntime.js";
import {
  isCodexCliAvailable,
  isCodexSdkAvailable,
} from "../startup/configValidation.js";
import { log } from "../utils/logger.js";

// --- RuntimeSet: all runtimes created for a MainLoop instance ---

/** Killable handle for lifecycle management. */
export interface Killable {
  kill(): void;
}

export interface RuntimeSet {
  brain: RuntimeAdapter;
  worker: RuntimeAdapter;
  /** All underlying sessions that need kill() on shutdown. */
  sessions: Killable[];
  /** Local runtime map keyed by canonical name (includes brain/worker split). */
  runtimes: Record<string, RuntimeAdapter>;
}

/**
 * Create and register all runtimes for a MainLoop instance.
 * Encapsulates concrete runtime class creation so MainLoop only sees RuntimeAdapter.
 */
export function createRuntimeSet(
  config: Config,
  sdkExtras?: SdkExtras,
): RuntimeSet {
  const brainSession = new ClaudeCodeSession(sdkExtras);
  const workerSession = new ClaudeCodeSession(sdkExtras);

  const claudeSdkBrain = new ClaudeSdkRuntime(brainSession);
  const claudeSdkWorker = new ClaudeSdkRuntime(workerSession);
  const codexCliRuntime = new CodexCliRuntime(config.values.codex);
  const codexSdkRuntime = new CodexSdkRuntime(config.values.codex.tokenPricing);

  // Register under canonical names.
  // "claude-sdk" is the brain (read-only) session; "claude-sdk-worker" is the
  // worker session. findRuntimeForModel checks worker first so cross-runtime
  // fallback won't accidentally land on the brain session.
  registerRuntime("claude-sdk", claudeSdkBrain);
  registerRuntime("claude-sdk-worker", claudeSdkWorker);

  // Only register codex runtimes if startup validation confirmed availability.
  const codexCliOk = isCodexCliAvailable();
  const codexSdkOk = isCodexSdkAvailable();

  if (codexCliOk) {
    registerRuntime("codex-cli", codexCliRuntime);
  }
  if (codexSdkOk) {
    registerRuntime("codex-sdk", codexSdkRuntime);
  }
  if (!codexCliOk && !codexSdkOk) {
    log.info(
      "codex not available — cross-runtime routing to codex models disabled",
    );
  } else if (!codexSdkOk) {
    log.info(
      "codex-sdk not available — codex-sdk routes will fall back to codex-cli",
    );
  }

  const runtimes: Record<string, RuntimeAdapter> = {
    "claude-sdk-brain": claudeSdkBrain,
    "claude-sdk-worker": claudeSdkWorker,
    ...(codexCliOk ? { "codex-cli": codexCliRuntime } : {}),
    ...(codexSdkOk ? { "codex-sdk": codexSdkRuntime } : {}),
  };

  return {
    brain: claudeSdkBrain,
    worker: claudeSdkWorker,
    sessions: [brainSession, workerSession],
    runtimes,
  };
}

// --- Alias normalization ---

const RUNTIME_ALIASES: Record<string, string> = {
  claude: "claude-sdk",
  codex: "codex-sdk",
};

/**
 * Fallback chain: when a canonical runtime is not available, try these.
 * Currently only codex-sdk falls back to codex-cli.
 */
const RUNTIME_FALLBACKS: Record<string, string> = {
  "codex-sdk": "codex-cli",
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
 * Resolve a runtime from registry with fallback (sync, registration-based).
 * E.g. codex-sdk -> codex-cli if SDK is not registered.
 * Registration gating: MainLoop only registers runtimes confirmed available at startup.
 */
function resolveFromRegistry(canonical: string): RuntimeAdapter | undefined {
  const runtime = registry.get(canonical);
  if (runtime) return runtime;

  const fallback = RUNTIME_FALLBACKS[canonical];
  if (fallback) {
    const fb = registry.get(fallback);
    if (fb) {
      log.info(
        `Runtime "${canonical}" not registered, falling back to "${fallback}"`,
      );
      return fb;
    }
  }
  return undefined;
}

/**
 * Get a registered runtime by canonical name (async).
 * Applies alias normalization, fallback chain, and availability check.
 * If the resolved runtime reports unavailable, attempts the fallback.
 */
export async function getRuntime(name: string): Promise<RuntimeAdapter> {
  const canonical = normalizeRuntimeName(name);

  // Try primary runtime with availability check
  const runtime = registry.get(canonical);
  if (runtime) {
    const available = await runtime.isAvailable();
    if (available) return runtime;

    // Primary registered but unavailable — try fallback
    const fallback = RUNTIME_FALLBACKS[canonical];
    if (fallback) {
      const fb = registry.get(fallback);
      if (fb) {
        log.info(
          `Runtime "${canonical}" unavailable at runtime, falling back to "${fallback}"`,
        );
        return fb;
      }
    }
  }

  // Not registered at all — try registration-based fallback
  const resolved = resolveFromRegistry(canonical);
  if (resolved) return resolved;

  throw new Error(
    `Runtime "${canonical}" not registered. Available: ${[...registry.keys()].join(", ")}`,
  );
}

/**
 * Get a registered runtime synchronously.
 * Applies alias normalization and registration-based fallback chain.
 * Does NOT check isAvailable() (async) — relies on startup registration gating.
 */
export function getRuntimeSync(name: string): RuntimeAdapter {
  const canonical = normalizeRuntimeName(name);
  const runtime = resolveFromRegistry(canonical);
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
  let fallbackName = "";
  let fallback: RuntimeAdapter | undefined;
  for (const [name, runtime] of registry.entries()) {
    if (runtime.supportsModel(modelId)) {
      // Prefer worker-designated runtimes (early return)
      if (name.endsWith("-worker")) return runtime;
      // Prefer SDK over CLI when both support the model
      if (
        !fallback ||
        (name.endsWith("-sdk") && fallbackName.endsWith("-cli"))
      ) {
        fallbackName = name;
        fallback = runtime;
      }
    }
  }
  return fallback;
}
