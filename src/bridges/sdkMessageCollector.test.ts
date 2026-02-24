import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectResult } from './sdkMessageCollector.js';
import type { SDKMessage, SDKResultSuccess, SDKResultError, SDKAssistantMessage } from '@anthropic-ai/claude-agent-sdk';

// Helper: create a fake SDKResultSuccess
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
    uuid: '00000000-0000-0000-0000-000000000001' as `${string}-${string}-${string}-${string}-${string}`,
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
    uuid: '00000000-0000-0000-0000-000000000002' as `${string}-${string}-${string}-${string}-${string}`,
    session_id: 'sess-456',
  };
}

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
    uuid: '00000000-0000-0000-0000-000000000003' as `${string}-${string}-${string}-${string}-${string}`,
    session_id: sessionId,
  };
}

async function* toAsyncGen(messages: SDKMessage[]): AsyncGenerator<SDKMessage> {
  for (const msg of messages) yield msg;
}

describe('collectResult', () => {
  it('collects text from assistant messages + result', async () => {
    const messages: SDKMessage[] = [
      makeAssistantMessage('Hello '),
      makeAssistantMessage('World'),
      makeSuccessResult(),
    ];
    const result = await collectResult(toAsyncGen(messages));
    assert.strictEqual(result.text, 'Task completed.');
    assert.strictEqual(result.costUsd, 0.05);
    assert.strictEqual(result.numTurns, 3);
    assert.strictEqual(result.sessionId, 'sess-123');
    assert.strictEqual(result.isError, false);
    assert.deepStrictEqual(result.errors, []);
  });

  it('uses accumulated text when result text is empty', async () => {
    const messages: SDKMessage[] = [
      makeAssistantMessage('Analyzing...'),
      makeAssistantMessage(' Done.'),
      makeSuccessResult({ result: '' }),
    ];
    const result = await collectResult(toAsyncGen(messages));
    assert.strictEqual(result.text, 'Analyzing... Done.');
  });

  it('handles error result', async () => {
    const messages: SDKMessage[] = [
      makeAssistantMessage('Starting...'),
      makeErrorResult(['Max turns exceeded']),
    ];
    const result = await collectResult(toAsyncGen(messages));
    assert.strictEqual(result.isError, true);
    assert.deepStrictEqual(result.errors, ['Max turns exceeded']);
    assert.strictEqual(result.sessionId, 'sess-456');
  });

  it('maps exitCode from subtype', async () => {
    const success = await collectResult(toAsyncGen([makeSuccessResult()]));
    assert.strictEqual(success.exitCode, 0);

    const error = await collectResult(toAsyncGen([makeErrorResult(['err'])]));
    assert.strictEqual(error.exitCode, 1);
  });

  it('invokes onText callback for each text block', async () => {
    const texts: string[] = [];
    const messages: SDKMessage[] = [
      makeAssistantMessage('Part 1'),
      makeAssistantMessage('Part 2'),
      makeSuccessResult(),
    ];
    await collectResult(toAsyncGen(messages), {
      onText: (t) => texts.push(t),
    });
    assert.deepStrictEqual(texts, ['Part 1', 'Part 2']);
  });

  it('invokes onEvent callback for each message', async () => {
    const events: string[] = [];
    const messages: SDKMessage[] = [
      makeAssistantMessage('Hi'),
      makeSuccessResult(),
    ];
    await collectResult(toAsyncGen(messages), {
      onEvent: (e) => events.push(e.type),
    });
    assert.deepStrictEqual(events, ['assistant', 'result']);
  });

  it('extracts structured_output', async () => {
    const messages: SDKMessage[] = [
      makeSuccessResult({ structured_output: { tasks: ['a', 'b'] } }),
    ];
    const result = await collectResult(toAsyncGen(messages));
    assert.deepStrictEqual(result.json, { tasks: ['a', 'b'] });
  });

  it('extracts usage tokens', async () => {
    const messages: SDKMessage[] = [makeSuccessResult()];
    const result = await collectResult(toAsyncGen(messages));
    assert.strictEqual(result.usage.inputTokens, 1000);
    assert.strictEqual(result.usage.outputTokens, 200);
    assert.strictEqual(result.usage.cacheCreationInputTokens, 100);
    assert.strictEqual(result.usage.cacheReadInputTokens, 500);
  });

  it('handles empty stream gracefully', async () => {
    const result = await collectResult(toAsyncGen([]));
    assert.strictEqual(result.text, '');
    assert.strictEqual(result.costUsd, 0);
    assert.strictEqual(result.isError, true);
    assert.ok(result.errors[0].includes('No result'));
  });
});
