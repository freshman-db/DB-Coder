import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

type SDKResultMessage = Extract<SDKMessage, { type: 'result' }>;

export interface AgentResultMessage extends Omit<SDKResultMessage, 'total_cost_usd' | 'result'> {
  total_cost_usd?: number;
  result?: string;
}

export type AgentSystemPrompt = NonNullable<Options['systemPrompt']>;
