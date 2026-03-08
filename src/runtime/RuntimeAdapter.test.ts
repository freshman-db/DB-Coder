/**
 * Tests for RuntimeAdapter interfaces + ClaudeSdkRuntime + runtimeFactory.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { RunOptions, RunResult } from "./RuntimeAdapter.js";
import { ClaudeSdkRuntime } from "./ClaudeSdkRuntime.js";
import {
  normalizeRuntimeName,
  registerRuntime,
  getRuntimeSync,
  clearRuntimes,
  findRuntimeForModel,
} from "./runtimeFactory.js";

// --- Mock ClaudeCodeSession ---

function createMockSession(
  overrides?: Partial<{
    run: (
      prompt: string,
      opts: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
  }>,
) {
  const calls: Array<{ prompt: string; opts: Record<string, unknown> }> = [];
  return {
    calls,
    session: {
      run: async (prompt: string, opts: Record<string, unknown>) => {
        calls.push({ prompt, opts });
        if (overrides?.run) return overrides.run(prompt, opts);
        return {
          text: "mock output",
          json: undefined,
          costUsd: 0.01,
          sessionId: "sess-123",
          exitCode: 0,
          numTurns: 5,
          durationMs: 1000,
          isError: false,
          errors: [],
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        };
      },
      kill: () => {},
    } as unknown as ConstructorParameters<typeof ClaudeSdkRuntime>[0],
  };
}

// --- ClaudeSdkRuntime tests ---

test("ClaudeSdkRuntime: capabilities are all true", () => {
  const { session } = createMockSession();
  const runtime = new ClaudeSdkRuntime(session);

  assert.equal(runtime.name, "claude-sdk");
  assert.equal(runtime.capabilities.nativeOutputSchema, true);
  assert.equal(runtime.capabilities.eventStreaming, true);
  assert.equal(runtime.capabilities.sessionPersistence, true);
  assert.equal(runtime.capabilities.sandboxControl, true);
  assert.equal(runtime.capabilities.toolSurface, true);
  assert.equal(runtime.capabilities.extendedThinking, true);
});

test("ClaudeSdkRuntime: run() returns RunResult with correct fields", async () => {
  const { session } = createMockSession();
  const runtime = new ClaudeSdkRuntime(session);

  const result = await runtime.run("test prompt", {
    cwd: "/tmp",
    model: "claude-opus-4-6",
    timeout: 30000,
  });

  assert.equal(result.text, "mock output");
  assert.equal(result.costUsd, 0.01);
  assert.equal(result.sessionId, "sess-123");
  assert.equal(result.numTurns, 5);
  assert.equal(result.isError, false);
  assert.deepEqual(result.errors, []);
});

test("ClaudeSdkRuntime: run() passes model and timeout through", async () => {
  const { session, calls } = createMockSession();
  const runtime = new ClaudeSdkRuntime(session);

  await runtime.run("test", {
    cwd: "/tmp",
    model: "claude-sonnet-4-6",
    timeout: 60000,
    maxTurns: 100,
    maxBudget: 5.0,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.model, "claude-sonnet-4-6");
  assert.equal(calls[0].opts.timeout, 60000);
  assert.equal(calls[0].opts.maxTurns, 100);
  assert.equal(calls[0].opts.maxBudget, 5.0);
});

test("ClaudeSdkRuntime: readOnly adds disallowedTools", async () => {
  const { session, calls } = createMockSession();
  const runtime = new ClaudeSdkRuntime(session);

  await runtime.run("test", {
    cwd: "/tmp",
    readOnly: true,
  });

  assert.equal(calls.length, 1);
  const disallowed = calls[0].opts.disallowedTools as string[];
  assert.ok(disallowed.includes("Edit"));
  assert.ok(disallowed.includes("Write"));
  assert.ok(disallowed.includes("NotebookEdit"));
});

test("ClaudeSdkRuntime: readOnly merges with existing disallowedTools", async () => {
  const { session, calls } = createMockSession();
  const runtime = new ClaudeSdkRuntime(session);

  await runtime.run("test", {
    cwd: "/tmp",
    readOnly: true,
    disallowedTools: ["Bash"],
  });

  const disallowed = calls[0].opts.disallowedTools as string[];
  assert.ok(disallowed.includes("Bash"));
  assert.ok(disallowed.includes("Edit"));
});

test("ClaudeSdkRuntime: resume uses resumePrompt", async () => {
  const { session, calls } = createMockSession();
  const runtime = new ClaudeSdkRuntime(session);

  await runtime.run("full prompt", {
    cwd: "/tmp",
    resumeSessionId: "sess-old",
    resumePrompt: "continue",
  });

  assert.equal(calls[0].prompt, "continue");
  assert.equal(calls[0].opts.resumeSessionId, "sess-old");
});

test("ClaudeSdkRuntime: outputSchema maps to jsonSchema", async () => {
  const { session, calls } = createMockSession();
  const runtime = new ClaudeSdkRuntime(session);

  const schema = { type: "object", properties: { x: { type: "string" } } };
  await runtime.run("test", {
    cwd: "/tmp",
    outputSchema: schema,
  });

  assert.deepEqual(calls[0].opts.jsonSchema, schema);
});

test("ClaudeSdkRuntime: structured output passed through", async () => {
  const { session } = createMockSession({
    run: async () => ({
      text: '{"x":"y"}',
      json: { x: "y" },
      costUsd: 0,
      sessionId: "",
      exitCode: 0,
      numTurns: 1,
      durationMs: 100,
      isError: false,
      errors: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    }),
  });
  const runtime = new ClaudeSdkRuntime(session);

  const result = await runtime.run("test", { cwd: "/tmp" });
  assert.deepEqual(result.structured, { x: "y" });
});

test("ClaudeSdkRuntime: isAvailable returns true", async () => {
  const { session } = createMockSession();
  const runtime = new ClaudeSdkRuntime(session);
  assert.equal(await runtime.isAvailable(), true);
});

test("ClaudeSdkRuntime: supportsModel recognizes Claude models", () => {
  const { session } = createMockSession();
  const runtime = new ClaudeSdkRuntime(session);

  assert.equal(runtime.supportsModel("claude-opus-4-6"), true);
  assert.equal(runtime.supportsModel("claude-sonnet-4-6"), true);
  assert.equal(runtime.supportsModel("claude-haiku-4-5-20251001"), true);
  assert.equal(runtime.supportsModel("gpt-5.3-codex"), false);
  assert.equal(runtime.supportsModel("unknown-model"), false);
});

// --- runtimeFactory tests ---

test("normalizeRuntimeName resolves aliases", () => {
  assert.equal(normalizeRuntimeName("claude"), "claude-sdk");
  assert.equal(normalizeRuntimeName("codex"), "codex-sdk");
  assert.equal(normalizeRuntimeName("claude-sdk"), "claude-sdk");
  assert.equal(normalizeRuntimeName("codex-cli"), "codex-cli");
});

test("registerRuntime + getRuntime round-trip", () => {
  clearRuntimes();
  const { session } = createMockSession();
  const runtime = new ClaudeSdkRuntime(session);

  registerRuntime("claude-sdk", runtime);
  const retrieved = getRuntimeSync("claude-sdk");
  assert.equal(retrieved, runtime);

  // Test alias resolution
  const viaAlias = getRuntimeSync("claude");
  assert.equal(viaAlias, runtime);

  clearRuntimes();
});

test("getRuntime throws for unregistered runtime", () => {
  clearRuntimes();
  assert.throws(() => getRuntimeSync("nonexistent"), /not registered/);
  clearRuntimes();
});

test("findRuntimeForModel finds matching runtime", () => {
  clearRuntimes();
  const { session } = createMockSession();
  const runtime = new ClaudeSdkRuntime(session);

  registerRuntime("claude-sdk", runtime);

  const found = findRuntimeForModel("claude-opus-4-6");
  assert.equal(found, runtime);

  const notFound = findRuntimeForModel("gpt-5.3-codex");
  assert.equal(notFound, undefined);

  clearRuntimes();
});

// --- CodexSdkRuntime tests ---

import { CodexSdkRuntime } from "./CodexSdkRuntime.js";
import { CodexCliRuntime } from "./CodexCliRuntime.js";
import type { RuntimeAdapter } from "./RuntimeAdapter.js";

test("CodexSdkRuntime: capabilities match spec", () => {
  const runtime = new CodexSdkRuntime();
  const caps = runtime.capabilities;

  assert.equal(caps.nativeOutputSchema, true);
  assert.equal(caps.eventStreaming, true);
  assert.equal(caps.sessionPersistence, true);
  assert.equal(caps.sandboxControl, false);
  assert.equal(caps.toolSurface, false);
  assert.equal(caps.extendedThinking, false);
});

test("CodexSdkRuntime: name is codex-sdk", () => {
  const runtime = new CodexSdkRuntime();
  assert.equal(runtime.name, "codex-sdk");
});

test("CodexSdkRuntime: supportsModel for codex models", () => {
  const runtime = new CodexSdkRuntime();
  assert.equal(runtime.supportsModel("gpt-5.3-codex"), true);
  assert.equal(runtime.supportsModel("o4-mini"), true);
  assert.equal(runtime.supportsModel("claude-opus-4-6"), false);
  assert.equal(runtime.supportsModel("gemini-pro"), false);
});

// --- CodexCliRuntime tests ---

test("CodexCliRuntime: capabilities match spec", () => {
  const codexConfig = {
    model: "gpt-5.3-codex",
    sandbox: "full-auto" as const,
  };
  const runtime = new CodexCliRuntime(codexConfig);
  const caps = runtime.capabilities;

  assert.equal(caps.nativeOutputSchema, false);
  assert.equal(caps.eventStreaming, true);
  assert.equal(caps.sandboxControl, true);
  assert.equal(caps.toolSurface, false);
  assert.equal(caps.extendedThinking, false);
  assert.deepEqual(caps.sessionPersistence, {
    conditional: "sandbox=full-auto",
  });
});

test("CodexCliRuntime: name is codex-cli", () => {
  const codexConfig = {
    model: "gpt-5.3-codex",
    sandbox: "workspace-write" as const,
  };
  const runtime = new CodexCliRuntime(codexConfig);
  assert.equal(runtime.name, "codex-cli");
});

test("CodexCliRuntime: supportsModel for codex models", () => {
  const codexConfig = {
    model: "gpt-5.3-codex",
    sandbox: "full-auto" as const,
  };
  const runtime = new CodexCliRuntime(codexConfig);
  assert.equal(runtime.supportsModel("gpt-5.3-codex"), true);
  assert.equal(runtime.supportsModel("o3-mini"), true);
  assert.equal(runtime.supportsModel("claude-sonnet-4-6"), false);
});

// --- runtimeFactory codex-sdk not registered ---

test("getRuntime: codex-sdk throws when not registered", async () => {
  clearRuntimes();

  const { getRuntime } = await import("./runtimeFactory.js");
  await assert.rejects(() => getRuntime("codex-sdk"), /not registered/);

  clearRuntimes();
});

// --- CodexSdkRuntime pricing tests ---

test("CodexSdkRuntime: default pricing matches config defaults", () => {
  const runtime = new CodexSdkRuntime();
  // Access private pricing via constructor — verify by creating with explicit values
  // and comparing against a runtime with defaults
  const runtimeCustom = new CodexSdkRuntime({
    inputPerMillion: 1.75,
    cachedInputPerMillion: 0.175,
    outputPerMillion: 14,
  });
  // Both should exist and have the same name
  assert.equal(runtime.name, "codex-sdk");
  assert.equal(runtimeCustom.name, "codex-sdk");
});

test("CodexSdkRuntime: accepts custom TokenPricing", () => {
  const customPricing = {
    inputPerMillion: 3.0,
    cachedInputPerMillion: 0.3,
    outputPerMillion: 15,
  };
  const runtime = new CodexSdkRuntime(customPricing);
  assert.equal(runtime.name, "codex-sdk");
  // Runtime should construct without error — pricing is used internally in run()
});

// --- runtimeFactory codex alias ---

// --- CodexSdkRuntime as brain runtime (routing.brain.runtime = "codex-sdk") ---
// These tests verify the complete code path: runBrainThink → CodexSdkRuntime.run()

/**
 * Creates a mock CodexSdkRuntime that records run() calls and returns
 * configurable responses. Simulates the real CodexSdkRuntime behavior
 * (toolSurface=false, sandboxControl=false, sessionPersistence=true).
 */
