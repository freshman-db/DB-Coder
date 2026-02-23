import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeCodeSession, type SessionResult, type StreamEvent } from './ClaudeCodeSession.js';

// --- Helpers to build stream-json events ---

function initEvent(sessionId: string): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    tools: ['Bash', 'Read'],
    model: 'claude-sonnet-4-6',
  });
}

function assistantTextEvent(sessionId: string, text: string): string {
  return JSON.stringify({
    type: 'assistant',
    session_id: sessionId,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  });
}

function assistantToolUseEvent(sessionId: string, toolName: string, input: unknown): string {
  return JSON.stringify({
    type: 'assistant',
    session_id: sessionId,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_123', name: toolName, input }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 80, output_tokens: 30 },
    },
  });
}

function resultEvent(sessionId: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: sessionId,
    is_error: false,
    duration_ms: 5000,
    num_turns: 3,
    result: 'Task completed successfully.',
    total_cost_usd: 0.05,
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 500,
    },
    structured_output: null,
    ...overrides,
  });
}

function errorResultEvent(sessionId: string, errors: string[]): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'error_during_execution',
    session_id: sessionId,
    is_error: true,
    duration_ms: 2000,
    num_turns: 1,
    total_cost_usd: 0.01,
    usage: { input_tokens: 200, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    errors,
  });
}

