/**
 * BrainPhase — Brain decision-making, context gathering, plan synthesis,
 * review decisions, and reflection.
 *
 * Methods:
 * - brainDecide (directive-driven, single-phase)
 * - brainSynthesizePlan, brainReviewDecision, brainReflect
 * - gatherBrainContext (minimal — brain self-serves via tools)
 * - deriveMemoryProject
 *
 * Standalone functions:
 * - normalizeSubtasks, coerceSubtaskOrder (exported for MainLoop runCycle)
 */

import type { Config } from "../../config/Config.js";
import type { TaskStore } from "../../memory/TaskStore.js";
import type { CostTracker } from "../../utils/cost.js";
import type {
  RuntimeAdapter,
  RunResult,
} from "../../runtime/RuntimeAdapter.js";
import type { ReviewResult } from "../../bridges/ReviewTypes.js";
import type { Task, ResourceRequest } from "../../memory/types.js";
import type { TaskQueue } from "../TaskQueue.js";
import type { RegisteredStrategies } from "../strategies/index.js";
import type { ProjectMemory } from "../../memory/ProjectMemory.js";
import type { WorkInstructions } from "../PersonaLoader.js";
import { COMPLEXITY_CONFIG } from "./WorkerPhase.js";
import { runBrainThink } from "./brainThink.js";
import { truncate, extractJsonFromText, isRecord } from "../../utils/parse.js";
import {
  SUMMARY_PREVIEW_LEN,
  TASK_DESC_MAX_LENGTH,
} from "../../types/constants.js";
import { log } from "../../utils/logger.js";
import { basename } from "node:path";

// ---------------------------------------------------------------------------
// Brain-driven types (B-1)
// ---------------------------------------------------------------------------

/** Structured output from brainDecide */
export interface BrainDecision {
  directive: string;
  summary: string;
  strategy_note: string;
  resource_request: ResourceRequest;
  verification_plan: string;
  extra_tasks?: Array<{
    directive: string;
    resource_request: ResourceRequest;
  }>;
}

/** Structured output from brainReflect */
export interface BrainReflection {
  reflection: string;
  strategy_update: string;
  retrieval_lesson: string;
  orchestrator_feedback?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DIRECTIVE_MAX_CHARS = 50_000;
const SUMMARY_MAX_CHARS = 120;

// ---------------------------------------------------------------------------
// Standalone helper functions (exported for MainLoop runCycle)
// ---------------------------------------------------------------------------

export function coerceSubtaskOrder(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) return fallback;
  return n;
}

/**
 * Normalize a raw subtasks array from brain output:
 * - Filter out items without a string `description`
 * - Coerce each `order` to a valid positive integer (fallback: index+1)
 */
