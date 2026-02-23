import type { CodingAgent, AgentResult, ReviewResult } from './CodingAgent.js';
import type { CodexConfig, TokenPricing } from '../config/types.js';
import { runProcess, spawnWithJsonl, type JsonlEvent } from '../utils/process.js';
import { log } from '../utils/logger.js';
import { tryParseJson, tryParseReview } from '../utils/parse.js';
import { readFileSync, unlinkSync } from 'node:fs';
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

  private async invokeCodex(
    args: string[],
    cwd: string,
    opts?: {
      timeout?: number;
      onEvent?: (event: JsonlEvent) => void;
      outFilePrefix?: string;
    },
  ): Promise<{
    output: string;
    events: JsonlEvent[];
    exitCode: number;
    stderr: string;
  }> {
    const outFile = join(tmpdir(), `${opts?.outFilePrefix ?? 'codex'}-${Date.now()}.json`);
    const jsonFlagIndex = args.indexOf('--json');
    const invokeArgs = jsonFlagIndex >= 0
      ? [...args.slice(0, jsonFlagIndex + 1), '-o', outFile, ...args.slice(jsonFlagIndex + 1)]
      : [...args, '-o', outFile];

    const { exitCode, events, stderr } = await spawnWithJsonl('codex', invokeArgs, {
      cwd,
      ...(opts?.timeout && { timeout: opts.timeout }),
      ...(opts?.onEvent && { onEvent: opts.onEvent }),
    });

    if (exitCode !== 0) {
      log.warn('CodexBridge invokeCodex: non-zero exit code', { exitCode, stderr: stderr?.slice(0, 500) });
    }

    let output = '';
    try {
      output = readFileSync(outFile, 'utf-8');
      unlinkSync(outFile);
    } catch (err) {
      log.debug('CodexBridge invokeCodex output file read failed', {
        error: err,
        inputPreview: String(args.at(-1) ?? '').slice(0, 200),
      });
    }

    return { output, events, exitCode, stderr };
  }

  async execute(prompt: string, cwd: string, options?: {
    systemPrompt?: string;
    maxTurns?: number;
    maxBudget?: number;
    timeout?: number;
    sandboxOverride?: CodexConfig['sandbox'];
  }): Promise<AgentResult> {
    const start = Date.now();

    try {
      const args = [
        'exec',
        ...this.sandboxArgs(options?.sandboxOverride),
        '--json',
      ];

      if (options?.systemPrompt) {
        args.push('--instructions', options.systemPrompt);
      }

      args.push(prompt);

      const { output, exitCode, events, stderr } = await this.invokeCodex(args, cwd, {
        timeout: options?.timeout,
        outFilePrefix: 'codex',
        onEvent: (event) => {
          if (event.type === 'message' || event.type === 'function_call') {
            log.debug(`Codex: ${event.type}`, event);
          }
        },
      });

      // Non-zero exit code means Codex CLI itself failed (bad flags, crash, etc.)
      if (exitCode !== 0) {
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

    try {
      // Reviews are read-only — enforce workspace-read regardless of config
      const args = ['exec', ...this.sandboxArgs('workspace-read'), '--json', prompt];
      const { output, exitCode, events, stderr } = await this.invokeCodex(args, cwd, {
        outFilePrefix: 'codex-review',
      });

      // Non-zero exit code means the CLI invocation itself failed
      if (exitCode !== 0) {
        return {
          passed: false,
          issues: [{ severity: 'critical', description: `codex exec failed (exit ${exitCode}): ${stderr?.slice(0, 300) ?? 'unknown error'}`, source: 'codex' }],
          summary: `Codex review failed with exit code ${exitCode}`,
          cost_usd: extractCost(events),
        };
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
  return extractFromStructuredFields(events)
    ?? extractFromEventText(events)
    ?? estimateFromTokenUsage(events, pricing)
    ?? 0;
}

function extractFromStructuredFields(events: JsonlEvent[]): number | null {
  let lastTotalCost = 0;
  let lastPartialCost = 0;

  for (const event of events) {
    const directTotal = firstPositiveNumber([event.total_cost_usd, event.total_cost]);
    if (directTotal !== null) lastTotalCost = directTotal;

    const directPartial = firstPositiveNumber([event.cost]);
    if (directPartial !== null) lastPartialCost = directPartial;

    if (typeof event.usage !== 'object' || event.usage === null) continue;
    const usage = event.usage as Record<string, unknown>;
    const usageTotal = firstPositiveNumber([usage.total_cost_usd, usage.total_cost]);
    if (usageTotal !== null) lastTotalCost = usageTotal;
    const usagePartial = firstPositiveNumber([usage.cost]);
    if (usagePartial !== null) lastPartialCost = usagePartial;
  }

  if (lastTotalCost > 0) return lastTotalCost;
  if (lastPartialCost > 0) return lastPartialCost;
  return null;
}

function extractFromEventText(events: JsonlEvent[]): number | null {
  let lastTotalCost = 0;
  let lastPartialCost = 0;

  for (const event of events) {
    const costs = extractCostFromEventText(event);
    if (costs.total !== null) lastTotalCost = costs.total;
    if (costs.partial !== null) lastPartialCost = costs.partial;
  }

  if (lastTotalCost > 0) return lastTotalCost;
  if (lastPartialCost > 0) return lastPartialCost;
  return null;
}

function estimateFromTokenUsage(events: JsonlEvent[], pricing?: TokenPricing): number | null {
  if (!pricing) return null;

  let totalInput = 0;
  let totalCached = 0;
  let totalOutput = 0;

  for (const event of events) {
    if (event.type !== 'turn.completed' || typeof event.usage !== 'object' || event.usage === null) continue;
    const usage = event.usage as Record<string, unknown>;
    if (typeof usage.input_tokens === 'number' && Number.isFinite(usage.input_tokens)) totalInput += usage.input_tokens;
    if (typeof usage.cached_input_tokens === 'number' && Number.isFinite(usage.cached_input_tokens)) totalCached += usage.cached_input_tokens;
    if (typeof usage.output_tokens === 'number' && Number.isFinite(usage.output_tokens)) totalOutput += usage.output_tokens;
  }

  if (totalInput <= 0 && totalCached <= 0 && totalOutput <= 0) return null;
  const nonCachedInput = Math.max(0, totalInput - totalCached);
  return (nonCachedInput * pricing.inputPerMillion
    + totalCached * pricing.cachedInputPerMillion
    + totalOutput * pricing.outputPerMillion) / 1_000_000;
}

function extractCostFromEventText(event: JsonlEvent): { total: number | null; partial: number | null } {
  const strings: string[] = [];
  collectStringValues(event, strings);

  let total: number | null = null;
  let partial: number | null = null;

  for (const text of strings) {
    const totalMatch = extractLastPositiveMatch(text, '\\btotal[_\\s-]*cost(?:[_\\s-]*usd)?\\b\\s*[:=]\\s*\\$?\\s*(-?\\d*\\.?\\d+)');
    if (totalMatch !== null) {
      total = totalMatch;
    }

    const partialMatch = extractLastPositiveMatch(text, '\\bcost(?:[_\\s-]*usd)?\\b\\s*[:=]\\s*\\$?\\s*(-?\\d*\\.?\\d+)');
    if (partialMatch !== null) {
      partial = partialMatch;
    }
  }

  return { total, partial };
}

function extractLastPositiveMatch(text: string, pattern: string): number | null {
  let lastValue: number | null = null;

  for (const match of text.matchAll(new RegExp(pattern, 'gi'))) {
    const maybeValue = Number(match[1]);
    if (Number.isFinite(maybeValue) && maybeValue > 0) {
      lastValue = maybeValue;
    }
  }

  return lastValue;
}

function collectStringValues(
  value: unknown,
  output: string[],
  seen: Set<object> = new Set<object>(),
): void {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringValues(item, output, seen);
    }
    return;
  }

  if (typeof value !== 'object' || value === null) {
    return;
  }

  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  for (const nested of Object.values(value as Record<string, unknown>)) {
    collectStringValues(nested, output, seen);
  }
}

function firstPositiveNumber(values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return null;
}
