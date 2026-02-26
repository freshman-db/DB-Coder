import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../utils/logger.js";

// --- Types ---

export type ProjectType =
  | "typescript"
  | "javascript"
  | "go"
  | "rust"
  | "python"
  | "makefile"
  | "unknown";

export interface VerifyBaseline {
  projectType: ProjectType;
  typeCheckErrors: number; // -1 = check not available
  testFailures: number; // -1 = tests not available/skipped
}

export interface VerifyResult {
  passed: boolean;
  reason?: string;
  typeCheck: { passed: boolean; errorCount: number; reason?: string };
  test: { passed: boolean; failCount: number; reason?: string } | null;
}

// --- Dependency injection for testing ---

type RunProcessFn = (
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    timeout?: number;
  },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface ProjectVerifierDeps {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: "utf-8") => string;
  runProcess: RunProcessFn;
}

const defaultDeps: ProjectVerifierDeps = {
  existsSync,
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  runProcess: async (command, args, options) => {
    const { runProcess } = await import("../utils/process.js");
    return runProcess(command, args, options ?? {});
  },
};

// --- Detection rules ---

interface ProjectRule {
  type: ProjectType;
  detect: (projectPath: string, deps: ProjectVerifierDeps) => boolean;
  typeCheckCmd?: { command: string; args: string[] };
  typeCheckParser: (output: string) => number; // returns error count
  testCmd?: (projectPath: string, deps: ProjectVerifierDeps) => { command: string; args: string[] } | null;
  testParser: (output: string, exitCode: number) => number; // returns fail count, -1 = skip
}

/** Check if package.json has a real test script (not the npm init placeholder) */
function hasRealTestScript(
  projectPath: string,
  deps: ProjectVerifierDeps,
): boolean {
  const pkgPath = join(projectPath, "package.json");
  if (!deps.existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(deps.readFileSync(pkgPath, "utf-8"));
    const testScript = pkg?.scripts?.test;
    if (!testScript) return false;
    // npm init default placeholder
    if (testScript.includes('echo "Error: no test specified"')) return false;
    return true;
  } catch {
    return false;
  }
}

/** Count lines matching a pattern */
function countLines(output: string, pattern: RegExp): number {
  return output.split("\n").filter((l) => pattern.test(l)).length;
}

