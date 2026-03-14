/**
 * PR 0 — MainLoop Public API Contract Tests
 *
 * These tests freeze the behavioral contract of MainLoop's public API.
 * They serve as the safety net for the entire MainLoop refactoring:
 * every subsequent PR must pass these tests unchanged.
 *
 * Tested contracts:
 * 1. StatusSnapshot field completeness
 * 2. Step lifecycle ordering (beginStep → endStep)
 * 3. resetCycleSteps rebuilds full CYCLE_PIPELINE as pending
 * 4. Listener registration / unregistration
 * 5. cleanupTaskBranch behavior (preserve branch with worker output)
 * 6. Public API initial state
 * 7. pause / resume behavior
 * 8. skipRemainingSteps behavior
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MainLoop } from "../../src/core/MainLoop.js";
import { CYCLE_PIPELINE } from "../../src/core/types.js";
import type { StatusSnapshot, CycleStep } from "../../src/core/types.js";
import { CycleStepTracker } from "../../src/core/StepTracker.js";
import {
  MaintenancePhase,
  setCleanupBranchDepsForTests,
} from "../../src/core/phases/MaintenancePhase.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal MainLoop stub, bypassing the real constructor.
 * Injects only the private fields needed for public API / state management.
 */
function createStub(): InstanceType<typeof MainLoop> {
  const loop = Object.create(MainLoop.prototype) as InstanceType<
    typeof MainLoop
  >;
  const any = loop as unknown as Record<string, unknown>;

  // CycleStepTracker manages all mutable state
  any.tracker = new CycleStepTracker();
  any.restartListeners = new Set();

  // Minimal config stub for cleanupTaskBranch
  any.config = { projectPath: "/tmp/contract-test" };

  return loop;
}

/**
 * Access private methods via any-cast for testing state management.
 */
function priv(loop: MainLoop) {
  return loop as unknown as {
    setState(state: string): void;
    setCurrentTaskId(id: string | null): void;
    setPaused(paused: boolean): void;
    setRunning(running: boolean): void;
    resetCycleSteps(): void;
    beginStep(phase: string): void;
    endStep(
      phase: string,
      result: "done" | "failed" | "skipped",
      summary?: string,
      durationOverrideMs?: number,
    ): void;
    updateStepStatus(
      phase: string,
      status: "done" | "failed",
      summary?: string,
    ): void;
    skipRemainingSteps(fromPhase?: string): void;
    broadcastStatus(): void;
    cleanupTaskBranch(
      branch: string,
      opts?: { force?: boolean; startCommit?: string },
    ): Promise<void>;
    cycleSteps: CycleStep[];
    cycleNumber: number;
    currentPhase: string | null;
  };
}

// ---------------------------------------------------------------------------
// 1. Public API initial state
// ---------------------------------------------------------------------------

describe("MainLoop contract: initial state", () => {
  it("getState() returns 'idle' initially", () => {
    const loop = createStub();
    assert.equal(loop.getState(), "idle");
  });

  it("getCurrentTaskId() returns null initially", () => {
    const loop = createStub();
    assert.equal(loop.getCurrentTaskId(), null);
  });

  it("isPaused() returns false initially", () => {
    const loop = createStub();
    assert.equal(loop.isPaused(), false);
  });

  it("isRunning() returns false initially", () => {
    const loop = createStub();
    assert.equal(loop.isRunning(), false);
  });
});

// ---------------------------------------------------------------------------
// 2. StatusSnapshot field completeness
// ---------------------------------------------------------------------------

