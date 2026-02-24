import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { countTscErrors, setCountTscErrorsDepsForTests } from "./MainLoop.js";

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