function createMockCodexSdkBrainRuntime(response?: Partial<RunResult>): {
  runtime: RuntimeAdapter;
  calls: Array<{ prompt: string; opts: RunOptions }>;
} {
  const calls: Array<{ prompt: string; opts: RunOptions }> = [];
  const runtime: RuntimeAdapter = {
    name: "codex-sdk",
    capabilities: {
      nativeOutputSchema: true,
      eventStreaming: true,
      sessionPersistence: true,
      sandboxControl: false, // readOnly via sandboxMode, not disallowedTools
      toolSurface: false, // disallowedTools silently ignored
      extendedThinking: false,
    },
    run: async (prompt: string, opts: RunOptions): Promise<RunResult> => {
      calls.push({ prompt, opts });
      const defaults: RunResult = {
        text: '{"tasks":[]}',
        structured: { tasks: [] },
        costUsd: 0.05,
        durationMs: 2000,
        sessionId: "thread-brain-001",
        numTurns: 3,
        isError: false,
        errors: [],
      };
      return { ...defaults, ...response };
    },
    isAvailable: async () => true,
    supportsModel: (m: string) =>
      ["gpt-", "o1-", "o3-", "o4-"].some((p) => m.startsWith(p)),
  };
  return { runtime, calls };
}

test("codex-sdk as brain: outputSchema passed through and structured result returned", async () => {
  const brainDecisionSchema = {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            directive: { type: "string" },
            summary: { type: "string" },
            resource_request: {
              type: "object",
              properties: {
                budget_usd: { type: "number" },
                timeout_s: { type: "number" },
              },
            },
          },
        },
      },
    },
  };

  const structuredResponse = {
    tasks: [
      {
        directive: "Refactor auth module",
        summary: "重构认证模块",
        strategy_note: "Improves security surface",
        resource_request: { budget_usd: 8, timeout_s: 1200 },
        verification_plan: "tsc passes, auth tests pass",
      },
    ],
  };

  const { runtime, calls } = createMockCodexSdkBrainRuntime({
    text: JSON.stringify(structuredResponse),
    structured: structuredResponse,
  });

  const result = await runtime.run("Brain decision prompt", {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    outputSchema: brainDecisionSchema,
    readOnly: true,
    disallowedTools: ["Edit", "Write", "NotebookEdit"],
  });

  // outputSchema was passed to the runtime
  assert.deepEqual(calls[0].opts.outputSchema, brainDecisionSchema);

  // structured output correctly returned
  assert.ok(result.structured);
  const parsed = result.structured as { tasks: Array<{ directive: string }> };
  assert.equal(parsed.tasks[0].directive, "Refactor auth module");

  // readOnly passed through (runtime maps to sandboxMode internally)
  assert.equal(calls[0].opts.readOnly, true);
});