const RULES: ProjectRule[] = [
  {
    type: "typescript",
    detect: (p, d) => d.existsSync(join(p, "tsconfig.json")),
    typeCheckCmd: { command: "npx", args: ["tsc", "--noEmit"] },
    typeCheckParser: (out) => countLines(out, /: error TS/),
    testCmd: (p, d) =>
      hasRealTestScript(p, d) ? { command: "npm", args: ["test"] } : null,
    testParser: (_out, exitCode) => (exitCode === 0 ? 0 : 1),
  },
  {
    type: "javascript",
    detect: (p, d) =>
      d.existsSync(join(p, "package.json")) &&
      !d.existsSync(join(p, "tsconfig.json")),
    typeCheckParser: () => 0, // no type check for JS
    testCmd: (p, d) =>
      hasRealTestScript(p, d) ? { command: "npm", args: ["test"] } : null,
    testParser: (_out, exitCode) => (exitCode === 0 ? 0 : 1),
  },
  {
    type: "go",
    detect: (p, d) => d.existsSync(join(p, "go.mod")),
    typeCheckCmd: { command: "go", args: ["vet", "./..."] },
    typeCheckParser: (out) => (out.trim() ? countLines(out, /.+/) : 0),
    testCmd: () => ({ command: "go", args: ["test", "./..."] }),
    testParser: (out, exitCode) => {
      if (exitCode === 0) return 0;
      return countLines(out, /--- FAIL:/);
    },
  },
  {
    type: "rust",
    detect: (p, d) => d.existsSync(join(p, "Cargo.toml")),
    typeCheckCmd: { command: "cargo", args: ["check"] },
    typeCheckParser: (out) => countLines(out, /^error\[/),
    testCmd: () => ({ command: "cargo", args: ["test"] }),
    testParser: (out, exitCode) => {
      if (exitCode === 0) return 0;
      const m = out.match(/(\d+) failed/);
      return m ? parseInt(m[1], 10) : 1;
    },
  },
  {
    type: "python",
    detect: (p, d) =>
      d.existsSync(join(p, "pyproject.toml")) ||
      d.existsSync(join(p, "setup.py")),
    typeCheckParser: () => 0, // no default type check for Python
    testCmd: () => ({ command: "pytest", args: ["--tb=no", "-q"] }),
    testParser: (out, exitCode) => {
      if (exitCode === 0) return 0;
      const m = out.match(/(\d+) failed/);
      return m ? parseInt(m[1], 10) : 1;
    },
  },
  {
    type: "makefile",
    detect: (p, d) => {
      const makefile = join(p, "Makefile");
      if (!d.existsSync(makefile)) return false;
      try {
        return d.readFileSync(makefile, "utf-8").includes("test:");
      } catch {
        return false;
      }
    },
    typeCheckParser: () => 0,
    testCmd: () => ({ command: "make", args: ["test"] }),
    testParser: (_out, exitCode) => (exitCode === 0 ? 0 : 1),
  },
];

// --- Timeout for commands ---

const TYPE_CHECK_TIMEOUT = 120_000; // 2 min
const TEST_TIMEOUT = 120_000; // 2 min

// --- ProjectVerifier ---

export class ProjectVerifier {
  private deps: ProjectVerifierDeps;

  constructor(deps?: Partial<ProjectVerifierDeps>) {
    this.deps = deps ? { ...defaultDeps, ...deps } : defaultDeps;
  }

  detect(projectPath: string): ProjectType {
    for (const rule of RULES) {
      if (rule.detect(projectPath, this.deps)) return rule.type;
    }
    return "unknown";
  }

  async baseline(projectPath: string): Promise<VerifyBaseline> {
    const projectType = this.detect(projectPath);
    const rule = RULES.find((r) => r.type === projectType);

    if (!rule) {
      return { projectType, typeCheckErrors: -1, testFailures: -1 };
    }

    const typeCheckErrors = await this.runTypeCheck(rule, projectPath);
    const testFailures = await this.runTests(rule, projectPath);

    log.info(
      `ProjectVerifier baseline: type=${projectType}, typeErrors=${typeCheckErrors}, testFails=${testFailures}`,
    );

    return { projectType, typeCheckErrors, testFailures };
  }

  async verify(
    projectPath: string,
    baseline: VerifyBaseline,
  ): Promise<VerifyResult> {
    const rule = RULES.find((r) => r.type === baseline.projectType);

    if (!rule) {
      return {
        passed: true,
        typeCheck: { passed: true, errorCount: 0 },
        test: null,
      };
    }

    // --- Type check ---
    const typeCheckErrors = await this.runTypeCheck(rule, projectPath);
    const typeCheck = this.compareTypeCheck(typeCheckErrors, baseline);

    // --- Tests ---
    const testResult = await this.compareTests(rule, projectPath, baseline);

    const passed = typeCheck.passed && (testResult?.passed ?? true);
    const reasons: string[] = [];
    if (!typeCheck.passed && typeCheck.reason) reasons.push(typeCheck.reason);
    if (testResult && !testResult.passed && testResult.reason)
      reasons.push(testResult.reason);

    return {
      passed,
      reason: reasons.length > 0 ? reasons.join("; ") : undefined,
      typeCheck,
      test: testResult,
    };
  }

  // --- Private helpers ---

  private async runTypeCheck(
    rule: ProjectRule,
    projectPath: string,
  ): Promise<number> {
    if (!rule.typeCheckCmd) return 0;
    try {
      const result = await this.deps.runProcess(
        rule.typeCheckCmd.command,
        rule.typeCheckCmd.args,
        { cwd: projectPath, timeout: TYPE_CHECK_TIMEOUT },
      );
      return rule.typeCheckParser(result.stdout + result.stderr);
    } catch (e) {
      log.warn(`ProjectVerifier typeCheck failed for ${rule.type}`, {
        error: e instanceof Error ? e.message : String(e),
      });
      return -1;
    }
  }

  private async runTests(
    rule: ProjectRule,
    projectPath: string,
  ): Promise<number> {
    const testCmd = rule.testCmd?.(projectPath, this.deps);
    if (!testCmd) return -1;
    try {
      const result = await this.deps.runProcess(
        testCmd.command,
        testCmd.args,
        { cwd: projectPath, timeout: TEST_TIMEOUT },
      );
      return rule.testParser(result.stdout + result.stderr, result.exitCode);
    } catch (e) {
      log.warn(`ProjectVerifier test failed for ${rule.type}`, {
        error: e instanceof Error ? e.message : String(e),
      });
      return -1; // timeout or crash → skip, don't block
    }
  }

  private compareTypeCheck(
    current: number,
    baseline: VerifyBaseline,
  ): VerifyResult["typeCheck"] {
    if (current < 0) {
      return {
        passed: false,
        errorCount: current,
        reason: `${baseline.projectType} type check crashed`,
      };
    }
    if (baseline.typeCheckErrors >= 0 && current > baseline.typeCheckErrors) {
      return {
        passed: false,
        errorCount: current,
        reason: `Type errors increased: ${baseline.typeCheckErrors} → ${current} (+${current - baseline.typeCheckErrors})`,
      };
    }
    return { passed: true, errorCount: current };
  }

  private async compareTests(
    rule: ProjectRule,
    projectPath: string,
    baseline: VerifyBaseline,
  ): Promise<VerifyResult["test"]> {
    if (baseline.testFailures === -1) return null; // tests weren't available at baseline

    const current = await this.runTests(rule, projectPath);
    if (current === -1) {
      // Tests were available at baseline but now crash/timeout → warn but don't block
      log.warn(
        "ProjectVerifier: tests available at baseline but failed to run now, skipping test check",
      );
      return null;
    }
    if (current > baseline.testFailures) {
      return {
        passed: false,
        failCount: current,
        reason: `Test failures increased: ${baseline.testFailures} → ${current} (+${current - baseline.testFailures})`,
      };
    }
    return { passed: true, failCount: current };
  }
}
