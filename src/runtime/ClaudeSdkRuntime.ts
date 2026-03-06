/**
 * ClaudeSdkRuntime — RuntimeAdapter wrapping the existing ClaudeCodeSession
 * (Agent SDK query() API).
 *
 * Full capabilities: all fields true. This is the reference implementation.
 */

import type {
  RuntimeAdapter,
  RuntimeCapabilities,
  RunOptions,
  RunResult,
} from "./RuntimeAdapter.js";
import type {
  ClaudeCodeSession,
  SessionOptions,
} from "../bridges/ClaudeCodeSession.js";

const CLAUDE_MODEL_PREFIXES = ["claude-"];

export class ClaudeSdkRuntime implements RuntimeAdapter {
  readonly name = "claude-sdk";

  readonly capabilities: RuntimeCapabilities = {
    nativeOutputSchema: true,
    eventStreaming: true,
    sessionPersistence: true,
    sandboxControl: true,
    toolSurface: true,
    extendedThinking: true,
  };

  constructor(private readonly session: ClaudeCodeSession) {}

  async run(prompt: string, opts: RunOptions): Promise<RunResult> {
    const sessionOpts: SessionOptions = {
      permissionMode: "bypassPermissions",
      cwd: opts.cwd,
      model: opts.model,
      timeout: opts.timeout,
      maxTurns: opts.maxTurns,
      maxBudget: opts.maxBudget,
      appendSystemPrompt: opts.systemPrompt,
      jsonSchema: opts.outputSchema,
      resumeSessionId: opts.resumeSessionId,
      onText: opts.onText,
      disallowedTools: opts.disallowedTools,
      allowedTools: opts.allowedTools,
      thinking: opts.thinking as SessionOptions["thinking"],
      effort: opts.effort as SessionOptions["effort"],
    };

    // Read-only via native tool blocking (sandboxControl=true)
    if (opts.readOnly) {
      sessionOpts.disallowedTools = [
        ...(sessionOpts.disallowedTools ?? []),
        "Edit",
        "Write",
        "NotebookEdit",
      ];
    }

    // Handle resume: use resumePrompt if resuming, fall back to main prompt
    const effectivePrompt =
      opts.resumeSessionId && opts.resumePrompt
        ? opts.resumePrompt
        : prompt;

    const result = await this.session.run(effectivePrompt, sessionOpts);

    return {
      text: result.text,
      structured: result.json,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      sessionId: result.sessionId || undefined,
      numTurns: result.numTurns,
      isError: result.isError,
      errors: result.errors,
    };
  }

  async isAvailable(): Promise<boolean> {
    // Claude SDK is always available when the package is installed
    return true;
  }

  supportsModel(modelId: string): boolean {
    return CLAUDE_MODEL_PREFIXES.some((prefix) =>
      modelId.startsWith(prefix),
    );
  }
}