describe("MainLoop contract: StatusSnapshot completeness", () => {
  it("getStatusSnapshot() contains all required fields", () => {
    const loop = createStub();
    const snapshot = loop.getStatusSnapshot();

    // Mandatory fields (always present)
    assert.ok("state" in snapshot, "missing 'state'");
    assert.ok("currentTaskId" in snapshot, "missing 'currentTaskId'");
    assert.ok("patrolling" in snapshot, "missing 'patrolling'");
    assert.ok("paused" in snapshot, "missing 'paused'");
    assert.ok("cycleNumber" in snapshot, "missing 'cycleNumber'");
    assert.ok("cycleSteps" in snapshot, "missing 'cycleSteps'");

    // Type checks
    assert.equal(typeof snapshot.state, "string");
    assert.equal(typeof snapshot.patrolling, "boolean");
    assert.equal(typeof snapshot.paused, "boolean");
    assert.equal(typeof snapshot.cycleNumber, "number");
    assert.ok(Array.isArray(snapshot.cycleSteps));
  });

  it("getStatusSnapshot() reflects state changes via setState", () => {
    const loop = createStub();
    priv(loop).setState("executing");
    assert.equal(loop.getStatusSnapshot().state, "executing");
  });

  it("getStatusSnapshot() reflects currentTaskId changes", () => {
    const loop = createStub();
    priv(loop).setCurrentTaskId("task-42");
    assert.equal(loop.getStatusSnapshot().currentTaskId, "task-42");
  });

  it("getStatusSnapshot() reflects paused state", () => {
    const loop = createStub();
    priv(loop).setPaused(true);
    assert.equal(loop.getStatusSnapshot().paused, true);
  });

  it("getStatusSnapshot() reflects running as patrolling", () => {
    const loop = createStub();
    priv(loop).setRunning(true);
    assert.equal(loop.getStatusSnapshot().patrolling, true);
  });

  it("getStatusSnapshot() includes taskDescription when set", () => {
    const loop = createStub();
    // Set via tracker (state is now managed by CycleStepTracker)
    const tracker = (loop as unknown as { tracker: CycleStepTracker }).tracker;
    tracker.setCurrentTaskDescription("Fix the login bug");
    const snapshot = loop.getStatusSnapshot();
    assert.equal(snapshot.taskDescription, "Fix the login bug");
  });

  it("getStatusSnapshot() omits taskDescription when null", () => {
    const loop = createStub();
    const snapshot = loop.getStatusSnapshot();
    assert.equal(snapshot.taskDescription, undefined);
  });

  it("getStatusSnapshot() returns a copy of cycleSteps (not reference)", () => {
    const loop = createStub();
    priv(loop).resetCycleSteps();
    const snap1 = loop.getStatusSnapshot();
    const snap2 = loop.getStatusSnapshot();
    assert.notStrictEqual(snap1.cycleSteps, snap2.cycleSteps);
    assert.deepStrictEqual(snap1.cycleSteps, snap2.cycleSteps);
  });
});

// ---------------------------------------------------------------------------
// 3. resetCycleSteps rebuilds full CYCLE_PIPELINE
// ---------------------------------------------------------------------------

describe("MainLoop contract: resetCycleSteps", () => {
  it("creates steps for every phase in CYCLE_PIPELINE, all pending", () => {
    const loop = createStub();
    priv(loop).resetCycleSteps();

    const steps = loop.getStatusSnapshot().cycleSteps!;
    assert.equal(steps.length, CYCLE_PIPELINE.length);

    for (let i = 0; i < CYCLE_PIPELINE.length; i++) {
      assert.equal(steps[i].phase, CYCLE_PIPELINE[i]);
      assert.equal(steps[i].status, "pending");
    }
  });

  it("increments cycleNumber on each reset", () => {
    const loop = createStub();
    priv(loop).resetCycleSteps();
    assert.equal(loop.getStatusSnapshot().cycleNumber, 1);

    priv(loop).resetCycleSteps();
    assert.equal(loop.getStatusSnapshot().cycleNumber, 2);
  });

  it("clears currentPhase on reset", () => {
    const loop = createStub();
    priv(loop).resetCycleSteps();
    priv(loop).beginStep("decide");
    assert.equal(loop.getStatusSnapshot().currentPhase, "decide");

    priv(loop).resetCycleSteps();
    assert.equal(loop.getStatusSnapshot().currentPhase, undefined);
  });
});

// ---------------------------------------------------------------------------
// 4. Step lifecycle: beginStep → endStep ordering
// ---------------------------------------------------------------------------

