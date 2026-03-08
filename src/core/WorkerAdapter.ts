/**
 * WorkerAdapter — Review adapter and shared types for phase orchestration.
 *
 * Dead code removed (Phase 4): WorkerAdapter interface, ClaudeWorkerAdapter,
 * CodexWorkerAdapter, ClaudeReviewAdapter, CodexReviewAdapter.
 * All phases now use RuntimeAdapter directly.
 */

import type { ReviewResult } from "../bridges/ReviewTypes.js";
import type { RuntimeAdapter } from "../runtime/RuntimeAdapter.js";
import { log } from "../utils/logger.js";
import {
  parsePreExistingIssues,
  VALID_SEVERITIES,
  type ValidSeverity,
} from "../utils/parse.js";

// --- Unified Worker Result ---

export interface WorkerResult {
  text: string;
  costUsd: number;
  durationMs: number;
  sessionId?: string;
  isError: boolean;
  errors: string[];
}

// --- Review Adapter Interface ---

export interface ReviewAdapter {
  readonly name: "claude" | "codex";
  /** Precise runtime name for logging (e.g. "claude-sdk", "codex-cli"). */
  readonly runtimeName?: string;

  /** Review code changes and return structured result */
  review(
    prompt: string,
    cwd: string,
    opts?: { model?: string },
  ): Promise<ReviewResult>;
}

// --- Unified Runtime Review Adapter ---

/**
 * ReviewAdapter backed by a RuntimeAdapter.
 * Routes review calls through the unified RuntimeAdapter.run() interface.
 */
export class RuntimeReviewAdapter implements ReviewAdapter {
  readonly name: "claude" | "codex";
  /** The underlying runtime's name, for precise logging. */
  readonly runtimeName: string;

  constructor(
    private readonly runtime: RuntimeAdapter,
    name?: "claude" | "codex",
  ) {
    this.name = name ?? (runtime.name.includes("codex") ? "codex" : "claude");
    this.runtimeName = runtime.name;
  }

  async review(
    prompt: string,
    cwd: string,
    opts?: { model?: string },
  ): Promise<ReviewResult> {
    try {
      const result = await this.runtime.run(prompt, {
        cwd,
        maxTurns: 200,
        timeout: 600_000,
        model: opts?.model,
        readOnly: true,
        disallowedTools: ["Edit", "Write", "NotebookEdit"],
        systemPrompt:
          "You are an adversarial code reviewer. Do NOT modify files — only read and analyze.",
      });

      const parsed = parseReviewOutput(result.text);
      return {
        ...parsed,
        cost_usd: result.costUsd,
        issues: parsed.issues.map((i) => ({
          ...i,
          source: this.name as "claude" | "codex",
        })),
      };
    } catch (err) {
      log.error(`RuntimeReviewAdapter(${this.name}) review failed`, err);
      return {
        passed: false,
        issues: [
          {
            severity: "critical",
            description: `Review failed: ${err}`,
            source: this.name,
          },
        ],
        summary: `Review error: ${err}`,
        cost_usd: 0,
      };
    }
  }
}

// --- Helpers ---

function parseReviewOutput(text: string): Omit<ReviewResult, "cost_usd"> {
  try {
    const jsonMatch = text.match(
      /\{[\s\S]*"passed"\s*:\s*(true|false)[\s\S]*\}/,
    );
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (typeof parsed.passed === "boolean") {
        const issues = Array.isArray(parsed.issues)
          ? parsed.issues
              .filter(
                (i: unknown): i is Record<string, unknown> =>
                  i !== null && typeof i === "object" && !Array.isArray(i),
              )
              .map((i: Record<string, unknown>) => ({
                severity:
                  typeof i.severity === "string" &&
                  VALID_SEVERITIES.has(i.severity as ValidSeverity)
                    ? (i.severity as ValidSeverity)
                    : ("medium" as const),
                description: String(i.description ?? ""),
                file: typeof i.file === "string" ? i.file : undefined,
                line: typeof i.line === "number" ? i.line : undefined,
                suggestion:
                  typeof i.suggestion === "string" ? i.suggestion : undefined,
                source: "claude" as const,
                confidence:
                  typeof i.confidence === "number" ? i.confidence : undefined,
              }))
          : [];
        return {
          passed: parsed.passed,
          issues,
          summary: typeof parsed.summary === "string" ? parsed.summary : "",
          preExistingIssues: parsePreExistingIssues(parsed.preExistingIssues),
        };
      }
    }
  } catch {
    // Fall through to text-based analysis
  }

  log.warn("parseReviewOutput: could not parse structured output, treating as FAIL");
  return {
    passed: false,
    issues: [
      {
        severity: "medium",
        description: "Review output could not be parsed",
        source: "claude",
      },
    ],
    summary: text.slice(0, 300),
  };
}
