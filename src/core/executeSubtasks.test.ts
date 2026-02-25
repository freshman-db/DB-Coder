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
  it("should not mutate withId array (.toSorted)", async () => {
    // Two subtasks in reverse order — .sort() would mutate the array,
    // .toSorted() returns a new array leaving the original intact.
    const subtaskRecords: SubTaskRecord[] = [
      {
        id: "1",
        description: "first",
        executor: "claude",
        status: "pending",
        order: 1,
      },
      {
        id: "2",
        description: "second",
        executor: "claude",
        status: "pending",
        order: 2,
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
            // Simulate DB persisting the update
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

    // Pass subtasks in REVERSE order — if .sort() mutates, iteration order bugs emerge
    const subtasksInput = [
      { description: "second", order: 2 },
      { description: "first", order: 1 },
    ];
    const inputCopy = [...subtasksInput];

    const result = await (loop as unknown as Record<string, Function>)[
      "executeSubtasks"
    ](currentTask, subtasksInput, {
      baselineErrors: 0,
      startCommit: "abc123",
    });

    assert.ok(result.success, "executeSubtasks should succeed");
    // Original input array should NOT have been reordered by .sort()
    assert.deepStrictEqual(
      subtasksInput.map((s) => s.order),
      inputCopy.map((s) => s.order),
      "Input array must not be mutated by sort",
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
});
