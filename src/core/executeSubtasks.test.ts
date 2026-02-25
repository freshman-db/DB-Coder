import { describe, it, mock } from "node:test";
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
  workerFix?: (
    sessionId: string,
    errors: string,
    task: Task,
  ) => Promise<SessionResult>;
  maxRetries?: number;
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
    values: { autonomy: { maxRetries: overrides.maxRetries ?? 0 } },
  };

  // Replace private methods
  any.workerExecute = overrides.workerExecute;
  any.hardVerify = overrides.hardVerify;
  if (overrides.workerFix) {
    any.workerFix = overrides.workerFix;
  }

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
        workerExecute: async () => makeSessionResult(),
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
        workerExecute: async () => makeSessionResult(),
        hardVerify: async () => {
          hardVerifyCalls++;
          // Advance time by 30ms per verify call
          mock.timers.tick(30);
          return { passed: false, reason: "errors increased" };
        },
        workerFix: async () => {
          // Advance time by 200ms for fix work — now counted in totalVerifyMs
          mock.timers.tick(200);
          return makeSessionResult();
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
        return makeSessionResult();
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
        return makeSessionResult();
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
    // Persisted: id="1" order=1, id="2" order=2
    // Incoming:  order=5, order=6 — neither exists in orderToId
    // OLD BUG:  fallback String(0+1)="1" and String(1+1)="2" would wrongly
    //           match persisted ids (but order mismatch → sentinel). With the
    //           fix, fallback String(5)="5" / String(6)="6" are not in
    //           persistedIds at all → sentinel immediately, no false match.
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
    // Persisted: id="1" order=3, id="2" order=1, id="3" order=2
    // Incoming:  order=99 — misses orderToId
    // Fallback String(99) not in persistedIds → sentinel
    // Also test: incoming order=1 should succeed via orderToId (main path)
    const subtaskRecords: SubTaskRecord[] = [
      {
        id: "1",
        description: "task-A",
        executor: "claude",
        status: "pending",
        order: 3,
      },
      {
        id: "2",
        description: "task-B",
        executor: "claude",
        status: "pending",
        order: 1,
      },
      {
        id: "3",
        description: "task-C",
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
        return makeSessionResult();
      },
      hardVerify: async () => ({ passed: true }),
      costTracker: { addCost: async () => {} },
    });

    const result = await (loop as unknown as Record<string, Function>)[
      "executeSubtasks"
    ](
      currentTask,
      [
        { description: "known-task", order: 1 }, // orderToId hit → id="2"
        { description: "unknown-task", order: 99 }, // miss → fallback "99" not in persistedIds → sentinel
      ],
      {
        baselineErrors: 0,
        startCommit: "abc123",
      },
    );

    assert.ok(result.success, "executeSubtasks should succeed");
    // order:1 sorts before order:99, so known-task executes first
    assert.deepEqual(
      executedDescriptions,
      ["known-task", "unknown-task"],
      "Should execute known-task (order=1) then unknown-task (order=99)",
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
