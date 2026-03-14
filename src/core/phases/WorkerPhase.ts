/**
 * WorkerPhase — Worker execution, fix, analyze, subtask orchestration.
 *
 * Methods extracted from MainLoop:
 * - workerExecute, workerFix, workerReviewFix, workerAnalyze
 * - executeSubtasks, patchSubtask
 * - COMPLEXITY_CONFIG
 */

import type { Config } from "../../config/Config.js";
/** Inline model alias resolution for brain's dynamic resource_request.model. */
const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
};
import type { TaskStore } from "../../memory/TaskStore.js";
import type { CostTracker } from "../../utils/cost.js";
import type { WorkerResult } from "../WorkerAdapter.js";
import type {
  RuntimeAdapter,
  RunResult,
} from "../../runtime/RuntimeAdapter.js";
import { findRuntimeForModel } from "../../runtime/runtimeFactory.js";
import type { Task, SubTaskRecord } from "../../memory/types.js";
import type { VerifyBaseline } from "../ProjectVerifier.js";
import type { PersonaLoader, WorkInstructions } from "../PersonaLoader.js";
import { getModifiedAndAddedFiles, commitAll } from "../../utils/git.js";
import { log } from "../../utils/logger.js";
import { truncate } from "../../utils/parse.js";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PatchSubtaskResult =
  | { ok: true; task: Task }
  | { ok: false; reason: "task-gone" }
  | { ok: false; reason: "subtask-not-found" };

export type HardVerifyFn = (
  baseline: VerifyBaseline,
  startCommit: string,
  projectPath: string,
) => Promise<{ passed: boolean; reason?: string }>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

interface ComplexityConfig {
  maxTurns: number;
  maxBudget: number;
  timeout: number;
  maxReviewFixes: number;
}

/** Default resource limits per complexity level (model is handled by routing config). */
export const COMPLEXITY_CONFIG: Record<string, ComplexityConfig> = {
  S: { maxTurns: 100, maxBudget: 5.0, timeout: 600_000, maxReviewFixes: 1 },
  M: { maxTurns: 200, maxBudget: 10.0, timeout: 1_200_000, maxReviewFixes: 2 },
  L: { maxTurns: 200, maxBudget: 15.0, timeout: 2_400_000, maxReviewFixes: 3 },
  XL: { maxTurns: 200, maxBudget: 20.0, timeout: 3_600_000, maxReviewFixes: 3 },
};

/** Return validated complexity key, falling back to "M" for unknown values. */
export function safeComplexity(raw: string | undefined | null): string {
  return raw && raw in COMPLEXITY_CONFIG ? raw : "M";
}

/**
 * Resolve a model ID from brain's resource_request.
 * Handles both aliases ("opus" -> "claude-opus-4-6") and full IDs
 * (e.g. "gpt-5.3-codex", "claude-opus-4-6").
 *
 * Decision chain:
 * 1. Full model IDs (contain "-") pass through unchanged
 * 2. Known aliases ("opus", "sonnet") resolve via MODEL_MAP
 * 3. Unknown short names fall back to defaultModel with warning
 */
/**
 * Resolve a model ID from brain's resource_request.
 * - Known aliases ("opus", "sonnet") → canonical ID via MODEL_ALIASES
 * - Full model IDs (e.g. "claude-opus-4-6", "gpt-5.3-codex") → pass through
 * - Unknown short names → fall back to defaultModel with warning
 */
export function resolveModelForBrain(
  brainModel: string,
  defaultModel: string,
): string {
  // Full model IDs (contain "-") pass through
  if (brainModel.includes("-")) {
    return brainModel;
  }
  // Short name: try alias resolution
  const resolved = MODEL_ALIASES[brainModel];
  if (resolved) {
    return resolved; // known alias was mapped
  }
  // Unknown short name — no alias found, fall back to default
  log.warn(
    `resource_request.model "${brainModel}" is not a recognized alias, using default "${defaultModel}"`,
  );
  return defaultModel;
}

// ---------------------------------------------------------------------------
// WorkerPhase class
// ---------------------------------------------------------------------------

/** Convert RuntimeAdapter RunResult to WorkerResult (consumed by MainLoop). */
function toWorkerResult(r: RunResult): WorkerResult {
  return {
    text: r.text,
    costUsd: r.costUsd,
    durationMs: r.durationMs,
    sessionId: r.sessionId,
    isError: r.isError,
    errors: r.errors,
  };
}