describe("MainLoop contract: step lifecycle", () => {
  it("beginStep activates a pending step and sets currentPhase", () => {
    const loop = createStub();
    priv(loop).resetCycleSteps();
    priv(loop).beginStep("decide");

    const snap = loop.getStatusSnapshot();
    assert.equal(snap.currentPhase, "decide");
    const step = snap.cycleSteps!.find((s) => s.phase === "decide")!;
    assert.equal(step.status, "active");
    assert.ok(typeof step.startedAt === "number");
  });

  it("endStep marks a step as done and clears currentPhase", () => {
    const loop = createStub();
    priv(loop).resetCycleSteps();
    priv(loop).beginStep("decide");
    priv(loop).endStep("decide", "done", "task selected");

    const snap = loop.getStatusSnapshot();
    assert.equal(snap.currentPhase, undefined);
    const step = snap.cycleSteps!.find((s) => s.phase === "decide")!;
    assert.equal(step.status, "done");
    assert.equal(step.summary, "task selected");
    assert.ok(typeof step.finishedAt === "number");
    assert.ok(typeof step.durationMs === "number");
  });

  it("endStep respects durationOverrideMs", () => {
    const loop = createStub();
    priv(loop).resetCycleSteps();
    priv(loop).beginStep("execute");
    priv(loop).endStep("execute", "done", "completed", 12345);

    const step = loop
      .getStatusSnapshot()
      .cycleSteps!.find((s) => s.phase === "execute")!;
    assert.equal(step.durationMs, 12345);
  });

  it("beginStep is idempotent (re-entry rejected for non-pending)", () => {
    const loop = createStub();
    priv(loop).resetCycleSteps();
    priv(loop).beginStep("decide");

    const startedAt1 = loop
      .getStatusSnapshot()
      .cycleSteps!.find((s) => s.phase === "decide")!.startedAt;

    // Second beginStep on already-active phase should be a no-op
    priv(loop).beginStep("decide");
    const startedAt2 = loop
      .getStatusSnapshot()
      .cycleSteps!.find((s) => s.phase === "decide")!.startedAt;

    assert.equal(
      startedAt1,
      startedAt2,
      "startedAt must not change on re-entry",
    );
  });

  it("endStep can mark as failed", () => {
    const loop = createStub();
    priv(loop).resetCycleSteps();
    priv(loop).beginStep("verify");
    priv(loop).endStep("verify", "failed", "3 tsc errors");

    const step = loop
      .getStatusSnapshot()
      .cycleSteps!.find((s) => s.phase === "verify")!;
    assert.equal(step.status, "failed");
    assert.equal(step.summary, "3 tsc errors");
  });

  it("endStep can mark as skipped", () => {
    const loop = createStub();
    priv(loop).resetCycleSteps();
    priv(loop).beginStep("analyze");
    priv(loop).endStep("analyze", "skipped", "S task, skip analysis");

    const step = loop
      .getStatusSnapshot()
      .cycleSteps!.find((s) => s.phase === "analyze")!;
    assert.equal(step.status, "skipped");
  });

  it("updateStepStatus changes status/summary of finished step", () => {
    const loop = createStub();
    priv(loop).resetCycleSteps();
    priv(loop).beginStep("verify");
    priv(loop).endStep("verify", "done", "0 errors initially");

    // Now update the already-finished step
    priv(loop).updateStepStatus("verify", "failed", "2 errors after recheck");

    const step = loop
      .getStatusSnapshot()
      .cycleSteps!.find((s) => s.phase === "verify")!;
    assert.equal(step.status, "failed");
    assert.equal(step.summary, "2 errors after recheck");
    // finishedAt preserved
    assert.ok(typeof step.finishedAt === "number");
  });
});

// ---------------------------------------------------------------------------
// 5. Listener registration / unregistration
// ---------------------------------------------------------------------------

