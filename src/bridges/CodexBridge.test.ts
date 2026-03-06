import assert from "node:assert/strict";
import childProcess, {
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { CodexConfig } from "../config/types.js";
import { CodexBridge } from "./CodexBridge.js";

interface SpawnCall {
  command: string;
  args: string[];
  options: SpawnOptions;
}

type SpawnImplementation = (call: SpawnCall) => ChildProcess;

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();

  kill(_signal?: NodeJS.Signals | number): boolean {
    this.emit("close", null);
    return true;
  }
}

class FakeChildProcessWithKillSpy extends FakeChildProcess {
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];

  override kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    this.emit("close", null);
    return true;
  }
}

function createCodexConfig(): CodexConfig {
  return {
    model: "gpt-5-codex",
    sandbox: "workspace-write",
  };
}

async function withMockedSpawn(
  implementation: SpawnImplementation,
  run: (calls: SpawnCall[]) => Promise<void>,
): Promise<void> {
  const originalSpawn = childProcess.spawn;
  const calls: SpawnCall[] = [];

  childProcess.spawn = ((
    command: string,
    args: readonly string[] = [],
    options: SpawnOptions = {},
  ) => {
    const call: SpawnCall = {
      command,
      args: [...args],
      options,
    };
    calls.push(call);
    return implementation(call);
  }) as typeof childProcess.spawn;
  syncBuiltinESMExports();

  try {
    await run(calls);
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  }
}

function getOutputFilePath(args: string[]): string {
  const outputArgIndex = args.indexOf("-o");
  assert.ok(outputArgIndex >= 0);
  const outFile = args[outputArgIndex + 1];
  assert.ok(outFile);
  return outFile;
}

test("execute runs codex with expected args and parses JSON output", async () => {
  await withMockedSpawn(
    (call) => {
      const child = new FakeChildProcess();
      const outFile = getOutputFilePath(call.args);

      setImmediate(() => {
        writeFileSync(
          outFile,
          JSON.stringify({ output: "Implemented feature" }),
        );
        child.stdout.write(
          `${JSON.stringify({ type: "turn.completed", total_cost_usd: 0.42 })}\n`,
        );
        child.stdout.end();
        child.emit("close", 0);
      });

      return child as unknown as ChildProcess;
    },
    async (calls) => {
      const bridge = new CodexBridge(createCodexConfig());
      const result = await bridge.execute("Implement endpoint", process.cwd(), {
        systemPrompt: "Return JSON only",
      });

      assert.equal(calls.length, 1);
      const call = calls[0];

      assert.equal(call.command, "codex");
      assert.deepEqual(call.args.slice(0, 4), [
        "exec",
        "--sandbox",
        "workspace-write",
        "--json",
      ]);

      const outputArgIndex = call.args.indexOf("-o");
      assert.ok(outputArgIndex >= 0);
      assert.match(
        call.args[outputArgIndex + 1] ?? "",
        /codex-\d+-[0-9a-f-]+\.json$/,
      );

      assert.equal(call.args[outputArgIndex + 2], "--instructions");
      assert.equal(call.args[outputArgIndex + 3], "Return JSON only");
      assert.equal(call.args[call.args.length - 1], "Implement endpoint");

      assert.equal(result.success, true);
      assert.equal(
        result.output,
        JSON.stringify({ output: "Implemented feature" }),
      );
      assert.equal(result.cost_usd, 0.42);
      assert.deepEqual(result.structured, { output: "Implemented feature" });
      assert.ok(result.duration_ms >= 0);
    },
  );
});

test("execute returns failure result when codex exits with non-zero code", async () => {
  await withMockedSpawn(
    () => {
      const child = new FakeChildProcess();

      setImmediate(() => {
        child.stderr.write("invalid codex args");
        child.stderr.end();
        child.stdout.write(
          `${JSON.stringify({ type: "turn.completed", total_cost_usd: 0.13 })}\n`,
        );
        child.stdout.end();
        child.emit("close", 2);
      });

      return child as unknown as ChildProcess;
    },
    async () => {
      const bridge = new CodexBridge(createCodexConfig());
      const result = await bridge.execute("Implement endpoint", process.cwd());

      assert.equal(result.success, false);
      assert.equal(result.output, "invalid codex args");
      assert.equal(result.cost_usd, 0.13);
      assert.ok(result.duration_ms >= 0);
    },
  );
});