export class WorkerPhase {
  /**
   * Tracks the runtime actually used during the last execute call.
   * When cross-runtime model switching kicks in, this differs from this.worker.
   * workerFix/workerReviewFix use this to stay on the same runtime as execute,
   * preventing sessionId mismatches across providers.
   */
  private lastEffectiveRuntime: RuntimeAdapter | undefined;

  /** The runtime name that should appear in logs/task_logs for the current task. */
  get effectiveRuntimeName(): string {
    return (this.lastEffectiveRuntime ?? this.worker).name;
  }

  constructor(
    private readonly config: Config,
    private readonly taskStore: TaskStore,
    private readonly costTracker: CostTracker,
    private readonly worker: RuntimeAdapter,
    private readonly personaLoader: PersonaLoader,
    private readonly hardVerify: HardVerifyFn,
  ) {}

  // --- Worker execution ---

  async workerExecute(
    task: Task,
    opts?: {
      persona?: string;
      taskType?: string;
      complexity?: string;
      subtaskDescription?: string;
      workInstructions?: WorkInstructions;
      approvedPlan?: string;
      resumeSessionId?: string;
      // Brain-driven mode (B-1)
      directive?: string;
      resourceRequest?: {
        budget_usd: number;
        timeout_s: number;
        model?: string;
      };
      reviewChecklist?: string;
    },
  ): Promise<WorkerResult> {
    // Reset per-task runtime tracking (set again by execute paths below)
    this.lastEffectiveRuntime = undefined;

    // Brain-driven: directive passthrough with minimal wrapping
    // (brain-driven is the only path since Phase 4; gate on directive presence
    // for backward compat with legacy queue tasks that lack a directive)
    if (opts?.directive) {
      return this.workerExecuteBrainDriven(task, opts);
    }

    const description = opts?.subtaskDescription ?? task.task_description;
    const { prompt: basePrompt, systemPrompt } =
      await this.personaLoader.buildWorkerPrompt({
        taskDescription: description,
        personaName: opts?.persona,
        taskType: opts?.taskType,
        workInstructions: opts?.workInstructions,
      });

    // Full prompt for new sessions or when resume fails silently (e.g. Codex
    // with non-full-auto sandbox).  Adapter uses resumePrompt when it can
    // actually resume, falling back to the full prompt otherwise.
    const checklistSuffix = opts?.reviewChecklist
      ? `\n\n${opts.reviewChecklist}`
      : "";
    const prompt = opts?.approvedPlan
      ? `${basePrompt}\n\n## Approved Implementation Plan\nFollow this plan that was reviewed and approved:\n\n${opts.approvedPlan}${checklistSuffix}`
      : `${basePrompt}${checklistSuffix}`;

    const resumePrompt = opts?.resumeSessionId
      ? `--- NEXT SUBTASK ---\n${description}\n\n${opts?.approvedPlan ? `## Approved Plan\n${opts.approvedPlan}\n\n` : ""}${opts?.reviewChecklist ? `${opts.reviewChecklist}\n\n` : ""}Continue working in this session.`
      : undefined;

    const rawComplexity =
      opts?.complexity ??
      ((task.plan as Record<string, unknown> | null)?.complexity as
        | string
        | undefined);
    const complexity = safeComplexity(rawComplexity);
    const cConfig = COMPLEXITY_CONFIG[complexity];

    const model = this.resolveWorkerModel();

    const result = await this.worker.run(prompt, {
      cwd: this.config.projectPath,
      maxTurns: cConfig.maxTurns,
      maxBudget: Math.min(
        cConfig.maxBudget,
        this.config.values.claude.maxTaskBudget,
      ),
      timeout: cConfig.timeout,
      model,
      systemPrompt,
      resumeSessionId: opts?.resumeSessionId,
      resumePrompt,
    });
    return toWorkerResult(result);
  }

