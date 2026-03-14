/**
 * WorkerPhase.workerExecute — prompt construction and RunOptions chain tests.
 *
 * Verifies that WorkerPhase correctly constructs both the full prompt and
 * resumePrompt, and passes them through to the RuntimeAdapter.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { WorkerPhase } from "../../../src/core/phases/WorkerPhase.js";
import type {
  RuntimeAdapter,
  RunOptions,
  RunResult,
} from "../../../src/runtime/RuntimeAdapter.js";
import type { Task } from "../../../src/memory/types.js";

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

// ---------------------------------------------------------------------------
// workerReviewFix: FIX vs REWRITE prompt, cumulativeContext, durationMs
// ---------------------------------------------------------------------------

describe("WorkerPhase.workerReviewFix prompt and return", () => {
  it("isRewrite=false: prompt says 'Fix these issues'", async () => {
    const calls: CapturedCall[] = [];
    const phase = buildPhase(createMockRuntime(calls));

    await phase.workerReviewFix(makeTask(), "add null checks", "sess-1");

    assert.equal(calls.length, 1);
    assert.ok(calls[0].prompt.includes("Fix these issues"));
    assert.ok(!calls[0].prompt.includes("fresh solution"));
  });

  it("isRewrite=true: prompt says 'implement a fresh solution'", async () => {
    const calls: CapturedCall[] = [];
    const phase = buildPhase(createMockRuntime(calls));

    await phase.workerReviewFix(
      makeTask(),
      "completely different approach",
      "sess-1",
      undefined,
      true,
    );

    assert.equal(calls.length, 1);
    assert.ok(calls[0].prompt.includes("fresh solution"));
    assert.ok(!calls[0].prompt.includes("Fix these issues"));
  });

  it("with cumulativeContext: prompt includes the context block", async () => {
    const calls: CapturedCall[] = [];
    const phase = buildPhase(createMockRuntime(calls));

    const mockContext =
      '## Previous Fix Attempts (data summary — not action items)\n```json\n{"rounds":[]}\n```';
    await phase.workerReviewFix(makeTask(), "fix it", "sess-1", mockContext);

    assert.ok(calls[0].prompt.includes("Previous Fix Attempts"));
    assert.ok(calls[0].prompt.includes("```json"));
  });

  it("without cumulativeContext: prompt has no 'Previous Fix Attempts'", async () => {
    const calls: CapturedCall[] = [];
    const phase = buildPhase(createMockRuntime(calls));

    await phase.workerReviewFix(makeTask(), "fix it", "sess-1");

    assert.ok(!calls[0].prompt.includes("Previous Fix Attempts"));
  });

  it("passes sessionId as resumeSessionId", async () => {
    const calls: CapturedCall[] = [];
    const phase = buildPhase(createMockRuntime(calls));

    await phase.workerReviewFix(makeTask(), "fix", "my-sess");

    assert.equal(calls[0].opts.resumeSessionId, "my-sess");
  });

  it("return includes durationMs", async () => {
    const calls: CapturedCall[] = [];
    const phase = buildPhase(createMockRuntime(calls));

    const result = await phase.workerReviewFix(makeTask(), "fix", "sess-1");

    assert.equal(typeof result.durationMs, "number");
    assert.equal(result.durationMs, 100);
  });
});

// ---------------------------------------------------------------------------
// Brain-driven: reviewChecklist injection
// ---------------------------------------------------------------------------

describe("WorkerPhase.workerExecuteBrainDriven checklist injection", () => {
  it("injects checklist into main prompt when reviewChecklist is provided", async () => {
    const calls: CapturedCall[] = [];
    const phase = buildPhase(createMockRuntime(calls));

    await phase.workerExecute(makeTask(), {
      directive: "Implement feature X",
      reviewChecklist: "## Pre-Review Checklist\n- [high] Check error handling",
    });

    assert.ok(
      calls[0].prompt.includes("Pre-Review Checklist"),
      "main prompt must include checklist",
    );
    assert.ok(calls[0].prompt.includes("Check error handling"));
  });

  it("injects checklist into resumePrompt when both checklist and resume are provided", async () => {
    const calls: CapturedCall[] = [];
    const phase = buildPhase(createMockRuntime(calls));

    await phase.workerExecute(makeTask(), {
      directive: "Implement feature X",
      resumeSessionId: "prev-sess",
      reviewChecklist:
        "## Pre-Review Checklist\n- [high] Always validate inputs",
    });

    assert.ok(
      calls[0].opts.resumePrompt!.includes("Pre-Review Checklist"),
      "resumePrompt must include checklist",
    );
    assert.ok(calls[0].opts.resumePrompt!.includes("Always validate inputs"));
  });

  it("no checklist marker in prompt when reviewChecklist is absent", async () => {
    const calls: CapturedCall[] = [];
    const phase = buildPhase(createMockRuntime(calls));

    await phase.workerExecute(makeTask(), {
      directive: "Implement feature X",
    });

    assert.ok(!calls[0].prompt.includes("Pre-Review Checklist"));
  });

  it("no checklist in resumePrompt when checklist is absent", async () => {
    const calls: CapturedCall[] = [];
    const phase = buildPhase(createMockRuntime(calls));

    await phase.workerExecute(makeTask(), {
      directive: "Implement feature X",
      resumeSessionId: "prev-sess",
    });

    assert.ok(!calls[0].opts.resumePrompt!.includes("Pre-Review Checklist"));
  });

  it("legacy path (no directive) also injects checklist", async () => {
    const calls: CapturedCall[] = [];
    const phase = buildPhase(createMockRuntime(calls));

    await phase.workerExecute(makeTask(), {
      reviewChecklist: "## Pre-Review Checklist\n- [high] Something",
    });

    // Legacy path (subtask execution) must also inject checklist
    assert.ok(
      calls[0].prompt.includes("Pre-Review Checklist"),
      "legacy prompt must include checklist",
    );
    assert.ok(calls[0].prompt.includes("[high] Something"));
  });

  it("legacy path with resume injects checklist into resumePrompt", async () => {
    const calls: CapturedCall[] = [];
    const phase = buildPhase(createMockRuntime(calls));

    await phase.workerExecute(makeTask(), {
      resumeSessionId: "prev-sess",
      reviewChecklist: "## Pre-Review Checklist\n- [high] Validate inputs",
    });

    assert.ok(
      calls[0].opts.resumePrompt!.includes("Pre-Review Checklist"),
      "legacy resumePrompt must include checklist",
    );
    assert.ok(calls[0].opts.resumePrompt!.includes("Validate inputs"));
  });
});