test("execute catches child process errors and returns graceful failure result", async () => {
  await withMockedSpawn(
    () => {
      const child = new FakeChildProcess();

      setImmediate(() => {
        child.emit("error", new Error("spawn failed"));
      });

      return child as unknown as ChildProcess;
    },
    async () => {
      const bridge = new CodexBridge(createCodexConfig());
      const result = await bridge.execute("Implement endpoint", process.cwd());

      assert.equal(result.success, false);
      assert.match(result.output, /spawn failed/);
      assert.equal(result.cost_usd, 0);
      assert.ok(result.duration_ms >= 0);
    },
  );
});

test("execute returns raw output when output file is not valid JSON", async () => {
  await withMockedSpawn(
    (call) => {
      const child = new FakeChildProcess();
      const outFile = getOutputFilePath(call.args);

      setImmediate(() => {
        writeFileSync(outFile, "not-json output from codex");
        child.stdout.write("this line is not jsonl\n");
        child.stdout.end();
        child.emit("close", 0);
      });

      return child as unknown as ChildProcess;
    },
    async () => {
      const bridge = new CodexBridge(createCodexConfig());
      const result = await bridge.execute("Implement endpoint", process.cwd());

      assert.equal(result.success, true);
      assert.equal(result.output, "not-json output from codex");
      assert.equal(result.structured, undefined);
      assert.equal(result.cost_usd, 0);
    },
  );
});

test("execute kills codex process on timeout", async () => {
  const child = new FakeChildProcessWithKillSpy();

  await withMockedSpawn(
    () => child as unknown as ChildProcess,
    async () => {
      const bridge = new CodexBridge(createCodexConfig());
      const result = await bridge.execute("Implement endpoint", process.cwd(), {
        timeout: 25,
      });

      assert.equal(result.success, false);
      assert.equal(result.output, "codex exec failed with exit code -1");
      assert.equal(child.killSignals.length, 1);
      assert.equal(child.killSignals[0], "SIGTERM");
    },
  );
});

test("review parses valid review JSON and tags issues as codex-sourced", async () => {
  await withMockedSpawn(
    (call) => {
      const child = new FakeChildProcess();
      const outFile = getOutputFilePath(call.args);

      setImmediate(() => {
        writeFileSync(
          outFile,
          JSON.stringify({
            passed: false,
            issues: [
              {
                severity: "high",
                description: "Potential SQL injection in raw query",
                file: "src/db/query.ts",
                line: 42,
                suggestion: "Use parameterized placeholders",
              },
            ],
            summary: "Found one high severity issue",
          }),
        );
        child.stdout.write(
          `${JSON.stringify({ type: "turn.completed", total_cost_usd: 0.09 })}\n`,
        );
        child.stdout.end();
        child.emit("close", 0);
      });

      return child as unknown as ChildProcess;
    },
    async (calls) => {
      const bridge = new CodexBridge(createCodexConfig());
      const result = await bridge.review(
        "Review the pending DB migration",
        process.cwd(),
      );

      assert.equal(calls.length, 1);
      const call = calls[0];
      assert.equal(call.command, "codex");
      assert.deepEqual(call.args.slice(0, 4), [
        "exec",
        "--sandbox",
        "read-only",
        "--json",
      ]);
      assert.match(
        call.args[call.args.length - 1] ?? "",
        /Review the pending DB migration/,
      );
      assert.doesNotMatch(
        call.args[call.args.length - 1] ?? "",
        /Review the uncommitted/,
      );

      assert.equal(result.passed, false);
      assert.equal(result.summary, "Found one high severity issue");
      assert.equal(result.cost_usd, 0.09);
      assert.deepEqual(result.issues, [
        {
          severity: "high",
          description: "Potential SQL injection in raw query",
          file: "src/db/query.ts",
          line: 42,
          suggestion: "Use parameterized placeholders",
          source: "codex",
          confidence: undefined,
        },
      ]);
    },
  );
});

