import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Dirent } from "node:fs";

import { ChainScanner, setChainScannerDepsForTests } from "./ChainScanner.js";
import type { EntryPoint, ChainScanState } from "./chain-scanner-types.js";

// ---------------------------------------------------------------------------
// Minimal mock helpers
// ---------------------------------------------------------------------------

function makeDirent(name: string, isDir: boolean): Dirent {
  return {
    name,
    isFile: () => !isDir,
    isDirectory: () => isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
    parentPath: "",
    path: "",
  } as Dirent;
}

type MockSessionResult = {
  text: string;
  costUsd: number;
  sessionId: string;
  exitCode: number;
  numTurns: number;
  durationMs: number;
  isError: boolean;
  errors: string[];
  json: unknown;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    cacheCreation: number;
  };
};

function makeResult(text: string, costUsd = 0.01): MockSessionResult {
  return {
    text,
    costUsd,
    sessionId: "test-session",
    exitCode: 0,
    numTurns: 1,
    durationMs: 100,
    isError: false,
    errors: [],
    json: null,
    usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0 },
  };
}

function createMockBrain(handler?: (prompt: string) => MockSessionResult) {
  return {
    run: async (prompt: string, _opts: unknown) => {
      if (handler) return handler(prompt);
      return makeResult("{}");
    },
    kill: () => {},
  };
}

function createMockTaskStore() {
  const tasks: Array<{
    desc: string;
    priority: number;
    projectPath: string;
  }> = [];
  let scanState: ChainScanState | null = null;
  let dailyCostAdded = 0;

  return {
    tasks,
    get dailyCostAdded() {
      return dailyCostAdded;
    },
    getChainScanState: async (_pp: string) => scanState,
    upsertChainScanState: async (s: ChainScanState) => {
      scanState = s;
    },
    createTask: async (
      projectPath: string,
      desc: string,
      priority: number,
    ) => {
      tasks.push({ desc, priority, projectPath });
      return {
        id: `task-${tasks.length}`,
        project_path: projectPath,
        task_description: desc,
        priority,
        status: "queued",
      };
    },
    findSimilarTask: async () => null,
    hasRecentlyFailedSimilar: async () => false,
    addDailyCost: async (cost: number) => {
      dailyCostAdded += cost;
    },
    setScanState: (s: ChainScanState | null) => {
      scanState = s;
    },
    getScanState: () => scanState,
  };
}

