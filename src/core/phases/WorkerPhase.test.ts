/**
 * WorkerPhase.workerExecute — prompt construction and RunOptions chain tests.
 *
 * Verifies that WorkerPhase correctly constructs both the full prompt and
 * resumePrompt, and passes them through to the RuntimeAdapter.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { WorkerPhase } from "./WorkerPhase.js";
import type {
  RuntimeAdapter,
  RunOptions,
  RunResult,
} from "../../runtime/RuntimeAdapter.js";
import type { Task } from "../../memory/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture the args passed to runtime.run() */
interface CapturedCall {
  prompt: string;
  opts: RunOptions;
}

function createMockRuntime(calls: CapturedCall[]): RuntimeAdapter {
  return {
    name: "claude-sdk",
    capabilities: {
      nativeOutputSchema: true,
      eventStreaming: true,
      sessionPersistence: true,
      sandboxControl: true,
      toolSurface: true,
      extendedThinking: true,
    },
    run: async (prompt, opts) => {
      calls.push({ prompt, opts });
      return makeResult();
    },
    isAvailable: async () => true,
    supportsModel: (id) => id.startsWith("claude-"),
  };
}

function makeResult(): RunResult {
  return {
    text: "done",
    costUsd: 0,
    durationMs: 100,
    sessionId: "sess-1",
    isError: false,
    errors: [],
  };
}

function makeTask(desc = "Fix the bug"): Task {
  return {
    id: "t-1",
    project_path: "/tmp/test",
    task_description: desc,
    phase: "executing",
    priority: 1,
    plan: null,
    subtasks: [],
    review_results: [],
    iteration: 0,
    total_cost_usd: 0,
    git_branch: null,
    start_commit: null,
    depends_on: [],
    status: "active",
    created_at: new Date(),
    updated_at: new Date(),
  };
}

/**
 * Build a WorkerPhase with mocked deps, keeping real workerExecute logic.
 */
function buildPhase(worker: RuntimeAdapter): WorkerPhase {
  const wp = Object.create(WorkerPhase.prototype) as InstanceType<
    typeof WorkerPhase
  >;
  const any = wp as unknown as Record<string, unknown>;

  any.worker = worker;
  any.config = {
    projectPath: "/tmp/test",
    values: {
      claude: { model: "sonnet", maxTaskBudget: 20.0 },
      codex: { model: "gpt-5.3-codex" },
      autonomy: { maxRetries: 0 },
      routing: {
        execute: { runtime: "claude-sdk", model: "opus" },
      },
    },
  };
  any.personaLoader = {
    buildWorkerPrompt: async (opts: { taskDescription: string }) => ({
      prompt: `[FULL] ${opts.taskDescription}`,
      systemPrompt: "system-instructions",
    }),
  };
  any.taskStore = { addLog: async () => {} };
  any.costTracker = { addCost: async () => {} };

  return wp;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorkerPhase.workerExecute prompt chain", () => {
  it("without resumeSessionId: passes full prompt, no resumePrompt", async () => {
    const calls: CapturedCall[] = [];
    const phase = buildPhase(createMockRuntime(calls));

    await phase.workerExecute(makeTask("Implement feature X"));

    assert.equal(calls.length, 1);
    const { prompt, opts } = calls[0];
    assert.ok(
      prompt.includes("[FULL] Implement feature X"),
      "must pass full prompt from personaLoader",
    );
    assert.equal(opts.resumeSessionId, undefined);
    assert.equal(
      opts.resumePrompt,
      undefined,
      "no resumePrompt without resumeSessionId",
    );
    assert.equal(opts.systemPrompt, "system-instructions");
  });

  it("with resumeSessionId: passes full prompt AND resumePrompt", async () => {
    const calls: CapturedCall[] = [];
    const phase = buildPhase(createMockRuntime(calls));

    await phase.workerExecute(makeTask("Fix the bug"), {
      resumeSessionId: "prev-sess",
    });

    assert.equal(calls.length, 1);
    const { prompt, opts } = calls[0];

    // Full prompt is always built
    assert.ok(
      prompt.includes("[FULL] Fix the bug"),
      "full prompt must always be built and passed as main prompt arg",
    );

    // resumePrompt is constructed for the adapter to choose
    assert.equal(opts.resumeSessionId, "prev-sess");
    assert.ok(
      typeof opts.resumePrompt === "string" && opts.resumePrompt.length > 0,
      "resumePrompt must be provided when resumeSessionId is set",
    );
    assert.ok(
      opts.resumePrompt!.includes("Fix the bug"),
      "resumePrompt must include task description",
    );
    assert.ok(
      !opts.resumePrompt!.includes("[FULL]"),
      "resumePrompt must NOT include the full persona-enriched prompt",
    );

    // systemPrompt is still passed — runtime decides whether to use it
    assert.equal(opts.systemPrompt, "system-instructions");
  });

  it("with resumeSessionId + approvedPlan: both prompts include the plan", async () => {
    const calls: CapturedCall[] = [];
    const phase = buildPhase(createMockRuntime(calls));

    await phase.workerExecute(makeTask("Refactor module"), {
      resumeSessionId: "sess-2",
      approvedPlan: "Step 1: Extract interface\nStep 2: Migrate callers",
    });

    const { prompt, opts } = calls[0];

    // Full prompt includes plan
    assert.ok(
      prompt.includes("Approved Implementation Plan"),
      "full prompt must include approved plan section",
    );
    assert.ok(prompt.includes("Extract interface"));

    // resumePrompt also includes plan (abbreviated)
    assert.ok(
      opts.resumePrompt!.includes("Approved Plan"),
      "resumePrompt must include plan",
    );
    assert.ok(opts.resumePrompt!.includes("Extract interface"));
  });

  it("subtaskDescription overrides task_description in both prompts", async () => {
    const calls: CapturedCall[] = [];
    const phase = buildPhase(createMockRuntime(calls));

    await phase.workerExecute(makeTask("Parent task"), {
      resumeSessionId: "sess-3",
      subtaskDescription: "Child subtask: add validation",
    });

    const { prompt, opts } = calls[0];

    assert.ok(
      prompt.includes("Child subtask: add validation"),
      "full prompt uses subtaskDescription",
    );
    assert.ok(
      opts.resumePrompt!.includes("Child subtask: add validation"),
      "resumePrompt uses subtaskDescription",
    );
    assert.ok(
      !opts.resumePrompt!.includes("Parent task"),
      "resumePrompt must NOT use parent task description",
    );
  });
});