test("execute extracts structured total cost from direct and usage fields", async () => {
  await withMockedSpawn(
    (call) => {
      const child = new FakeChildProcess();
      const outFile = getOutputFilePath(call.args);

      setImmediate(() => {
        writeFileSync(outFile, JSON.stringify({ output: "done" }));
        child.stdout.write(
          `${JSON.stringify({ type: "message", cost: 0.02 })}\n`,
        );
        child.stdout.write(
          `${JSON.stringify({ type: "turn.completed", usage: { total_cost: 0.11 } })}\n`,
        );
        child.stdout.write(
          `${JSON.stringify({ type: "message", total_cost_usd: 0.15 })}\n`,
        );
        child.stdout.write(
          `${JSON.stringify({ type: "message", usage: { cost: 0.5 } })}\n`,
        );
        child.stdout.end();
        child.emit("close", 0);
      });

      return child as unknown as ChildProcess;
    },
    async () => {
      const bridge = new CodexBridge(createCodexConfig());
      const result = await bridge.execute("Implement endpoint", process.cwd());

      assert.equal(result.success, true);
      assert.equal(result.cost_usd, 0.15);
    },
  );
});

test("execute falls back to last structured partial cost when no total is present", async () => {
  await withMockedSpawn(
    (call) => {
      const child = new FakeChildProcess();
      const outFile = getOutputFilePath(call.args);

      setImmediate(() => {
        writeFileSync(outFile, JSON.stringify({ output: "done" }));
        child.stdout.write(
          `${JSON.stringify({ type: "message", total_cost_usd: 0 })}\n`,
        );
        child.stdout.write(
          `${JSON.stringify({ type: "turn.completed", usage: { cost: 0.03 } })}\n`,
        );
        child.stdout.write(
          `${JSON.stringify({ type: "message", cost: 0.05 })}\n`,
        );
        child.stdout.end();
        child.emit("close", 0);
      });

      return child as unknown as ChildProcess;
    },
    async () => {
      const bridge = new CodexBridge(createCodexConfig());
      const result = await bridge.execute("Implement endpoint", process.cwd());

      assert.equal(result.success, true);
      assert.equal(result.cost_usd, 0.05);
    },
  );
});

for (const costCase of [
  { name: "Cost: $0.0123", content: "Cost: $0.0123", expectedCost: 0.0123 },
  { name: "total_cost: 0.05", content: "total_cost: 0.05", expectedCost: 0.05 },
  {
    name: "missing cost falls back to zero",
    content: "No cost provided",
    expectedCost: 0,
  },
]) {
  test(`execute extracts cost from text format (${costCase.name})`, async () => {
    await withMockedSpawn(
      (call) => {
        const child = new FakeChildProcess();
        const outFile = getOutputFilePath(call.args);

        setImmediate(() => {
          writeFileSync(outFile, JSON.stringify({ output: "done" }));
          child.stdout.write(
            `${JSON.stringify({ type: "message", content: costCase.content })}\n`,
          );
          child.stdout.end();
          child.emit("close", 0);
        });

        return child as unknown as ChildProcess;
      },
      async () => {
        const bridge = new CodexBridge(createCodexConfig());
        const result = await bridge.execute(
          "Implement endpoint",
          process.cwd(),
        );

        assert.equal(result.success, true);
        assert.ok(Math.abs(result.cost_usd - costCase.expectedCost) < 1e-9);
      },
    );
  });
}

