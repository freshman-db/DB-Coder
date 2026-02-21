import type { CodingAgent, AgentResult, ReviewResult, ReviewIssue } from './CodingAgent.js';
import type { CodexConfig } from '../config/types.js';
import { runProcess, spawnWithJsonl, type JsonlEvent } from '../utils/process.js';
import { log } from '../utils/logger.js';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export class CodexBridge implements CodingAgent {
  readonly name = 'codex';

  constructor(private config: CodexConfig) {}

  /** Map config sandbox value to the corresponding Codex CLI flag */
  private sandboxFlag(overrideSandbox?: CodexConfig['sandbox']): string {
    const level = overrideSandbox ?? this.config.sandbox;
    switch (level) {
      case 'workspace-read':  return '--read-only';
      case 'workspace-write': return '--workspace-write';
      case 'full-auto':       return '--full-auto';
      default:                return '--workspace-write'; // safe default
    }
  }

  async execute(prompt: string, cwd: string, options?: {
    systemPrompt?: string;
    maxTurns?: number;
    maxBudget?: number;
    timeout?: number;
    sandboxOverride?: CodexConfig['sandbox'];
  }): Promise<AgentResult> {
    const start = Date.now();
    const outFile = join(tmpdir(), `codex-${Date.now()}.json`);

    try {
      const args = [
        'exec',
        this.sandboxFlag(options?.sandboxOverride),
        '--json',
        '-o', outFile,
      ];

      if (options?.systemPrompt) {
        args.push('--instructions', options.systemPrompt);
      }

      args.push(prompt);

      const { exitCode, events, stderr } = await spawnWithJsonl('codex', args, {
        cwd,
        timeout: options?.timeout ?? 600_000,
        onEvent: (event) => {
          if (event.type === 'message' || event.type === 'function_call') {
            log.debug(`Codex: ${event.type}`, event);
          }
        },
      });

      // Read output file for final result
      let output = '';
      try {
        output = readFileSync(outFile, 'utf-8');
        unlinkSync(outFile);
      } catch (err) {
        log.debug('CodexBridge execute output file read failed', {
          error: err,
          inputPreview: prompt.slice(0, 200),
        });
      }

      // Parse result - codex exit code is always 0, check events
      const success = !events.some(e =>
        e.type === 'error' ||
        (e.type === 'function_call_output' && String(e.output ?? '').includes('Error')),
      );

      const cost = extractCost(events);

      return {
        success,
        output: output || events.map(e => String(e.content ?? e.output ?? '')).join('\n'),
        cost_usd: cost,
        duration_ms: Date.now() - start,
        structured: output ? tryParseJson(output) : undefined,
      };
    } catch (err) {
      log.error('CodexBridge execute failed', err);
      return {
        success: false,
        output: String(err),
        cost_usd: 0,
        duration_ms: Date.now() - start,
      };
    }
  }

  async plan(prompt: string, cwd: string, options?: {
    systemPrompt?: string;
    maxTurns?: number;
  }): Promise<AgentResult> {
    // Codex doesn't have a separate plan mode — enforce read-only sandbox
    // regardless of config so plan never mutates the workspace.
    return this.execute(
      prompt,
      cwd,
      {
        systemPrompt: (options?.systemPrompt ?? '') + '\nIMPORTANT: This is analysis only. Do NOT modify any files. Only read and analyze.',
        timeout: 300_000,
        sandboxOverride: 'workspace-read',
      },
    );
  }

  async review(prompt: string, cwd: string): Promise<ReviewResult> {
    const start = Date.now();
    const outFile = join(tmpdir(), `codex-review-${Date.now()}.json`);

    try {
      const reviewPrompt = `Review the uncommitted code changes in this repository.
Focus on: logic errors, security vulnerabilities, test coverage, performance issues.
Output your review as JSON: { "passed": boolean, "issues": [{ "severity": "critical"|"high"|"medium"|"low", "description": string, "file": string, "line": number, "suggestion": string }], "summary": string }

${prompt}`;

      // Reviews are read-only — enforce workspace-read regardless of config
      const args = ['exec', this.sandboxFlag('workspace-read'), '--json', '-o', outFile, reviewPrompt];

      const { events } = await spawnWithJsonl('codex', args, {
        cwd,
        timeout: 300_000,
      });

      let output = '';
      try {
        output = readFileSync(outFile, 'utf-8');
        unlinkSync(outFile);
      } catch (err) {
        log.debug('CodexBridge review output file read failed', {
          error: err,
          inputPreview: reviewPrompt.slice(0, 200),
        });
      }

      const cost = extractCost(events);
      const parsed = tryParseReview(output || events.map(e => String(e.content ?? '')).join('\n'));

      return {
        ...parsed,
        cost_usd: cost,
        issues: parsed.issues.map(i => ({ ...i, source: 'codex' as const })),
      };
    } catch (err) {
      log.error('CodexBridge review failed', err);
      return {
        passed: false,
        issues: [{ severity: 'critical', description: `Review failed: ${err}`, source: 'codex' }],
        summary: `Review error: ${err}`,
        cost_usd: 0,
      };
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const r = await runProcess('codex', ['--version'], { timeout: 5000 });
      return r.exitCode === 0;
    } catch {
      return false;
    }
  }
}

function extractCost(events: JsonlEvent[]): number {
  // Try to find cost info in events
  for (const e of events) {
    if (typeof e.cost === 'number') return e.cost;
    if (typeof e.usage === 'object' && e.usage !== null) {
      const u = e.usage as { total_cost?: number };
      if (typeof u.total_cost === 'number') return u.total_cost;
    }
  }
  return 0;
}

function tryParseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

function tryParseReview(output: string): Omit<ReviewResult, 'cost_usd'> {
  const jsonMatch = output.match(/\{[\s\S]*"passed"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        passed: Boolean(parsed.passed),
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
        summary: parsed.summary ?? '',
      };
    } catch (err) {
      log.debug('CodexBridge tryParseReview JSON parse failed', {
        error: err,
        inputPreview: output.slice(0, 200),
      });
    }
  }
  const hasIssues = /critical|error|bug|vulnerability|security/i.test(output);
  return {
    passed: !hasIssues,
    issues: [],
    summary: output.slice(0, 500),
  };
}
