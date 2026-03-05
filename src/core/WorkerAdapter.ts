import type {
  ClaudeCodeSession,
  SessionResult,
  SessionOptions,
} from "../bridges/ClaudeCodeSession.js";
import type { ThinkingConfig } from "@anthropic-ai/claude-agent-sdk";
import type { CodexBridge } from "../bridges/CodexBridge.js";
import type { ReviewResult } from "../bridges/CodingAgent.js";
import type { CodexConfig } from "../config/types.js";
import { log } from "../utils/logger.js";

// --- Unified Worker Result ---

export interface WorkerResult {
  text: string;
  costUsd: number;
  durationMs: number;
  sessionId?: string; // Only Claude Code supports resume
  isError: boolean;
  errors: string[];
}

// --- Worker Options ---

export interface WorkerExecOpts {
  maxTurns?: number;
  maxBudget?: number;
  timeout?: number;
  cwd: string;
  model?: string;
  appendSystemPrompt?: string;
  resumeSessionId?: string;
  /** Short prompt for resumed sessions; adapter falls back to main prompt
   *  if resume is not possible (e.g. Codex with non-full-auto sandbox). */
  resumePrompt?: string;
  thinking?: ThinkingConfig;
  effort?: "low" | "medium" | "high" | "max";
}

export interface WorkerAnalyzeOpts {
  maxTurns?: number;
  maxBudget?: number;
  timeout?: number;
  cwd: string;
  model?: string;
  resumeSessionId?: string;
  thinking?: ThinkingConfig;
  effort?: "low" | "medium" | "high" | "max";
}

// --- Worker Adapter Interface ---

export interface WorkerAdapter {
  readonly name: "claude" | "codex";

  /** Execute a coding task (read-write) */
  execute(prompt: string, opts: WorkerExecOpts): Promise<WorkerResult>;

  /** Fix verification or review issues */
  fix(prompt: string, opts: WorkerExecOpts): Promise<WorkerResult>;

  /** Analyze code (read-only) for plan generation */
  analyze(prompt: string, opts: WorkerAnalyzeOpts): Promise<WorkerResult>;
}

// --- Review Adapter Interface ---

export interface ReviewAdapter {
  readonly name: "claude" | "codex";

  /** Review code changes and return structured result */
  review(prompt: string, cwd: string): Promise<ReviewResult>;
}

// --- Claude Code Worker ---

export class ClaudeWorkerAdapter implements WorkerAdapter {
  readonly name = "claude" as const;

  constructor(private session: ClaudeCodeSession) {}

  async execute(prompt: string, opts: WorkerExecOpts): Promise<WorkerResult> {
    const isResume = !!opts.resumeSessionId;
    const result = await this.session.run(
      isResume ? (opts.resumePrompt ?? prompt) : prompt,
      {
        permissionMode: "bypassPermissions",
        maxTurns: opts.maxTurns,
        maxBudget: opts.maxBudget,
        cwd: opts.cwd,
        timeout: opts.timeout,
        model: opts.model,
        thinking: opts.thinking,
        effort: opts.effort,
        appendSystemPrompt: isResume ? undefined : opts.appendSystemPrompt,
        resumeSessionId: opts.resumeSessionId,
      },
    );
    return sessionToWorkerResult(result);
  }

  async fix(prompt: string, opts: WorkerExecOpts): Promise<WorkerResult> {
    // Claude supports session resume for contextual fixes
    return this.execute(prompt, opts);
  }

  async analyze(
    prompt: string,
    opts: WorkerAnalyzeOpts,
  ): Promise<WorkerResult> {
    const result = await this.session.run(prompt, {
      permissionMode: "bypassPermissions",
      maxTurns: opts.maxTurns ?? 100,
      maxBudget: opts.maxBudget ?? 3.0,
      cwd: opts.cwd,
      timeout: opts.timeout ?? 300_000,
      model: opts.model,
      thinking: opts.thinking,
      effort: opts.effort,
      resumeSessionId: opts.resumeSessionId,
      disallowedTools: ["Edit", "Write", "NotebookEdit"],
      appendSystemPrompt:
        "You are analyzing code for planning purposes. Do NOT modify any files — only read and analyze.",
    });
    return sessionToWorkerResult(result);
  }
}

// --- Codex Worker ---

export class CodexWorkerAdapter implements WorkerAdapter {
  readonly name = "codex" as const;

  constructor(private codex: CodexBridge) {}