  /**
   * Brain-driven execution: directive goes through with only
   * GLOBAL_WORKER_RULES appended (no PersonaLoader restructuring).
   */
  private async workerExecuteBrainDriven(
    task: Task,
    opts: {
      directive?: string;
      resourceRequest?: {
        budget_usd: number;
        timeout_s: number;
        model?: string;
      };
      approvedPlan?: string;
      resumeSessionId?: string;
      complexity?: string;
      reviewChecklist?: string;
    },
  ): Promise<WorkerResult> {
    const { GLOBAL_WORKER_RULES } = await import("../PersonaLoader.js");

    // directive is the primary prompt; worker rules are supplementary
    let prompt = `${opts.directive}\n\nRead CLAUDE.md for project context and environment rules.\n\n${GLOBAL_WORKER_RULES}`;

    if (opts.reviewChecklist) {
      prompt += `\n\n${opts.reviewChecklist}`;
    }

    if (opts.approvedPlan) {
      prompt += `\n\n## Approved Implementation Plan\n${opts.approvedPlan}`;
    }

    // Inject verification plan so the worker knows how success is measured
    if (task.verification_plan) {
      prompt += `\n\n## Verification Plan\n${task.verification_plan}`;
    }

    // Resource request -> actual limits (brain request capped by config)
    const rr = opts.resourceRequest;
    const maxBudget = rr
      ? Math.min(rr.budget_usd, this.config.values.budget.maxPerTask)
      : this.config.values.claude.maxTaskBudget;
    const timeout = rr
      ? Math.min(rr.timeout_s * 1000, 3_600_000) // hard cap 1h
      : COMPLEXITY_CONFIG[safeComplexity(opts.complexity)].timeout;

    // Model: resolve brain's model request, then validate worker compatibility.
    const defaultModel = this.resolveWorkerModel();
    const resolvedModel = rr?.model
      ? resolveModelForBrain(rr.model, defaultModel)
      : defaultModel;

    // Compatibility check: resolved model must be supported by worker runtime.
    // If not, validateModelForWorker may return an alternative runtime.
    const { model, runtime: effectiveRuntime } = this.validateModelForWorker(
      resolvedModel,
      defaultModel,
      rr?.model,
    );
    // Track for subsequent fix/review-fix calls within the same task
    this.lastEffectiveRuntime = effectiveRuntime;

    const resumePrompt = opts.resumeSessionId
      ? `Continue working on this task.\n\n${opts.approvedPlan ? `## Approved Plan\n${opts.approvedPlan}\n\n` : ""}${opts.reviewChecklist ? `${opts.reviewChecklist}\n\n` : ""}Proceed.`
      : undefined;

    const complexityTurns =
      COMPLEXITY_CONFIG[safeComplexity(opts.complexity)].maxTurns;
    const maxTurns = rr
      ? Math.min(this.config.values.claude.maxTurns, complexityTurns)
      : complexityTurns;

    const result = await effectiveRuntime.run(prompt, {
      cwd: this.config.projectPath,
      maxTurns,
      maxBudget,
      timeout,
      model,
      resumeSessionId: opts.resumeSessionId,
      resumePrompt,
    });
    return toWorkerResult(result);
  }

  /**
   * Resolve the default model for a given runtime.
   * Priority: routing.execute.model > legacy fallbacks.
   * Model aliases are normalized at Config construction time.
   *
   * @param runtime - the runtime to check compatibility against (defaults to this.worker)
   */
  private resolveWorkerModel(runtime?: RuntimeAdapter): string {
    const rt = runtime ?? this.worker;

    // 1. Use routing.execute.model as the canonical source (already normalized)
    const routingModel = this.config.values.routing.execute.model;
    if (rt.supportsModel(routingModel)) return routingModel;

    // 2. Legacy fallbacks (already normalized at Config construction)
    const configModel = this.config.values.claude.model;
    if (rt.supportsModel(configModel)) return configModel;
    return this.config.values.codex.model;
  }

  /**
   * Validate that a resolved model is compatible with the current worker runtime.
   * Uses runtime.supportsModel() instead of name-based checks.
   *
   * Returns { model, runtime } — runtime may differ from this.worker if
   * cross-runtime routing kicks in.
   */
  private validateModelForWorker(
    resolvedModel: string,
    defaultModel: string,
    originalRequest?: string,
  ): { model: string; runtime: RuntimeAdapter } {
    if (this.worker.supportsModel(resolvedModel)) {
      return { model: resolvedModel, runtime: this.worker };
    }

    // Incompatible: check strictModelRouting
    const strict = this.config.values.experimental?.strictModelRouting === true;
    if (strict) {
      throw new Error(
        `strictModelRouting: model "${resolvedModel}" (requested: "${originalRequest}") is incompatible with worker "${this.worker.name}"`,
      );
    }

    // Try cross-runtime routing: find another registered runtime that supports this model
    const altRuntime = findRuntimeForModel(resolvedModel);
    if (altRuntime) {
      log.warn(
        `resource_request.model "${originalRequest}" resolved to "${resolvedModel}" incompatible with "${this.worker.name}", ` +
          `temporarily switching to "${altRuntime.name}" for this task`,
      );
      return { model: resolvedModel, runtime: altRuntime };
    }

    log.warn(
      `resource_request.model "${originalRequest}" resolved to "${resolvedModel}" incompatible with "${this.worker.name}", ` +
        `no compatible runtime available, falling back to "${defaultModel}"`,
    );
    return { model: defaultModel, runtime: this.worker };
  }

