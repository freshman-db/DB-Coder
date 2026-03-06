/**
 * CodexCliRuntime — RuntimeAdapter wrapping the Codex CLI (`codex exec`).
 *
 * Extracted from CodexBridge. Adds --model passthrough.
 * Capabilities: sandboxControl=true, sessionPersistence=conditional (full-auto only).
 */

import type {
  RuntimeAdapter,
  RuntimeCapabilities,
  RunOptions,
  RunResult,
} from "./RuntimeAdapter.js";
import type { CodexConfig } from "../config/types.js";
import { CodexBridge } from "../bridges/CodexBridge.js";
import { runProcess } from "../utils/process.js";

const CODEX_MODEL_PREFIXES = ["gpt-", "o1-", "o3-", "o4-"];

export class CodexCliRuntime implements RuntimeAdapter {
  readonly name = "codex-cli";

  readonly capabilities: RuntimeCapabilities = {
    nativeOutputSchema: false,
    eventStreaming: true,
    sessionPersistence: { conditional: "sandbox=full-auto" },
    sandboxControl: true,
    toolSurface: false,
    extendedThinking: false,
  };

  private readonly bridge: CodexBridge;

  constructor(private readonly config: CodexConfig) {
    this.bridge = new CodexBridge(config);
  }

  async run(prompt: string, opts: RunOptions): Promise<RunResult> {
    const start = Date.now();

    // Determine sandbox override for read-only mode
    const sandboxOverride = opts.readOnly
      ? ("workspace-read" as const)
      : undefined;

    const result = await this.bridge.execute(prompt, opts.cwd, {
      systemPrompt: opts.systemPrompt,
      maxTurns: opts.maxTurns,
      maxBudget: opts.maxBudget,
      timeout: opts.timeout,
      model: opts.model,
      sandboxOverride,
      resumeSessionId: opts.resumeSessionId,
      resumePrompt: opts.resumePrompt,
    });

    return {
      text: result.output,
      costUsd: result.cost_usd,
      durationMs: result.duration_ms,
      sessionId: result.sessionId,
      numTurns: result.numTurns,
      isError: !result.success,
      errors: result.success ? [] : [result.output],
    };
  }

  async isAvailable(): Promise<boolean> {
    return this.bridge.isAvailable();
  }

  supportsModel(modelId: string): boolean {
    return CODEX_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix));
  }
}
