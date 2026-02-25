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
    const addLogCalls: unknown[] = [];

    const loop = buildStub({
      taskStore: {
        getTask: async () => null,
        updateTask: async () => {},
        addLog: async (entry: unknown) => {
          addLogCalls.push(entry);
        },
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
      result.reason?.includes("before subtask execution"),
      `Reason should mention 'before subtask execution', got: ${result.reason}`,
    );
    assert.equal(
      workerCalled,
      false,
      "Worker should NOT be called when task is null",
    );
    // addLog must NOT be called when task is deleted — FK constraint would fail
    assert.equal(
      addLogCalls.filter(
        (c) => (c as Record<string, unknown>).phase === "error",
      ).length,
      0,
      "addLog must NOT be called with phase='error' when task is deleted — FK constraint would fail",
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
    const addLogCalls: unknown[] = [];

    const loop = buildStub({
      taskStore: {
        getTask: async () => {
          getTaskCallCount++;
          // entry=1, patchSubtask(running) pre-read=2 → ok; post-read=3 → null
          if (getTaskCallCount <= 2) return structuredClone(currentTask);
          return null;
        },
        updateTask: async () => {},
        addLog: async (entry: unknown) => {
          addLogCalls.push(entry);
        },
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
      result.reason?.includes("after running-status write"),
      `Reason should mention 'after running-status write', got: ${result.reason}`,
    );
    assert.equal(
      workerCalled,
      false,
      "Worker should NOT execute after task disappears",
    );
    assert.equal(
      addLogCalls.filter(
        (c) => (c as Record<string, unknown>).phase === "error",
      ).length,
      0,
      "addLog must NOT be called with phase='error' when task is deleted — FK constraint would fail",
    );
  });

  it("should fail-fast when getTask() returns null after workerError write", async () => {
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
    let getTaskCallCount = 0;
    const addLogCalls: unknown[] = [];

    const loop = buildStub({
      taskStore: {
        getTask: async () => {
          getTaskCallCount++;
          // 1: entry, 2: patchSubtask(running) pre, 3: post, 4: patchSubtask(workerError) pre → ok
          // 5: patchSubtask(workerError) post → null
          if (getTaskCallCount <= 4) return structuredClone(currentTask);
          return null;
        },
        updateTask: async (_id, updates) => {
          if (updates.subtasks) {
            currentTask = {
              ...currentTask,
              subtasks: updates.subtasks as SubTaskRecord[],
            };
          }
        },
        addLog: async (entry: unknown) => {
          addLogCalls.push(entry);
        },
      },
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

    assert.equal(
      result.success,
      false,
      "Should return failure when task disappears during error processing",
    );
    assert.ok(
      result.reason?.includes("subtask error processing"),
      `Reason should mention 'subtask error processing', got: ${result.reason}`,
    );
    assert.equal(
      addLogCalls.filter(
        (c) => (c as Record<string, unknown>).phase === "error",
      ).length,
      0,
      "addLog must NOT be called with phase='error' when task is deleted — FK constraint would fail",
    );
  });

  it("should fail-fast when getTask() returns null after marking subtask done", async () => {
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
    let getTaskCallCount = 0;
    const addLogCalls: unknown[] = [];

    const loop = buildStub({
      taskStore: {
        getTask: async () => {
          getTaskCallCount++;
          // 1: entry, 2: patchSubtask(running) pre, 3: post, 4: patchSubtask(done) pre → ok
          // 5: patchSubtask(done) post → null
          if (getTaskCallCount <= 4) return structuredClone(currentTask);
          return null;
        },
        updateTask: async (_id, updates) => {
          if (updates.subtasks) {
            currentTask = {
              ...currentTask,
              subtasks: updates.subtasks as SubTaskRecord[],
            };
          }
        },
        addLog: async (entry: unknown) => {
          addLogCalls.push(entry);
        },
      },
      workerExecute: async () => makeSessionResult(),
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
      "Should return failure when task disappears after marking done",
    );
    assert.ok(
      result.reason?.includes("marking subtask done"),
      `Reason should mention 'marking subtask done', got: ${result.reason}`,
    );
    assert.equal(
      addLogCalls.filter(
        (c) => (c as Record<string, unknown>).phase === "error",
      ).length,
      0,
      "addLog must NOT be called with phase='error' when task is deleted — FK constraint would fail",
    );
  });

  it("should read fresh from DB before each subtask write, not from stale memory", async () => {
    // Verifies patchSubtask reads current DB state before writing.
    // An external modification injected via getTask at call 4 (patchSubtask(done) pre-read)
    // must be preserved in the "done" write — proving the write reads fresh, not stale memory.
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
    let getTaskCallCount = 0;
    const updateCalls: Array<{ subtasks: SubTaskRecord[] }> = [];

    const loop = buildStub({
      taskStore: {
        getTask: async () => {
          getTaskCallCount++;
          // 1: entry, 2: patchSubtask(running) pre, 3: post
          // 4: patchSubtask(done) pre — inject external modification here
          if (getTaskCallCount === 4) {
            currentTask = {
              ...currentTask,
              subtasks: currentTask.subtasks.map((s) =>
                s.id === "1" ? { ...s, result: "externally-injected" } : s,
              ),
            };
          }
          return structuredClone(currentTask);
        },
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
    ](currentTask, [{ description: "only subtask", order: 1 }], {
      baselineErrors: 0,
      startCommit: "abc123",
    });

    assert.ok(result.success, "executeSubtasks should succeed");

    // The "done" write (last updateTask call) must include the externally-injected result,
    // proving patchSubtask reads fresh from DB before writing
    const doneWrite = updateCalls[updateCalls.length - 1].subtasks.find(
      (s) => s.id === "1",
    );
    assert.equal(
      doneWrite?.status,
      "done",
      "Last write should set status to done",
    );
    assert.equal(
      doneWrite?.result,
      "externally-injected",
      "patchSubtask must read from DB before each write, preserving concurrent modifications",
    );
  });

  it("should fail when patchSubtask pre-read returns task without matching subtask", async () => {
    // Simulates a race: subtask existed at entry time but was removed before
    // patchSubtask's pre-read. The patchSubtask should return subtask-not-found
    // and the caller should propagate failure.
    const subtaskRecords: SubTaskRecord[] = [
      {
        id: "1",
        description: "only subtask",
        executor: "claude",
        status: "pending",
        order: 1,
      },
    ];

    const taskWithSubtask = makeTask(subtaskRecords);
    const taskWithoutSubtask = makeTask([]); // subtask removed externally
    let getTaskCallCount = 0;
    let workerCalled = false;

    const loop = buildStub({
      taskStore: {
        getTask: async () => {
          getTaskCallCount++;
          // 1: entry read — has subtask (so executeSubtasks proceeds)
          // 2: patchSubtask(running) pre-read — subtask gone
          if (getTaskCallCount === 1) return structuredClone(taskWithSubtask);
          return structuredClone(taskWithoutSubtask);
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
    ](taskWithSubtask, [{ description: "only subtask", order: 1 }], {
      baselineErrors: 0,
      startCommit: "abc123",
    });

    assert.equal(
      result.success,
      false,
      "Should return failure when subtask not found in patchSubtask pre-read",
    );
    assert.ok(
      result.reason?.includes("not found in task"),
      `Reason should mention 'not found in task', got: ${result.reason}`,
    );
    assert.equal(
      workerCalled,
      false,
      "Worker should NOT execute when subtask disappears before running-status write",
    );
  });
});