  async execute(prompt: string, opts: WorkerExecOpts): Promise<WorkerResult> {
    const result = await this.codex.execute(prompt, opts.cwd, {
      systemPrompt: opts.appendSystemPrompt,
      maxTurns: opts.maxTurns,
      maxBudget: opts.maxBudget,
      timeout: opts.timeout ? opts.timeout : undefined,
      resumeSessionId: opts.resumeSessionId,
      resumePrompt: opts.resumePrompt,
    });
    return {
      text: result.output,
      costUsd: result.cost_usd,
      durationMs: result.duration_ms,
      sessionId: result.sessionId,
      isError: !result.success,
      errors: result.success ? [] : [result.output],
    };
  }

  async fix(prompt: string, opts: WorkerExecOpts): Promise<WorkerResult> {
    return this.execute(prompt, opts);
  }

  async analyze(
    prompt: string,
    opts: WorkerAnalyzeOpts,
  ): Promise<WorkerResult> {
    // Codex plan() does not support resume — codex exec resume lacks
    // --sandbox read-only, so resuming would break the read-only guarantee.
    // Revision context is carried by the prompt itself (revisionPrompt).
    const result = await this.codex.plan(prompt, opts.cwd, {
      maxTurns: opts.maxTurns,
    });
    return {
      text: result.output,
      costUsd: result.cost_usd,
      durationMs: result.duration_ms,
      sessionId: result.sessionId,
      isError: !result.success,
      errors: result.success ? [] : [result.output],
    };
  }
}

// --- Claude Code Review Adapter ---

export class ClaudeReviewAdapter implements ReviewAdapter {
  readonly name = "claude" as const;

  constructor(private session: ClaudeCodeSession) {}

  async review(prompt: string, cwd: string): Promise<ReviewResult> {
    const start = Date.now();
    try {
      const result = await this.session.run(prompt, {
        permissionMode: "bypassPermissions",
        maxTurns: 200,
        cwd,
        timeout: 600_000,
        disallowedTools: ["Edit", "Write", "NotebookEdit"],
        appendSystemPrompt:
          "You are an adversarial code reviewer. Do NOT modify files — only read and analyze.",
      });

      // Parse structured review from Claude's output
      const parsed = parseClaudeReviewOutput(result.text);
      return {
        ...parsed,
        cost_usd: result.costUsd,
        issues: parsed.issues.map((i) => ({ ...i, source: "claude" as const })),
      };
    } catch (err) {
      log.error("ClaudeReviewAdapter review failed", err);
      return {
        passed: false,
        issues: [
          {
            severity: "critical",
            description: `Claude review failed: ${err}`,
            source: "claude",
          },
        ],
        summary: `Review error: ${err}`,
        cost_usd: 0,
      };
    }
  }
}

// --- Codex Review Adapter ---

export class CodexReviewAdapter implements ReviewAdapter {
  readonly name = "codex" as const;

  constructor(private codex: CodexBridge) {}

  async review(prompt: string, cwd: string): Promise<ReviewResult> {
    return this.codex.review(prompt, cwd);
  }
}

// --- Helpers ---

function sessionToWorkerResult(result: SessionResult): WorkerResult {
  return {
    text: result.text,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
    sessionId: result.sessionId || undefined,
    isError: result.isError,
    errors: result.errors,
  };
}

function parseClaudeReviewOutput(text: string): Omit<ReviewResult, "cost_usd"> {
  // Try to extract JSON from Claude's output
  try {
    const jsonMatch = text.match(
      /\{[\s\S]*"passed"\s*:\s*(true|false)[\s\S]*\}/,
    );
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (typeof parsed.passed === "boolean") {
        const issues = Array.isArray(parsed.issues)
          ? parsed.issues.map((i: Record<string, unknown>) => ({
              severity: (i.severity as string) ?? "medium",
              description: String(i.description ?? ""),
              file: i.file as string | undefined,
              line: i.line as number | undefined,
              suggestion: i.suggestion as string | undefined,
              source: "claude" as const,
              confidence:
                typeof i.confidence === "number" ? i.confidence : undefined,
            }))
          : [];
        return {
          passed: parsed.passed,
          issues,
          summary: typeof parsed.summary === "string" ? parsed.summary : "",
          preExistingIssues: Array.isArray(parsed.preExistingIssues)
            ? parsed.preExistingIssues
            : undefined,
        };
      }
    }
  } catch {
    // Fall through to text-based analysis
  }

  // Fallback: treat as failed if we can't parse
  log.warn(
    "ClaudeReviewAdapter: could not parse structured output, treating as FAIL",
  );
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
