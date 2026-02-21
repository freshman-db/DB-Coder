import { query } from '@anthropic-ai/claude-agent-sdk';
import type { CodingAgent, AgentResult, ReviewResult, ReviewIssue } from './CodingAgent.js';
import type { ClaudeConfig } from '../config/types.js';
import { log } from '../utils/logger.js';

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

  constructor(private config: ClaudeConfig) {}

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
      for await (const message of query({
        prompt,
        options: {
          cwd,
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          permissionMode: 'bypassPermissions',
          systemPrompt: options?.systemPrompt,
          maxTurns: options?.maxTurns ?? this.config.maxTurns,
          model: this.config.model === 'opus' ? 'claude-opus-4-6' : 'claude-sonnet-4-6',
          env: cleanEnv(),
        },
      })) {
        if ('result' in message) {
          result = message.result as string;
        }
        if ('costUSD' in message) {
          cost = (message as { costUSD: number }).costUSD;
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
      for await (const message of query({
        prompt,
        options: {
          cwd,
          // Plan mode: read-only tools only
          allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
          permissionMode: 'bypassPermissions',
          systemPrompt: options?.systemPrompt,
          maxTurns: options?.maxTurns ?? 20,
          model: this.config.model === 'opus' ? 'claude-opus-4-6' : 'claude-sonnet-4-6',
          env: cleanEnv(),
        },
      })) {
        if ('result' in message) {
          result = message.result as string;
        }
        if ('costUSD' in message) {
          cost = (message as { costUSD: number }).costUSD;
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
      for await (const message of query({
        prompt,
        options: {
          cwd,
          allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
          permissionMode: 'bypassPermissions',
          systemPrompt: `You are a senior code reviewer. Review the code changes carefully.
Focus on: architecture, design patterns, frontend quality, accessibility, UX.
Output your review as JSON: { "passed": boolean, "issues": [{ "severity": "critical"|"high"|"medium"|"low", "description": string, "file": string, "line": number, "suggestion": string }], "summary": string }`,
          maxTurns: 15,
          model: this.config.model === 'opus' ? 'claude-opus-4-6' : 'claude-sonnet-4-6',
          env: cleanEnv(),
        },
      })) {
        if ('result' in message) {
          result = message.result as string;
        }
        if ('costUSD' in message) {
          cost = (message as { costUSD: number }).costUSD;
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

function tryParseReview(output: string): Omit<ReviewResult, 'cost_usd'> {
  // Try to find JSON in the output
  const jsonMatch = output.match(/\{[\s\S]*"passed"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        passed: Boolean(parsed.passed),
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
        summary: parsed.summary ?? '',
      };
    } catch { /* fall through */ }
  }
  // Fallback: treat as text review
  const hasIssues = /critical|error|bug|vulnerability|security/i.test(output);
  return {
    passed: !hasIssues,
    issues: [],
    summary: output.slice(0, 500),
  };
}