  // --- Worker fix (resume session to fix verification errors) ---

  async workerFix(
    sessionId: string,
    errors: string,
    task: Task,
  ): Promise<WorkerResult> {
    const prompt = `The previous changes failed verification:\n${errors}\n\nFix these issues. The original task was: ${task.task_description}\n\nUse superpowers:systematic-debugging to investigate the root cause.\nFollow all 4 phases: investigate → analyze → hypothesize → implement.\nDo NOT guess or "try changing X". Find the actual root cause first.`;

    // Use the same runtime that executed the task — prevents sessionId from
    // landing on the wrong provider after cross-runtime switching.
    const runtime = this.lastEffectiveRuntime ?? this.worker;

    const result = await runtime.run(prompt, {
      cwd: this.config.projectPath,
      maxTurns: 100,
      maxBudget: this.config.values.claude.maxTaskBudget,
      timeout: 600_000,
      model: this.resolveWorkerModel(runtime),
      resumeSessionId: sessionId,
    });
    return toWorkerResult(result);
  }

  // --- Worker review fix ---

  async workerReviewFix(
    task: Task,
    fixInstructions: string,
    sessionId?: string,
    cumulativeContext?: string,
    isRewrite?: boolean,
  ): Promise<{
    costUsd: number;
    durationMs: number;
    sessionId?: string;
    isError: boolean;
  }> {
    const cumulativeCtx = cumulativeContext ? `\n${cumulativeContext}\n` : "";

    const prompt = isRewrite
      ? `The previous approach was fundamentally wrong. A rewrite is needed.

## Original Task
${task.task_description}

## Rewrite Instructions
${fixInstructions}
${cumulativeCtx}
Implement a fresh solution following the new instructions. You may discard the previous approach entirely.`
      : `The code review found issues that need fixing.

## Original Task
${task.task_description}

## Fix Instructions
${fixInstructions}
${cumulativeCtx}
Fix these issues. Do not make unrelated changes.`;

    // Use the same runtime that executed the task (see workerFix comment)
    const runtime = this.lastEffectiveRuntime ?? this.worker;

    const runResult = await runtime.run(prompt, {
      cwd: this.config.projectPath,
      maxTurns: 100,
      maxBudget: this.config.values.claude.maxTaskBudget,
      timeout: 600_000,
      model: this.resolveWorkerModel(runtime),
      resumeSessionId: sessionId,
    });
    const result = toWorkerResult(runResult);

    if (result.costUsd > 0) {
      await this.costTracker.addCost(task.id, result.costUsd);
    }

    await this.taskStore.addLog({
      task_id: task.id,
      phase: "executing",
      agent: `${this.effectiveRuntimeName}-review-fix`,
      input_summary: isRewrite ? "Review rewrite" : "Review fix",
      output_summary: result.text,
      cost_usd: result.costUsd,
      duration_ms: result.durationMs,
    });

    return {
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      sessionId: result.sessionId,
      isError: result.isError,
    };
  }

  // --- Worker analyze (M/L/XL read-only analysis) ---

