/**
 * WorkerPhase — Worker execution, fix, analyze, subtask orchestration.
 *
 * Methods extracted from MainLoop:
 * - workerExecute, workerFix, workerReviewFix, workerAnalyze
 * - executeSubtasks, patchSubtask
 * - COMPLEXITY_CONFIG
 */

import type { Config } from "../../config/Config.js";
import { resolveModelId } from "../../config/Config.js";
import type { TaskStore } from "../../memory/TaskStore.js";
import type { CostTracker } from "../../utils/cost.js";
import type { WorkerAdapter, WorkerResult } from "../WorkerAdapter.js";
import type { RuntimeAdapter } from "../../runtime/RuntimeAdapter.js";

// Thin seam: WorkerPhase accepts either the legacy WorkerAdapter or
// the new RuntimeAdapter. Phase 3 will remove WorkerAdapter from this union.
export type WorkerRuntime = WorkerAdapter | RuntimeAdapter;

/** Type guard: distinguish RuntimeAdapter from WorkerAdapter */
function isRuntimeAdapter(rt: WorkerRuntime): rt is RuntimeAdapter {
  return "capabilities" in rt;
}
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
  model?: string; // Claude model override (e.g. "sonnet", "opus"); ignored by Codex
}

export const COMPLEXITY_CONFIG: Record<string, ComplexityConfig> = {
  S: { maxTurns: 100, maxBudget: 5.0, timeout: 600_000, model: "sonnet" },
  M: { maxTurns: 200, maxBudget: 10.0, timeout: 1_200_000, model: "sonnet" },
  L: { maxTurns: 200, maxBudget: 15.0, timeout: 2_400_000, model: "opus" },
  XL: { maxTurns: 200, maxBudget: 20.0, timeout: 3_600_000, model: "opus" },
};

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
export function resolveModelForBrain(
  brainModel: string,
  defaultModel: string,
): string {
  // Full model IDs (contain "-") pass through — could be Claude, Codex, or any provider
  if (brainModel.includes("-")) {
    return brainModel;
  }
  // Short name: try alias resolution
  const resolved = resolveModelId(brainModel);
  if (resolved !== brainModel) {
    // resolveModelId mapped it (or fell back to sonnet for unknown).
    // Check if it's a known alias vs unknown fallback.
    if (brainModel === "opus" || brainModel === "sonnet") {
      return resolved; // known alias
    }
    // Unknown alias — resolveModelId silently fell back to sonnet.
    // Use defaultModel instead to avoid silent downgrade.
    log.warn(
      `resource_request.model "${brainModel}" is not a recognized alias, using default "${defaultModel}"`,
    );
    return defaultModel;
  }
  // resolved === brainModel: no mapping found and no fallback triggered.
  // This shouldn't happen with current resolveModelId (always falls back),
  // but handle it defensively.
  return brainModel;
}

// ---------------------------------------------------------------------------
// WorkerPhase class
// ---------------------------------------------------------------------------

export class WorkerPhase {
  constructor(
    private readonly config: Config,
    private readonly taskStore: TaskStore,
    private readonly costTracker: CostTracker,
    private readonly worker: WorkerRuntime,
    private readonly personaLoader: PersonaLoader,
    private readonly hardVerify: HardVerifyFn,
  ) {}