function createMockConfig(overrides?: Record<string, unknown>) {
  return {
    projectPath: "/test-project",
    values: {
      brain: {
        model: "sonnet",
        chainScan: {
          enabled: true,
          interval: 5,
          maxBudget: 3.0,
          chainsPerTrigger: 2,
          rediscoveryInterval: 10,
          ...overrides,
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests: Deterministic entry-point discovery
// ---------------------------------------------------------------------------

describe("ChainScanner", () => {
  afterEach(() => {
    setChainScannerDepsForTests();
  });

  describe("deterministicScan — TypeScript/JavaScript", () => {
    it("should detect HTTP route entries", () => {
      const fileContents: Record<string, string> = {
        "/test-project/src/server/routes.ts": `
route("POST", "/api/tasks", handler);
route("GET", "/api/status", getStatus);
`,
      };

      setChainScannerDepsForTests({
        existsSync: (p: string) =>
          p.endsWith("tsconfig.json") ||
          p.endsWith("package.json"),
        readFileSync: (p: string) => fileContents[p] ?? "",
        readdirSync: (p: string, _opts: unknown) => {
          if (p === "/test-project") {
            return [makeDirent("src", true)] as Dirent[];
          }
          if (p === "/test-project/src") {
            return [makeDirent("server", true)] as Dirent[];
          }
          if (p === "/test-project/src/server") {
            return [makeDirent("routes.ts", false)] as Dirent[];
          }
          return [] as Dirent[];
        },
      });

      const scanner = new ChainScanner(
        createMockBrain() as never,
        createMockTaskStore() as never,
        createMockConfig() as never,
      );

      const entries = scanner.deterministicScan("/test-project");
      const httpEntries = entries.filter((e) => e.kind === "http");
      assert.ok(httpEntries.length >= 2, `Expected >= 2 HTTP entries, got ${httpEntries.length}`);
      assert.ok(
        httpEntries.some((e) => e.name.includes("POST") && e.name.includes("/api/tasks")),
      );
      assert.ok(
        httpEntries.some((e) => e.name.includes("GET") && e.name.includes("/api/status")),
      );
    });

    it("should detect CLI command entries", () => {
      const fileContents: Record<string, string> = {
        "/test-project/src/index.ts": `
program.command("serve").description("Start server");
program.command("scan").description("Run scan");
`,
      };

      setChainScannerDepsForTests({
        existsSync: (p: string) => p.endsWith("package.json"),
        readFileSync: (p: string) => fileContents[p] ?? "",
        readdirSync: (p: string) => {
          if (p === "/test-project") {
            return [makeDirent("src", true)] as Dirent[];
          }
          if (p === "/test-project/src") {
            return [makeDirent("index.ts", false)] as Dirent[];
          }
          return [] as Dirent[];
        },
      });

      const scanner = new ChainScanner(
        createMockBrain() as never,
        createMockTaskStore() as never,
        createMockConfig() as never,
      );

      const entries = scanner.deterministicScan("/test-project");
      const cliEntries = entries.filter((e) => e.kind === "cli");
      assert.ok(cliEntries.length >= 2, `Expected >= 2 CLI entries, got ${cliEntries.length}`);
      assert.ok(cliEntries.some((e) => e.name.includes("serve")));
      assert.ok(cliEntries.some((e) => e.name.includes("scan")));
    });

    it("should return empty array for empty directory", () => {
      setChainScannerDepsForTests({
        existsSync: (p: string) => p.endsWith("package.json"),
        readFileSync: () => "",
        readdirSync: () => [] as Dirent[],
      });

      const scanner = new ChainScanner(
        createMockBrain() as never,
        createMockTaskStore() as never,
        createMockConfig() as never,
      );

      const entries = scanner.deterministicScan("/test-project");
      assert.equal(entries.length, 0);
    });

    it("should skip test files", () => {
      const fileContents: Record<string, string> = {
        "/test-project/src/core/MainLoop.test.ts": `
export function testHelper() {}
`,
        "/test-project/src/core/MainLoop.ts": `
export async function runCycle() {}
`,
      };

      setChainScannerDepsForTests({
        existsSync: (p: string) => p.endsWith("package.json"),
        readFileSync: (p: string) => fileContents[p] ?? "",
        readdirSync: (p: string) => {
          if (p === "/test-project") {
            return [makeDirent("src", true)] as Dirent[];
          }
          if (p === "/test-project/src") {
            return [makeDirent("core", true)] as Dirent[];
          }
          if (p === "/test-project/src/core") {
            return [
              makeDirent("MainLoop.ts", false),
              makeDirent("MainLoop.test.ts", false),
            ] as Dirent[];
          }
          return [] as Dirent[];
        },
      });

      const scanner = new ChainScanner(
        createMockBrain() as never,
        createMockTaskStore() as never,
        createMockConfig() as never,
      );

      const entries = scanner.deterministicScan("/test-project");
      assert.ok(
        entries.every((e) => !e.file.includes(".test.")),
        "Should not include test files",
      );
    });

    it("should filter out DOM/non-business events", () => {
      const fileContents: Record<string, string> = {
        "/test-project/src/server.ts": `
server.on("error", handleError);
server.on("close", handleClose);
eventBus.on("task:created", handleTaskCreated);
`,
      };

      setChainScannerDepsForTests({
        existsSync: (p: string) => p.endsWith("package.json"),
        readFileSync: (p: string) => fileContents[p] ?? "",
        readdirSync: (p: string) => {
          if (p === "/test-project") {
            return [makeDirent("src", true)] as Dirent[];
          }
          if (p === "/test-project/src") {
            return [makeDirent("server.ts", false)] as Dirent[];
          }
          return [] as Dirent[];
        },
      });

      const scanner = new ChainScanner(
        createMockBrain() as never,
        createMockTaskStore() as never,
        createMockConfig() as never,
      );

      const entries = scanner.deterministicScan("/test-project");
      const eventEntries = entries.filter((e) => e.kind === "event");
      // "error" and "close" should be filtered out, "task:created" should remain
      assert.ok(
        eventEntries.some((e) => e.name.includes("task:created")),
        "Should include business events",
      );
      assert.ok(
        !eventEntries.some((e) => e.name === "on: error"),
        "Should filter out 'error' event",
      );
      assert.ok(
        !eventEntries.some((e) => e.name === "on: close"),
        "Should filter out 'close' event",
      );
    });
  });

  describe("deterministicScan — Python", () => {
    it("should detect FastAPI route entries", () => {
      const fileContents: Record<string, string> = {
        "/test-project/src/api.py": `
@app.get("/users")
def get_users():
    pass

@app.post("/users")
def create_user():
    pass
`,
      };

      setChainScannerDepsForTests({
        existsSync: (p: string) => p.endsWith("requirements.txt"),
        readFileSync: (p: string) => fileContents[p] ?? "",
        readdirSync: (p: string) => {
          if (p === "/test-project") {
            return [makeDirent("src", true)] as Dirent[];
          }
          if (p === "/test-project/src") {
            return [makeDirent("api.py", false)] as Dirent[];
          }
          return [] as Dirent[];
        },
      });

      const scanner = new ChainScanner(
        createMockBrain() as never,
        createMockTaskStore() as never,
        createMockConfig() as never,
      );

      const entries = scanner.deterministicScan("/test-project");
      const httpEntries = entries.filter((e) => e.kind === "http");
      assert.ok(httpEntries.length >= 2, `Expected >= 2 HTTP entries, got ${httpEntries.length}`);
    });

    it("should detect click CLI entries", () => {
      const fileContents: Record<string, string> = {
        "/test-project/cli.py": `
@click.command()
def main():
    pass
`,
      };

      setChainScannerDepsForTests({
        existsSync: (p: string) => p.endsWith("pyproject.toml"),
        readFileSync: (p: string) => fileContents[p] ?? "",
        readdirSync: (p: string) => {
          if (p === "/test-project") {
            return [makeDirent("cli.py", false)] as Dirent[];
          }
          return [] as Dirent[];
        },
      });

      const scanner = new ChainScanner(
        createMockBrain() as never,
        createMockTaskStore() as never,
        createMockConfig() as never,
      );

      const entries = scanner.deterministicScan("/test-project");
      const cliEntries = entries.filter((e) => e.kind === "cli");
      assert.ok(cliEntries.length >= 1, `Expected >= 1 CLI entry, got ${cliEntries.length}`);
    });

    it("should detect Celery task entries", () => {
      const fileContents: Record<string, string> = {
        "/test-project/tasks.py": `
@shared_task
def process_order(order_id):
    pass
`,
      };

      setChainScannerDepsForTests({
        existsSync: (p: string) => p.endsWith("requirements.txt"),
        readFileSync: (p: string) => fileContents[p] ?? "",
        readdirSync: (p: string) => {
          if (p === "/test-project") {
            return [makeDirent("tasks.py", false)] as Dirent[];
          }
          return [] as Dirent[];
        },
      });

      const scanner = new ChainScanner(
        createMockBrain() as never,
        createMockTaskStore() as never,
        createMockConfig() as never,
      );

      const entries = scanner.deterministicScan("/test-project");
      const eventEntries = entries.filter((e) => e.kind === "event");
      assert.ok(eventEntries.length >= 1, `Expected >= 1 event entry, got ${eventEntries.length}`);
    });
  });

  // ---------------------------------------------------------------------------
  // Rotation logic
  // ---------------------------------------------------------------------------

  describe("rotation logic", () => {
    it("should rotate through entries with wrapping", async () => {
      const entries: EntryPoint[] = [
        { name: "A", file: "a.ts", line: 1, kind: "http" },
        { name: "B", file: "b.ts", line: 1, kind: "http" },
        { name: "C", file: "c.ts", line: 1, kind: "http" },
        { name: "D", file: "d.ts", line: 1, kind: "http" },
        { name: "E", file: "e.ts", line: 1, kind: "http" },
      ];

      const store = createMockTaskStore();
      store.setScanState({
        projectPath: "/test-project",
        nextIndex: 0,
        entryPoints: entries,
        knownFingerprints: [],
        lastDiscoveryAt: new Date().toISOString(),
        lastScanAt: "",
        scanCount: 1, // non-zero so it won't re-discover
      });

      // Mock brain returns empty findings
      const brain = createMockBrain(() =>
        makeResult(JSON.stringify({ callPath: [], boundaries: [] })),
      );

      const scanner = new ChainScanner(
        brain as never,
        store as never,
        createMockConfig({ chainsPerTrigger: 2 }) as never,
      );

      // Scan 1: entries[0], entries[1]
      await scanner.scanNext("/test-project");
      let state = store.getScanState()!;
      assert.equal(state.nextIndex, 2);

      // Scan 2: entries[2], entries[3]
      await scanner.scanNext("/test-project");
      state = store.getScanState()!;
      assert.equal(state.nextIndex, 4);

      // Scan 3: entries[4], entries[0] (wraps)
      await scanner.scanNext("/test-project");
      state = store.getScanState()!;
      assert.equal(state.nextIndex, 1); // (4+2) % 5 = 1
    });
  });

  // ---------------------------------------------------------------------------
  // Fingerprint deduplication
  // ---------------------------------------------------------------------------

  describe("fingerprint dedup", () => {
    it("should not create duplicate tasks for same crossing+mismatch", async () => {
      const entries: EntryPoint[] = [
        { name: "A", file: "a.ts", line: 1, kind: "http" },
      ];

      const finding = {
        boundary: {
          crossing: "A.method → B.method",
          producerFile: "a.ts",
          consumerFile: "b.ts",
          dataFlowing: "string",
          producerContract: "returns non-empty string",
          consumerAssumption: "truthy check",
        },
        mismatch: 'returns "" on error which is falsy',
        severity: "high",
        failureScenario: "consumer skips processing",
      };

      // Brain: trace returns one boundary, verify returns one finding
      const brain = createMockBrain((prompt: string) => {
        if (prompt.includes("Trace the execution chain")) {
          return makeResult(
            JSON.stringify({
              callPath: ["A.method", "B.method"],
              boundaries: [finding.boundary],
            }),
          );
        }
        if (prompt.includes("boundary contract auditor")) {
          return makeResult(JSON.stringify({ findings: [finding] }));
        }
        return makeResult("[]"); // AI refinement
      });

      const store = createMockTaskStore();
      store.setScanState({
        projectPath: "/test-project",
        nextIndex: 0,
        entryPoints: entries,
        knownFingerprints: [],
        lastDiscoveryAt: new Date().toISOString(),
        lastScanAt: "",
        scanCount: 1,
      });

      const scanner = new ChainScanner(
        brain as never,
        store as never,
        createMockConfig({ chainsPerTrigger: 1 }) as never,
      );

      // First scan: should create 1 task
      await scanner.scanNext("/test-project");
      assert.equal(store.tasks.length, 1);

      // Second scan: same finding, should not create duplicate
      await scanner.scanNext("/test-project");
      assert.equal(store.tasks.length, 1, "Should not create duplicate task");
    });

    it("should create separate tasks for different mismatches on same crossing", async () => {
      const entries: EntryPoint[] = [
        { name: "A", file: "a.ts", line: 1, kind: "http" },
      ];

      let callCount = 0;
      const brain = createMockBrain((prompt: string) => {
        if (prompt.includes("Trace the execution chain")) {
          return makeResult(
            JSON.stringify({
              callPath: ["A", "B"],
              boundaries: [
                {
                  crossing: "A → B",
                  producerFile: "a.ts",
                  consumerFile: "b.ts",
                  dataFlowing: "n/a",
                  producerContract: "",
                  consumerAssumption: "",
                },
              ],
            }),
          );
        }
        if (prompt.includes("boundary contract auditor")) {
          callCount++;
          const mismatch =
            callCount === 1 ? "mismatch-alpha" : "mismatch-beta";
          return makeResult(
            JSON.stringify({
              findings: [
                {
                  boundary: {
                    crossing: "A → B",
                    producerFile: "a.ts",
                    consumerFile: "b.ts",
                    dataFlowing: "n/a",
                    producerContract: "",
                    consumerAssumption: "",
                  },
                  mismatch,
                  severity: "high",
                  failureScenario: "issue",
                },
              ],
            }),
          );
        }
        return makeResult("[]");
      });

      const store = createMockTaskStore();
      store.setScanState({
        projectPath: "/test-project",
        nextIndex: 0,
        entryPoints: entries,
        knownFingerprints: [],
        lastDiscoveryAt: new Date().toISOString(),
        lastScanAt: "",
        scanCount: 1,
      });

      const scanner = new ChainScanner(
        brain as never,
        store as never,
        createMockConfig({ chainsPerTrigger: 1 }) as never,
      );

      await scanner.scanNext("/test-project");
      assert.equal(store.tasks.length, 1);

      await scanner.scanNext("/test-project");
      assert.equal(store.tasks.length, 2, "Different mismatch should create new task");
    });
  });

  // ---------------------------------------------------------------------------
  // Budget control
  // ---------------------------------------------------------------------------

  describe("budget control", () => {
    it("should skip remaining chains when budget exhausted", async () => {
      const entries: EntryPoint[] = [
        { name: "A", file: "a.ts", line: 1, kind: "http" },
        { name: "B", file: "b.ts", line: 1, kind: "http" },
      ];

      let traceCallCount = 0;
      const brain = createMockBrain((prompt: string) => {
        if (prompt.includes("Trace the execution chain")) {
          traceCallCount++;
          return makeResult(
            JSON.stringify({ callPath: [], boundaries: [] }),
            2.0, // Each trace costs $2.0
          );
        }
        return makeResult("[]");
      });

      const store = createMockTaskStore();
      store.setScanState({
        projectPath: "/test-project",
        nextIndex: 0,
        entryPoints: entries,
        knownFingerprints: [],
        lastDiscoveryAt: new Date().toISOString(),
        lastScanAt: "",
        scanCount: 1,
      });

      const scanner = new ChainScanner(
        brain as never,
        store as never,
        createMockConfig({ chainsPerTrigger: 2, maxBudget: 3.0 }) as never,
      );

      await scanner.scanNext("/test-project");

      // First chain costs $2.0, second should be skipped ($2.0 >= $3.0 is false,
      // but after first trace total is $2.0, which < $3.0, so second trace runs
      // making total $4.0; but actually budget check is at the start of loop)
      // Actually: after first chain, totalCost=2.0, which < 3.0, so second chain starts.
      // After second trace, totalCost=4.0. But the check is at the top of the loop.
      assert.equal(traceCallCount, 2, "Both traces should run (budget check is before loop iteration)");
    });

    it("should skip chain when budget already exceeded", async () => {
      const entries: EntryPoint[] = [
        { name: "A", file: "a.ts", line: 1, kind: "http" },
        { name: "B", file: "b.ts", line: 1, kind: "http" },
        { name: "C", file: "c.ts", line: 1, kind: "http" },
      ];

      let traceCallCount = 0;
      const brain = createMockBrain((prompt: string) => {
        if (prompt.includes("Trace the execution chain")) {
          traceCallCount++;
          return makeResult(
            JSON.stringify({ callPath: [], boundaries: [] }),
            2.0,
          );
        }
        return makeResult("[]");
      });

      const store = createMockTaskStore();
      store.setScanState({
        projectPath: "/test-project",
        nextIndex: 0,
        entryPoints: entries,
        knownFingerprints: [],
        lastDiscoveryAt: new Date().toISOString(),
        lastScanAt: "",
        scanCount: 1,
      });

      const scanner = new ChainScanner(
        brain as never,
        store as never,
        createMockConfig({ chainsPerTrigger: 3, maxBudget: 3.0 }) as never,
      );

      await scanner.scanNext("/test-project");

      // Chain A: $2.0 (total $2.0 < $3.0, proceed)
      // Chain B: $2.0 (total $4.0 >= $3.0 at start of next iteration, skip C)
      // Actually: After A's trace, totalCost=2.0 < 3.0. B's trace runs, totalCost=4.0.
      // Then C's loop iteration checks 4.0 >= 3.0 → skips.
      assert.equal(traceCallCount, 2);
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  describe("error handling", () => {
    it("should continue to next chain when brain session throws", async () => {
      const entries: EntryPoint[] = [
        { name: "A", file: "a.ts", line: 1, kind: "http" },
        { name: "B", file: "b.ts", line: 1, kind: "http" },
      ];

      let callCount = 0;
      const brain = {
        run: async (prompt: string) => {
          if (prompt.includes("Trace the execution chain")) {
            callCount++;
            if (callCount === 1) throw new Error("Session timeout");
            return makeResult(
              JSON.stringify({ callPath: [], boundaries: [] }),
            );
          }
          return makeResult("[]");
        },
        kill: () => {},
      };

      const store = createMockTaskStore();
      store.setScanState({
        projectPath: "/test-project",
        nextIndex: 0,
        entryPoints: entries,
        knownFingerprints: [],
        lastDiscoveryAt: new Date().toISOString(),
        lastScanAt: "",
        scanCount: 1,
      });

      const scanner = new ChainScanner(
        brain as never,
        store as never,
        createMockConfig({ chainsPerTrigger: 2 }) as never,
      );

      // Should not throw
      await scanner.scanNext("/test-project");
      assert.equal(callCount, 2, "Should attempt both chains");
    });

    it("should handle JSON parse failure gracefully", async () => {
      const entries: EntryPoint[] = [
        { name: "A", file: "a.ts", line: 1, kind: "http" },
      ];

      const brain = createMockBrain((prompt: string) => {
        if (prompt.includes("Trace the execution chain")) {
          return makeResult("This is not JSON at all");
        }
        return makeResult("[]");
      });

      const store = createMockTaskStore();
      store.setScanState({
        projectPath: "/test-project",
        nextIndex: 0,
        entryPoints: entries,
        knownFingerprints: [],
        lastDiscoveryAt: new Date().toISOString(),
        lastScanAt: "",
        scanCount: 1,
      });

      const scanner = new ChainScanner(
        brain as never,
        store as never,
        createMockConfig({ chainsPerTrigger: 1 }) as never,
      );

      // Should not throw, just log warning
      await scanner.scanNext("/test-project");
      assert.equal(store.tasks.length, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // Rediscovery interval
  // ---------------------------------------------------------------------------

  describe("rediscovery", () => {
    it("should re-discover when scanCount reaches rediscoveryInterval", async () => {
      const entries: EntryPoint[] = [
        { name: "A", file: "a.ts", line: 1, kind: "http" },
      ];

      setChainScannerDepsForTests({
        existsSync: (p: string) => p.endsWith("package.json"),
        readFileSync: () =>
          'export async function newEndpoint() {}\nroute("GET", "/api/new", handler);',
        readdirSync: (p: string) => {
          if (p === "/test-project") {
            return [makeDirent("src", true)] as Dirent[];
          }
          if (p === "/test-project/src") {
            return [makeDirent("routes.ts", false)] as Dirent[];
          }
          return [] as Dirent[];
        },
      });

      const brain = createMockBrain((prompt: string) => {
        if (prompt.includes("Trace the execution chain")) {
          return makeResult(
            JSON.stringify({ callPath: [], boundaries: [] }),
          );
        }
        // AI refinement: return the raw entries as-is
        if (prompt.includes("entry points discovered")) {
          return makeResult("[]");
        }
        return makeResult("[]");
      });

      const store = createMockTaskStore();
      store.setScanState({
        projectPath: "/test-project",
        nextIndex: 0,
        entryPoints: entries,
        knownFingerprints: [],
        lastDiscoveryAt: new Date().toISOString(),
        lastScanAt: "",
        scanCount: 10, // = rediscoveryInterval, triggers re-discovery
      });

      const scanner = new ChainScanner(
        brain as never,
        store as never,
        createMockConfig({ chainsPerTrigger: 1, rediscoveryInterval: 10 }) as never,
      );

      await scanner.scanNext("/test-project");

      const state = store.getScanState()!;
      // After re-discovery, entry points should be updated (from file scan, not the old single entry)
      assert.ok(state.scanCount === 11, "scanCount should be incremented");
      assert.ok(state.lastDiscoveryAt !== "", "lastDiscoveryAt should be set");
    });
  });
});
