import type { ReviewResult } from "./ReviewTypes.js";
import type { CodexConfig, TokenPricing } from "../config/types.js";
import {
  runProcess,
  spawnWithJsonl,
  type JsonlEvent,
} from "../utils/process.js";
import { log } from "../utils/logger.js";
import {
  isPositiveFinite,
  tryParseJson,
  tryParseReview,
} from "../utils/parse.js";
import { readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface CodexAgentResult {
  success: boolean;
  output: string;
  cost_usd: number;
  duration_ms: number;
  structured?: unknown;
  sessionId?: string;
  toolSummaries?: string[];
  numTurns?: number;
  stopReason?: string;
}

export class CodexBridge {
  readonly name = "codex";

  constructor(private config: CodexConfig) {}

  /**
   * Map config sandbox value to the corresponding Codex CLI flags.
   *
   * `codex exec` expects `--sandbox <level>` (two args) or `--full-auto` (single flag).
   * Note: `sandboxOverride` is intentionally a CodexBridge-specific option —
   * sandbox control is an implementation detail that higher layers shouldn't
   * need to understand.
   */
  private sandboxArgs(overrideSandbox?: CodexConfig["sandbox"]): string[] {
    const level = overrideSandbox ?? this.config.sandbox;
    switch (level) {
      case "workspace-read":
        return ["--sandbox", "read-only"];
      case "workspace-write":
        return ["--sandbox", "workspace-write"];
      case "full-auto":
        return ["--full-auto"];
      default: {
        // Exhaustive check — TypeScript should catch this at compile time,
        // but log a warning for runtime safety (e.g. bad config values).
        const _exhaustive: never = level;
        log.warn("Unknown sandbox level, defaulting to workspace-write", {
          level,
        });
        return ["--sandbox", "workspace-write"];
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
    const outFile = join(
      tmpdir(),
      `${opts?.outFilePrefix ?? "codex"}-${Date.now()}-${randomUUID()}.json`,
    );
    const jsonFlagIndex = args.indexOf("--json");
    const invokeArgs =
      jsonFlagIndex >= 0
        ? [
            ...args.slice(0, jsonFlagIndex + 1),
            "-o",
            outFile,
            ...args.slice(jsonFlagIndex + 1),
          ]
        : [...args, "-o", outFile];

    const { exitCode, events, stderr } = await spawnWithJsonl(
      "codex",
      invokeArgs,
      {
        cwd,
        ...(opts?.timeout && { timeout: opts.timeout }),
        ...(opts?.onEvent && { onEvent: opts.onEvent }),
      },
    );

    if (exitCode !== 0) {
      log.warn("CodexBridge invokeCodex: non-zero exit code", {
        exitCode,
        stderr: stderr?.slice(0, 500),
      });
    }

    let output = "";
    try {
      output = readFileSync(outFile, "utf-8");
    } catch (err) {
      log.debug("CodexBridge invokeCodex output file read failed", {
        error: err,
        inputPreview: String(args.at(-1) ?? "").slice(0, 200),
      });
    } finally {
      try {
        unlinkSync(outFile);
      } catch (cleanupErr: unknown) {
        const isEnoent =
          cleanupErr instanceof Error &&
          (cleanupErr as NodeJS.ErrnoException).code === "ENOENT";
        if (!isEnoent) {
          log.debug("CodexBridge invokeCodex temp file cleanup failed", {
            error: cleanupErr,
            outFile,
          });
        }
      }
    }

    return { output, events, exitCode, stderr };
  }

  async execute(
    prompt: string,
    cwd: string,
    options?: {
      systemPrompt?: string;
      maxTurns?: number;
      maxBudget?: number;
      timeout?: number;
      model?: string;
      sandboxOverride?: CodexConfig["sandbox"];
      resumeSessionId?: string;
      /** Short prompt for resumed sessions; used only when resume is possible. */
      resumePrompt?: string;
      /** Callback for streaming text events (agent messages). */
      onText?: (text: string) => void;
    },
  ): Promise<CodexAgentResult> {
    const start = Date.now();

    try {
      // codex exec resume only supports --full-auto (no --sandbox flag).
      // Resuming would silently change the sandbox/approval semantics for
      // workspace-read and workspace-write configs, so we only resume
      // when the effective sandbox is already full-auto.
      const effectiveSandbox = options?.sandboxOverride ?? this.config.sandbox;
      const canResume =
        !!options?.resumeSessionId && effectiveSandbox === "full-auto";

      let args: string[];
      if (canResume) {
        // codex exec resume [OPTIONS] <SESSION_ID> <PROMPT>
        const effectivePrompt = options!.resumePrompt ?? prompt;
        args = ["exec", "resume", "--full-auto", "--json"];
        if (options?.model) {
          args.push("--model", options.model);
        }
        args.push(options!.resumeSessionId!, effectivePrompt);
      } else {
        args = [
          "exec",
          ...this.sandboxArgs(options?.sandboxOverride),
          "--json",
        ];
        if (options?.model) {
          args.push("--model", options.model);
        }
        if (options?.systemPrompt) {
          args.push("--instructions", options.systemPrompt);
        }
        args.push(prompt);
      }

      const { output, exitCode, events, stderr } = await this.invokeCodex(
        args,
        cwd,
        {
          timeout: options?.timeout,
          outFilePrefix: "codex",
          onEvent: (event) => {
            if (event.type === "message" || event.type === "function_call") {
              log.debug(`Codex: ${event.type}`, event);
            }
            if (
              options?.onText &&
              event.type === "message" &&
              typeof event.content === "string"
            ) {
              options.onText(event.content);
            }
          },
        },
      );

      const numTurns =
        events.filter((e) => e.type === "turn.completed").length || undefined;
      const stopReason =
        exitCode === -1 ? "timeout" : exitCode !== 0 ? "error" : undefined;
      const sessionId = extractThreadId(events);

      // Non-zero exit code means Codex CLI itself failed (bad flags, crash, etc.)
      if (exitCode !== 0) {
        return {
          success: false,
          output: stderr || `codex exec failed with exit code ${exitCode}`,
          cost_usd: extractCost(events),
          duration_ms: Date.now() - start,
          sessionId,
          numTurns,
          stopReason,
        };
      }

      // Exit code 0 — check events for logical errors
      const hasEventError = events.some(
        (e) =>
          e.type === "error" ||
          (e.type === "function_call_output" &&
            String(e.output ?? "").includes("Error")),
      );

      const cost = extractCost(events, this.config.tokenPricing);

      return {
        success: !hasEventError,
        output:
          output ||
          events.map((e) => String(e.content ?? e.output ?? "")).join("\n"),
        cost_usd: cost,
        duration_ms: Date.now() - start,
        structured: output ? tryParseJson(output) : undefined,
        sessionId,
        numTurns,
        stopReason,
      };
    } catch (err) {
      log.error("CodexBridge execute failed", err);
      return {
        success: false,
        output: String(err),
        cost_usd: 0,
        duration_ms: Date.now() - start,
      };
    }
  }

  async plan(
    prompt: string,
    cwd: string,
    options?: {
      systemPrompt?: string;
      maxTurns?: number;
    },
  ): Promise<CodexAgentResult> {
    // Codex doesn't have a separate plan mode — enforce read-only sandbox
    // regardless of config so plan never mutates the workspace.
    // NOTE: resume is intentionally NOT supported here because
    // `codex exec resume` only supports --full-auto (workspace-write),
    // which would break the read-only guarantee.
    return this.execute(prompt, cwd, {
      systemPrompt:
        (options?.systemPrompt ?? "") +
        "\nIMPORTANT: This is analysis only. Do NOT modify any files. Only read and analyze.",
      timeout: (this.config.planTimeout ?? 900) * 1000,
      sandboxOverride: "workspace-read",
    });
  }

  async review(
    prompt: string,
    cwd: string,
    opts?: { model?: string },
  ): Promise<ReviewResult> {
    const start = Date.now();

    try {
      // Reviews are read-only — enforce workspace-read regardless of config
      const args = ["exec", ...this.sandboxArgs("workspace-read"), "--json"];
      if (opts?.model) {
        args.push("--model", opts.model);
      }
      args.push(prompt);
      const { output, exitCode, events, stderr } = await this.invokeCodex(
        args,
        cwd,
        {
          timeout: (this.config.reviewTimeout ?? 1800) * 1000,
          outFilePrefix: "codex-review",
        },
      );

      // Non-zero exit code means the CLI invocation itself failed
      if (exitCode !== 0) {
        return {
          passed: false,
          issues: [
            {
              severity: "critical",
              description: `codex exec failed (exit ${exitCode}): ${stderr?.slice(0, 300) ?? "unknown error"}`,
              source: "codex",
            },
          ],
          summary: `Codex review failed with exit code ${exitCode}`,
          cost_usd: extractCost(events),
        };
      }

      const cost = extractCost(events, this.config.tokenPricing);
      const reviewText =
        output ||
        events
          .map((e) => String(e.content ?? e.output ?? e.text ?? ""))
          .join("\n");
      log.info("CodexBridge review raw output", {
        outputLen: output.length,
        outputPreview: output.slice(0, 500),
        eventTypes: events.map((e) => e.type).join(","),
        exitCode,
      });
      const parsed = tryParseReview(reviewText);

      return {
        ...parsed,
        cost_usd: cost,
        issues: parsed.issues.map((i) => ({ ...i, source: "codex" as const })),
      };
    } catch (err) {
      log.error("CodexBridge review failed", err);
      return {
        passed: false,
        issues: [
          {
            severity: "critical",
            description: `Review failed: ${err}`,
            source: "codex",
          },
        ],
        summary: `Review error: ${err}`,
        cost_usd: 0,
      };
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const r = await runProcess("codex", ["--version"], { timeout: 5000 });
      return r.exitCode === 0;
    } catch {
      return false;
    }
  }
}

function extractCost(events: JsonlEvent[], pricing?: TokenPricing): number {
  return (
    extractFromStructuredFields(events) ??
    extractFromEventText(events) ??
    estimateFromTokenUsage(events, pricing) ??
    0
  );
}

function extractFromStructuredFields(events: JsonlEvent[]): number | null {
  let lastTotalCost = 0;
  let lastPartialCost = 0;

  for (const event of events) {
    const directTotal = firstPositiveNumber([
      event.total_cost_usd,
      event.total_cost,
    ]);
    if (directTotal !== null) lastTotalCost = directTotal;

    const directPartial = firstPositiveNumber([event.cost]);
    if (directPartial !== null) lastPartialCost = directPartial;

    if (typeof event.usage !== "object" || event.usage === null) continue;
    const usage = event.usage as Record<string, unknown>;
    const usageTotal = firstPositiveNumber([
      usage.total_cost_usd,
      usage.total_cost,
    ]);
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

function estimateFromTokenUsage(
  events: JsonlEvent[],
  pricing?: TokenPricing,
): number | null {
  if (!pricing) return null;

  let totalInput = 0;
  let totalCached = 0;
  let totalOutput = 0;

  for (const event of events) {
    if (
      event.type !== "turn.completed" ||
      typeof event.usage !== "object" ||
      event.usage === null
    )
      continue;
    const usage = event.usage as Record<string, unknown>;
    if (isPositiveFinite(usage.input_tokens)) totalInput += usage.input_tokens;
    if (isPositiveFinite(usage.cached_input_tokens))
      totalCached += usage.cached_input_tokens;
    if (isPositiveFinite(usage.output_tokens))
      totalOutput += usage.output_tokens;
  }

  if (totalInput <= 0 && totalCached <= 0 && totalOutput <= 0) return null;
  const nonCachedInput = Math.max(0, totalInput - totalCached);
  return (
    (nonCachedInput * pricing.inputPerMillion +
      totalCached * pricing.cachedInputPerMillion +
      totalOutput * pricing.outputPerMillion) /
    1_000_000
  );
}

function extractCostFromEventText(event: JsonlEvent): {
  total: number | null;
  partial: number | null;
} {
  const strings: string[] = [];
  collectStringValues(event, strings);

  let total: number | null = null;
  let partial: number | null = null;

  for (const text of strings) {
    const totalMatch = extractLastPositiveMatch(
      text,
      "\\btotal[_\\s-]*cost(?:[_\\s-]*usd)?\\b\\s*[:=]\\s*\\$?\\s*(-?\\d*\\.?\\d+)",
    );
    if (totalMatch !== null) {
      total = totalMatch;
    }

    const partialMatch = extractLastPositiveMatch(
      text,
      "\\bcost(?:[_\\s-]*usd)?\\b\\s*[:=]\\s*\\$?\\s*(-?\\d*\\.?\\d+)",
    );
    if (partialMatch !== null) {
      partial = partialMatch;
    }
  }

  return { total, partial };
}

function extractLastPositiveMatch(
  text: string,
  pattern: string,
): number | null {
  let lastValue: number | null = null;

  for (const match of text.matchAll(new RegExp(pattern, "gi"))) {
    const maybeValue = Number(match[1]);
    if (isPositiveFinite(maybeValue)) {
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
  if (typeof value === "string") {
    output.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringValues(item, output, seen);
    }
    return;
  }

  if (typeof value !== "object" || value === null) {
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
    if (isPositiveFinite(value)) {
      return value;
    }
  }
  return null;
}

/** Extract thread/session ID from the first thread.started event. */
function extractThreadId(events: JsonlEvent[]): string | undefined {
  const threadEvent = events.find((e) => e.type === "thread.started");
  if (threadEvent && typeof threadEvent.thread_id === "string") {
    return threadEvent.thread_id;
  }
  return undefined;
}
