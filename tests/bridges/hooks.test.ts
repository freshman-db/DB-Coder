import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildHooks, type HookCallbacks, type HookRegistry, type ToolStat } from '../../src/bridges/hooks.js';
import type { PreToolUseHookInput, PostToolUseHookInput, SessionEndHookInput, StopHookInput } from '@anthropic-ai/claude-agent-sdk';

describe('buildHooks', () => {
  it('returns empty object when no callbacks provided', () => {
    const hooks = buildHooks();
    assert.deepStrictEqual(hooks, {});
  });

  it('returns empty object when undefined passed', () => {
    const hooks = buildHooks(undefined);
    assert.deepStrictEqual(hooks, {});
  });

  it('registers PreToolUse hook when onToolUse provided', () => {
    const hooks = buildHooks({
      onToolUse: () => {},
    });
    assert.ok(hooks.PreToolUse);
    assert.strictEqual(hooks.PreToolUse!.length, 1);
    assert.strictEqual(hooks.PreToolUse![0].hooks.length, 1);
  });

  it('registers PostToolUse hook when onToolResult provided', () => {
    const calls: Array<{ name: string; input: unknown; response: unknown }> = [];
    const hooks = buildHooks({
      onToolResult: (name, input, response) => { calls.push({ name, input, response }); },
    });
    assert.ok(hooks.PostToolUse);
    assert.strictEqual(hooks.PostToolUse!.length, 1);
    assert.strictEqual(hooks.PostToolUse![0].hooks.length, 1);
  });

  it('registers Stop hook when onStop provided', () => {
    const hooks = buildHooks({
      onStop: () => {},
    });
    assert.ok(hooks.Stop);
    assert.strictEqual(hooks.Stop!.length, 1);
  });

  it('registers SessionEnd hook when onSessionEnd provided', () => {
    const hooks = buildHooks({
      onSessionEnd: () => {},
    });
    assert.ok(hooks.SessionEnd);
    assert.strictEqual(hooks.SessionEnd!.length, 1);
  });

  it('registers all hooks when all callbacks provided', () => {
    const hooks = buildHooks({
      onToolUse: () => {},
      onToolResult: () => {},
      onStop: () => {},
      onSessionEnd: () => {},
    });
    assert.ok(hooks.PreToolUse);
    assert.ok(hooks.PostToolUse);
    assert.ok(hooks.Stop);
    assert.ok(hooks.SessionEnd);
  });

  it('only registers hooks for provided callbacks', () => {
    const hooks = buildHooks({
      onToolUse: () => {},
    });
    assert.ok(hooks.PreToolUse);
    assert.strictEqual(hooks.PostToolUse, undefined);
    assert.strictEqual(hooks.Stop, undefined);
    assert.strictEqual(hooks.SessionEnd, undefined);
  });
});

describe('hook callback invocations', () => {
  const fakeBase = { session_id: 'test-session', transcript_path: '/tmp/transcript', cwd: '/tmp' };

  it('PreToolUse hook calls onToolUse with correct args', async () => {
    const calls: Array<{ name: string; input: unknown }> = [];
    const hooks = buildHooks({
      onToolUse: (name, input) => { calls.push({ name, input }); },
    });
    const hookFn = hooks.PreToolUse![0].hooks[0];
    const input: PreToolUseHookInput = {
      ...fakeBase,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_use_id: 'tu-1',
    };
    const result = await hookFn(input, 'tu-1', { signal: AbortSignal.abort() });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].name, 'Bash');
    assert.deepStrictEqual(calls[0].input, { command: 'ls' });
    assert.deepStrictEqual(result, {});
  });

  it('PostToolUse hook calls onToolResult with correct args', async () => {
    const calls: Array<{ name: string; input: unknown; response: unknown }> = [];
    const hooks = buildHooks({
      onToolResult: (name, input, response) => { calls.push({ name, input, response }); },
    });
    const hookFn = hooks.PostToolUse![0].hooks[0];
    const input: PostToolUseHookInput = {
      ...fakeBase,
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/test' },
      tool_response: 'file contents',
      tool_use_id: 'tu-2',
    };
    const result = await hookFn(input, 'tu-2', { signal: AbortSignal.abort() });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].name, 'Read');
    assert.deepStrictEqual(calls[0].input, { file_path: '/tmp/test' });
    assert.strictEqual(calls[0].response, 'file contents');
    assert.deepStrictEqual(result, {});
  });

  it('Stop hook calls onStop', async () => {
    let called = false;
    const hooks = buildHooks({
      onStop: () => { called = true; },
    });
    const hookFn = hooks.Stop![0].hooks[0];
    const input: StopHookInput = {
      ...fakeBase,
      hook_event_name: 'Stop',
      stop_hook_active: true,
    };
    const result = await hookFn(input, undefined, { signal: AbortSignal.abort() });
    assert.ok(called);
    assert.deepStrictEqual(result, {});
  });

  it('SessionEnd hook calls onSessionEnd with reason', async () => {
    let capturedReason = '';
    const hooks = buildHooks({
      onSessionEnd: (reason) => { capturedReason = reason; },
    });
    const hookFn = hooks.SessionEnd![0].hooks[0];
    const input: SessionEndHookInput = {
      ...fakeBase,
      hook_event_name: 'SessionEnd',
      reason: 'other',
    };
    const result = await hookFn(input, undefined, { signal: AbortSignal.abort() });
    assert.strictEqual(capturedReason, 'other');
    assert.deepStrictEqual(result, {});
  });
});

describe('ToolStat type', () => {
  it('exports ToolStat type correctly', () => {
    const stat: ToolStat = { name: 'Bash', callCount: 5, totalDurationMs: 1200, errorCount: 1 };
    assert.strictEqual(stat.name, 'Bash');
    assert.strictEqual(stat.callCount, 5);
    assert.strictEqual(stat.totalDurationMs, 1200);
    assert.strictEqual(stat.errorCount, 1);
  });
});

describe('HookRegistry type', () => {
  it('accepts return value from buildHooks', () => {
    const registry: HookRegistry = buildHooks({ onStop: () => {} });
    assert.ok(registry.Stop);
  });
});