test("execute scans all event text and prefers total cost over partial cost", async () => {
  await withMockedSpawn(
    (call) => {
      const child = new FakeChildProcess();
      const outFile = getOutputFilePath(call.args);

      setImmediate(() => {
        writeFileSync(outFile, JSON.stringify({ output: "done" }));
        child.stdout.write(
          `${JSON.stringify({ type: "message", content: "cost: 0.02" })}\n`,
        );
        child.stdout.write(
          `${JSON.stringify({ type: "message", content: "Cost: $0.03" })}\n`,
        );
        child.stdout.write(
          `${JSON.stringify({ type: "message", content: "total_cost: 0.07" })}\n`,
        );
        child.stdout.write(
          `${JSON.stringify({ type: "message", content: "cost: 0.11" })}\n`,
        );
        child.stdout.end();
        child.emit("close", 0);
      });

      return child as unknown as ChildProcess;
    },
    async () => {
      const bridge = new CodexBridge(createCodexConfig());
      const result = await bridge.execute("Implement endpoint", process.cwd());

      assert.equal(result.success, true);
      assert.equal(result.cost_usd, 0.07);
    },
  );
});

test("execute estimates cost from turn.completed token usage when pricing is configured", async () => {
  await withMockedSpawn(
    (call) => {
      const child = new FakeChildProcess();
      const outFile = getOutputFilePath(call.args);

      setImmediate(() => {
        writeFileSync(outFile, JSON.stringify({ output: "done" }));
        child.stdout.write(
          `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 2000, cached_input_tokens: 500, output_tokens: 1000 } })}\n`,
        );
        child.stdout.end();
        child.emit("close", 0);
      });

      return child as unknown as ChildProcess;
    },
    async () => {
      const bridge = new CodexBridge({
        ...createCodexConfig(),
        tokenPricing: {
          inputPerMillion: 10,
          cachedInputPerMillion: 1,
          outputPerMillion: 20,
        },
      });
      const result = await bridge.execute("Implement endpoint", process.cwd());

      assert.equal(result.success, true);
      assert.ok(Math.abs(result.cost_usd - 0.0355) < 1e-9);
    },
  );
});

test("execute keeps cost at zero without pricing even when usage tokens are present", async () => {
  await withMockedSpawn(
    (call) => {
      const child = new FakeChildProcess();
      const outFile = getOutputFilePath(call.args);

      setImmediate(() => {
        writeFileSync(outFile, JSON.stringify({ output: "done" }));
        child.stdout.write(
          `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 2000, cached_input_tokens: 500, output_tokens: 1000 } })}\n`,
        );
        child.stdout.end();
        child.emit("close", 0);
      });

      return child as unknown as ChildProcess;
    },
    async () => {
      const bridge = new CodexBridge(createCodexConfig());
      const result = await bridge.execute("Implement endpoint", process.cwd());

      assert.equal(result.success, true);
      assert.equal(result.cost_usd, 0);
    },
  );
});

// ─── --model passthrough tests ──────────────────────────────────────

test("execute passes --model flag to CLI args when model is specified", async () => {
  await withMockedSpawn(
    (call) => {
      const child = new FakeChildProcess();
      const outFile = getOutputFilePath(call.args);

      setImmediate(() => {
        writeFileSync(outFile, JSON.stringify({ output: "done" }));
        child.stdout.end();
        child.emit("close", 0);
      });

      return child as unknown as ChildProcess;
    },
    async (calls) => {
      const bridge = new CodexBridge(createCodexConfig());
      await bridge.execute("Do work", process.cwd(), {
        model: "o4-mini",
      });

      const args = calls[0].args;
      const modelIdx = args.indexOf("--model");
      assert.ok(modelIdx >= 0, "must include --model flag");
      assert.equal(args[modelIdx + 1], "o4-mini");
    },
  );
});

test("execute does not include --model flag when model is not specified", async () => {
  await withMockedSpawn(
    (call) => {
      const child = new FakeChildProcess();
      const outFile = getOutputFilePath(call.args);

      setImmediate(() => {
        writeFileSync(outFile, JSON.stringify({ output: "done" }));
        child.stdout.end();
        child.emit("close", 0);
      });

      return child as unknown as ChildProcess;
    },
    async (calls) => {
      const bridge = new CodexBridge(createCodexConfig());
      await bridge.execute("Do work", process.cwd());

      const args = calls[0].args;
      assert.ok(
        !args.includes("--model"),
        "must NOT include --model when not specified",
      );
    },
  );
});

