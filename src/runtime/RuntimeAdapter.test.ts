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
  getRuntime,
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
  const retrieved = getRuntime("claude-sdk");
  assert.equal(retrieved, runtime);

  // Test alias resolution
  const viaAlias = getRuntime("claude");
  assert.equal(viaAlias, runtime);

  clearRuntimes();
});

test("getRuntime throws for unregistered runtime", () => {
  clearRuntimes();
  assert.throws(
    () => getRuntime("nonexistent"),
    /not registered/,
  );
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
