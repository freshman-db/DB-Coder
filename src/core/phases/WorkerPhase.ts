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

// ---------------------------------------------------------------------------
// WorkerPhase class
// ---------------------------------------------------------------------------

export class WorkerPhase {
  constructor(
    private readonly config: Config,
    private readonly taskStore: TaskStore,
    private readonly costTracker: CostTracker,
    private readonly worker: WorkerAdapter,
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
    },
  ): Promise<WorkerResult> {
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

    const model = cConfig.model
      ? resolveModelId(cConfig.model)
      : resolveModelId(this.config.values.claude.model);

    return this.worker.execute(prompt, {
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

  // --- Worker fix (resume session to fix verification errors) ---

  async workerFix(
    sessionId: string,
    errors: string,
    task: Task,
  ): Promise<WorkerResult> {
    return this.worker.fix(
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

    const result = await this.worker.fix(prompt, {
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
      agent: `${this.worker.name}-review-fix`,
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

    const result = await this.worker.analyze(analyzePrompt, {
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
      agent: this.worker.name,
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
        agent: this.worker.name,
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
