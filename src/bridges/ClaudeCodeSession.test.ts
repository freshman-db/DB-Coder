import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeCodeSession, type QueryFn, type SessionOptions, type SessionResult, type StreamEvent } from './ClaudeCodeSession.js';
import type { SDKMessage, SDKResultSuccess, SDKResultError, SDKAssistantMessage, Query } from '@anthropic-ai/claude-agent-sdk';

// --- Mock helpers ---

function makeAssistantMessage(text: string, sessionId = 'sess-123'): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: {
      id: 'msg_001',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50 },
    } as any,
    parent_tool_use_id: null,
    uuid: '00000000-0000-0000-0000-000000000001' as `${string}-${string}-${string}-${string}-${string}`,
    session_id: sessionId,
  };
}

function makeSuccessResult(overrides: Partial<SDKResultSuccess> = {}): SDKResultSuccess {
  return {
    type: 'result',
    subtype: 'success',
    result: 'Task completed.',
    is_error: false,
    duration_ms: 5000,
    duration_api_ms: 4500,
    num_turns: 3,
    total_cost_usd: 0.05,
    stop_reason: 'end_turn',
    usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 100, cache_read_input_tokens: 500 },
    modelUsage: {},
    permission_denials: [],
    structured_output: undefined,
    uuid: '00000000-0000-0000-0000-000000000002' as `${string}-${string}-${string}-${string}-${string}`,
    session_id: 'sess-123',
    ...overrides,
  };
}

function makeErrorResult(errors: string[]): SDKResultError {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    duration_ms: 2000,
    duration_api_ms: 1800,
    num_turns: 1,
    total_cost_usd: 0.01,
    stop_reason: null,
    usage: { input_tokens: 200, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    errors,
    uuid: '00000000-0000-0000-0000-000000000003' as `${string}-${string}-${string}-${string}-${string}`,
    session_id: 'sess-err',
  };
}

/**
 * Creates a mock QueryFn that yields the given messages as an async generator.
 */
function createMockQuery(messages: SDKMessage[]): QueryFn {
  return ((_params: any) => {
    async function* gen() {
      for (const msg of messages) yield msg;
    }
    const g = gen();
    return Object.assign(g, {
      interrupt: async () => {},
      setPermissionMode: async () => {},
      setModel: async () => {},
      setMaxThinkingTokens: async () => {},
      close: () => {},
    });
  }) as unknown as QueryFn;
}

/**
 * Creates a mock QueryFn whose generator hangs until resolve() is called
 * or the AbortController fires. Simulates the real SDK behavior where
 * aborting causes the generator iteration to throw.
 */
function createHangingQuery(): { queryFn: QueryFn; resolve: () => void } {
  let resolveHang!: () => void;
  const hangPromise = new Promise<void>(r => { resolveHang = r; });
  const queryFn: QueryFn = ((_params: any) => {
    const ac: AbortController | undefined = _params?.options?.abortController;
    async function* gen() {
      // Race between hang and abort — simulates real SDK aborting on signal
      await new Promise<void>((resolve, reject) => {
        hangPromise.then(resolve);
        if (ac) {
          if (ac.signal.aborted) {
            reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
            return;
          }
          ac.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
          });
        }
      });
    }
    const g = gen();
    return Object.assign(g, {
      interrupt: async () => {},
      setPermissionMode: async () => {},
      setModel: async () => {},
      setMaxThinkingTokens: async () => {},
      close: () => {},
    });
  }) as unknown as QueryFn;
  return { queryFn, resolve: resolveHang };
}

/**
 * Creates a mock QueryFn that throws an error on iteration.
 */
function createThrowingQuery(error: Error): QueryFn {
  return ((_params: any) => {
    async function* gen() {
      throw error;
    }
    const g = gen();
    return Object.assign(g, {
      interrupt: async () => {},
      setPermissionMode: async () => {},
      setModel: async () => {},
      setMaxThinkingTokens: async () => {},
      close: () => {},
    });
  }) as unknown as QueryFn;
}

