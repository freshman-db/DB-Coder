import { query } from '@anthropic-ai/claude-agent-sdk';
import type { CodingAgent, AgentResult, ReviewResult } from './CodingAgent.js';
import type { ClaudeConfig } from '../config/types.js';
import type { McpDiscovery, Phase } from '../mcp/McpDiscovery.js';
import { buildCanUseTool, type QuestionHandler } from './MessageHandler.js';
import { log } from '../utils/logger.js';
import { tryParseReview } from '../utils/parse.js';

// Tools to remove from env to avoid nesting conflicts
const CLAUDE_ENV_VARS = [
  'CLAUDECODE', 'CLAUDE_CODE_SESSION', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_PACKAGE_DIR', 'CLAUDE_DEV_HOST', 'CLAUDE_DEV_PORT',
];

function cleanEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  for (const key of CLAUDE_ENV_VARS) {
    delete env[key];
  }
  return env;
}

export class ClaudeBridge implements CodingAgent {
  readonly name = 'claude';
  private questionHandler?: QuestionHandler;

  constructor(
    private config: ClaudeConfig,
    private mcpDiscovery?: McpDiscovery,
  ) {}

  /** Set the handler for auto-answering AskUserQuestion (called after Brain is constructed) */
  setQuestionHandler(handler: QuestionHandler): void {
    this.questionHandler = handler;
  }

  /** Get MCP server names available for a phase (for prompt building) */
  getMcpServerNames(phase: Phase): string[] {
    return this.mcpDiscovery?.getServerNames(phase) ?? [];
  }

  /** Get loaded plugin IDs (for agent guidance generation) */
  getLoadedPluginIds(): string[] {
    return this.mcpDiscovery?.getLoadedPluginIds() ?? [];
  }

  async execute(prompt: string, cwd: string, options?: {
    systemPrompt?: string;
    maxTurns?: number;
    maxBudget?: number;
    timeout?: number;
  }): Promise<AgentResult> {
    const start = Date.now();
    let result = '';
    let cost = 0;

    try {
      const mcpServers = this.mcpDiscovery?.getServersForPhase('execute') ?? {};
      const plugins = this.mcpDiscovery?.getPluginsForPhase('execute') ?? [];
      const canUseTool = this.questionHandler
        ? buildCanUseTool(this.questionHandler, prompt)
        : undefined;

      for await (const message of query({
        prompt,
        options: {
          cwd,
          permissionMode: 'bypassPermissions',
          systemPrompt: options?.systemPrompt,
          maxTurns: options?.maxTurns ?? this.config.maxTurns,
          model: this.config.model === 'opus' ? 'claude-opus-4-6' : 'claude-sonnet-4-6',
          env: { ...cleanEnv(), CLAUDE_MEM_MODEL: 'claude-opus-4-6' },
          ...(Object.keys(mcpServers).length > 0 && { mcpServers }),
          ...(plugins.length > 0 && { plugins }),
          ...(canUseTool && { canUseTool }),
        },
      })) {
        if (message.type === 'result') {
          cost = (message as any).total_cost_usd ?? 0;
          if ('result' in message) {
            result = (message as any).result;
          }
        }
      }

      return {
        success: true,
        output: result,
        cost_usd: cost,
        duration_ms: Date.now() - start,
      };
    } catch (err) {
      log.error('ClaudeBridge execute failed', err);
      return {
        success: false,
        output: String(err),
        cost_usd: cost,
        duration_ms: Date.now() - start,
      };
    }
  }

  async plan(prompt: string, cwd: string, options?: {
    systemPrompt?: string;
    maxTurns?: number;
  }): Promise<AgentResult> {
    const start = Date.now();
    let result = '';
    let cost = 0;

    try {
      const mcpServers = this.mcpDiscovery?.getServersForPhase('plan') ?? {};
      const plugins = this.mcpDiscovery?.getPluginsForPhase('plan') ?? [];
      for await (const message of query({
        prompt,
        options: {
          cwd,
          // Plan mode: read-only tools + Task for spawning analysis agents
          tools: ['Read', 'Glob', 'Grep', 'Bash', 'Task'],
          permissionMode: 'bypassPermissions',
          systemPrompt: options?.systemPrompt,
          maxTurns: options?.maxTurns ?? 20,
          model: this.config.model === 'opus' ? 'claude-opus-4-6' : 'claude-sonnet-4-6',
          env: cleanEnv(),
          ...(Object.keys(mcpServers).length > 0 && { mcpServers }),
          ...(plugins.length > 0 && { plugins }),
        },
      })) {
        if (message.type === 'result') {
          cost = (message as any).total_cost_usd ?? 0;
          if ('result' in message) {
            result = (message as any).result;
          }
        }
      }

      return {
        success: true,
        output: result,
        cost_usd: cost,
        duration_ms: Date.now() - start,
      };
    } catch (err) {
      log.error('ClaudeBridge plan failed', err);
      return {
        success: false,
        output: String(err),
        cost_usd: cost,
        duration_ms: Date.now() - start,
      };
    }
  }

  async review(prompt: string, cwd: string): Promise<ReviewResult> {
    const start = Date.now();
    let result = '';
    let cost = 0;

    try {
      const mcpServers = this.mcpDiscovery?.getServersForPhase('review') ?? {};
      const plugins = this.mcpDiscovery?.getPluginsForPhase('review') ?? [];
      const canUseTool = this.questionHandler
        ? buildCanUseTool(this.questionHandler, prompt)
        : undefined;

      for await (const message of query({
        prompt,
        options: {
          cwd,
          tools: ['Read', 'Glob', 'Grep', 'Bash', 'Task'],
          permissionMode: 'bypassPermissions',
          systemPrompt: `You are a senior code reviewer. Review the code changes carefully.
Focus on: architecture, design patterns, frontend quality, accessibility, UX.
Output your review as JSON: { "passed": boolean, "issues": [{ "severity": "critical"|"high"|"medium"|"low", "description": string, "file": string, "line": number, "suggestion": string }], "summary": string }`,
          maxTurns: 15,
          model: this.config.model === 'opus' ? 'claude-opus-4-6' : 'claude-sonnet-4-6',
          env: { ...cleanEnv(), CLAUDE_MEM_MODEL: 'claude-opus-4-6' },
          ...(Object.keys(mcpServers).length > 0 && { mcpServers }),
          ...(plugins.length > 0 && { plugins }),
          ...(canUseTool && { canUseTool }),
        },
      })) {
        if (message.type === 'result') {
          cost = (message as any).total_cost_usd ?? 0;
          if ('result' in message) {
            result = (message as any).result;
          }
        }
      }

      // Try to parse structured review output
      const parsed = tryParseReview(result);
      return {
        ...parsed,
        cost_usd: cost,
        issues: parsed.issues.map(i => ({ ...i, source: 'claude' as const })),
      };
    } catch (err) {
      log.error('ClaudeBridge review failed', err);
      return {
        passed: false,
        issues: [{ severity: 'critical', description: `Review failed: ${err}`, source: 'claude' }],
        summary: `Review error: ${err}`,
        cost_usd: cost,
      };
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Check if claude binary is accessible
      const { runProcess } = await import('../utils/process.js');
      const r = await runProcess('claude', ['--version'], { timeout: 5000 });
      return r.exitCode === 0;
    } catch {
      return false;
    }
  }
}
