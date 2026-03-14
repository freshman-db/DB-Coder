import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import { WorkerPhase } from "../../src/core/phases/WorkerPhase.js";
import type { Task, SubTaskRecord } from "../../src/memory/types.js";
import type { WorkerResult } from "../../src/core/WorkerAdapter.js";

/**
 * Creates a minimal WorkerPhase instance with mocked internals,
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
  ) => Promise<WorkerResult>;
  hardVerify: () => Promise<{ passed: boolean; reason?: string }>;
  costTracker: { addCost: (...args: unknown[]) => Promise<void> };
  workerFix?: (
    sessionId: string,
    errors: string,
    task: Task,
  ) => Promise<WorkerResult>;
  maxRetries?: number;
}) {
  // Bypass constructor completely
  const wp = Object.create(WorkerPhase.prototype) as InstanceType<
    typeof WorkerPhase
  >;

  // Inject mocked dependencies as private fields
  const any = wp as unknown as Record<string, unknown>;
  any.taskStore = overrides.taskStore;
  any.costTracker = overrides.costTracker;
  any.config = {
    projectPath: "/tmp/test",
    values: { autonomy: { maxRetries: overrides.maxRetries ?? 0 } },
  };

  // Mock worker adapter (provides .name for logging)
  any.worker = { name: "claude" };

  // Replace public methods / injected callbacks
  any.workerExecute = overrides.workerExecute;
  any.hardVerify = overrides.hardVerify;
  if (overrides.workerFix) {
    any.workerFix = overrides.workerFix;
  }

  return wp;
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

function makeWorkerResult(overrides?: Partial<WorkerResult>): WorkerResult {
  return {
    text: "done",
    costUsd: 0,
    sessionId: "sess-1",
    durationMs: 100,
    isError: false,
    errors: [],
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
      workerExecute: async () => makeWorkerResult(),
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
        makeWorkerResult({ isError: true, errors: ["compile error"] }),
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
        return makeWorkerResult();
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

  it("should fail-fast when getTask() returns null during running-status write", async () => {
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
    let runningWritten = false;
    let workerCalled = false;
    const addLogCalls: unknown[] = [];

    const loop = buildStub({
      taskStore: {
        getTask: async () => {
          // After running status is persisted, task disappears
          if (runningWritten) return null;
          return structuredClone(currentTask);
        },
        updateTask: async (_id, updates) => {
          const subs = updates.subtasks as SubTaskRecord[] | undefined;
          if (subs?.some((s) => s.status === "running")) {
            runningWritten = true;
          }
        },
        addLog: async (entry: unknown) => {
          addLogCalls.push(entry);
        },
      },
      workerExecute: async () => {
        workerCalled = true;
        return makeWorkerResult();
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
      result.reason?.includes("during running-status write"),
      `Reason should mention 'during running-status write', got: ${result.reason}`,
    );
    assert.equal(
      result.failureKind,
      "task-gone",
      "failureKind should be 'task-gone' when task disappears after running-status write",
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
    let errorWritten = false;
    const addLogCalls: unknown[] = [];

    const loop = buildStub({
      taskStore: {
        getTask: async () => {
          // After workerError is persisted, task disappears
          if (errorWritten) return null;
          return structuredClone(currentTask);
        },
        updateTask: async (_id, updates) => {
          const subs = updates.subtasks as SubTaskRecord[] | undefined;
          if (subs) {
            if (subs.some((s) => s.workerError)) {
              errorWritten = true;
            }
            currentTask = {
              ...currentTask,
              subtasks: subs,
            };
          }
        },
        addLog: async (entry: unknown) => {
          addLogCalls.push(entry);
        },
      },
      workerExecute: async () =>
        makeWorkerResult({ isError: true, errors: ["compile error"] }),
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
      result.reason?.includes("error-status write"),
      `Reason should mention 'error-status write', got: ${result.reason}`,
    );
    assert.equal(
      result.failureKind,
      "task-gone",
      "failureKind should be 'task-gone' when task disappears after error-status write",
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
    let doneWritten = false;
    const addLogCalls: unknown[] = [];

    const loop = buildStub({
      taskStore: {
        getTask: async () => {
          // After done status is persisted, task disappears
          if (doneWritten) return null;
          return structuredClone(currentTask);
        },
        updateTask: async (_id, updates) => {
          const subs = updates.subtasks as SubTaskRecord[] | undefined;
          if (subs) {
            if (subs.some((s) => s.status === "done")) {
              doneWritten = true;
            }
            currentTask = {
              ...currentTask,
              subtasks: subs,
            };
          }
        },
        addLog: async (entry: unknown) => {
          addLogCalls.push(entry);
        },
      },
      workerExecute: async () => makeWorkerResult(),
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
      result.reason?.includes("done-status write"),
      `Reason should mention 'done-status write', got: ${result.reason}`,
    );
    assert.equal(
      result.failureKind,
      "task-gone",
      "failureKind should be 'task-gone' when task disappears after done-status write",
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
      workerExecute: async () => makeWorkerResult(),
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

  it("should accumulate totalVerifyMs across subtasks", async () => {
    const subtaskRecords: SubTaskRecord[] = [
      {
        id: "A",
        description: "alpha",
        executor: "claude",
        status: "pending",
        order: 1,
      },
      {
        id: "B",
        description: "beta",
        executor: "claude",
        status: "pending",
        order: 2,
      },
    ];

    let currentTask = makeTask(subtaskRecords);
    let hardVerifyCalls = 0;

    mock.timers.enable({ apis: ["Date"] });
    try {
      const loop = buildStub({
        taskStore: {
          getTask: async () => structuredClone(currentTask),
          updateTask: async (_id, updates) => {
            if (updates.subtasks) {
              currentTask = {
                ...currentTask,
                subtasks: updates.subtasks as SubTaskRecord[],
              };
            }
          },
          addLog: async () => {},
        },
        workerExecute: async () => makeWorkerResult(),
        hardVerify: async () => {
          hardVerifyCalls++;
          // Advance time by 50ms during each verify call
          mock.timers.tick(50);
          return { passed: true };
        },
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
      assert.equal(
        hardVerifyCalls,
        2,
        "hardVerify should be called once per subtask",
      );
      assert.equal(
        result.totalVerifyMs,
        100,
        "totalVerifyMs should be sum of per-subtask verify durations (50 + 50 = 100)",
      );
    } finally {
      mock.timers.reset();
    }
  });

  it("should return totalVerifyMs=0 on early failure before any verify", async () => {
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

    const loop = buildStub({
      taskStore: {
        getTask: async () => null,
        updateTask: async () => {},
        addLog: async () => {},
      },
      workerExecute: async () => makeWorkerResult(),
      hardVerify: async () => ({ passed: true }),
      costTracker: { addCost: async () => {} },
    });

    const result = await (loop as unknown as Record<string, Function>)[
      "executeSubtasks"
    ](currentTask, [{ description: "only subtask", order: 1 }], {
      baselineErrors: 0,
      startCommit: "abc123",
    });

    assert.equal(result.success, false, "Should fail when task disappears");
    assert.equal(
      result.totalVerifyMs,
      0,
      "totalVerifyMs should be 0 when no verify ran",
    );
  });

  it("should accumulate totalVerifyMs including workerFix and retry orchestration time", async () => {
    // First hardVerify fails (30ms) → retry phase: workerFix (200ms) → commitAll throws
    // → loop breaks. totalVerifyMs should include both initial verify AND retry phase.
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
    let hardVerifyCalls = 0;

    mock.timers.enable({ apis: ["Date"] });
    try {
      const loop = buildStub({
        taskStore: {
          getTask: async () => structuredClone(currentTask),
          updateTask: async (_id, updates) => {
            if (updates.subtasks) {
              currentTask = {
                ...currentTask,
                subtasks: updates.subtasks as SubTaskRecord[],
              };
            }
          },
          addLog: async () => {},
        },
        workerExecute: async () => makeWorkerResult(),
        hardVerify: async () => {
          hardVerifyCalls++;
          // Advance time by 30ms per verify call
          mock.timers.tick(30);
          return { passed: false, reason: "errors increased" };
        },
        workerFix: async () => {
          // Advance time by 200ms for fix work — now counted in totalVerifyMs
          mock.timers.tick(200);
          return makeWorkerResult();
        },
        costTracker: { addCost: async () => {} },
        maxRetries: 1,
      });

      const result = await (loop as unknown as Record<string, Function>)[
        "executeSubtasks"
      ](currentTask, [{ description: "only subtask", order: 1 }], {
        baselineErrors: 0,
        startCommit: "abc123",
      });

      assert.equal(result.success, false, "Should fail after HALT");
      assert.ok(
        hardVerifyCalls >= 1,
        "hardVerify should be called at least once",
      );
      // Initial verify = 30ms. Retry phase = workerFix 200ms + commitAll throws.
      // totalVerifyMs includes both initial verify and full retry phase.
      assert.ok(
        result.totalVerifyMs >= 230 && result.totalVerifyMs <= 260,
        `totalVerifyMs should be 230-260ms (initial verify 30ms + retry phase with workerFix 200ms), got: ${result.totalVerifyMs}`,
      );
    } finally {
      mock.timers.reset();
    }
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
    let updateTaskCallCount = 0;
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
        updateTask: async () => {
          updateTaskCallCount++;
        },
        addLog: async () => {},
      },
      workerExecute: async () => {
        workerCalled = true;
        return makeWorkerResult();
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
      result.failureKind,
      "subtask-not-found",
      "failureKind should be 'subtask-not-found' for structured error matching",
    );
    assert.equal(
      workerCalled,
      false,
      "Worker should NOT execute when subtask disappears before running-status write",
    );
    assert.equal(
      updateTaskCallCount,
      0,
      "subtask-not-found should not trigger updateTask — no write occurred",
    );
  });

  it("should handle subtasks without `order` — sort defense pushes to Infinity, no NaN crash", async () => {
    // Subtasks with undefined order get sentinel IDs (no persisted match).
    // The sort comparator must not crash with NaN; Infinity fallback keeps stable order.
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
    const executedDescriptions: string[] = [];

    const loop = buildStub({
      taskStore: {
        getTask: async () => structuredClone(currentTask),
        updateTask: async (_id, updates) => {
          if (updates.subtasks) {
            currentTask = {
              ...currentTask,
              subtasks: updates.subtasks as SubTaskRecord[],
            };
          }
        },
        addLog: async () => {},
      },
      workerExecute: async (_task, opts) => {
        // Track via subtaskDescription option — works even for sentinel IDs
        const desc = (opts as Record<string, unknown>)?.subtaskDescription;
        if (typeof desc === "string") executedDescriptions.push(desc);
        return makeWorkerResult();
      },
      hardVerify: async () => ({ passed: true }),
      costTracker: { addCost: async () => {} },
    });

    // Pass subtasks WITHOUT order field — simulates malformed brain output
    const result = await (loop as unknown as Record<string, Function>)[
      "executeSubtasks"
    ](
      currentTask,
      [{ description: "first" }, { description: "second" }] as Array<{
        description: string;
        order?: number;
      }>,
      {
        baselineErrors: 0,
        startCommit: "abc123",
      },
    );

    assert.ok(
      result.success,
      "executeSubtasks should succeed with missing order",
    );
    // Both subtasks have undefined order → Infinity fallback → stable insertion order
    assert.deepEqual(
      executedDescriptions,
      ["first", "second"],
      "Subtasks should execute in stable order when `order` is missing (Infinity fallback)",
    );
  });

  it("should handle subtasks with NaN/string `order` — sort defense prevents NaN comparator", async () => {
    const subtaskRecords: SubTaskRecord[] = [
      {
        id: "1",
        description: "alpha",
        executor: "claude",
        status: "pending",
        order: 1,
      },
      {
        id: "2",
        description: "beta",
        executor: "claude",
        status: "pending",
        order: 2,
      },
    ];

    let currentTask = makeTask(subtaskRecords);
    const executedDescriptions: string[] = [];

    const loop = buildStub({
      taskStore: {
        getTask: async () => structuredClone(currentTask),
        updateTask: async (_id, updates) => {
          if (updates.subtasks) {
            currentTask = {
              ...currentTask,
              subtasks: updates.subtasks as SubTaskRecord[],
            };
          }
        },
        addLog: async () => {},
      },
      workerExecute: async (_task, opts) => {
        const desc = (opts as Record<string, unknown>)?.subtaskDescription;
        if (typeof desc === "string") executedDescriptions.push(desc);
        return makeWorkerResult();
      },
      hardVerify: async () => ({ passed: true }),
      costTracker: { addCost: async () => {} },
    });

    // Pass subtasks with invalid order values
    const result = await (loop as unknown as Record<string, Function>)[
      "executeSubtasks"
    ](
      currentTask,
      [
        { description: "alpha", order: "not-a-number" },
        { description: "beta", order: NaN },
      ] as unknown as Array<{ description: string; order: number }>,
      {
        baselineErrors: 0,
        startCommit: "abc123",
      },
    );

    assert.ok(
      result.success,
      "executeSubtasks should succeed with NaN/string order",
    );
    assert.deepEqual(
      executedDescriptions,
      ["alpha", "beta"],
      "Subtasks with invalid order should execute stably (Infinity fallback)",
    );
  });

  it("should use order-based fallback (not index) when orderToId lookup misses — prevents wrong id binding", async () => {
    // Persisted subtasks WITHOUT order (legacy data) — simulates records
    // created before the order field was introduced.
    //
    // Incoming:  order=5, order=6 — neither exists in orderToId (empty map).
    //
    // OLD BUG (fallback = String(i+1)):
    //   i=0 → fallback "1" → persistedIds has "1" → persistedOrder undefined
    //   → enters the "no order field" sentinel branch, touching persisted id.
    // NEW CODE (fallback = String(st.order)):
    //   order=5 → fallback "5" → persistedIds lacks "5" → sentinel directly,
    //   never consulting persisted ids "1"/"2" at all.
    //
    // Both paths produce sentinels, but the fix avoids probing persisted ids
    // entirely when the incoming order doesn't correspond to any persisted id.
    // This also validates that new subtask ID generation (line 706,
    // order-based) stays consistent with the fallback lookup semantics.
    const subtaskRecords: SubTaskRecord[] = [
      {
        id: "1",
        description: "first",
        executor: "claude",
        status: "pending",
      },
      {
        id: "2",
        description: "second",
        executor: "claude",
        status: "pending",
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
      workerExecute: async () => makeWorkerResult(),
      hardVerify: async () => ({ passed: true }),
      costTracker: { addCost: async () => {} },
    });

    const result = await (loop as unknown as Record<string, Function>)[
      "executeSubtasks"
    ](
      currentTask,
      [
        { description: "new-task-A", order: 5 },
        { description: "new-task-B", order: 6 },
      ],
      {
        baselineErrors: 0,
        startCommit: "abc123",
      },
    );

    assert.ok(
      result.success,
      "executeSubtasks should succeed with sentinel IDs",
    );
    // Sentinel subtasks skip patchSubtask DB writes (persistedIds check).
    // With old code, fallback "1"/"2" would hit persistedIds and trigger
    // the order mismatch branch. With the fix, fallback "5"/"6" aren't
    // in persistedIds → no spurious DB writes for persisted subtask IDs.
    // updateCalls should contain NO running-status writes for id="1" or id="2".
    for (const call of updateCalls) {
      for (const s of call.subtasks) {
        if (s.id === "1" || s.id === "2") {
          assert.notEqual(
            s.status,
            "running",
            `Persisted subtask id=${s.id} should NOT be set to running by unrelated incoming orders`,
          );
        }
      }
    }
  });

  it("should use sentinel when fallback String(order) hits persistedId but stored order mismatches", async () => {
    // Persisted: id="1" order=1, id="2" order=2, id="3" order=7
    // Incoming:  order=1 (orderToId hit), order=3 (miss → fallback)
    //
    // For order=3: orderToId has no entry for 3 → fallback String(3)="3"
    //   → persistedIds has "3" → persistedOrder=7 → 7≠3 → ORDER MISMATCH
    //   → sentinel (NOT id="3"), verifying the mismatch branch at lines 2195-2198.
    const subtaskRecords: SubTaskRecord[] = [
      {
        id: "1",
        description: "task-A",
        executor: "claude",
        status: "pending",
        order: 1,
      },
      {
        id: "2",
        description: "task-B",
        executor: "claude",
        status: "pending",
        order: 2,
      },
      {
        id: "3",
        description: "task-C",
        executor: "claude",
        status: "pending",
        order: 7,
      },
    ];

    let currentTask = makeTask(subtaskRecords);
    const updateCalls: Array<{ subtasks: SubTaskRecord[] }> = [];
    const executedDescriptions: string[] = [];

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
      workerExecute: async (_task, opts) => {
        const desc = (opts as Record<string, unknown>)?.subtaskDescription;
        if (typeof desc === "string") executedDescriptions.push(desc);
        return makeWorkerResult();
      },
      hardVerify: async () => ({ passed: true }),
      costTracker: { addCost: async () => {} },
    });

    const result = await (loop as unknown as Record<string, Function>)[
      "executeSubtasks"
    ](
      currentTask,
      [
        { description: "known-task", order: 1 }, // orderToId hit → id="1"
        { description: "mismatch-test", order: 3 }, // miss → fallback "3" in persistedIds, order=7≠3 → sentinel
      ],
      {
        baselineErrors: 0,
        startCommit: "abc123",
      },
    );

    assert.ok(result.success, "executeSubtasks should succeed");
    // Both subtasks should execute (order=1 first, then order=3).
    assert.deepEqual(
      executedDescriptions,
      ["known-task", "mismatch-test"],
      "Should execute known-task (order=1) then mismatch-test (order=3)",
    );
    // order=3 should NOT reuse id="3" because stored order=7 mismatches.
    // Verify id="3" was never set to running in any update call.
    for (const call of updateCalls) {
      for (const s of call.subtasks) {
        if (s.id === "3") {
          assert.notEqual(
            s.status,
            "running",
            `Persisted subtask id="3" (order=7) should NOT be set to running for incoming order=3`,
          );
        }
      }
    }
  });

  it("should match subtask with falsy-but-valid ID (empty string) via orderToId, not fallback", async () => {
    // Regression: `if (matchedId)` skips empty-string IDs because "" is falsy.
    // After fix to `if (matchedId != null)`, empty-string IDs should be recognized.
    const subtaskRecords: SubTaskRecord[] = [
      {
        id: "",
        description: "empty-id subtask",
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
      workerExecute: async () => makeWorkerResult(),
      hardVerify: async () => ({ passed: true }),
      costTracker: { addCost: async () => {} },
    });

    const result = await (loop as unknown as Record<string, Function>)[
      "executeSubtasks"
    ](currentTask, [{ description: "empty-id subtask", order: 1 }], {
      baselineErrors: 0,
      startCommit: "abc123",
    });

    assert.ok(result.success, "executeSubtasks should succeed");

    // The first running-status write must use id="" (matched via orderToId),
    // NOT a sentinel like "__sentinel_..." which would happen if the falsy
    // check skipped the match.
    const firstRunning = updateCalls[0]?.subtasks.find(
      (s) => s.status === "running",
    );
    assert.equal(
      firstRunning?.id,
      "",
      'Subtask with id="" must be matched via orderToId, not fall through to sentinel',
    );
    // Verify no sentinel IDs were generated
    for (const call of updateCalls) {
      for (const s of call.subtasks) {
        assert.ok(
          !s.id.startsWith("__sentinel_"),
          `No sentinel ID should be generated when orderToId has a valid match (got ${s.id})`,
        );
      }
    }
  });

  it("should re-evaluate isPersisted from live task.subtasks when subtask is removed concurrently", async () => {
    // Scenario: task starts with two persisted subtasks ("1" and "2").
    // After patchSubtask sets "1" to running, the task returned no longer
    // contains subtask "2" (concurrent external removal).
    //
    // OLD code: persistedIds.has("2") → true (stale snapshot) → calls patchSubtask
    //           → patchSubtask pre-read finds no "2" → returns subtask-not-found
    //           → executeSubtasks returns failure.
    // NEW code: isPersisted = task.subtasks.some(s => s.id === "2") → false
    //           (task was refreshed by patchSubtask for "1") → skips patchSubtask
    //           → worker executes → succeeds.
    const subtaskRecords: SubTaskRecord[] = [
      {
        id: "1",
        description: "first subtask",
        executor: "claude",
        status: "pending",
        order: 1,
      },
      {
        id: "2",
        description: "second subtask",
        executor: "claude",
        status: "pending",
        order: 2,
      },
    ];

    let currentTask = makeTask(subtaskRecords);
    let firstUpdateDone = false;
    const runningWritesForId2: SubTaskRecord[] = [];

    const loop = buildStub({
      taskStore: {
        getTask: async () => {
          // Once the first updateTask (running-status for "1") has been called,
          // return task WITHOUT id="2" to simulate concurrent removal.
          if (firstUpdateDone) {
            return structuredClone({
              ...currentTask,
              subtasks: currentTask.subtasks.filter((s) => s.id !== "2"),
            });
          }
          return structuredClone(currentTask);
        },
        updateTask: async (_id, updates) => {
          const subs = updates.subtasks as SubTaskRecord[] | undefined;
          if (subs) {
            // Track any running-status writes targeting id="2"
            const r2 = subs.find((s) => s.id === "2" && s.status === "running");
            if (r2) runningWritesForId2.push(r2);
            currentTask = { ...currentTask, subtasks: subs };
            firstUpdateDone = true;
          }
        },
        addLog: async () => {},
      },
      workerExecute: async () => makeWorkerResult(),
      hardVerify: async () => ({ passed: true }),
      costTracker: { addCost: async () => {} },
    });

    const result = await (loop as unknown as Record<string, Function>)[
      "executeSubtasks"
    ](
      currentTask,
      [
        { description: "first subtask", order: 1 },
        { description: "second subtask", order: 2 },
      ],
      {
        baselineErrors: 0,
        startCommit: "abc123",
      },
    );

    assert.ok(
      result.success,
      "executeSubtasks should succeed when a subtask is removed concurrently " +
        "(new isPersisted guard uses refreshed task.subtasks, not stale snapshot)",
    );
    assert.equal(
      runningWritesForId2.length,
      0,
      "Subtask id='2' must NOT be set to running after it was removed from task.subtasks " +
        "(isPersisted computed from live task, not stale initialPersistedIds)",
    );
  });

  it("should produce NaN-free comparator results for all invalid order combinations", () => {
    // Directly verify the sort comparator logic never returns NaN
    const cmp = (a: { order: unknown }, b: { order: unknown }): number => {
      const aOrd = Number.isFinite(a.order) ? (a.order as number) : Infinity;
      const bOrd = Number.isFinite(b.order) ? (b.order as number) : Infinity;
      if (aOrd === bOrd) return 0;
      if (!Number.isFinite(aOrd)) return 1;
      if (!Number.isFinite(bOrd)) return -1;
      return aOrd - bOrd;
    };
    const pairs: Array<{ order: unknown }> = [
      { order: undefined },
      { order: NaN },
      { order: Infinity },
      { order: "abc" },
      { order: 1 },
      { order: 3 },
    ];
    for (const x of pairs) {
      for (const y of pairs) {
        const result = cmp(x, y);
        assert.ok(
          !Number.isNaN(result),
          `comparator(${JSON.stringify(x)}, ${JSON.stringify(y)}) must not be NaN, got ${result}`,
        );
      }
    }
  });
});