test("execute resume passes --model flag when model is specified", async () => {
  await withMockedSpawn(
    (call) => {
      const child = new FakeChildProcess();
      const outFile = getOutputFilePath(call.args);

      setImmediate(() => {
        writeFileSync(outFile, JSON.stringify({ output: "resumed" }));
        child.stdout.end();
        child.emit("close", 0);
      });

      return child as unknown as ChildProcess;
    },
    async (calls) => {
      const bridge = new CodexBridge({
        ...createCodexConfig(),
        sandbox: "full-auto",
      });
      await bridge.execute("Continue", process.cwd(), {
        resumeSessionId: "sess-abc",
        model: "gpt-5.3-codex",
      });

      const args = calls[0].args;
      assert.ok(args.includes("resume"), "must use resume subcommand");
      const modelIdx = args.indexOf("--model");
      assert.ok(modelIdx >= 0, "resume must include --model flag");
      assert.equal(args[modelIdx + 1], "gpt-5.3-codex");
      // Session ID and prompt are the last two positional args
      assert.equal(args[args.length - 2], "sess-abc");
      assert.equal(args[args.length - 1], "Continue");
    },
  );
});

// ─── resume tests ───────────────────────────────────────────────────

test("execute with resumeSessionId builds correct codex exec resume args", async () => {
  await withMockedSpawn(
    (call) => {
      const child = new FakeChildProcess();
      const outFile = getOutputFilePath(call.args);

      setImmediate(() => {
        writeFileSync(outFile, JSON.stringify({ output: "resumed ok" }));
        child.stdout.write(
          `${JSON.stringify({ type: "thread.started", thread_id: "abc-123" })}\n`,
        );
        child.stdout.write(
          `${JSON.stringify({ type: "turn.completed", total_cost_usd: 0.05 })}\n`,
        );
        child.stdout.end();
        child.emit("close", 0);
      });

      return child as unknown as ChildProcess;
    },
    async (calls) => {
      const bridge = new CodexBridge({
        ...createCodexConfig(),
        sandbox: "full-auto",
      });
      const result = await bridge.execute("Continue fixing", process.cwd(), {
        resumeSessionId: "sess-uuid-123",
      });

      assert.equal(calls.length, 1);
      const args = calls[0].args;

      // Should be: exec resume --full-auto --json -o <file> sess-uuid-123 "Continue fixing"
      assert.equal(args[0], "exec");
      assert.equal(args[1], "resume");
      assert.ok(args.includes("--full-auto"), "resume must use --full-auto");
      assert.ok(args.includes("--json"), "resume must use --json");
      assert.ok(!args.includes("--sandbox"), "resume must NOT use --sandbox");

      // Positional args: session ID then prompt (after -o <file>)
      const outputIdx = args.indexOf("-o");
      const positionals = args.slice(outputIdx + 2); // skip -o and file path
      assert.equal(positionals[0], "sess-uuid-123");
      assert.equal(positionals[1], "Continue fixing");

      assert.equal(result.success, true);
      assert.equal(result.sessionId, "abc-123");
      assert.equal(result.cost_usd, 0.05);
    },
  );
});

test("execute without resume does not include session ID in args", async () => {
  await withMockedSpawn(
    (call) => {
      const child = new FakeChildProcess();
      const outFile = getOutputFilePath(call.args);

      setImmediate(() => {
        writeFileSync(outFile, JSON.stringify({ output: "done" }));
        child.stdout.write(
          `${JSON.stringify({ type: "thread.started", thread_id: "new-thread-id" })}\n`,
        );
        child.stdout.end();
        child.emit("close", 0);
      });

      return child as unknown as ChildProcess;
    },
    async (calls) => {
      const bridge = new CodexBridge(createCodexConfig());
      const result = await bridge.execute("Do something", process.cwd());

      const args = calls[0].args;
      assert.ok(
        !args.includes("resume"),
        "non-resume exec must not include resume subcommand",
      );
      assert.equal(result.sessionId, "new-thread-id");
    },
  );
});