const baseOpts: SessionOptions = { permissionMode: 'bypassPermissions' };

// --- Tests ---

describe('ClaudeCodeSession', () => {
  describe('class API', () => {
    it('constructor accepts no arguments', () => {
      const session = new ClaudeCodeSession();
      assert.ok(session);
      assert.strictEqual(typeof session.run, 'function');
      assert.strictEqual(typeof session.kill, 'function');
    });

    it('constructor accepts sdkExtras and queryFn', () => {
      const mockQuery = createMockQuery([makeSuccessResult()]);
      const session = new ClaudeCodeSession({}, mockQuery);
      assert.ok(session);
    });

    it('exports SessionResult, StreamEvent, and QueryFn types', () => {
      // Type-level check: these imports should compile without error
      const _sr: SessionResult | undefined = undefined;
      const _se: StreamEvent | undefined = undefined;
      const _qf: QueryFn | undefined = undefined;
      assert.ok(true);
    });
  });

  describe('success path', () => {
    it('returns correct SessionResult on successful query', async () => {
      const messages: SDKMessage[] = [
        makeAssistantMessage('Analyzing...'),
        makeAssistantMessage('Done.'),
        makeSuccessResult(),
      ];
      const session = new ClaudeCodeSession({}, createMockQuery(messages));
      const result = await session.run('test prompt', baseOpts);

      assert.strictEqual(result.text, 'Task completed.');
      assert.strictEqual(result.costUsd, 0.05);
      assert.strictEqual(result.numTurns, 3);
      assert.strictEqual(result.sessionId, 'sess-123');
      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.isError, false);
      assert.deepStrictEqual(result.errors, []);
      assert.ok(result.durationMs >= 0);
    });

    it('uses accumulated text when result text is empty', async () => {
      const messages: SDKMessage[] = [
        makeAssistantMessage('Part 1 '),
        makeAssistantMessage('Part 2'),
        makeSuccessResult({ result: '' }),
      ];
      const session = new ClaudeCodeSession({}, createMockQuery(messages));
      const result = await session.run('test', baseOpts);

      assert.strictEqual(result.text, 'Part 1 Part 2');
    });

    it('extracts token usage', async () => {
      const session = new ClaudeCodeSession({}, createMockQuery([makeSuccessResult()]));
      const result = await session.run('test', baseOpts);

      assert.strictEqual(result.usage.inputTokens, 1000);
      assert.strictEqual(result.usage.outputTokens, 200);
      assert.strictEqual(result.usage.cacheCreationInputTokens, 100);
      assert.strictEqual(result.usage.cacheReadInputTokens, 500);
    });
  });

  describe('error path', () => {
    it('returns exitCode 1 and isError true on error result', async () => {
      const messages: SDKMessage[] = [
        makeAssistantMessage('Starting...'),
        makeErrorResult(['Max turns exceeded']),
      ];
      const session = new ClaudeCodeSession({}, createMockQuery(messages));
      const result = await session.run('test', baseOpts);

      assert.strictEqual(result.exitCode, 1);
      assert.strictEqual(result.isError, true);
      assert.deepStrictEqual(result.errors, ['Max turns exceeded']);
      assert.strictEqual(result.sessionId, 'sess-err');
    });

    it('returns exitCode 1 when query throws an error', async () => {
      const session = new ClaudeCodeSession({}, createThrowingQuery(new Error('Network failure')));
      const result = await session.run('test', baseOpts);

      assert.strictEqual(result.exitCode, 1);
      assert.strictEqual(result.isError, true);
      assert.ok(result.errors[0].includes('Network failure'));
    });
  });

  describe('timeout path', () => {
    it('returns exitCode -1 when timeout fires', async () => {
      const { queryFn } = createHangingQuery();
      const session = new ClaudeCodeSession({}, queryFn);
      const result = await session.run('test', {
        ...baseOpts,
        timeout: 50, // 50ms timeout
      });

      assert.strictEqual(result.exitCode, -1);
      assert.strictEqual(result.isError, true);
      assert.ok(
        result.errors.some(e => /time(?:d?\s*)?out/i.test(e)),
        `errors should mention timeout, got: ${JSON.stringify(result.errors)}`,
      );
    });
  });

  describe('manual kill path', () => {
    it('returns exitCode -2 when kill() is called', async () => {
      const { queryFn } = createHangingQuery();
      const session = new ClaudeCodeSession({}, queryFn);

      // Start the session, then kill after a short delay
      const resultPromise = session.run('test', {
        ...baseOpts,
        timeout: 5000, // long timeout so it won't fire
      });

      // Wait a tick, then kill
      await new Promise(r => setTimeout(r, 10));
      session.kill();

      const result = await resultPromise;

      assert.strictEqual(result.exitCode, -2, 'kill should set exitCode to -2');
      assert.strictEqual(result.isError, true);
      assert.ok(
        result.errors.some(e => e.includes('kill')),
        `errors should mention kill, got: ${JSON.stringify(result.errors)}`,
      );
    });

    it('kill() does not confuse with timeout', async () => {
      const { queryFn } = createHangingQuery();
      const session = new ClaudeCodeSession({}, queryFn);

      const resultPromise = session.run('test', {
        ...baseOpts,
        timeout: 5000,
      });

      await new Promise(r => setTimeout(r, 10));
      session.kill();

      const result = await resultPromise;

      // Must be -2 (kill), NOT -1 (timeout)
      assert.strictEqual(result.exitCode, -2);
      assert.ok(!result.errors.some(e => /timeout/i.test(e)));
    });
  });

  describe('onText callback', () => {
    it('invokes callback for each assistant text block', async () => {
      const texts: string[] = [];
      const messages: SDKMessage[] = [
        makeAssistantMessage('Hello'),
        makeAssistantMessage(' World'),
        makeSuccessResult(),
      ];
      const session = new ClaudeCodeSession({}, createMockQuery(messages));
      await session.run('test', {
        ...baseOpts,
        onText: (t) => texts.push(t),
      });

      assert.deepStrictEqual(texts, ['Hello', ' World']);
    });
  });

  describe('onEvent callback', () => {
    it('invokes callback for each SDKMessage', async () => {
      const eventTypes: string[] = [];
      const messages: SDKMessage[] = [
        makeAssistantMessage('Hi'),
        makeSuccessResult(),
      ];
      const session = new ClaudeCodeSession({}, createMockQuery(messages));
      await session.run('test', {
        ...baseOpts,
        onEvent: (e) => eventTypes.push(e.type),
      });

      assert.deepStrictEqual(eventTypes, ['assistant', 'result']);
    });
  });

  describe('structured output', () => {
    it('populates json field from structured_output', async () => {
      const messages: SDKMessage[] = [
        makeSuccessResult({ structured_output: { tasks: ['a', 'b'] } }),
      ];
      const session = new ClaudeCodeSession({}, createMockQuery(messages));
      const result = await session.run('test', baseOpts);

      assert.deepStrictEqual(result.json, { tasks: ['a', 'b'] });
    });
  });

  describe('sdkExtras injection', () => {
    it('passes sdkExtras through to buildSdkOptions', async () => {
      // This test verifies the constructor stores sdkExtras and uses it.
      // We verify indirectly by checking no errors occur.
      const messages: SDKMessage[] = [makeSuccessResult()];
      const session = new ClaudeCodeSession(
        { plugins: [{ type: 'local' as const, path: './test' }] },
        createMockQuery(messages),
      );
      const result = await session.run('test', baseOpts);
      assert.strictEqual(result.exitCode, 0);
    });
  });

  describe('sequential runs', () => {
    it('can run multiple prompts sequentially', async () => {
      const messages: SDKMessage[] = [makeSuccessResult()];
      const session = new ClaudeCodeSession({}, createMockQuery(messages));

      const r1 = await session.run('first', baseOpts);
      assert.strictEqual(r1.exitCode, 0);

      const r2 = await session.run('second', baseOpts);
      assert.strictEqual(r2.exitCode, 0);
    });
  });
});
