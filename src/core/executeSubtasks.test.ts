import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MainLoop } from "./MainLoop.js";
import type { Task, SubTaskRecord } from "../memory/types.js";
import type { SessionResult } from "../bridges/ClaudeCodeSession.js";

/**
 * Creates a minimal MainLoop instance with mocked internals,
 * bypassing the real constructor.
 */
function buildStub(overrides: {
  taskStore: {
    getTask: (id: string) => Promise<Task | null>;
    updateTask: (id: string, updates: Partial<Task>) => Promise<void>;
    addLog: (...args: unknown[]) => Promise<void>;
  };
  workerExecute: (
    task: Task,
    opts?: Record<string, unknown>,
  ) => Promise<SessionResult>;
  hardVerify: () => Promise<{ passed: boolean; reason?: string }>;
  costTracker: { addCost: (...args: unknown[]) => Promise<void> };
}) {
  // Bypass constructor completely
  const loop = Object.create(MainLoop.prototype) as InstanceType<
    typeof MainLoop
  >;

  // Inject mocked dependencies as private fields
  const any = loop as unknown as Record<string, unknown>;
  any.taskStore = overrides.taskStore;
  any.costTracker = overrides.costTracker;
  any.config = {
    projectPath: "/tmp/test",
    values: { autonomy: { maxRetries: 0 } },
  };

  // Replace private methods
  any.workerExecute = overrides.workerExecute;
  any.hardVerify = overrides.hardVerify;

  return loop;
}