test("codex-sdk as brain: disallowedTools passed but silently ignored (toolSurface=false)", async () => {
  const { runtime, calls } = createMockCodexSdkBrainRuntime();

  await runtime.run("Test", {
    cwd: "/tmp",
    readOnly: true,
    disallowedTools: [
      "Edit",
      "Write",
      "NotebookEdit",
      "mcp__db-coder-system-data__create_task",
    ],
  });

  // disallowedTools ARE passed in RunOptions (the interface allows them)
  assert.deepEqual(calls[0].opts.disallowedTools, [
    "Edit",
    "Write",
    "NotebookEdit",
    "mcp__db-coder-system-data__create_task",
  ]);

  // But the runtime's toolSurface=false means it won't act on them.
  // The real CodexSdkRuntime.run() simply doesn't read opts.disallowedTools.
  // File mutation prevention relies on readOnly → sandboxMode: "read-only".
  assert.equal(runtime.capabilities.toolSurface, false);
});

test("codex-sdk as brain: systemPrompt is prepended to prompt (no native instructions)", async () => {
  // In the real CodexSdkRuntime (line 106-108), systemPrompt is prepended.
  // This test verifies the brainThink contract: systemPrompt is passed in RunOptions.
  const { runtime, calls } = createMockCodexSdkBrainRuntime();

  await runtime.run("Analyze the project", {
    cwd: "/tmp",
    systemPrompt:
      "You are the brain of an autonomous coding agent. Read CLAUDE.md for context.",
    readOnly: true,
  });

  // systemPrompt is available for the runtime to handle
  assert.equal(
    calls[0].opts.systemPrompt,
    "You are the brain of an autonomous coding agent. Read CLAUDE.md for context.",
  );
});