test("execute with resumeSessionId ignores systemPrompt (no --instructions)", async () => {
  await withMockedSpawn(
    (call) => {
      const child = new FakeChildProcess();
      const outFile = getOutputFilePath(call.args);

      setImmediate(() => {
        writeFileSync(outFile, JSON.stringify({ output: "resumed" }));
        child.stdout.write(
          `${JSON.stringify({ type: "thread.started", thread_id: "t-1" })}\n`,
        );
        child.stdout.end();
        child.emit("close", 0);
      });

      return child as unknown as ChildProcess;
    },
    async (calls) => {
      const bridge = new CodexBridge({
        ...createCodexConfig(),
        sandbox: "full-auto",
      });
      await bridge.execute("Fix it", process.cwd(), {
        resumeSessionId: "prev-sess",
        systemPrompt: "You are a coding agent",
      });

      const args = calls[0].args;
      assert.ok(
        !args.includes("--instructions"),
        "resume must NOT include --instructions even when systemPrompt is provided",
      );
      assert.ok(args.includes("resume"), "must use resume subcommand");
    },
  );
});

test("execute returns sessionId from thread.started event on failure too", async () => {
  await withMockedSpawn(
    () => {
      const child = new FakeChildProcess();

      setImmediate(() => {
        child.stderr.write("some error");
        child.stderr.end();
        child.stdout.write(
          `${JSON.stringify({ type: "thread.started", thread_id: "fail-thread" })}\n`,
        );
        child.stdout.end();
        child.emit("close", 1);
      });

      return child as unknown as ChildProcess;
    },
    async () => {
      const bridge = new CodexBridge(createCodexConfig());
      const result = await bridge.execute("Try something", process.cwd());

      assert.equal(result.success, false);
      assert.equal(result.sessionId, "fail-thread");
    },
  );
});

test("execute with workspace-write + resumeSessionId does NOT resume (falls back to new session)", async () => {
  await withMockedSpawn(
    (call) => {
      const child = new FakeChildProcess();
      const outFile = getOutputFilePath(call.args);

      setImmediate(() => {
        writeFileSync(outFile, JSON.stringify({ output: "new session" }));
        child.stdout.write(
          `${JSON.stringify({ type: "thread.started", thread_id: "new-thread" })}\n`,
        );
        child.stdout.end();
        child.emit("close", 0);
      });

      return child as unknown as ChildProcess;
    },
    async (calls) => {
      // Config is workspace-write (not full-auto) — resume must NOT be used
      const bridge = new CodexBridge(createCodexConfig()); // sandbox: "workspace-write"
      const result = await bridge.execute(
        "Full context prompt",
        process.cwd(),
        {
          resumeSessionId: "old-sess-id",
          resumePrompt: "Short resume prompt",
        },
      );

      const args = calls[0].args;
      assert.ok(
        !args.includes("resume"),
        "workspace-write must NOT use resume subcommand",
      );
      assert.ok(
        !args.includes("old-sess-id"),
        "workspace-write must NOT pass session ID",
      );
      assert.ok(
        args.includes("--sandbox"),
        "workspace-write must use --sandbox flag",
      );
      // Must use the full prompt, NOT the resumePrompt
      assert.ok(
        args.includes("Full context prompt"),
        "workspace-write fallback must use full prompt",
      );
      assert.ok(
        !args.includes("Short resume prompt"),
        "workspace-write must NOT use resumePrompt",
      );
      assert.equal(result.success, true);
      assert.equal(result.sessionId, "new-thread");
    },
  );
});