function makeTask(subtasks: SubTaskRecord[]): Task {
  return {
    id: "task-1",
    project_path: "/tmp/test",
    task_description: "test task",
    phase: "executing",
    priority: 1,
    plan: null,
    subtasks,
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

function makeSessionResult(overrides?: Partial<SessionResult>): SessionResult {
  return {
    text: "done",
    costUsd: 0,
    sessionId: "sess-1",
    exitCode: 0,
    numTurns: 1,
    durationMs: 100,
    isError: false,
    errors: [],
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    ...overrides,
  };
}

// --- Tests ---

describe("executeSubtasks", () => {
  it("should match subtasks by order-based ID, not array index", async () => {
    // Persisted subtasks stored in reverse order (B first, A second).
    // Input subtasks arrive as order:1, order:2.
    // The code must match by order→id mapping, NOT by array position.
    const subtaskRecords: SubTaskRecord[] = [
      {
        id: "B",
        description: "beta",
        executor: "claude",
        status: "pending",
        order: 2,
      },
      {
        id: "A",
        description: "alpha",
        executor: "claude",
        status: "pending",
        order: 1,
      },
    ];

    let currentTask = makeTask(subtaskRecords);
    const updateCalls: Array<{ subtasks: SubTaskRecord[] }> = [];

    const loop = buildStub({
      taskStore: {
        getTask: async () => structuredClone(currentTask),
        updateTask: async (_id, updates) => {
          if (updates.subtasks) {
            updateCalls.push({ subtasks: updates.subtasks as SubTaskRecord[] });
            currentTask = {
              ...currentTask,
              subtasks: updates.subtasks as SubTaskRecord[],
            };
          }
        },
        addLog: async () => {},
      },
      workerExecute: async () => makeSessionResult(),
      hardVerify: async () => ({ passed: true }),
      costTracker: { addCost: async () => {} },
    });

    const result = await (loop as unknown as Record<string, Function>)[
      "executeSubtasks"
    ](
      currentTask,
      [
        { description: "alpha", order: 1 },
        { description: "beta", order: 2 },
      ],
      {
        baselineErrors: 0,
        startCommit: "abc123",
      },
    );

    assert.ok(result.success, "executeSubtasks should succeed");

    // Sorted execution order: order=1 first, order=2 second.
    // updateCalls pattern: [running, done, running, done]
    // Call [0]: set running for order=1 → must target id='A'
    const firstRunning = updateCalls[0].subtasks.find(
      (s) => s.status === "running",
    );
    assert.equal(
      firstRunning?.id,
      "A",
      "First running update must target id='A' (order=1), not array-index-based 'B'",
    );

    // Call [2]: set running for order=2 → must target id='B'
    const secondRunning = updateCalls[2].subtasks.find(
      (s) => s.status === "running",
    );
    assert.equal(
      secondRunning?.id,
      "B",
      "Second running update must target id='B' (order=2), not array-index-based 'A'",
    );
  });

  it("should refresh task after writing 'running' status, preventing stale-state regression in error path", async () => {
    const subtaskRecords: SubTaskRecord[] = [
      {
        id: "1",
        description: "only subtask",
        executor: "claude",
        status: "pending",
        order: 1,
      },
    ];

    let currentTask = makeTask(subtaskRecords);
    const updateCalls: Array<{ subtasks: SubTaskRecord[] }> = [];

    const loop = buildStub({
      taskStore: {
        getTask: async () => structuredClone(currentTask),
        updateTask: async (_id, updates) => {
          if (updates.subtasks) {
            updateCalls.push({ subtasks: updates.subtasks as SubTaskRecord[] });
            currentTask = {
              ...currentTask,
              subtasks: updates.subtasks as SubTaskRecord[],
            };
          }
        },
        addLog: async () => {},
      },
      // Worker reports error — triggers the error path that writes workerError
      workerExecute: async () =>
        makeSessionResult({ isError: true, errors: ["compile error"] }),
      hardVerify: async () => ({ passed: true }),
      costTracker: { addCost: async () => {} },
    });

    const result = await (loop as unknown as Record<string, Function>)[
      "executeSubtasks"
    ](currentTask, [{ description: "only subtask", order: 1 }], {
      baselineErrors: 0,
      startCommit: "abc123",
    });

    assert.ok(
      result.success,
      "executeSubtasks should succeed (hardVerify passes)",
    );

    // updateCalls should contain:
    // [0] set status: "running"
    // [1] set workerError (error path)
    // [2] set status: "done"
    assert.ok(
      updateCalls.length >= 2,
      `Expected at least 2 updateTask calls, got ${updateCalls.length}`,
    );

    // Call [0]: status set to "running"
    const runningCall = updateCalls[0].subtasks.find((s) => s.id === "1");
    assert.equal(
      runningCall?.status,
      "running",
      "First update should set status to running",
    );

    // Call [1]: error path writes workerError — status must still be "running", NOT "pending"
    const errorCall = updateCalls[1].subtasks.find((s) => s.id === "1");
    assert.equal(
      errorCall?.status,
      "running",
      "Error path must preserve 'running' status (not regress to 'pending'). " +
        "Without task re-read after running write, stale task.subtasks would overwrite status.",
    );
    assert.ok(errorCall?.workerError, "Error path should set workerError");
  });

  it("should fail-fast when getTask() returns null at entry", async () => {
    const subtaskRecords: SubTaskRecord[] = [
      {
        id: "1",
        description: "only subtask",
        executor: "claude",
        status: "pending",
        order: 1,
      },
    ];

    const currentTask = makeTask(subtaskRecords);
    let workerCalled = false;

    const loop = buildStub({
      taskStore: {
        // First getTask (entry re-read) returns null — task disappeared
        getTask: async () => null,
        updateTask: async () => {},
        addLog: async () => {},
      },
      workerExecute: async () => {
        workerCalled = true;
        return makeSessionResult();
      },
      hardVerify: async () => ({ passed: true }),
      costTracker: { addCost: async () => {} },
    });

    const result = await (loop as unknown as Record<string, Function>)[
      "executeSubtasks"
    ](currentTask, [{ description: "only subtask", order: 1 }], {
      baselineErrors: 0,
      startCommit: "abc123",
    });

    assert.equal(
      result.success,
      false,
      "Should return failure when task disappears at entry",
    );
    assert.ok(
      result.reason?.includes("disappeared") || result.reason?.includes("null"),
      `Reason should mention task disappearance, got: ${result.reason}`,
    );
    assert.equal(
      workerCalled,
      false,
      "Worker should NOT be called when task is null",
    );
  });

  it("should fail-fast when getTask() returns null after running-status write", async () => {
    const subtaskRecords: SubTaskRecord[] = [
      {
        id: "1",
        description: "only subtask",
        executor: "claude",
        status: "pending",
        order: 1,
      },
    ];

    const currentTask = makeTask(subtaskRecords);
    let getTaskCallCount = 0;
    let workerCalled = false;

    const loop = buildStub({
      taskStore: {
        getTask: async () => {
          getTaskCallCount++;
          // First call (entry re-read) returns task; second call (after running write) returns null
          if (getTaskCallCount === 1) return structuredClone(currentTask);
          return null;
        },
        updateTask: async () => {},
        addLog: async () => {},
      },
      workerExecute: async () => {
        workerCalled = true;
        return makeSessionResult();
      },
      hardVerify: async () => ({ passed: true }),
      costTracker: { addCost: async () => {} },
    });

    const result = await (loop as unknown as Record<string, Function>)[
      "executeSubtasks"
    ](currentTask, [{ description: "only subtask", order: 1 }], {
      baselineErrors: 0,
      startCommit: "abc123",
    });

    assert.equal(
      result.success,
      false,
      "Should return failure when task disappears after running write",
    );
    assert.ok(
      result.reason?.includes("disappeared") || result.reason?.includes("null"),
      `Reason should mention task disappearance, got: ${result.reason}`,
    );
    assert.equal(
      workerCalled,
      false,
      "Worker should NOT execute after task disappears",
    );
  });
});