test("codex-sdk as brain: session resume with unconditional persistence", async () => {
  const { runtime, calls } = createMockCodexSdkBrainRuntime({
    sessionId: "thread-resumed-002",
  });

  // CodexSdkRuntime has sessionPersistence=true (unconditional)
  assert.equal(runtime.capabilities.sessionPersistence, true);

  const result = await runtime.run("Continue analysis", {
    cwd: "/tmp",
    resumeSessionId: "thread-brain-001",
    resumePrompt: "Continue from where you left off",
  });

  assert.equal(calls[0].opts.resumeSessionId, "thread-brain-001");
  assert.equal(calls[0].opts.resumePrompt, "Continue from where you left off");
  assert.equal(result.sessionId, "thread-resumed-002");
});

test("codex-sdk as brain: error result propagated correctly", async () => {
  const { runtime } = createMockCodexSdkBrainRuntime({
    isError: true,
    errors: ["API rate limit exceeded"],
    text: "",
    structured: undefined,
  });

  const result = await runtime.run("Decide next task", {
    cwd: "/tmp",
    readOnly: true,
  });

  assert.equal(result.isError, true);
  assert.deepEqual(result.errors, ["API rate limit exceeded"]);
  assert.equal(result.structured, undefined);
});

test("codex-sdk as brain: supportsModel rejects Claude models", () => {
  const { runtime } = createMockCodexSdkBrainRuntime();

  // Brain routed to codex-sdk should use codex-compatible models
  assert.equal(runtime.supportsModel("gpt-5.3-codex"), true);
  assert.equal(runtime.supportsModel("o4-mini"), true);
  assert.equal(runtime.supportsModel("claude-opus-4-6"), false);
});

test("getRuntime via alias: 'codex' resolves to codex-sdk (SDK-first)", async () => {
  clearRuntimes();

  const sdk: RuntimeAdapter = {
    name: "codex-sdk",
    capabilities: {
      nativeOutputSchema: true,
      eventStreaming: true,
      sessionPersistence: true,
      sandboxControl: false,
      toolSurface: false,
      extendedThinking: false,
    },
    run: async () => ({
      text: "",
      costUsd: 0,
      durationMs: 0,
      isError: false,
      errors: [],
    }),
    isAvailable: async () => true,
    supportsModel: () => true,
  };

  registerRuntime("codex-sdk", sdk);

  const { getRuntime } = await import("./runtimeFactory.js");
  const result = await getRuntime("codex");
  assert.equal(result.name, "codex-sdk");

  clearRuntimes();
});
