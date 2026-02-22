import assert from 'node:assert/strict';
import childProcess, { type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import type { CodexConfig } from '../config/types.js';
import { CodexBridge } from './CodexBridge.js';

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
    this.emit('close', null);
    return true;
  }
}

function createCodexConfig(): CodexConfig {
  return {
    model: 'gpt-5-codex',
    sandbox: 'workspace-write',
  };
}

async function withMockedSpawn(
  implementation: SpawnImplementation,
  run: (calls: SpawnCall[]) => Promise<void>,
): Promise<void> {
  const originalSpawn = childProcess.spawn;
  const calls: SpawnCall[] = [];

  childProcess.spawn = ((command: string, args: readonly string[] = [], options: SpawnOptions = {}) => {
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

test('execute runs codex with expected args and parses JSON output', async () => {
  await withMockedSpawn((call) => {
    const child = new FakeChildProcess();
    const outputArgIndex = call.args.indexOf('-o');
    assert.ok(outputArgIndex >= 0);

    const outFile = call.args[outputArgIndex + 1];
    assert.ok(outFile);

    setImmediate(() => {
      writeFileSync(outFile, JSON.stringify({ output: 'Implemented feature' }));
      child.stdout.write(`${JSON.stringify({ type: 'turn.completed', total_cost_usd: 0.42 })}\n`);
      child.stdout.end();
      child.emit('close', 0);
    });

    return child as unknown as ChildProcess;
  }, async (calls) => {
    const bridge = new CodexBridge(createCodexConfig());
    const result = await bridge.execute('Implement endpoint', process.cwd(), {
      systemPrompt: 'Return JSON only',
    });

    assert.equal(calls.length, 1);
    const call = calls[0];

    assert.equal(call.command, 'codex');
    assert.deepEqual(call.args.slice(0, 4), ['exec', '--sandbox', 'workspace-write', '--json']);

    const outputArgIndex = call.args.indexOf('-o');
    assert.ok(outputArgIndex >= 0);
    assert.match(call.args[outputArgIndex + 1] ?? '', /codex-\d+\.json$/);

    assert.equal(call.args[outputArgIndex + 2], '--instructions');
    assert.equal(call.args[outputArgIndex + 3], 'Return JSON only');
    assert.equal(call.args[call.args.length - 1], 'Implement endpoint');

    assert.equal(result.success, true);
    assert.equal(result.output, JSON.stringify({ output: 'Implemented feature' }));
    assert.equal(result.cost_usd, 0.42);
    assert.deepEqual(result.structured, { output: 'Implemented feature' });
    assert.ok(result.duration_ms >= 0);
  });
});
