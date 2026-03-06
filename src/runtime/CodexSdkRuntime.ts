/**
 * CodexSdkRuntime — RuntimeAdapter wrapping @openai/codex-sdk (Thread API).
 *
 * Capabilities: nativeOutputSchema=true, sessionPersistence=true, sandboxControl=false.
 * Model is passed via ThreadOptions.
 *
 * Fallback: if SDK is not available, runtimeFactory can fall back to CodexCliRuntime.
 */

import type {
  RuntimeAdapter,
  RuntimeCapabilities,
  RunOptions,
  RunResult,
} from "./RuntimeAdapter.js";
import { log } from "../utils/logger.js";

// Lazy import to avoid hard crash when @openai/codex-sdk is not installed
let CodexClass: typeof import("@openai/codex-sdk").Codex | null = null;
let sdkLoadError: Error | null = null;

async function loadSdk(): Promise<typeof import("@openai/codex-sdk").Codex> {
  if (CodexClass) return CodexClass;
  if (sdkLoadError) throw sdkLoadError;
  try {
    const mod = await import("@openai/codex-sdk");
    CodexClass = mod.Codex;
    return CodexClass;
  } catch (err) {
    sdkLoadError = err instanceof Error ? err : new Error(String(err));
    throw sdkLoadError;
  }
}

const CODEX_MODEL_PREFIXES = ["gpt-", "o1-", "o3-", "o4-"];

export class CodexSdkRuntime implements RuntimeAdapter {
  readonly name = "codex-sdk";

  readonly capabilities: RuntimeCapabilities = {
    nativeOutputSchema: true,
    eventStreaming: true,
    sessionPersistence: true,
    sandboxControl: false,
    toolSurface: false,
    extendedThinking: false,
  };

  async run(prompt: string, opts: RunOptions): Promise<RunResult> {
    const start = Date.now();
    const Cls = await loadSdk();
    const codex = new Cls();

    try {
      // Build thread options
      const threadOpts: import("@openai/codex-sdk").ThreadOptions = {
        workingDirectory: opts.cwd,
        approvalPolicy: "never",
      };
      if (opts.model) {
        threadOpts.model = opts.model;
      }
      if (opts.readOnly) {
        threadOpts.sandboxMode = "read-only";
      }

      // Start or resume thread
      const thread = opts.resumeSessionId
        ? codex.resumeThread(opts.resumeSessionId, threadOpts)
        : codex.startThread(threadOpts);

      // Build turn options
      const turnOpts: import("@openai/codex-sdk").TurnOptions = {};
      if (opts.outputSchema) {
        turnOpts.outputSchema = opts.outputSchema;
      }

      // Timeout via AbortController
      const controller = new AbortController();
      let timedOut = false;
      const timeoutHandle = opts.timeout
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, opts.timeout)
        : null;
      turnOpts.signal = controller.signal;

      // Use streamed run for event access
      const effectivePrompt =
        opts.resumeSessionId && opts.resumePrompt
          ? opts.resumePrompt
          : prompt;

      const streamed = await thread.runStreamed(effectivePrompt, turnOpts);

      // Collect events for cost extraction and thread ID
      let threadId: string | undefined;
      let totalInputTokens = 0;
      let totalCachedInputTokens = 0;
      let totalOutputTokens = 0;
      let textParts: string[] = [];
      let hasError = false;
      const errors: string[] = [];

      for await (const event of streamed.events) {
        switch (event.type) {
          case "thread.started":
            threadId = event.thread_id;
            break;
          case "turn.completed":
            if (event.usage) {
              totalInputTokens += event.usage.input_tokens;
              totalCachedInputTokens += event.usage.cached_input_tokens;
              totalOutputTokens += event.usage.output_tokens;
            }
            break;
          case "turn.failed":
            hasError = true;
            if (event.error?.message) {
              errors.push(event.error.message);
            }
            break;
          case "item.completed":
            if (event.item.type === "agent_message") {
              textParts.push(event.item.text);
              if (opts.onText) opts.onText(event.item.text);
            } else if (
              event.item.type === "error" &&
              "message" in event.item
            ) {
              hasError = true;
              errors.push(
                (event.item as { message: string }).message,
              );
            }
            break;
        }
      }

      if (timeoutHandle) clearTimeout(timeoutHandle);

      const text = textParts.join("\n");
      const durationMs = Date.now() - start;

      // Estimate cost from token usage (using codex pricing)
      // Default pricing: $1.75/M input, $0.175/M cached, $7/M output
      const costUsd =
        (totalInputTokens - totalCachedInputTokens) * (1.75 / 1_000_000) +
        totalCachedInputTokens * (0.175 / 1_000_000) +
        totalOutputTokens * (7.0 / 1_000_000);

      // Attempt structured output extraction from last agent_message
      let structured: unknown;
      if (opts.outputSchema && text) {
        try {
          structured = JSON.parse(text);
        } catch {
          // Not valid JSON — leave structured undefined
        }
      }

      return {
        text,
        structured,
        costUsd,
        durationMs,
        sessionId: threadId,
        isError: timedOut || hasError,
        errors: timedOut ? [...errors, "timeout"] : errors,
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      log.error("CodexSdkRuntime run failed", err);
      return {
        text: "",
        costUsd: 0,
        durationMs,
        isError: true,
        errors: [message],
      };
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      await loadSdk();
      return true;
    } catch {
      return false;
    }
  }

  supportsModel(modelId: string): boolean {
    return CODEX_MODEL_PREFIXES.some((prefix) =>
      modelId.startsWith(prefix),
    );
  }
}
