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

  async execute(prompt: string, cwd: string, options?: {
    systemPrompt?: string;
    maxTurns?: number;
    maxBudget?: number;
    timeout?: number;
  }): Promise<AgentResult> {
    const start = Date.now();
    const outFile = join(tmpdir(), `codex-${Date.now()}.json`);

    try {
      const args = [
        'exec',
        '--full-auto',
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

      const cost = extractCost(events, this.config.tokenPricing);

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
    // Codex doesn't have a separate plan mode, so we use execute with read-only instructions
    return this.execute(
      prompt,
      cwd,
      {
        systemPrompt: (options?.systemPrompt ?? '') + '\nIMPORTANT: This is analysis only. Do NOT modify any files. Only read and analyze.',
        timeout: 300_000,
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

      const args = ['exec', '--full-auto', '--json', '-o', outFile, reviewPrompt];

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

      const cost = extractCost(events, this.config.tokenPricing);
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

interface TokenPricing {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
}

function extractCost(events: JsonlEvent[], pricing?: TokenPricing): number {
  // 1. Search for explicit cost fields in events
  for (const e of events) {
    if (typeof e.cost === 'number' && e.cost > 0) return e.cost;
    if (typeof e.total_cost === 'number' && e.total_cost > 0) return e.total_cost;
    if (typeof e.total_cost_usd === 'number' && e.total_cost_usd > 0) return e.total_cost_usd;
    if (typeof e.usage === 'object' && e.usage !== null) {
      const u = e.usage as Record<string, unknown>;
      if (typeof u.cost === 'number' && u.cost > 0) return u.cost;
      if (typeof u.total_cost === 'number' && u.total_cost > 0) return u.total_cost;
      if (typeof u.total_cost_usd === 'number' && u.total_cost_usd > 0) return u.total_cost_usd;
    }
  }

  // 2. Estimate from token usage in turn.completed events
  if (pricing) {
    let totalInput = 0, totalCached = 0, totalOutput = 0;
    for (const e of events) {
      if (e.type !== 'turn.completed' || typeof e.usage !== 'object' || !e.usage) continue;
      const u = e.usage as Record<string, unknown>;
      if (typeof u.input_tokens === 'number') totalInput += u.input_tokens;
      if (typeof u.cached_input_tokens === 'number') totalCached += u.cached_input_tokens;
      if (typeof u.output_tokens === 'number') totalOutput += u.output_tokens;
    }
    if (totalInput > 0 || totalOutput > 0) {
      const nonCachedInput = Math.max(0, totalInput - totalCached);
      return (nonCachedInput * pricing.inputPerMillion
        + totalCached * pricing.cachedInputPerMillion
        + totalOutput * pricing.outputPerMillion) / 1_000_000;
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