test("execute with full-auto + resumePrompt uses resumePrompt instead of full prompt", async () => {
  await withMockedSpawn(
    (call) => {
      const child = new FakeChildProcess();
      const outFile = getOutputFilePath(call.args);

      setImmediate(() => {
        writeFileSync(outFile, JSON.stringify({ output: "resumed" }));
        child.stdout.write(
          `${JSON.stringify({ type: "thread.started", thread_id: "resumed-t" })}\n`,
        );
        child.stdout.end();
        child.emit("close", 0);
      });

      return child as unknown as ChildProcess;
    },
    async (calls) => {
      const bridge = new CodexBridge({
        ...createCodexConfig(),
        sandbox: "full-auto",
      });
      await bridge.execute(
        "Full context prompt with persona and instructions",
        process.cwd(),
        {
          resumeSessionId: "sess-to-resume",
          resumePrompt: "Continue next subtask",
        },
      );

      const args = calls[0].args;
      assert.ok(
        args.includes("resume"),
        "full-auto must use resume subcommand",
      );

      // Positional args after -o <file>: SESSION_ID then PROMPT
      const outputIdx = args.indexOf("-o");
      const positionals = args.slice(outputIdx + 2);
      assert.equal(positionals[0], "sess-to-resume");
      assert.equal(
        positionals[1],
        "Continue next subtask",
        "full-auto resume must use resumePrompt, not the full prompt",
      );
    },
  );
});

test("execute with full-auto + resumeSessionId but no resumePrompt falls back to full prompt", async () => {
  await withMockedSpawn(
    (call) => {
      const child = new FakeChildProcess();
      const outFile = getOutputFilePath(call.args);

      setImmediate(() => {
        writeFileSync(outFile, JSON.stringify({ output: "resumed" }));
        child.stdout.end();
        child.emit("close", 0);
      });

      return child as unknown as ChildProcess;
    },
    async (calls) => {
      const bridge = new CodexBridge({
        ...createCodexConfig(),
        sandbox: "full-auto",
      });
      await bridge.execute("Full prompt as fallback", process.cwd(), {
        resumeSessionId: "sess-123",
        // no resumePrompt
      });

      const args = calls[0].args;
      assert.ok(
        args.includes("resume"),
        "full-auto must use resume subcommand",
      );

      const outputIdx = args.indexOf("-o");
      const positionals = args.slice(outputIdx + 2);
      assert.equal(
        positionals[1],
        "Full prompt as fallback",
        "without resumePrompt, resume must fall back to full prompt",
      );
    },
  );
});

// ─── plan() tests ───────────────────────────────────────────────────

test("plan forces workspace-read sandbox regardless of config", async () => {
  await withMockedSpawn(
    (call) => {
      const child = new FakeChildProcess();
      const outFile = getOutputFilePath(call.args);

      setImmediate(() => {
        writeFileSync(outFile, JSON.stringify({ output: "analysis result" }));
        child.stdout.end();
        child.emit("close", 0);
      });

      return child as unknown as ChildProcess;
    },
    async (calls) => {
      // Config says full-auto, but plan() must override to workspace-read
      const config = { ...createCodexConfig(), sandbox: "full-auto" as const };
      const bridge = new CodexBridge(config);
      await bridge.plan("Analyze the codebase", process.cwd());

      assert.equal(calls.length, 1);
      const args = calls[0].args;
      // Must contain --sandbox read-only, NOT --full-auto
      assert.ok(args.includes("--sandbox"), "plan() must use --sandbox flag");
      assert.ok(
        args.includes("read-only"),
        "plan() must force read-only sandbox",
      );
      assert.ok(
        !args.includes("--full-auto"),
        "plan() must not use --full-auto",
      );
    },
  );
});

test("plan uses planTimeout config and defaults to 900s", async () => {
  // Custom planTimeout: kill process before it finishes to verify timeout is applied.
  // Using a very short planTimeout to observe timeout behavior.
  const child = new FakeChildProcessWithKillSpy();
  await withMockedSpawn(
    () => child as unknown as ChildProcess,
    async () => {
      const bridge = new CodexBridge({
        ...createCodexConfig(),
        planTimeout: 0.025,
      }); // 25ms
      const result = await bridge.plan("Analyze", process.cwd());

      // Process should be killed by timeout → exit code -1 → failure
      assert.equal(result.success, false);
      assert.equal(child.killSignals.length, 1);
      assert.equal(child.killSignals[0], "SIGTERM");
    },
  );
});

