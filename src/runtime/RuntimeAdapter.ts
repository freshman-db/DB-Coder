/**
 * RuntimeAdapter — Unified interface for executing prompts across different
 * AI runtimes (Claude SDK, Codex SDK, Codex CLI, etc.).
 *
 * Part of the phase->runtime->model three-layer decoupling (Line A).
 */

// --- Capabilities ---

/**
 * Session persistence is conditional — different runtimes support it
 * to different degrees. A single boolean can't express constraints like
 * "only resumable in full-auto sandbox mode".
 */
export type SessionPersistenceCapability =
  | false // not supported
  | true // unconditionally supported
  | { conditional: string }; // supported under described conditions

export interface RuntimeCapabilities {
  /** Native JSON schema / outputSchema (vs text-parse fallback) */
  nativeOutputSchema: boolean;
  /** Streaming text/event callbacks */
  eventStreaming: boolean;
  /** Session resume support */
  sessionPersistence: SessionPersistenceCapability;
  /** Native read-only / sandbox mode (vs prompt-based constraint) */
  sandboxControl: boolean;
  /** Tool control: allowedTools / disallowedTools / hooks / plugins / MCP */
  toolSurface: boolean;
  /** Extended thinking + effort (currently Claude only) */
  extendedThinking: boolean;
}

// --- Run options & result ---

export interface RunOptions {
  cwd: string;
  model?: string;
  timeout?: number;
  maxTurns?: number;
  maxBudget?: number;
  systemPrompt?: string;
  outputSchema?: object;
  readOnly?: boolean;
  resumeSessionId?: string;
  resumePrompt?: string;
  thinking?: object;
  effort?: string;
  onText?: (text: string) => void;
  /** Tools to explicitly block (runtime-specific) */
  disallowedTools?: string[];
  /** Tools to allow (runtime-specific) */
  allowedTools?: string[];
}

export interface RunResult {
  text: string;
  structured?: unknown;
  costUsd: number;
  durationMs: number;
  sessionId?: string;
  numTurns?: number;
  isError: boolean;
  errors: string[];
}

// --- Adapter interface ---

export interface RuntimeAdapter {
  readonly name: string;
  readonly capabilities: RuntimeCapabilities;

  /** Execute a prompt and return the result. */
  run(prompt: string, opts: RunOptions): Promise<RunResult>;

  /** Check if this runtime is currently available (e.g. SDK installed, API reachable). */
  isAvailable(): Promise<boolean>;

  /**
   * Whether this runtime supports the given model ID.
   * Used for resource_request.model routing.
   * Returns false (not throw) for unknown models.
   */
  supportsModel(modelId: string): boolean;
}
