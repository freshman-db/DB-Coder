import type { SDKMessage, SDKResultMessage, SDKAssistantMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SessionResult, TokenUsage } from './ClaudeCodeSession.js';

export interface CollectOptions {
  /** Callback invoked for each text block extracted from assistant messages */
  onText?: (text: string) => void;
  /** Callback invoked for every SDKMessage in the stream */
  onEvent?: (event: SDKMessage) => void;
}

export type CollectedResult = SessionResult;

/**
 * Iterates an AsyncGenerator<SDKMessage> from the Agent SDK query() API
 * and collects text + SessionResult.
 *
 * Pure function — no side effects beyond invoking the optional callbacks.
 */
export async function collectResult(
  stream: AsyncGenerator<SDKMessage, void>,
  opts?: CollectOptions,
): Promise<CollectedResult> {
  const textParts: string[] = [];
  let resultMsg: SDKResultMessage | null = null;
  let sessionId = '';

  for await (const message of stream) {
    opts?.onEvent?.(message);

    // Capture session_id from first message that has it
    if ('session_id' in message && message.session_id && !sessionId) {
      sessionId = message.session_id;
    }

    if (message.type === 'assistant') {
      const assistantMsg = message as SDKAssistantMessage;
      const content = assistantMsg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && 'text' in block) {
            textParts.push(block.text);
            opts?.onText?.(block.text);
          }
        }
      }
    }

    if (message.type === 'result') {
      resultMsg = message as SDKResultMessage;
    }
  }

  // No result message received — stream was empty or malformed
  if (!resultMsg) {
    return {
      text: textParts.join(''),
      costUsd: 0,
      sessionId,
      exitCode: 1,
      numTurns: 0,
      durationMs: 0,
      isError: true,
      errors: ['No result message received from SDK'],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    };
  }

  // Extract fields from the result message (success or error variants)
  const resultText = 'result' in resultMsg ? (resultMsg as any).result ?? '' : '';
  const structuredOutput = 'structured_output' in resultMsg ? (resultMsg as any).structured_output : undefined;
  const errors: string[] = 'errors' in resultMsg ? ((resultMsg as any).errors ?? []) : [];

  const usage: TokenUsage = {
    inputTokens: resultMsg.usage?.input_tokens ?? 0,
    outputTokens: resultMsg.usage?.output_tokens ?? 0,
    cacheCreationInputTokens: resultMsg.usage?.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: resultMsg.usage?.cache_read_input_tokens ?? 0,
  };

  // Map subtype to exitCode: success → 0, any error variant → 1
  const exitCode = resultMsg.subtype === 'success' ? 0 : 1;

  return {
    text: resultText || textParts.join(''),
    json: structuredOutput,
    costUsd: resultMsg.total_cost_usd ?? 0,
    sessionId: resultMsg.session_id ?? sessionId,
    exitCode,
    numTurns: resultMsg.num_turns ?? 0,
    durationMs: resultMsg.duration_ms ?? 0,
    isError: resultMsg.is_error ?? false,
    errors,
    usage,
  };
}