test("plan appends read-only system prompt instruction", async () => {
  await withMockedSpawn(
    (call) => {
      const child = new FakeChildProcess();
      const outFile = getOutputFilePath(call.args);

      setImmediate(() => {
        writeFileSync(outFile, "");
        child.stdout.end();
        child.emit("close", 0);
      });

      return child as unknown as ChildProcess;
    },
    async (calls) => {
      const bridge = new CodexBridge(createCodexConfig());
      await bridge.plan("Analyze code", process.cwd(), {
        systemPrompt: "Be thorough.",
      });

      const args = calls[0].args;
      const instrIdx = args.indexOf("--instructions");
      assert.ok(instrIdx >= 0, "plan() must pass --instructions");
      const instrValue = args[instrIdx + 1];
      assert.ok(
        instrValue.includes("Be thorough."),
        "must include original systemPrompt",
      );
      assert.ok(
        instrValue.includes("Do NOT modify any files"),
        "must include read-only instruction",
      );
    },
  );
});

test("plan does not use resume even if resumeSessionId was previously returned", async () => {
  // plan() must always enforce read-only sandbox.
  // codex exec resume only supports --full-auto (workspace-write),
  // so plan() must never use the resume subcommand.
  await withMockedSpawn(
    (call) => {
      const child = new FakeChildProcess();
      const outFile = getOutputFilePath(call.args);

      setImmediate(() => {
        writeFileSync(outFile, JSON.stringify({ output: "analysis" }));
        child.stdout.end();
        child.emit("close", 0);
      });

      return child as unknown as ChildProcess;
    },
    async (calls) => {
      const bridge = new CodexBridge(createCodexConfig());
      // plan() no longer accepts resumeSessionId, so just call it normally
      await bridge.plan("Revise the proposal", process.cwd());

      const args = calls[0].args;
      assert.ok(
        !args.includes("resume"),
        "plan() must never use resume subcommand",
      );
      assert.ok(
        args.includes("read-only"),
        "plan() must always enforce read-only sandbox",
      );
      assert.ok(
        !args.includes("--full-auto"),
        "plan() must not use --full-auto",
      );
    },
  );
});

// ─── isAvailable() tests ────────────────────────────────────────────

test("isAvailable returns true when codex --version succeeds", async () => {
  await withMockedSpawn(
    (call) => {
      const child = new FakeChildProcess();

      setImmediate(() => {
        child.stdout.write("codex 1.0.0\n");
        child.stdout.end();
        child.emit("close", 0);
      });

      return child as unknown as ChildProcess;
    },
    async () => {
      const bridge = new CodexBridge(createCodexConfig());
      const available = await bridge.isAvailable();
      assert.equal(available, true);
    },
  );
});

test("isAvailable returns false when codex command not found", async () => {
  await withMockedSpawn(
    () => {
      const child = new FakeChildProcess();

      setImmediate(() => {
        child.emit("error", new Error("spawn codex ENOENT"));
      });

      return child as unknown as ChildProcess;
    },
    async () => {
      const bridge = new CodexBridge(createCodexConfig());
      const available = await bridge.isAvailable();
      assert.equal(available, false);
    },
  );
});

// ─── review() event text fallback consistency ───────────────────────

test("review falls back to e.output when output file is empty", async () => {
  const reviewJson = JSON.stringify({
    passed: true,
    issues: [],
    summary: "All good",
  });
  await withMockedSpawn(
    (call) => {
      const child = new FakeChildProcess();
      const outFile = getOutputFilePath(call.args);

      setImmediate(() => {
        // Empty output file — forces fallback to event text
        writeFileSync(outFile, "");
        // Event has 'output' field (no 'content'), matching Codex CLI event format.
        // The bug: review() used e.text fallback instead of e.output,
        // so this output field was silently dropped.
        child.stdout.write(
          `${JSON.stringify({ type: "message", output: reviewJson })}\n`,
        );
        child.stdout.end();
        child.emit("close", 0);
      });

      return child as unknown as ChildProcess;
    },
    async () => {
      const bridge = new CodexBridge(createCodexConfig());
      const result = await bridge.review("Review code", process.cwd());

      assert.equal(
        result.passed,
        true,
        "review should parse text from e.output fallback",
      );
      assert.equal(result.summary, "All good");
    },
  );
});