export function normalizeSubtasks(
  raw: unknown[],
): Array<{ description: string; order: number }> {
  const valid: Array<Record<string, unknown>> = [];
  for (const item of raw) {
    if (
      typeof item === "object" &&
      item !== null &&
      typeof (item as Record<string, unknown>).description === "string"
    ) {
      valid.push(item as Record<string, unknown>);
    } else if (log.isEnabled("warn")) {
      const descPreview =
        typeof item === "object" &&
        item !== null &&
        Object.hasOwn(item, "description")
          ? String((item as Record<string, unknown>).description)
              .slice(0, 120)
              .replace(
                /(?:\x1b\[|\x9b)[0-9;:?>=!]*[\x20-\x2f]*[@-~]|\x1b[\x20-\x7e]/g,
                "",
              )
              .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
          : undefined;
      log.warn(
        "normalizeSubtasks: dropping invalid subtask item (missing string description)",
        {
          type: typeof item,
          descriptionPreview: descPreview,
        },
      );
    }
  }
  return valid.map((item, i) => ({
    description: String(item.description),
    order: coerceSubtaskOrder(item.order, i + 1),
  }));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function runGitLog(cwd: string): Promise<{ stdout: string }> {
  const { runProcess } = await import("../../utils/process.js");
  const result = await runProcess(
    "git",
    ["log", "--name-only", "--format=", "-30", "--", "src/"],
    { cwd, timeout: 10_000 },
  );
  return { stdout: result.stdout };
}

// ---------------------------------------------------------------------------
// BrainPhase class
// ---------------------------------------------------------------------------

export class BrainPhase {
  /** Per-phase runtime overrides. Falls back to brainSession when undefined. */
  private readonly planRuntime: RuntimeAdapter;
  private readonly reflectRuntime: RuntimeAdapter;

  constructor(
    private readonly config: Config,
    private readonly taskStore: TaskStore,
    private readonly costTracker: CostTracker,
    private readonly brainSession: RuntimeAdapter,
    private readonly taskQueue: TaskQueue,
    private readonly strategies: RegisteredStrategies | undefined,
    private readonly projectMemory: ProjectMemory | null,
    private readonly memoryProject: string,
    phaseRuntimes?: {
      plan?: RuntimeAdapter;
      reflect?: RuntimeAdapter;
    },
  ) {
    this.planRuntime = phaseRuntimes?.plan ?? brainSession;
    this.reflectRuntime = phaseRuntimes?.reflect ?? brainSession;
  }

  // --- Convenience wrapper ---

  private brainThink(
    prompt: string,
    opts?: {
      jsonSchema?: object;
      resumeSessionId?: string;
      model?: string;
      runtime?: RuntimeAdapter;
    },
  ): Promise<RunResult> {
    const runtime = opts?.runtime ?? this.brainSession;
    return runBrainThink(runtime, this.config, prompt, opts);
  }

  // --- Brain decide (two-phase: explore + structured) ---

  async brainDecide(projectPath: string): Promise<{
    taskDescription: string | null;
    priority?: number;
    persona?: string;
    taskType?: string;
    complexity?: string;
    subtasks?: Array<{ description: string; order: number }>;
    workInstructions?: WorkInstructions;
    costUsd: number;
    // Brain-driven mode (B-1) extra fields
    directive?: string;
    strategyNote?: string;
    verificationPlan?: string;
    resourceRequest?: ResourceRequest;
    extraDirectiveTasks?: Array<{
      directive: string;
      resourceRequest: ResourceRequest;
    }>;
    isBrainDriven?: boolean;
  }> {
    // Budget gate: if daily budget exhausted, don't spend on brain call
    const dailyCost = await this.taskStore.getDailyCost();
    const maxPerDay = this.config.values.budget.maxPerDay;
    if (dailyCost.total_cost_usd >= maxPerDay) {
      log.info(
        `Daily budget exhausted ($${dailyCost.total_cost_usd.toFixed(2)}/$${maxPerDay}). Skipping brain call.`,
      );
      return { taskDescription: null, costUsd: 0 };
    }

    // Brain-driven decision: minimal context, brain self-serves via tools
    const context = await this.gatherBrainContext(projectPath);
    let totalCost = 0;

    // Single-phase: exploration + structured output in one call
    const prompt = `你是这个项目的技术负责人。

## 项目状态
${context}

## 你的职责
- 决定下一步做什么（可以是一个任务或多个）
- 为工人写完整的执行指令（directive）
- 申请合理的资源（预算、超时）
- 说明怎么验证任务做对了

自由探索代码库，用你自己的判断力。不要自我设限。
你可以使用所有已安装的工具和插件，但以下操作被禁用：修改文件（Edit/Write/NotebookEdit）、创建任务、重排队列。

`;

    const brainDecisionSchema = {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              directive: {
                type: "string",
                description:
                  "Complete instructions for the worker (free-form, any length)",
              },
              summary: {
                type: "string",
                description: "One-line summary, max 120 chars",
                maxLength: 120,
              },
              strategy_note: {
                type: "string",
                description: "Why this task matters (for future self)",
              },
              resource_request: {
                type: "object",
                properties: {
                  budget_usd: { type: "number" },
                  timeout_s: { type: "number" },
                  model: { type: "string" },
                },
                required: ["budget_usd", "timeout_s"],
              },
              verification_plan: {
                type: "string",
                description: "How to verify the task was done correctly",
              },
              priority: { type: "number" },
              complexity: { type: "string" },
            },
            required: ["directive", "summary", "resource_request"],
          },
        },
        reasoning: { type: "string" },
      },
      required: ["tasks"],
    };

    const result = await this.brainThink(prompt, {
      jsonSchema: brainDecisionSchema,
    });
    totalCost += result.costUsd;
    log.info(
      `Brain (brain-driven): cost=$${result.costUsd.toFixed(4)}, error=${result.isError}, json=${result.structured ? "yes" : "no"}`,
    );
    if (result.isError) {
      log.warn(`Brain (brain-driven) errors: ${result.errors.join("; ")}`);
    }

    // Parse the brain-driven output
    const parsed = isRecord(result.structured) ? result.structured : null;
    if (parsed && Array.isArray(parsed.tasks) && parsed.tasks.length > 0) {
      const parsedResult = this.parseBrainDrivenTasks(
        parsed.tasks as Record<string, unknown>[],
        totalCost,
      );
      if (parsedResult) return parsedResult;
    }

    // Fallback: try extracting JSON from text
    const textParsed = extractJsonFromText(result.text, (v) => {
      if (!isRecord(v)) return false;
      const rec = v as Record<string, unknown>;
      return (
        Array.isArray(rec.tasks) &&
        rec.tasks.length > 0 &&
        isRecord(rec.tasks[0]) &&
        typeof (rec.tasks[0] as Record<string, unknown>).directive === "string"
      );
    });
    if (isRecord(textParsed) && Array.isArray(textParsed.tasks)) {
      log.warn("brainDecideDriven: fell back to text extraction");
      const parsedResult = this.parseBrainDrivenTasks(
        textParsed.tasks as Record<string, unknown>[],
        totalCost,
      );
      if (parsedResult) return parsedResult;
    }

    // Last resort: no valid output
    log.warn("brainDecideDriven: no valid output, returning null");
    return { taskDescription: null, costUsd: totalCost };
  }

  private parseBrainDrivenTasks(
    tasks: Record<string, unknown>[],
    totalCost: number,
  ): Awaited<ReturnType<BrainPhase["brainDecide"]>> | null {
    const first = tasks[0];
    if (!first || typeof first.directive !== "string") return null;

    const directive = first.directive.slice(0, DIRECTIVE_MAX_CHARS);

    // summary -> task_description (canonical persisted form)
    let summary: string;
    if (typeof first.summary === "string" && first.summary.trim().length > 0) {
      summary = first.summary.slice(0, SUMMARY_MAX_CHARS);
    } else {
      log.warn("brainDecideDriven: summary missing, truncating from directive");
      summary = directive.slice(0, SUMMARY_MAX_CHARS);
    }

    const parseResourceRequest = (v: unknown): ResourceRequest => {
      if (isRecord(v)) {
        const r = v as Record<string, unknown>;
        return {
          budget_usd: typeof r.budget_usd === "number" ? r.budget_usd : 10,
          timeout_s: typeof r.timeout_s === "number" ? r.timeout_s : 1200,
          model: typeof r.model === "string" ? r.model : undefined,
        };
      }
      return { budget_usd: 10, timeout_s: 1200 };
    };

    const resourceRequest = parseResourceRequest(first.resource_request);

    const extraDirectiveTasks = tasks
      .slice(1)
      .filter(
        (t): t is Record<string, unknown> =>
          isRecord(t) && typeof t.directive === "string",
      )
      .map((t) => ({
        directive: String(t.directive).slice(0, DIRECTIVE_MAX_CHARS),
        resourceRequest: parseResourceRequest(t.resource_request),
      }));

    return {
      taskDescription: summary,
      priority: typeof first.priority === "number" ? first.priority : 2,
      persona: typeof first.persona === "string" ? first.persona : undefined,
      taskType: typeof first.taskType === "string" ? first.taskType : undefined,
      complexity:
        typeof first.complexity === "string" &&
        first.complexity in COMPLEXITY_CONFIG
          ? first.complexity
          : undefined,
      costUsd: totalCost,
      // Brain-driven specific
      isBrainDriven: true,
      directive,
      strategyNote:
        typeof first.strategy_note === "string"
          ? first.strategy_note
          : undefined,
      verificationPlan:
        typeof first.verification_plan === "string"
          ? first.verification_plan
          : undefined,
      resourceRequest,
      extraDirectiveTasks:
        extraDirectiveTasks.length > 0 ? extraDirectiveTasks : undefined,
    };
  }

  // --- Brain context gathering ---

  /**
   * Gather minimal context for brain decisions.
   * Only provides task list, budget, and health metrics.
   * Brain can self-serve additional context via its tool permissions
   * (Read/Glob/Grep/Bash).
   */
  async gatherBrainContext(projectPath: string): Promise<string> {
    const parts: string[] = [];

    // Queued tasks
    const queuedTasks = await this.taskQueue.getQueued(projectPath);
    if (queuedTasks.length > 0) {
      parts.push(
        `Queued tasks (${queuedTasks.length}):\n${queuedTasks
          .slice(0, 5)
          .map((t) => `- [P${t.priority}] ${t.task_description}`)
          .join("\n")}`,
      );
    }

    // Recent tasks (dedup reference — brain should not re-create these)
    const recentResult = await this.taskStore.listTasksPaged(
      projectPath,
      1,
      15,
    );
    const recentTasks = recentResult.tasks ?? [];
    if (recentTasks.length > 0) {
      const lines = recentTasks.map(
        (t: Task) => `- [${t.status}] ${t.task_description}`,
      );
      parts.push(`Recent tasks (DO NOT duplicate these):\n${lines.join("\n")}`);
    }

    // Budget remaining
    const dailyCost = await this.taskStore.getDailyCost();
    const remaining =
      this.config.values.budget.maxPerDay - dailyCost.total_cost_usd;
    parts.push(
      `Budget: $${remaining.toFixed(2)} remaining today (${dailyCost.task_count} tasks completed). ${remaining < 30 ? "LOW BUDGET — pick small tasks." : ""}`,
    );

    // Health metrics
    try {
      const metrics = await this.taskStore.getOperationalMetrics(projectPath);
      parts.push(
        `Health: passRate=${metrics.taskPassRate}%, dailyCost=$${metrics.dailyCostUsd.toFixed(2)}, queue=${metrics.queueDepth}`,
      );
    } catch (e) {
      log.debug("gatherBrainContext: metrics failed:", e);
    }

    // Strategy context (quality alerts + priority suggestions)
    // Brain cannot self-retrieve these — they are in-memory state, not file-based
    if (this.strategies) {
      const qualityCtx = this.strategies.qualityEvaluator.getContextForBrain();
      if (qualityCtx) parts.push(qualityCtx);
      try {
        const priorityCtx =
          await this.strategies.dynamicPriority.getContextForBrain();
        if (priorityCtx) parts.push(priorityCtx);
      } catch (e) {
        log.debug("gatherBrainContext: priority suggestions failed:", e);
      }
    }

    // Brain can self-serve reflection lessons and claude-mem via its tool
    // permissions (Read/Glob/Grep/Bash) and the claude-mem plugin.
    // No pre-injection needed — context-on-demand (B-2).

    return parts.join("\n\n");
  }

  // --- Plan synthesis ---

  async brainSynthesizePlan(
    proposal: string,
    planReview: ReviewResult,
    task: Task,
  ): Promise<{
    decision: "approved" | "rejected" | "revise";
    finalPlan?: string;
    reviseInstructions?: string;
    costUsd: number;
  }> {
    const reviewSummary = planReview.passed
      ? `Review PASSED: ${planReview.summary}`
      : `Review FAILED:\n${planReview.issues.map((i) => `- [${i.severity}] ${i.description}`).join("\n")}\nSummary: ${planReview.summary}`;

    const prompt = `You are the brain of an autonomous coding agent. Decide whether to approve this plan.

## Task
${task.task_description}

## Worker Proposal
${proposal}

## Reviewer Feedback
${reviewSummary}

## Your Decision
If the plan is good (reviewer concerns are minor or addressed), output:
APPROVED
[final plan incorporating any reviewer fixes]

If the plan direction is right but needs specific fixes, output:
REVISE
[specific instructions for what the worker must change in the proposal]

If the plan is fundamentally flawed and cannot be salvaged, output:
REJECTED
[reason for rejection]

Prefer REVISE over REJECTED when the proposal shows understanding of the problem but has gaps.
Be decisive. Minor reviewer concerns should not block a good plan — use APPROVED.`;

    const result = await this.brainThink(prompt, {
      model: this.config.values.routing.plan.model,
      runtime: this.planRuntime,
    });

    if (result.costUsd > 0) {
      await this.costTracker.addCost(task.id, result.costUsd);
    }

    const text = result.text.trim();
    const isApproved =
      text.startsWith("APPROVED") || text.includes("\nAPPROVED");
    const isRevise = text.startsWith("REVISE") || text.includes("\nREVISE");

    const decision = isApproved
      ? ("approved" as const)
      : isRevise
        ? ("revise" as const)
        : ("rejected" as const);

    await this.taskStore.addLog({
      task_id: task.id,
      phase: "plan-review",
      agent: "brain",
      input_summary: "Plan synthesis",
      output_summary: `${decision.toUpperCase()}: ${text.slice(0, 200)}`,
      cost_usd: result.costUsd,
      duration_ms: result.durationMs,
    });

    if (isApproved) {
      const planStart = text.indexOf("\n", text.indexOf("APPROVED"));
      const finalPlan =
        planStart >= 0 ? text.slice(planStart).trim() : proposal;
      return { decision: "approved", finalPlan, costUsd: result.costUsd };
    }

    if (isRevise) {
      const instrStart = text.indexOf("\n", text.indexOf("REVISE"));
      const reviseInstructions =
        instrStart >= 0 ? text.slice(instrStart).trim() : "";
      return {
        decision: "revise",
        reviseInstructions,
        costUsd: result.costUsd,
      };
    }

    return { decision: "rejected", costUsd: result.costUsd };
  }

  // --- Review decision (post-code-review) ---

  async brainReviewDecision(
    task: Task,
    reviewResult: ReviewResult,
    diff: string,
    isFinalRound: boolean,
    fixRound?: number,
    maxFixes?: number,
  ): Promise<{
    decision: "fix" | "ignore" | "block" | "rewrite" | "split";
    reasoning: string;
    fixInstructions?: string;
    newTasks?: string[];
  }> {
    const reviewSummary = reviewResult.issues
      .map(
        (i) =>
          `- [${i.severity}] ${i.description}${i.file ? ` (${i.file})` : ""}`,
      )
      .join("\n");

    const allDecisions = [
      {
        key: "FIX",
        desc: "Send specific fix instructions to the worker (resume context)",
      },
      { key: "IGNORE", desc: "Issues are minor/false-positive, merge as-is" },
      { key: "BLOCK", desc: "Issues are severe, discard this work" },
      {
        key: "REWRITE",
        desc: "Fundamental approach is wrong, provide new instructions",
      },
      {
        key: "SPLIT",
        desc: "Merge what works, create new tasks for unresolved issues",
      },
    ];
    const allowed = isFinalRound
      ? allDecisions.filter((d) => ["IGNORE", "BLOCK", "SPLIT"].includes(d.key))
      : allDecisions;
    const allowedKeys = allowed.map((d) => d.key).join(", ");
    const decisionList = allowed
      .map((d) => `- **${d.key}**: ${d.desc}`)
      .join("\n");

    const templates = allowed
      .map((d) => {
        if (d.key === "SPLIT") {
          return `${d.key}\n[reasoning]\nNEW_TASKS:\n- [new task 1 description]\n- [new task 2 description]`;
        }
        return `${d.key}\n[${d.key === "FIX" || d.key === "REWRITE" ? "instructions for the worker" : "reasoning"}]`;
      })
      .join("\n\n");

    const prompt = `You are the brain of an autonomous coding agent. A code review found issues.

## Task
${task.task_description}

## Review Results
${reviewSummary}
Summary: ${reviewResult.summary}

## Code Diff (truncated)
\`\`\`diff
${diff.slice(0, 100_000)}
\`\`\`

## Available Decisions
${decisionList}
${isFinalRound ? "\nThis is the FINAL round — no more fix attempts allowed." : fixRound != null && maxFixes != null ? `\nThis is fix round ${fixRound} of ${maxFixes}. You may choose FIX to continue.` : ""}

## Output
Your FIRST LINE must be one of: ${allowedKeys}
Write all other text in ${this.config.values.brain.language}.

${templates}

For SPLIT, the NEW_TASKS: delimiter and task list are REQUIRED.`;

    const result = await this.brainThink(prompt);

    if (result.costUsd > 0) {
      await this.costTracker.addCost(task.id, result.costUsd);
    }

    await this.taskStore.addLog({
      task_id: task.id,
      phase: "reviewing",
      agent: "brain-decision",
      input_summary: `Review decision (final=${isFinalRound}${fixRound != null ? `, round=${fixRound}/${maxFixes}` : ""})`,
      output_summary: result.text,
      cost_usd: result.costUsd,
      duration_ms: result.durationMs,
    });

    return parseReviewDecision(result.text, isFinalRound);
  }

  // --- Brain reflection ---

  async brainReflect(
    task: Task,
    outcome: string,
    verification: { passed: boolean; reason?: string },
    projectPath: string,
  ): Promise<void> {
    const reflectionSchema = {
      type: "object",
      properties: {
        reflection: {
          type: "string",
          description: "Multi-paragraph deep analysis",
        },
        strategy_update: {
          type: "string",
          description: "Strategy-level insight for future decisions",
        },
        retrieval_lesson: {
          type: "string",
          description: "Short text for search/dedup (like the old LESSON)",
        },
        orchestrator_feedback: {
          type: "string",
          description:
            "Optional suggestions for how the orchestrator could work better",
        },
      },
      required: ["reflection", "strategy_update", "retrieval_lesson"],
    };

    const prompt = `反思这个已完成的任务。

任务: ${task.task_description}${task.directive ? `\n指令: ${truncate(task.directive, 2000)}` : ""}
结果: ${outcome}
验证: ${verification.passed ? "通过" : `失败 — ${verification.reason}`}

深入分析：
- 什么做得好？什么可以改进？
- 这次经验对未来的决策有什么启示？
- 编排器的行为有什么可以优化的？

不要编辑 CLAUDE.md。`;

    const result = await this.brainThink(prompt, {
      jsonSchema: reflectionSchema,
      model: this.config.values.routing.reflect.model,
      runtime: this.reflectRuntime,
    });

    if (result.costUsd > 0)
      await this.costTracker.addCost(task.id, result.costUsd);

    // Parse structured reflection
    let outputSummary: string;
    let details: Record<string, unknown> | null = null;

    const parsed = isRecord(result.structured) ? result.structured : null;
    if (parsed && typeof parsed.retrieval_lesson === "string") {
      outputSummary = `LESSON: ${parsed.retrieval_lesson}`;
      details = {
        reflection:
          typeof parsed.reflection === "string" ? parsed.reflection : "",
        strategy_update:
          typeof parsed.strategy_update === "string"
            ? parsed.strategy_update
            : "",
        orchestrator_feedback:
          typeof parsed.orchestrator_feedback === "string"
            ? parsed.orchestrator_feedback
            : undefined,
      };
    } else {
      // Fallback: extract LESSON from text
      const lessonMatch = result.text.match(/^LESSON:\s*(.+)$/m);
      outputSummary = lessonMatch
        ? `LESSON: ${lessonMatch[1]}`
        : result.text.slice(0, SUMMARY_PREVIEW_LEN);
    }

    await this.taskStore.addLog({
      task_id: task.id,
      phase: "reflect",
      agent: "brain",
      input_summary: `Reflect on ${outcome} (brain-driven)`,
      output_summary: outputSummary,
      cost_usd: result.costUsd,
      duration_ms: result.durationMs,
      details,
    });

    // Save lesson to claude-mem
    const lessonText = outputSummary.startsWith("LESSON:")
      ? outputSummary
      : null;
    if (this.projectMemory && lessonText) {
      const title = `Task ${task.status}: ${truncate(task.task_description, 80)}`;
      const memText = `${lessonText}\nTask: ${task.task_description}\nOutcome: ${outcome}\nVerification: ${verification.passed ? "PASSED" : "FAILED"}`;
      this.projectMemory
        .save(
          memText,
          title,
          this.memoryProject,
          this.config.projectPath,
          `db-coder-${task.id}`,
        )
        .then((saved) => {
          if (!saved)
            log.warn(`claude-mem save returned false (task ${task.id})`);
        })
        .catch((err: unknown) => {
          log.warn(`claude-mem save threw (task ${task.id})`, err);
        });
    }
  }

  // --- Utility helpers ---

  deriveMemoryProject(projectPath: string): string {
    const value = basename(projectPath)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return value || "default-project";
  }
}