describe("MainLoop contract: listeners", () => {
  it("addStatusListener receives broadcasts on state change", () => {
    const loop = createStub();
    const snapshots: StatusSnapshot[] = [];

    loop.addStatusListener((snap) => snapshots.push(snap));
    priv(loop).setState("executing");

    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].state, "executing");
  });

  it("addStatusListener returns unsubscribe function", () => {
    const loop = createStub();
    const snapshots: StatusSnapshot[] = [];

    const unsub = loop.addStatusListener((snap) => snapshots.push(snap));
    priv(loop).setState("executing");
    assert.equal(snapshots.length, 1);

    unsub();
    priv(loop).setState("reviewing");
    // Should NOT receive the second broadcast
    assert.equal(snapshots.length, 1);
  });

  it("multiple listeners all receive broadcasts", () => {
    const loop = createStub();
    const results1: string[] = [];
    const results2: string[] = [];

    loop.addStatusListener((snap) => results1.push(snap.state));
    loop.addStatusListener((snap) => results2.push(snap.state));

    priv(loop).setState("executing");
    assert.equal(results1.length, 1);
    assert.equal(results2.length, 1);
  });

  it("listener errors are silently ignored", () => {
    const loop = createStub();
    const received: string[] = [];

    // First listener throws
    loop.addStatusListener(() => {
      throw new Error("listener crash");
    });
    // Second listener should still receive
    loop.addStatusListener((snap) => received.push(snap.state));

    priv(loop).setState("executing");
    assert.equal(received.length, 1);
    assert.equal(received[0], "executing");
  });

  it("onRestart returns unsubscribe function", () => {
    const loop = createStub();
    const calls: number[] = [];

    const unsub = loop.onRestart(() => calls.push(1));
    // Access the restartListeners set to trigger
    const restartListeners = (
      loop as unknown as Record<string, Set<() => void>>
    ).restartListeners;
    for (const fn of restartListeners) fn();
    assert.equal(calls.length, 1);

    unsub();
    for (const fn of restartListeners) fn();
    assert.equal(calls.length, 1, "should not fire after unsubscribe");
  });

  it("broadcast fires on resetCycleSteps", () => {
    const loop = createStub();
    const snapshots: StatusSnapshot[] = [];
    loop.addStatusListener((snap) => snapshots.push(snap));

    priv(loop).resetCycleSteps();
    assert.ok(snapshots.length >= 1);
    // The last broadcast should have full pipeline steps
    const last = snapshots[snapshots.length - 1];
    assert.equal(last.cycleSteps!.length, CYCLE_PIPELINE.length);
  });

  it("broadcast fires on beginStep and endStep", () => {
    const loop = createStub();
    priv(loop).resetCycleSteps();

    const snapshots: StatusSnapshot[] = [];
    loop.addStatusListener((snap) => snapshots.push(snap));

    priv(loop).beginStep("decide");
    priv(loop).endStep("decide", "done");

    // At least 2 broadcasts: one from beginStep, one from endStep
    assert.ok(snapshots.length >= 2);
  });
});

// ---------------------------------------------------------------------------
// 6. pause / resume behavior
// ---------------------------------------------------------------------------

describe("MainLoop contract: pause / resume", () => {
  it("pause() sets paused to true", () => {
    const loop = createStub();
    loop.pause();
    assert.equal(loop.isPaused(), true);
  });

  it("resume() sets paused to false", () => {
    const loop = createStub();
    loop.pause();
    loop.resume();
    assert.equal(loop.isPaused(), false);
  });

  it("pause triggers broadcast", () => {
    const loop = createStub();
    const snapshots: StatusSnapshot[] = [];
    loop.addStatusListener((snap) => snapshots.push(snap));

    loop.pause();
    assert.ok(snapshots.length >= 1);
    assert.equal(snapshots[snapshots.length - 1].paused, true);
  });

  it("resume triggers broadcast", () => {
    const loop = createStub();
    loop.pause();

    const snapshots: StatusSnapshot[] = [];
    loop.addStatusListener((snap) => snapshots.push(snap));

    loop.resume();
    assert.ok(snapshots.length >= 1);
    assert.equal(snapshots[snapshots.length - 1].paused, false);
  });
});

// ---------------------------------------------------------------------------
// 7. skipRemainingSteps behavior
// ---------------------------------------------------------------------------

describe("MainLoop contract: skipRemainingSteps", () => {
  it("skips all pending steps when no fromPhase given", () => {
    const loop = createStub();
    priv(loop).resetCycleSteps();
    priv(loop).beginStep("decide");
    priv(loop).endStep("decide", "done");

    priv(loop).skipRemainingSteps();
    const steps = loop.getStatusSnapshot().cycleSteps!;

    // "decide" should stay done, everything else should be skipped
    assert.equal(steps.find((s) => s.phase === "decide")!.status, "done");
    for (const step of steps) {
      if (step.phase !== "decide") {
        assert.equal(step.status, "skipped", `${step.phase} should be skipped`);
      }
    }
  });

  it("skips only steps after fromPhase", () => {
    const loop = createStub();
    priv(loop).resetCycleSteps();
    priv(loop).beginStep("decide");
    priv(loop).endStep("decide", "done");
    priv(loop).beginStep("create-task");
    priv(loop).endStep("create-task", "done");

    // Skip remaining after "create-task"
    priv(loop).skipRemainingSteps("create-task");
    const steps = loop.getStatusSnapshot().cycleSteps!;

    assert.equal(steps.find((s) => s.phase === "decide")!.status, "done");
    assert.equal(steps.find((s) => s.phase === "create-task")!.status, "done");
    assert.equal(steps.find((s) => s.phase === "analyze")!.status, "skipped");
    assert.equal(steps.find((s) => s.phase === "execute")!.status, "skipped");
    assert.equal(steps.find((s) => s.phase === "verify")!.status, "skipped");
    assert.equal(steps.find((s) => s.phase === "review")!.status, "skipped");
    assert.equal(steps.find((s) => s.phase === "reflect")!.status, "skipped");
    assert.equal(steps.find((s) => s.phase === "merge")!.status, "skipped");
  });

  it("does not skip already done/failed steps", () => {
    const loop = createStub();
    priv(loop).resetCycleSteps();
    priv(loop).beginStep("decide");
    priv(loop).endStep("decide", "done");
    priv(loop).beginStep("create-task");
    priv(loop).endStep("create-task", "failed", "no tasks");

    priv(loop).skipRemainingSteps("decide");
    const steps = loop.getStatusSnapshot().cycleSteps!;

    // create-task was already failed before skip — skipRemainingSteps only touches "pending"
    assert.equal(
      steps.find((s) => s.phase === "create-task")!.status,
      "failed",
    );
  });
});