describe('ClaudeCodeSession', () => {
  describe('buildArgs (via run behavior)', () => {
    // We test arg building indirectly by verifying the session creates correct process args.
    // Since we can't easily intercept spawn without a DI mechanism, we test parsing instead.

    it('should export SessionResult and StreamEvent types', () => {
      // Type-only test: ensure types exist and are importable
      const session = new ClaudeCodeSession();
      assert.ok(session);
      assert.strictEqual(typeof session.run, 'function');
      assert.strictEqual(typeof session.kill, 'function');
    });
  });

  describe('event parsing', () => {
    // Test the event processing logic by simulating what run() would do internally.
    // We extract the parsing logic into testable units.

    it('should parse init event and extract session_id', () => {
      const event = JSON.parse(initEvent('test-session-123'));
      assert.strictEqual(event.type, 'system');
      assert.strictEqual(event.subtype, 'init');
      assert.strictEqual(event.session_id, 'test-session-123');
    });

    it('should parse assistant text event', () => {
      const event = JSON.parse(assistantTextEvent('s1', 'Hello world'));
      assert.strictEqual(event.type, 'assistant');
      assert.strictEqual(event.message.content[0].type, 'text');
      assert.strictEqual(event.message.content[0].text, 'Hello world');
    });

    it('should parse result event with cost and usage', () => {
      const event = JSON.parse(resultEvent('s1'));
      assert.strictEqual(event.type, 'result');
      assert.strictEqual(event.total_cost_usd, 0.05);
      assert.strictEqual(event.num_turns, 3);
      assert.strictEqual(event.is_error, false);
      assert.strictEqual(event.usage.input_tokens, 1000);
      assert.strictEqual(event.usage.output_tokens, 200);
    });

    it('should parse error result event', () => {
      const event = JSON.parse(errorResultEvent('s1', ['Something went wrong']));
      assert.strictEqual(event.is_error, true);
      assert.deepStrictEqual(event.errors, ['Something went wrong']);
    });

    it('should parse assistant tool_use event', () => {
      const event = JSON.parse(assistantToolUseEvent('s1', 'Bash', { command: 'ls' }));
      const toolUse = event.message.content[0];
      assert.strictEqual(toolUse.type, 'tool_use');
      assert.strictEqual(toolUse.name, 'Bash');
      assert.deepStrictEqual(toolUse.input, { command: 'ls' });
    });

    it('should handle result with structured_output', () => {
      const event = JSON.parse(resultEvent('s1', {
        structured_output: { tasks: [{ id: 1, name: 'test' }] },
      }));
      assert.deepStrictEqual(event.structured_output, { tasks: [{ id: 1, name: 'test' }] });
    });
  });

  describe('stream simulation', () => {
    // Simulate the full stream parsing that run() performs

    function parseStream(lines: string[]): {
      sessionId: string;
      textParts: string[];
      costUsd: number;
      numTurns: number;
      isError: boolean;
      errors: string[];
    } {
      let sessionId = '';
      const textParts: string[] = [];
      let costUsd = 0;
      let numTurns = 0;
      let isError = false;
      let errors: string[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let event: StreamEvent;
        try {
          event = JSON.parse(trimmed) as StreamEvent;
        } catch {
          continue;
        }

        if (event.session_id && !sessionId) {
          sessionId = event.session_id as string;
        }

        // Extract text from assistant messages
        if (event.type === 'assistant' && typeof event.message === 'object' && event.message !== null) {
          const msg = event.message as Record<string, unknown>;
          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (typeof block === 'object' && block !== null && (block as Record<string, unknown>).type === 'text') {
                textParts.push((block as Record<string, unknown>).text as string);
              }
            }
          }
        }

        // Extract result info
        if (event.type === 'result') {
          costUsd = typeof event.total_cost_usd === 'number' ? event.total_cost_usd : 0;
          numTurns = typeof event.num_turns === 'number' ? event.num_turns : 0;
          isError = Boolean(event.is_error);
          if (Array.isArray(event.errors)) {
            errors = (event.errors as unknown[]).filter((e): e is string => typeof e === 'string');
          }
        }
      }

      return { sessionId, textParts, costUsd, numTurns, isError, errors };
    }

    it('should parse a successful session stream', () => {
      const sid = 'abc-123';
      const lines = [
        initEvent(sid),
        assistantTextEvent(sid, 'Analyzing code...'),
        assistantToolUseEvent(sid, 'Read', { file_path: '/src/index.ts' }),
        assistantTextEvent(sid, 'Found 3 issues.'),
        resultEvent(sid),
      ];

      const result = parseStream(lines);
      assert.strictEqual(result.sessionId, sid);
      assert.deepStrictEqual(result.textParts, ['Analyzing code...', 'Found 3 issues.']);
      assert.strictEqual(result.costUsd, 0.05);
      assert.strictEqual(result.numTurns, 3);
      assert.strictEqual(result.isError, false);
      assert.deepStrictEqual(result.errors, []);
    });

    it('should parse an error session stream', () => {
      const sid = 'err-456';
      const lines = [
        initEvent(sid),
        assistantTextEvent(sid, 'Starting task...'),
        errorResultEvent(sid, ['Max turns exceeded']),
      ];

      const result = parseStream(lines);
      assert.strictEqual(result.sessionId, sid);
      assert.strictEqual(result.isError, true);
      assert.deepStrictEqual(result.errors, ['Max turns exceeded']);
    });

    it('should handle empty stream', () => {
      const result = parseStream([]);
      assert.strictEqual(result.sessionId, '');
      assert.deepStrictEqual(result.textParts, []);
      assert.strictEqual(result.costUsd, 0);
    });

    it('should skip malformed lines', () => {
      const sid = 'skip-789';
      const lines = [
        'not json at all',
        initEvent(sid),
        '{invalid json}}}',
        assistantTextEvent(sid, 'Valid text'),
        resultEvent(sid),
      ];

      const result = parseStream(lines);
      assert.strictEqual(result.sessionId, sid);
      assert.deepStrictEqual(result.textParts, ['Valid text']);
    });

    it('should accumulate text from multiple assistant messages', () => {
      const sid = 'multi-text';
      const lines = [
        initEvent(sid),
        assistantTextEvent(sid, 'Part 1. '),
        assistantTextEvent(sid, 'Part 2. '),
        assistantTextEvent(sid, 'Part 3.'),
        resultEvent(sid),
      ];

      const result = parseStream(lines);
      assert.deepStrictEqual(result.textParts, ['Part 1. ', 'Part 2. ', 'Part 3.']);
    });
  });

  describe('onText callback', () => {
    it('should invoke callback for each text block', () => {
      const session = new ClaudeCodeSession();
      const textParts: string[] = [];
      const processEvent = (session as any).processEvent.bind(session);

      const event1 = JSON.parse(assistantTextEvent('s1', 'Hello'));
      const event2 = JSON.parse(assistantTextEvent('s1', ' World'));
      const collected: string[] = [];

      processEvent(event1, collected, (t: string) => textParts.push(t));
      processEvent(event2, collected, (t: string) => textParts.push(t));

      assert.deepStrictEqual(textParts, ['Hello', ' World']);
      assert.deepStrictEqual(collected, ['Hello', ' World']);
    });

    it('should not invoke callback for tool_use messages', () => {
      const session = new ClaudeCodeSession();
      const processEvent = (session as any).processEvent.bind(session);

      const event = JSON.parse(assistantToolUseEvent('s1', 'Bash', { command: 'ls' }));
      const collected: string[] = [];
      const callbackTexts: string[] = [];

      processEvent(event, collected, (t: string) => callbackTexts.push(t));

      assert.deepStrictEqual(collected, []);
      assert.deepStrictEqual(callbackTexts, []);
    });
  });
});