  async workerAnalyze(
    task: Task,
    brainOpts?: {
      persona?: string;
      taskType?: string;
      complexity?: string;
      workInstructions?: WorkInstructions;
    },
    revision?: {
      resumeSessionId?: string;
      revisionPrompt: string;
    },
  ): Promise<{
    proposal: string;
    costUsd: number;
    isError: boolean;
    sessionId?: string;
  }> {
    let analyzePrompt: string;

    if (revision) {
      analyzePrompt = revision.revisionPrompt;
    } else {
      const { prompt: basePrompt } = await this.personaLoader.buildWorkerPrompt(
        {
          taskDescription: task.task_description,
          personaName: brainOpts?.persona,
          taskType: brainOpts?.taskType,
          workInstructions: brainOpts?.workInstructions,
        },
      );

      analyzePrompt = `## Analysis Mode (Read-Only)

You are analyzing code to produce a detailed change proposal. Do NOT modify any files.

${basePrompt}

## Required Output

Produce a structured proposal with:
1. **Files to modify** — exact file paths and what changes are needed
2. **New files to create** — path, purpose, key interfaces/classes
3. **Dependencies** — imports to add, packages needed
4. **Risk assessment** — what could go wrong, edge cases
5. **Test strategy** — what tests to add/modify

Be specific: include function signatures, type definitions, and concrete code snippets where helpful.`;
    }

    const complexity = safeComplexity(brainOpts?.complexity);
    const cConfig = COMPLEXITY_CONFIG[complexity];

    const runResult = await this.worker.run(analyzePrompt, {
      cwd: this.config.projectPath,
      maxTurns: Math.min(cConfig.maxTurns, 100),
      maxBudget: Math.min(cConfig.maxBudget, 5.0),
      timeout: Math.min(cConfig.timeout, 600_000),
      model: this.resolveWorkerModel(),
      readOnly: true,
      disallowedTools: ["Edit", "Write", "NotebookEdit"],
      systemPrompt:
        "You are analyzing code for planning purposes. Do NOT modify any files — only read and analyze.",
      resumeSessionId: revision?.resumeSessionId,
    });
    const result = toWorkerResult(runResult);

    if (result.costUsd > 0) {
      await this.costTracker.addCost(task.id, result.costUsd);
    }

    const phase = revision ? "analyzing-revision" : "analyzing";
    await this.taskStore.addLog({
      task_id: task.id,
      phase,
      agent: this.effectiveRuntimeName,
      input_summary: task.task_description,
      output_summary: result.text,
      cost_usd: result.costUsd,
      duration_ms: result.durationMs,
    });

    return {
      proposal: result.text,
      costUsd: result.costUsd,
      isError: result.isError || !result.text.trim(),
      sessionId: result.sessionId,
    };
  }

  // --- Subtask execution ---

