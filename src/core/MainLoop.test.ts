import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  countTscErrors,
  setCountTscErrorsDepsForTests,
  findFinishedStepsByPhase,
  applyStepStatusUpdate,
} from "./MainLoop.js";
import type { CycleStep } from "./types.js";

// --- countTscErrors ---

describe("countTscErrors", () => {
  afterEach(() => {
    setCountTscErrorsDepsForTests();
  });

  it("should return 0 if no tsconfig.json", async () => {
    setCountTscErrorsDepsForTests({
      existsSync: () => false,
    });

    const count = await countTscErrors("/some/project");
    assert.equal(count, 0);
  });

  it("should count error lines from tsc output", async () => {
    setCountTscErrorsDepsForTests({
      existsSync: () => true,
      runProcess: async () => ({
        exitCode: 2,
        stdout: `src/foo.ts(1,1): error TS2304: Cannot find name 'x'.
src/bar.ts(5,10): error TS2307: Cannot find module './baz.js'.
src/ok.ts(1,1): warning: some warning
Found 2 errors.`,
        stderr: "",
      }),
    });

    const count = await countTscErrors("/project");
    assert.equal(count, 2);
  });

  it("should return 0 for clean tsc output", async () => {
    setCountTscErrorsDepsForTests({
      existsSync: () => true,
      runProcess: async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
      }),
    });

    const count = await countTscErrors("/project");
    assert.equal(count, 0);
  });

  it("should return -1 on process failure", async () => {
    setCountTscErrorsDepsForTests({
      existsSync: () => true,
      runProcess: async () => {
        throw new Error("Process timed out");
      },
    });

    const count = await countTscErrors("/project");
    assert.equal(count, -1);
  });

  it("should count errors from stderr too", async () => {
    setCountTscErrorsDepsForTests({
      existsSync: () => true,
      runProcess: async () => ({
        exitCode: 2,
        stdout: "",
        stderr: `src/a.ts(3,5): error TS2345: Argument type mismatch.`,
      }),
    });

    const count = await countTscErrors("/project");
    assert.equal(count, 1);
  });
});

// --- findFinishedStepsByPhase ---

describe("findFinishedStepsByPhase", () => {
  it("should return null when no steps match the phase", () => {
    const steps: CycleStep[] = [
      {
        phase: "execute",
        status: "done",
        startedAt: 1000,
        finishedAt: 2000,
        durationMs: 1000,
      },
    ];
    assert.equal(findFinishedStepsByPhase(steps, "verify"), null);
  });

  it("should return null for empty steps array", () => {
    assert.equal(findFinishedStepsByPhase([], "execute"), null);
  });

  it("should return null when matching step has no finishedAt", () => {
    const steps: CycleStep[] = [
      { phase: "execute", status: "active", startedAt: 1000 },
    ];
    assert.equal(findFinishedStepsByPhase(steps, "execute"), null);
  });

  it("should return null when any matching step lacks finishedAt", () => {
    const steps: CycleStep[] = [
      {
        phase: "execute",
        status: "done",
        startedAt: 1000,
        finishedAt: 2000,
        durationMs: 1000,
      },
      { phase: "execute", status: "active", startedAt: 3000 },
    ];
    assert.equal(findFinishedStepsByPhase(steps, "execute"), null);
  });

  it("should return all matching steps when all have finishedAt", () => {
    const steps: CycleStep[] = [
      {
        phase: "execute",
        status: "done",
        startedAt: 1000,
        finishedAt: 2000,
        durationMs: 1000,
      },
      {
        phase: "verify",
        status: "done",
        startedAt: 3000,
        finishedAt: 4000,
        durationMs: 1000,
      },
      {
        phase: "execute",
        status: "done",
        startedAt: 5000,
        finishedAt: 6000,
        durationMs: 1000,
      },
    ];
    const result = findFinishedStepsByPhase(steps, "execute");
    assert.ok(result);
    assert.equal(result.length, 2);
    assert.equal(result[0].startedAt, 1000);
    assert.equal(result[1].startedAt, 5000);
  });
});

// --- applyStepStatusUpdate ---

describe("applyStepStatusUpdate", () => {
  const finishedStep: CycleStep = {
    phase: "execute",
    status: "done",
    startedAt: 1000,
    finishedAt: 2000,
    durationMs: 1000,
  };

  it("should throw when phase is not found in cycleSteps", () => {
    const steps: CycleStep[] = [finishedStep];
    assert.throws(
      () => applyStepStatusUpdate(steps, "verify", "failed", "tsc errors"),
      { message: /phase "verify" not found/ },
    );
  });

  it("should throw when step has no finishedAt", () => {
    const unfinished: CycleStep = {
      phase: "execute",
      status: "active",
      startedAt: 1000,
    };
    assert.throws(
      () =>
        applyStepStatusUpdate([unfinished], "execute", "failed", "tsc errors"),
      { message: /has no finishedAt/ },
    );
  });

  it("should throw when any duplicate-phase step has no finishedAt", () => {
    const steps: CycleStep[] = [
      {
        phase: "execute",
        status: "done",
        startedAt: 1000,
        finishedAt: 2000,
        durationMs: 1000,
      },
      { phase: "execute", status: "active", startedAt: 3000 },
    ];
    assert.throws(
      () => applyStepStatusUpdate(steps, "execute", "failed", "err"),
      { message: /has no finishedAt/ },
    );
  });

  it("should update all duplicate-phase steps when all finished", () => {
    const steps: CycleStep[] = [
      {
        phase: "execute",
        status: "done",
        startedAt: 1000,
        finishedAt: 2000,
        durationMs: 1000,
      },
      {
        phase: "execute",
        status: "done",
        startedAt: 3000,
        finishedAt: 4000,
        durationMs: 1000,
      },
    ];
    const result = applyStepStatusUpdate(
      steps,
      "execute",
      "failed",
      "both updated",
    );
    assert.equal(result.length, 2);
    assert.equal(result[0].status, "failed");
    assert.equal(result[0].summary, "both updated");
    assert.equal(result[1].status, "failed");
    assert.equal(result[1].summary, "both updated");
  });

  it("should update status and summary for a finished step", () => {
    const steps: CycleStep[] = [finishedStep];
    const result = applyStepStatusUpdate(
      steps,
      "execute",
      "failed",
      "2 tsc errors",
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].status, "failed");
    assert.equal(result[0].summary, "2 tsc errors");
    // Preserves timing fields
    assert.equal(result[0].finishedAt, 2000);
    assert.equal(result[0].durationMs, 1000);
    // Original not mutated
    assert.equal(steps[0].status, "done");
  });
});