// --- Exported pure function for review decision parsing ---

export type ReviewDecision = "fix" | "ignore" | "block" | "rewrite" | "split";

export interface ParsedReviewDecision {
  decision: ReviewDecision;
  reasoning: string;
  fixInstructions?: string;
  newTasks?: string[];
}

export function parseReviewDecision(
  rawText: string,
  isFinalRound: boolean,
): ParsedReviewDecision {
  const text = rawText.trim();
  const firstLine = text.split("\n")[0].trim().toUpperCase();
  const keywordMatch = /^(FIX|IGNORE|BLOCK|REWRITE|SPLIT)\b/.exec(firstLine);

  const decision: ReviewDecision | undefined = keywordMatch
    ? (keywordMatch[1].toLowerCase() as ReviewDecision)
    : undefined;

  // Include both same-line content after keyword and subsequent lines
  const rawFirstLine = text.split("\n")[0];
  const firstLineRemainder = keywordMatch
    ? rawFirstLine
        .slice(keywordMatch[0].length)
        .replace(/^[:\s]+/, "")
        .trim()
    : "";
  const restLines = text.includes("\n")
    ? text.slice(text.indexOf("\n")).trim()
    : "";
  const body = [firstLineRemainder, restLines].filter(Boolean).join("\n");

  if (decision) {
    const allowed: ReviewDecision[] = isFinalRound
      ? ["ignore", "block", "split"]
      : ["fix", "ignore", "block", "rewrite", "split"];

    if (allowed.includes(decision)) {
      // For split, extract new tasks after explicit NEW_TASKS: delimiter only
      let newTasks: string[] | undefined;
      let reasoning = body;
      if (decision === "split") {
        const delimMatch = /\bNEW[_ ]TASKS\s*:/i.exec(body);
        if (delimMatch) {
          reasoning = body.slice(0, delimMatch.index).trim();
          const taskSection = body.slice(
            delimMatch.index + delimMatch[0].length,
          );
          const tasks = taskSection
            .split("\n")
            .filter((l) => /^\s*[-*]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l))
            .map((l) =>
              l
                .replace(/^\s*[-*]\s+/, "")
                .replace(/^\s*\d+[.)]\s+/, "")
                .trim(),
            )
            .filter((l) => l.length > 0);
          if (tasks.length > 0) newTasks = tasks;
        }

        if (!newTasks) {
          return {
            decision: "block",
            reasoning: `Split without follow-up tasks: ${reasoning}`,
          };
        }
      }

      return {
        decision,
        reasoning,
        fixInstructions:
          decision === "fix" || decision === "rewrite" ? body : undefined,
        newTasks,
      };
    }
  }

  return {
    decision: "block",
    reasoning: "Decision parse failure — blocking for safety",
  };
}