// ---------------------------------------------------------------------------
// 8. cleanupTaskBranch behavior
// ---------------------------------------------------------------------------

describe("MainLoop contract: cleanupTaskBranch", () => {
  /**
   * Wire a real MaintenancePhase into the stub so calls go through
   * MainLoop.cleanupTaskBranch → MaintenancePhase.cleanupTaskBranch → mocked git.
   */
  function wireMaintenancePhase(loop: MainLoop): void {
    const phase = Object.create(MaintenancePhase.prototype) as MaintenancePhase;
    (phase as unknown as Record<string, unknown>).config = {
      projectPath: "/tmp/contract-test",
    };
    (loop as unknown as Record<string, unknown>).maintenance = phase;
  }

  it("preserves branch when worker has commits (branchHead !== startCommit)", async (t) => {
    const loop = createStub();
    wireMaintenancePhase(loop);
    const deleted: string[] = [];

    setCleanupBranchDepsForTests({
      getBranchHeadCommit: async () => "commit-abc",
      forceDeleteBranch: async (b) => {
        deleted.push(b);
      },
    });
    t.after(() => setCleanupBranchDepsForTests());

    const any = loop as unknown as Record<string, Function>;
    await any.cleanupTaskBranch("db-coder/task-1", {
      startCommit: "commit-000",
    });
    assert.equal(deleted.length, 0, "branch should be preserved, not deleted");
  });

  it("deletes branch when no worker output (branchHead === startCommit)", async (t) => {
    const loop = createStub();
    wireMaintenancePhase(loop);
    const deleted: string[] = [];

    setCleanupBranchDepsForTests({
      getBranchHeadCommit: async () => "commit-abc",
      forceDeleteBranch: async (b) => {
        deleted.push(b);
      },
    });
    t.after(() => setCleanupBranchDepsForTests());

    const any = loop as unknown as Record<string, Function>;
    await any.cleanupTaskBranch("db-coder/task-1", {
      startCommit: "commit-abc",
    });
    assert.equal(deleted.length, 1);
    assert.equal(deleted[0], "db-coder/task-1");
  });

  it("force-deletes branch regardless of commits", async (t) => {
    const loop = createStub();
    wireMaintenancePhase(loop);
    const deleted: string[] = [];

    setCleanupBranchDepsForTests({
      forceDeleteBranch: async (b) => {
        deleted.push(b);
      },
    });
    t.after(() => setCleanupBranchDepsForTests());

    const any = loop as unknown as Record<string, Function>;
    await any.cleanupTaskBranch("db-coder/task-1", { force: true });
    assert.equal(deleted.length, 1);
    assert.equal(deleted[0], "db-coder/task-1");
  });
});

// ---------------------------------------------------------------------------
// 9. Legacy no-op methods don't throw
// ---------------------------------------------------------------------------

describe("MainLoop contract: legacy methods", () => {
  it("setEvolutionEngine is a no-op", () => {
    const loop = createStub();
    assert.doesNotThrow(() => loop.setEvolutionEngine({}));
  });

  it("setPluginMonitor is a no-op", () => {
    const loop = createStub();
    assert.doesNotThrow(() => loop.setPluginMonitor({}));
  });

  it("setPromptRegistry is a no-op", () => {
    const loop = createStub();
    assert.doesNotThrow(() => loop.setPromptRegistry({}));
  });
});
