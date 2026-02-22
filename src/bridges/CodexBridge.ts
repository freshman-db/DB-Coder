import type { CodingAgent, AgentResult, ReviewResult } from './CodingAgent.js';
import type { CodexConfig, TokenPricing } from '../config/types.js';
import { runProcess, spawnWithJsonl, type JsonlEvent } from '../utils/process.js';
import { log } from '../utils/logger.js';
import { tryParseReview } from '../utils/parse.js';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export class CodexBridge implements CodingAgent {
  readonly name = 'codex';

  constructor(private config: CodexConfig) {}

  /**
   * Map config sandbox value to the corresponding Codex CLI flags.
   *
   * `codex exec` expects `--sandbox <level>` (two args) or `--full-auto` (single flag).
   * Note: `sandboxOverride` is intentionally a CodexBridge-specific option
   * and not part of the CodingAgent interface — sandbox control is an
   * implementation detail that callers via the interface shouldn't need.
   */
  private sandboxArgs(overrideSandbox?: CodexConfig['sandbox']): string[] {
    const level = overrideSandbox ?? this.config.sandbox;
    switch (level) {
      case 'workspace-read':  return ['--sandbox', 'read-only'];
      case 'workspace-write': return ['--sandbox', 'workspace-write'];
      case 'full-auto':       return ['--full-auto'];
      default: {
        // Exhaustive check — TypeScript should catch this at compile time,
        // but log a warning for runtime safety (e.g. bad config values).
        const _exhaustive: never = level;
        log.warn('Unknown sandbox level, defaulting to workspace-write', { level });
        return ['--sandbox', 'workspace-write'];
      }
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
        ...this.sandboxArgs(options?.sandboxOverride),
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

      // Non-zero exit code means Codex CLI itself failed (bad flags, crash, etc.)
      if (exitCode !== 0) {
        log.warn('CodexBridge execute: non-zero exit code', { exitCode, stderr: stderr?.slice(0, 500) });
        return {
          success: false,
          output: stderr || `codex exec failed with exit code ${exitCode}`,
          cost_usd: extractCost(events),
          duration_ms: Date.now() - start,
        };
      }

      // Exit code 0 — check events for logical errors
      const hasEventError = events.some(e =>
        e.type === 'error' ||
        (e.type === 'function_call_output' && String(e.output ?? '').includes('Error')),
      );

      const cost = extractCost(events, this.config.tokenPricing);

      return {
        success: !hasEventError,
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
      const args = ['exec', ...this.sandboxArgs('workspace-read'), '--json', '-o', outFile, reviewPrompt];

      const { exitCode, events, stderr } = await spawnWithJsonl('codex', args, {
        cwd,
        timeout: 300_000,
      });

      // Non-zero exit code means the CLI invocation itself failed
      if (exitCode !== 0) {
        log.warn('CodexBridge review: non-zero exit code', { exitCode, stderr: stderr?.slice(0, 500) });
        return {
          passed: false,
          issues: [{ severity: 'critical', description: `codex exec failed (exit ${exitCode}): ${stderr?.slice(0, 300) ?? 'unknown error'}`, source: 'codex' }],
          summary: `Codex review failed with exit code ${exitCode}`,
          cost_usd: extractCost(events),
        };
      }

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

function extractCost(events: JsonlEvent[], pricing?: TokenPricing): number {
  // 1. Search for explicit cost fields in events, preferring total cost fields.
  let lastTotalCost = 0;
  let lastPartialCost = 0;

  for (const e of events) {
    const directTotal = firstPositiveNumber([e.total_cost_usd, e.total_cost]);
    if (directTotal !== null) {
      lastTotalCost = directTotal;
    }

    const directPartial = firstPositiveNumber([e.cost]);
    if (directPartial !== null) {
      lastPartialCost = directPartial;
    }

    if (typeof e.usage === 'object' && e.usage !== null) {
      const u = e.usage as Record<string, unknown>;
      const usageTotal = firstPositiveNumber([u.total_cost_usd, u.total_cost]);
      if (usageTotal !== null) {
        lastTotalCost = usageTotal;
      }

      const usagePartial = firstPositiveNumber([u.cost]);
      if (usagePartial !== null) {
        lastPartialCost = usagePartial;
      }
    }
  }

  if (lastTotalCost > 0) return lastTotalCost;
  if (lastPartialCost > 0) return lastPartialCost;

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

function firstPositiveNumber(values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return null;
}

function tryParseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}