  async executeSubtasks(
    task: Task,
    subtasks: Array<{ description: string; order: number }>,
    opts: {
      persona?: string;
      taskType?: string;
      complexity?: string;
      workInstructions?: WorkInstructions;
      baseline: VerifyBaseline;
      startCommit: string;
      reviewChecklist?: string;
    },
  ): Promise<{
    success: boolean;
    sessionId?: string;
    reason?: string;
    failureKind?: "task-gone" | "subtask-not-found";
    totalVerifyMs: number;
  }> {
    let totalVerifyMs = 0;
    const freshTask = await this.taskStore.getTask(task.id);
    if (!freshTask) {
      const reason = `Task ${task.id} disappeared before subtask execution`;
      log.error(reason);
      return { success: false, reason, totalVerifyMs };
    }
    task = freshTask;

    const orderToId = new Map<number, string>();
    for (const s of task.subtasks ?? []) {
      if (s.order != null) {
        if (orderToId.has(s.order)) {
          log.warn(`Duplicate subtask order ${s.order}, keeping first`);
        } else {
          orderToId.set(s.order, s.id);
        }
      }
    }
    const initialPersistedIds = new Set((task.subtasks ?? []).map((s) => s.id));
    const persistedOrderById = new Map(
      (task.subtasks ?? []).map((s) => [s.id, s.order]),
    );
    const withId = subtasks.map((st) => {
      const matchedId = orderToId.get(st.order);
      if (matchedId != null) {
        return { ...st, subtaskId: matchedId };
      }
      const fallback = String(st.order);
      if (initialPersistedIds.has(fallback)) {
        const persistedOrder = persistedOrderById.get(fallback);
        if (persistedOrder == null) {
          log.warn(
            `Persisted subtask has no order field for fallback id=${fallback}, order=${st.order}, using sentinel`,
          );
          return { ...st, subtaskId: `__sentinel_${randomUUID()}` };
        }
        if (Number(persistedOrder) === Number(st.order)) {
          log.warn(
            `Persisted subtask fallback id=${fallback} matches order=${st.order}, reusing id`,
          );
          return { ...st, subtaskId: fallback };
        }
        log.warn(
          `Fallback id=${fallback} has order=${persistedOrder} but expected order=${st.order}, using sentinel`,
        );
        return { ...st, subtaskId: `__sentinel_${randomUUID()}` };
      }
      log.warn(
        `No persisted subtask for order=${st.order}, fallback=${fallback} not in persisted subtasks, using sentinel`,
      );
      return { ...st, subtaskId: `__sentinel_${randomUUID()}` };
    });
    const sorted = withId.toSorted((a, b) => {
      const aOrd = Number.isFinite(a.order) ? a.order : Infinity;
      const bOrd = Number.isFinite(b.order) ? b.order : Infinity;
      if (aOrd === bOrd) return 0;
      if (!Number.isFinite(aOrd)) return 1;
      if (!Number.isFinite(bOrd)) return -1;
      return aOrd - bOrd;
    });

    let lastSuccessfulSessionId: string | undefined;

    for (let i = 0; i < sorted.length; i++) {
      const st = sorted[i];
      const isPersisted = (task.subtasks ?? []).some(
        (s) => s.id === st.subtaskId,
      );
      log.info(
        `Subtask ${i + 1}/${sorted.length}: ${truncate(st.description, 100)}`,
      );

      if (isPersisted) {
        const result = await this.patchSubtask(task.id, st.subtaskId, {
          status: "running",
        });
        if (!result.ok) {
          const reason =
            result.reason === "task-gone"
              ? `Task ${task.id} disappeared during running-status write`
              : `Subtask ${st.subtaskId} not found in task ${task.id} during running-status write`;
          log.error(reason);
          return {
            success: false,
            reason,
            failureKind: result.reason,
            totalVerifyMs,
          };
        }
        task = result.task;
      }

      const result = await this.workerExecute(task, {
        persona: opts.persona,
        taskType: opts.taskType,
        complexity: opts.complexity,
        workInstructions: opts.workInstructions,
        subtaskDescription: st.description,
        resumeSessionId: lastSuccessfulSessionId,
        reviewChecklist: opts.reviewChecklist,
      });

      if (result.costUsd > 0)
        await this.costTracker.addCost(task.id, result.costUsd);

      await this.taskStore.addLog({
        task_id: task.id,
        phase: "execute",
        agent: this.effectiveRuntimeName,
        input_summary: `subtask ${i + 1}/${sorted.length}: ${truncate(st.description, 80)}`,
        output_summary: result.text,
        cost_usd: result.costUsd,
        duration_ms: result.durationMs,
      });

      let subtaskWorkerErrMsg: string | undefined;
      if (result.isError) {
        subtaskWorkerErrMsg = `Subtask ${i + 1} worker reported error: ${result.errors.join("; ") || "unknown error"}`;
        log.warn(subtaskWorkerErrMsg);
        if (isPersisted) {
          const result = await this.patchSubtask(task.id, st.subtaskId, {
            workerError: subtaskWorkerErrMsg,
          });
          if (!result.ok) {
            const reason =
              result.reason === "task-gone"
                ? `Task ${task.id} disappeared during error-status write`
                : `Subtask ${st.subtaskId} not found in task ${task.id} during error-status write`;
            log.error(reason);
            return {
              success: false,
              reason,
              failureKind: result.reason,
              totalVerifyMs,
            };
          }
          task = result.task;
        } else {
          const refreshed = await this.taskStore.getTask(task.id);
          if (!refreshed) {
            const reason = `Task ${task.id} disappeared during subtask error processing`;
            log.error(reason);
            return { success: false, reason, totalVerifyMs };
          }
          task = refreshed;
        }
      }

      // Per-subtask hard verify with HALT retry loop
      const verifyStart = Date.now();
      let verification: { passed: boolean; reason?: string };
      try {
        verification = await this.hardVerify(
          opts.baseline,
          opts.startCommit,
          this.config.projectPath,
        );
      } finally {
        totalVerifyMs += Date.now() - verifyStart;
      }
      if (!verification.passed) {
        const maxRetries = this.config.values.autonomy.maxRetries;
        let fixAttempts = 0;
        let currentSessionId = result.sessionId;
        let lastVerification = verification;

        const retryPhaseStart = Date.now();
        try {
          while (
            !lastVerification.passed &&
            currentSessionId &&
            fixAttempts < maxRetries
          ) {
            fixAttempts++;
            log.warn(
              `Subtask ${i + 1} verification failed (attempt ${fixAttempts}/${maxRetries}): ${lastVerification.reason}`,
            );
            const fixResult = await this.workerFix(
              currentSessionId,
              lastVerification.reason ?? "Unknown",
              task,
            );
            if (fixResult.costUsd > 0)
              await this.costTracker.addCost(task.id, fixResult.costUsd);
            currentSessionId = fixResult.sessionId ?? currentSessionId;

            const changedFilesForCommit = await getModifiedAndAddedFiles(
              this.config.projectPath,
            ).catch(() => []);
            try {
              await commitAll(
                "db-coder: fix verification issues",
                this.config.projectPath,
                changedFilesForCommit,
              );
            } catch (commitErr) {
              log.error(
                `commitAll failed during subtask verification retry ${fixAttempts}: ${commitErr}`,
              );
              lastVerification = {
                passed: false,
                reason: `commitAll failed: ${commitErr instanceof Error ? commitErr.message : String(commitErr)}`,
              };
              break;
            }
            lastVerification = await this.hardVerify(
              opts.baseline,
              opts.startCommit,
              this.config.projectPath,
            );
          }
        } finally {
          totalVerifyMs += Date.now() - retryPhaseStart;
        }

        if (!lastVerification.passed) {
          const haltMsg = currentSessionId
            ? `HALT after ${fixAttempts} fix attempts: ${lastVerification.reason}`
            : `Verification failed, no session to fix: ${lastVerification.reason}`;
          log.warn(`Subtask ${i + 1}: ${haltMsg}`);

          if (opts.persona) {
            await this.taskStore.addLog({
              task_id: task.id,
              phase: "halt-learning",
              agent: "system",
              input_summary: `subtask=${i + 1}`,
              output_summary: `HALT triggered: ${lastVerification.reason} (after ${fixAttempts} attempts)`,
              cost_usd: 0,
              duration_ms: 0,
            });
          }

          if (isPersisted) {
            const result = await this.patchSubtask(task.id, st.subtaskId, {
              status: "failed",
              result: lastVerification.reason,
            });
            if (!result.ok) {
              const reason =
                result.reason === "task-gone"
                  ? `Task ${task.id} disappeared during verification-failure write`
                  : `Subtask ${st.subtaskId} not found in task ${task.id} during verification-failure write`;
              log.error(reason);
              return {
                success: false,
                reason,
                failureKind: result.reason,
                totalVerifyMs,
              };
            }
            task = result.task;
          }
          const verifyReason = lastVerification.reason || "verification failed";
          const fullReason = subtaskWorkerErrMsg
            ? `${verifyReason} (worker also reported: ${result.errors.join("; ") || "unknown error"})`
            : verifyReason;
          return { success: false, reason: fullReason, totalVerifyMs };
        }
      }

      if (isPersisted) {
        const result = await this.patchSubtask(task.id, st.subtaskId, {
          status: "done",
        });
        if (!result.ok) {
          const reason =
            result.reason === "task-gone"
              ? `Task ${task.id} disappeared during done-status write`
              : `Subtask ${st.subtaskId} not found in task ${task.id} during done-status write`;
          log.error(reason);
          return {
            success: false,
            reason,
            failureKind: result.reason,
            totalVerifyMs,
          };
        }
        task = result.task;
      } else {
        const refreshed = await this.taskStore.getTask(task.id);
        if (!refreshed) {
          const reason = `Task ${task.id} disappeared after marking subtask done`;
          log.error(reason);
          return { success: false, reason, totalVerifyMs };
        }
        task = refreshed;
      }

      lastSuccessfulSessionId = result.sessionId;
    }

    return { success: true, totalVerifyMs };
  }

  // --- Private helpers ---

  private async patchSubtask(
    taskId: string,
    subtaskId: string,
    patch: Partial<Pick<SubTaskRecord, "status" | "result" | "workerError">>,
  ): Promise<PatchSubtaskResult> {
    const fresh = await this.taskStore.getTask(taskId);
    if (!fresh) return { ok: false, reason: "task-gone" };
    let matched = false;
    const patched = (fresh.subtasks ?? []).map((s) => {
      if (s.id === subtaskId) {
        matched = true;
        return { ...s, ...patch };
      }
      return s;
    });
    if (!matched) {
      log.warn(
        `patchSubtask: subtaskId ${subtaskId} not found in task ${taskId}, skipping write`,
      );
      return { ok: false, reason: "subtask-not-found" };
    }
    await this.taskStore.updateTask(taskId, { subtasks: patched });
    const verified = await this.taskStore.getTask(taskId);
    if (!verified) return { ok: false, reason: "task-gone" };
    return { ok: true, task: verified };
  }
}