  /**
   * Narrow worker to WorkerAdapter for legacy code paths.
   * Phase 3 will remove this once all call sites use RuntimeAdapter.run().
   */
  private get legacyWorker(): WorkerAdapter {
    if (isRuntimeAdapter(this.worker)) {
      throw new Error(
        "WorkerPhase: legacy code path called with RuntimeAdapter — migrate to RuntimeAdapter.run()",
      );
    }
    return this.worker;
  }

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
      isBrainDriven?: boolean;
    },
  ): Promise<WorkerResult> {
    // Brain-driven: directive passthrough with minimal wrapping
    if (opts?.isBrainDriven && opts.directive) {
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
    const prompt = opts?.approvedPlan
      ? `${basePrompt}\n\n## Approved Implementation Plan\nFollow this plan that was reviewed and approved:\n\n${opts.approvedPlan}`
      : basePrompt;

    const resumePrompt = opts?.resumeSessionId
      ? `--- NEXT SUBTASK ---\n${description}\n\n${opts?.approvedPlan ? `## Approved Plan\n${opts.approvedPlan}\n\n` : ""}Continue working in this session.`
      : undefined;

    const complexity =
      opts?.complexity ??
      ((task.plan as Record<string, unknown> | null)?.complexity as
        | string
        | undefined);
    const cConfig = COMPLEXITY_CONFIG[complexity ?? "M"];

    const model =
      this.legacyWorker.name === "claude"
        ? cConfig.model
          ? resolveModelId(cConfig.model)
          : resolveModelId(this.config.values.claude.model)
        : this.config.values.codex.model;

    return this.legacyWorker.execute(prompt, {
      cwd: this.config.projectPath,
      maxTurns: cConfig.maxTurns,
      maxBudget: Math.min(
        cConfig.maxBudget,
        this.config.values.claude.maxTaskBudget,
      ),
      timeout: cConfig.timeout,
      model,
      appendSystemPrompt: systemPrompt,
      resumeSessionId: opts?.resumeSessionId,
      resumePrompt,
    });
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
    },
  ): Promise<WorkerResult> {
    const { GLOBAL_WORKER_RULES } = await import("../PersonaLoader.js");

    // directive is the primary prompt; worker rules are supplementary
    let prompt = `${opts.directive}\n\nRead CLAUDE.md for project context and environment rules.\n\n${GLOBAL_WORKER_RULES}`;

    if (opts.approvedPlan) {
      prompt += `\n\n## Approved Implementation Plan\n${opts.approvedPlan}`;
    }

    // Resource request -> actual limits (brain request capped by config)
    const rr = opts.resourceRequest;
    const maxBudget = rr
      ? Math.min(rr.budget_usd, this.config.values.budget.maxPerTask)
      : this.config.values.claude.maxTaskBudget;
    const timeout = rr
      ? Math.min(rr.timeout_s * 1000, 3_600_000) // hard cap 1h
      : COMPLEXITY_CONFIG[opts.complexity ?? "M"].timeout;

    // Model: resolve brain's model request, then validate worker compatibility.
    // defaultModel must match the current worker's model space, otherwise
    // validateModelForWorker's fallback would land on an incompatible model.
    const complexity = opts.complexity ?? "M";
    const cConfig = COMPLEXITY_CONFIG[complexity] ?? COMPLEXITY_CONFIG.M;
    const isClaudeWorker = this.legacyWorker.name === "claude";
    const defaultModel = isClaudeWorker
      ? cConfig.model
        ? resolveModelId(cConfig.model)
        : resolveModelId(this.config.values.claude.model)
      : this.config.values.codex.model;
    const resolvedModel = rr?.model
      ? resolveModelForBrain(rr.model, defaultModel)
      : defaultModel;

    // Compatibility check: resolved model must match the current worker
    const model = this.validateModelForWorker(
      resolvedModel,
      defaultModel,
      rr?.model,
    );

    const resumePrompt = opts.resumeSessionId
      ? `Continue working on this task.\n\n${opts.approvedPlan ? `## Approved Plan\n${opts.approvedPlan}\n\n` : ""}Proceed.`
      : undefined;

    // NOTE: opts.model is resolved and validated above, but CodexWorkerAdapter
    // currently ignores it (codex model comes from ~/.codex/config.toml).
    // Model override for codex will take effect in Phase A-2 (CodexSdkRuntime).
    return this.legacyWorker.execute(prompt, {
      cwd: this.config.projectPath,
      maxTurns: cConfig.maxTurns,
      maxBudget,
      timeout,
      model,
      resumeSessionId: opts.resumeSessionId,
      resumePrompt,
    });
  }

  /**
   * Validate that a resolved model is compatible with the current worker.
   * Claude worker only accepts claude-* models; Codex only non-claude models.
   * Incompatible → falls back to defaultModel (or throws if strictModelRouting).
   */
  private validateModelForWorker(
    resolvedModel: string,
    defaultModel: string,
    originalRequest?: string,
  ): string {
    const workerName = this.legacyWorker.name;
    const isClaudeModel = resolvedModel.startsWith("claude-");
    const isClaudeWorker = workerName === "claude";
    const isCompatible =
      (isClaudeWorker && isClaudeModel) || (!isClaudeWorker && !isClaudeModel);

    if (isCompatible) return resolvedModel;

    // Incompatible: check strictModelRouting
    const strict = this.config.values.experimental?.strictModelRouting === true;
    if (strict) {
      throw new Error(
        `strictModelRouting: model "${resolvedModel}" (requested: "${originalRequest}") is incompatible with worker "${workerName}"`,
      );
    }

    log.warn(
      `resource_request.model "${originalRequest}" resolved to "${resolvedModel}" which is incompatible with worker "${workerName}", falling back to "${defaultModel}"`,
    );
    return defaultModel;
  }

  // --- Worker fix (resume session to fix verification errors) ---

  async workerFix(
    sessionId: string,
    errors: string,
    task: Task,
  ): Promise<WorkerResult> {
    return this.legacyWorker.fix(
      `The previous changes failed verification:\n${errors}\n\nFix these issues. The original task was: ${task.task_description}\n\nUse superpowers:systematic-debugging to investigate the root cause.\nFollow all 4 phases: investigate → analyze → hypothesize → implement.\nDo NOT guess or "try changing X". Find the actual root cause first.`,
      {
        cwd: this.config.projectPath,
        maxTurns: 100,
        maxBudget: this.config.values.claude.maxTaskBudget,
        timeout: 600_000,
        model: resolveModelId(this.config.values.claude.model),
        resumeSessionId: sessionId,
      },
    );
  }

  // --- Worker review fix ---

  async workerReviewFix(
    task: Task,
    fixInstructions: string,
    sessionId?: string,
  ): Promise<{ costUsd: number; sessionId?: string; isError: boolean }> {
    const prompt = `The code review found issues that need fixing.

## Original Task
${task.task_description}

## Fix Instructions
${fixInstructions}

Fix these issues. Do not make unrelated changes.`;

    const result = await this.legacyWorker.fix(prompt, {
      cwd: this.config.projectPath,
      maxTurns: 100,
      maxBudget: this.config.values.claude.maxTaskBudget,
      timeout: 600_000,
      model: resolveModelId(this.config.values.claude.model),
      resumeSessionId: sessionId,
    });

    if (result.costUsd > 0) {
      await this.costTracker.addCost(task.id, result.costUsd);
    }

    await this.taskStore.addLog({
      task_id: task.id,
      phase: "executing",
      agent: `${this.legacyWorker.name}-review-fix`,
      input_summary: "Review fix",
      output_summary: result.text,
      cost_usd: result.costUsd,
      duration_ms: result.durationMs,
    });

    return {
      costUsd: result.costUsd,
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

    const complexity = brainOpts?.complexity ?? "M";
    const cConfig = COMPLEXITY_CONFIG[complexity];

    const result = await this.legacyWorker.analyze(analyzePrompt, {
      cwd: this.config.projectPath,
      maxTurns: Math.min(cConfig.maxTurns, 100),
      maxBudget: Math.min(cConfig.maxBudget, 5.0),
      timeout: Math.min(cConfig.timeout, 600_000),
      model: resolveModelId(this.config.values.claude.model),
      resumeSessionId: revision?.resumeSessionId,
    });

    if (result.costUsd > 0) {
      await this.costTracker.addCost(task.id, result.costUsd);
    }

    const phase = revision ? "analyzing-revision" : "analyzing";
    await this.taskStore.addLog({
      task_id: task.id,
      phase,
      agent: this.legacyWorker.name,
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
      });

      if (result.costUsd > 0)
        await this.costTracker.addCost(task.id, result.costUsd);

      await this.taskStore.addLog({
        task_id: task.id,
        phase: "execute",
        agent: this.legacyWorker.name,
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
