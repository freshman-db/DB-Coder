import {
  query,
  type Query,
  type SDKMessage,
  type Options,
  type ThinkingConfig,
} from "@anthropic-ai/claude-agent-sdk";
import { log } from "../utils/logger.js";
import { buildSdkOptions, type SdkExtras } from "./buildSdkOptions.js";
import { collectResult } from "./sdkMessageCollector.js";

// --- Types (public interface unchanged) ---

export interface SessionOptions {
  /** Permission mode */
  permissionMode: "bypassPermissions" | "acceptEdits";
  /** Max USD budget for this session */
  maxBudget?: number;
  /** Resume a previous session by ID */
  resumeSessionId?: string;
  /** Limit on tools the session can use */
  allowedTools?: string[];
  /** Tools to explicitly block */
  disallowedTools?: string[];
  /** Extra system prompt appended to Claude's defaults */
  appendSystemPrompt?: string;
  /** JSON schema for structured output */
  jsonSchema?: object;
  /** Working directory */
  cwd?: string;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Max number of agentic turns */
  maxTurns?: number;
  /** Callback for streaming text deltas */
  onText?: (text: string) => void;
  /** Callback for each SDK message event */
  onEvent?: (event: SDKMessage) => void;
  /** Model to use (default: claude-sonnet-4-6) */
  model?: string;
  /** Extended thinking configuration (adaptive recommended for Opus 4.6) */
  thinking?: ThinkingConfig;
  /** Effort level for thinking depth */
  effort?: "low" | "medium" | "high" | "max";
}

export interface SessionResult {
  /** Assembled full text output */
  text: string;
  /** Parsed structured output if jsonSchema was specified */
  json?: unknown;
  /** Total cost in USD */
  costUsd: number;
  /** Session ID for resuming */
  sessionId: string;
  /** Process exit code (0=success, 1=error, -1=timeout, -2=killed) */
  exitCode: number;
  /** Number of agentic turns taken */
  numTurns: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Whether the result is an error */
  isError: boolean;
  /** Error messages if isError */
  errors: string[];
  /** Token usage summary */
  usage: TokenUsage;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

// Re-export SDKMessage as StreamEvent for backward compat
export type StreamEvent = SDKMessage;

// Type for the query function (allows injection for testing)
export type QueryFn = typeof query;

// Per-call mutable state, scoped to avoid cross-call interference.
interface RunContext {
  abortController: AbortController;
  killed: boolean;
  query: Query | null;
}

// --- Session ---

export class ClaudeCodeSession {
  private activeRun: RunContext | null = null;
  private sdkExtras: SdkExtras;
  private queryFn: QueryFn;

  constructor(sdkExtras?: SdkExtras, queryFn?: QueryFn) {
    this.sdkExtras = sdkExtras ?? {};
    this.queryFn = queryFn ?? query;
  }

  /**
   * Run a prompt using the Agent SDK query() API.
   */
  async run(prompt: string, opts: SessionOptions): Promise<SessionResult> {
    if (this.activeRun) {
      throw new Error(
        "ClaudeCodeSession.run() is not re-entrant: a query is already active",
      );
    }

    const start = Date.now();
    const { options, timeoutMs } = buildSdkOptions(
      prompt,
      opts,
      this.sdkExtras,
    );

    // Per-call state: abort controller, killed flag, query handle
    const ac = options.abortController ?? new AbortController();
    options.abortController = ac;
    const ctx: RunContext = {
      abortController: ac,
      killed: false,
      query: null,
    };
    this.activeRun = ctx;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        log.warn("ClaudeCodeSession: timeout, aborting query", {
          timeout: timeoutMs,
        });
        ac.abort();
      }, timeoutMs);
    }

    try {
      const q = this.queryFn({ prompt, options });
      ctx.query = q;

      const result = await collectResult(q, {
        onText: opts.onText,
        onEvent: opts.onEvent,
      });

      if (timer) clearTimeout(timer);

      if (timedOut) {
        return {
          ...result,
          exitCode: -1,
          isError: true,
          errors: [`Session timed out after ${timeoutMs}ms`],
          durationMs: Date.now() - start,
        };
      }

      return {
        ...result,
        durationMs: result.durationMs || Date.now() - start,
      };
    } catch (err: unknown) {
      if (timer) clearTimeout(timer);

      const errMsg = err instanceof Error ? err.message : String(err);
      const isAbort = err instanceof Error && err.name === "AbortError";

      // Read per-call killed flag (not instance state)
      if (ctx.killed) {
        return this.makeErrorResult(
          -2,
          ["Session aborted by kill()"],
          Date.now() - start,
        );
      }

      if (timedOut || isAbort) {
        return this.makeErrorResult(
          -1,
          [`Session timed out after ${timeoutMs}ms`],
          Date.now() - start,
        );
      }

      log.error("ClaudeCodeSession: query failed", { error: errMsg });
      return this.makeErrorResult(1, [errMsg], Date.now() - start);
    } finally {
      // Only clear if we are still the active run (defensive)
      if (this.activeRun === ctx) {
        this.activeRun = null;
      }
    }
  }

  /** Build an error SessionResult with zeroed-out fields. */
  private makeErrorResult(
    exitCode: number,
    errors: string[],
    durationMs: number,
  ): SessionResult {
    return {
      text: "",
      costUsd: 0,
      sessionId: "",
      exitCode,
      numTurns: 0,
      durationMs,
      isError: true,
      errors,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    };
  }

  /** Abort the running query (manual kill, distinct from timeout) */
  kill(): void {
    const ctx = this.activeRun;
    if (!ctx) return;
    ctx.killed = true;
    ctx.abortController.abort();
  }
}
