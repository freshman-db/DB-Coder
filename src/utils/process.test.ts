import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseJsonlEvents,
  runProcess,
  spawnWithJsonl,
  type JsonlEvent,
} from "./process.js";

describe("runProcess", () => {
  it("returns stdout and exitCode for a successful process", async () => {
    const result = await runProcess(process.execPath, [
      "-e",
      "const fs=require('node:fs');fs.writeSync(1,'hello\\n');",
    ]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /hello/);
  });

  it("rejects when spawning a missing command", async () => {
    await assert.rejects(
      runProcess("db-coder-definitely-missing-command", []),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        return /ENOENT|not found|spawn/i.test(error.message);
      },
    );
  });

  it("kills long-running process when timeout is reached", async () => {
    const result = await runProcess(
      process.execPath,
      ["-e", "setTimeout(() => {}, 10_000);"],
      { timeout: 100 },
    );

    assert.equal(result.exitCode, -1);
    assert.match(result.stderr, /\[TIMEOUT\]/);
  });

  it("writes input to stdin", async () => {
    const result = await runProcess(
      process.execPath,
      [
        "-e",
        "const fs=require('node:fs');const input=fs.readFileSync(0,'utf8');fs.writeSync(1,input);",
      ],
      { input: "test" },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "test");
  });
});

describe("parseJsonlEvents", () => {
  it("parses valid JSONL content", () => {
    const output = '{"type":"start","step":1}\n{"type":"finish","step":2}\n';

    const events = parseJsonlEvents(output);

    assert.deepEqual(events, [
      { type: "start", step: 1 },
      { type: "finish", step: 2 },
    ]);
  });

  it("skips invalid lines and keeps valid JSON lines", () => {
    const output =
      '{"type":"start","id":1}\nnot-json\n{"type":"finish","id":2}\n{"bad"\n';

    const events = parseJsonlEvents(output);

    assert.deepEqual(events, [
      { type: "start", id: 1 },
      { type: "finish", id: 2 },
    ]);
  });

  it("returns an empty array for empty output", () => {
    assert.deepEqual(parseJsonlEvents(""), []);
  });
});

describe("spawnWithJsonl", () => {
  it("collects JSONL events and invokes onEvent for each event", async () => {
    const callbackEvents: JsonlEvent[] = [];
    const script = [
      "const fs=require('node:fs');",
      "fs.writeSync(1, JSON.stringify({ type: 'start', index: 1 }) + '\\n');",
      "fs.writeSync(1, JSON.stringify({ type: 'finish', index: 2 }) + '\\n');",
    ].join("");

    const result = await spawnWithJsonl(process.execPath, ["-e", script], {
      onEvent: (event) => {
        callbackEvents.push(event);
      },
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.events, [
      { type: "start", index: 1 },
      { type: "finish", index: 2 },
    ]);
    assert.deepEqual(callbackEvents, result.events);
  });

  it("flushes remaining buffer when final line lacks trailing newline", async () => {
    const callbackEvents: JsonlEvent[] = [];
    const script = [
      "const fs=require('node:fs');",
      "fs.writeSync(1, JSON.stringify({ type: 'start', index: 1 }) + '\\n');",
      "fs.writeSync(1, JSON.stringify({ type: 'finish', index: 2 }));",
    ].join("");

    const result = await spawnWithJsonl(process.execPath, ["-e", script], {
      onEvent: (event) => {
        callbackEvents.push(event);
      },
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.events, [
      { type: "start", index: 1 },
      { type: "finish", index: 2 },
    ]);
    assert.deepEqual(callbackEvents, result.events);
  });
});
