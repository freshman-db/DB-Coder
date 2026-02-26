import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ProjectVerifier,
  type ProjectVerifierDeps,
  type VerifyBaseline,
} from "./ProjectVerifier.js";

// --- Helpers ---

function makeDeps(
  overrides: Partial<ProjectVerifierDeps> = {},
): ProjectVerifierDeps {
  return {
    existsSync: () => false,
    readFileSync: () => "",
    runProcess: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    ...overrides,
  };
}

// --- detect() ---

describe("ProjectVerifier.detect", () => {
  it("detects typescript when tsconfig.json exists", () => {
    const v = new ProjectVerifier(
      makeDeps({ existsSync: (p) => p.endsWith("tsconfig.json") }),
    );
    assert.equal(v.detect("/project"), "typescript");
  });

  it("detects go when go.mod exists", () => {
    const v = new ProjectVerifier(
      makeDeps({ existsSync: (p) => p.endsWith("go.mod") }),
    );
    assert.equal(v.detect("/project"), "go");
  });

  it("detects rust when Cargo.toml exists", () => {
    const v = new ProjectVerifier(
      makeDeps({ existsSync: (p) => p.endsWith("Cargo.toml") }),
    );
    assert.equal(v.detect("/project"), "rust");
  });

  it("detects python when pyproject.toml exists", () => {
    const v = new ProjectVerifier(
      makeDeps({ existsSync: (p) => p.endsWith("pyproject.toml") }),
    );
    assert.equal(v.detect("/project"), "python");
  });

  it("detects javascript when package.json exists without tsconfig", () => {
    const v = new ProjectVerifier(
      makeDeps({ existsSync: (p) => p.endsWith("package.json") }),
    );
    assert.equal(v.detect("/project"), "javascript");
  });

  it("prefers typescript over javascript when both exist", () => {
    const v = new ProjectVerifier(
      makeDeps({
        existsSync: (p) =>
          p.endsWith("tsconfig.json") || p.endsWith("package.json"),
      }),
    );
    assert.equal(v.detect("/project"), "typescript");
  });

  it("returns unknown when no markers found", () => {
    const v = new ProjectVerifier(makeDeps());
    assert.equal(v.detect("/project"), "unknown");
  });

  it("detects makefile with test target", () => {
    const v = new ProjectVerifier(
      makeDeps({
        existsSync: (p) => p.endsWith("Makefile"),
        readFileSync: () => "build:\n\tcc main.c\ntest:\n\t./run_tests\n",
      }),
    );
    assert.equal(v.detect("/project"), "makefile");
  });
});

// --- baseline() ---

describe("ProjectVerifier.baseline", () => {
  it("records tsc error count for typescript projects", async () => {
    const v = new ProjectVerifier(
      makeDeps({
        existsSync: (p) =>
          p.endsWith("tsconfig.json") || p.endsWith("package.json"),
        readFileSync: () =>
          JSON.stringify({ scripts: { test: "node --test" } }),
        runProcess: async (_cmd, args) => {
          if (args.includes("--noEmit")) {
            return {
              exitCode: 1,
              stdout:
                "src/a.ts(1,1): error TS2304: x\nsrc/b.ts(2,1): error TS2304: y\n",
              stderr: "",
            };
          }
          // npm test
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      }),
    );
    const b = await v.baseline("/project");
    assert.equal(b.projectType, "typescript");
    assert.equal(b.typeCheckErrors, 2);
    assert.equal(b.testFailures, 0);
  });

  it("returns -1 for tests when npm test is placeholder", async () => {
    const v = new ProjectVerifier(
      makeDeps({
        existsSync: (p) => p.endsWith("tsconfig.json") || p.endsWith("package.json"),
        readFileSync: () =>
          JSON.stringify({
            scripts: { test: 'echo "Error: no test specified" && exit 1' },
          }),
        runProcess: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    );
    const b = await v.baseline("/project");
    assert.equal(b.testFailures, -1);
  });

  it("returns -1 for unknown project type", async () => {
    const v = new ProjectVerifier(makeDeps());
    const b = await v.baseline("/project");
    assert.equal(b.projectType, "unknown");
    assert.equal(b.typeCheckErrors, -1);
    assert.equal(b.testFailures, -1);
  });
});

// --- verify() ---

describe("ProjectVerifier.verify", () => {
  it("passes when errors do not increase", async () => {
    const v = new ProjectVerifier(
      makeDeps({
        existsSync: (p) => p.endsWith("tsconfig.json"),
        readFileSync: () => JSON.stringify({}),
        runProcess: async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
        }),
      }),
    );
    const baseline: VerifyBaseline = {
      projectType: "typescript",
      typeCheckErrors: 2,
      testFailures: -1,
    };
    const result = await v.verify("/project", baseline);
    assert.equal(result.passed, true);
    assert.equal(result.typeCheck.passed, true);
    assert.equal(result.test, null);
  });

  it("fails when type errors increase", async () => {
    const v = new ProjectVerifier(
      makeDeps({
        existsSync: (p) => p.endsWith("tsconfig.json"),
        readFileSync: () => JSON.stringify({}),
        runProcess: async () => ({
          exitCode: 1,
          stdout:
            "a.ts(1,1): error TS1: x\nb.ts(2,1): error TS2: y\nc.ts(3,1): error TS3: z\n",
          stderr: "",
        }),
      }),
    );
    const baseline: VerifyBaseline = {
      projectType: "typescript",
      typeCheckErrors: 1,
      testFailures: -1,
    };
    const result = await v.verify("/project", baseline);
    assert.equal(result.passed, false);
    assert.ok(result.reason?.includes("Type errors increased"));
    assert.equal(result.typeCheck.errorCount, 3);
  });

  it("fails when test failures increase", async () => {
    let callCount = 0;
    const v = new ProjectVerifier(
      makeDeps({
        existsSync: (p) =>
          p.endsWith("tsconfig.json") || p.endsWith("package.json"),
        readFileSync: () =>
          JSON.stringify({ scripts: { test: "node --test" } }),
        runProcess: async (_cmd, args) => {
          if (args.includes("--noEmit")) {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          // npm test — fail
          callCount++;
          return { exitCode: 1, stdout: "1 failing", stderr: "" };
        },
      }),
    );
    const baseline: VerifyBaseline = {
      projectType: "typescript",
      typeCheckErrors: 0,
      testFailures: 0,
    };
    const result = await v.verify("/project", baseline);
    assert.equal(result.passed, false);
    assert.ok(result.test);
    assert.equal(result.test.passed, false);
    assert.ok(result.reason?.includes("Test failures increased"));
  });

  it("passes for unknown project type", async () => {
    const v = new ProjectVerifier(makeDeps());
    const baseline: VerifyBaseline = {
      projectType: "unknown",
      typeCheckErrors: -1,
      testFailures: -1,
    };
    const result = await v.verify("/project", baseline);
    assert.equal(result.passed, true);
  });

  it("handles type check crash gracefully", async () => {
    const v = new ProjectVerifier(
      makeDeps({
        existsSync: (p) => p.endsWith("tsconfig.json"),
        readFileSync: () => JSON.stringify({}),
        runProcess: async () => {
          throw new Error("process crashed");
        },
      }),
    );
    const baseline: VerifyBaseline = {
      projectType: "typescript",
      typeCheckErrors: 0,
      testFailures: -1,
    };
    const result = await v.verify("/project", baseline);
    assert.equal(result.passed, false);
    assert.ok(result.reason?.includes("crashed"));
  });
});
