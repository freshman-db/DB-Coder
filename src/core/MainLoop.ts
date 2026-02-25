import { resolveModelId } from "../config/Config.js";
import type { Config } from "../config/Config.js";
import type { TaskQueue } from "./TaskQueue.js";
import type { CodexBridge } from "../bridges/CodexBridge.js";
import type { TaskStore } from "../memory/TaskStore.js";
import type { CostTracker } from "../utils/cost.js";
import {
  ClaudeCodeSession,
  type SessionResult,
} from "../bridges/ClaudeCodeSession.js";
import type { SdkExtras } from "../bridges/buildSdkOptions.js";
import type { ReviewResult } from "../bridges/CodingAgent.js";
import {
  ClaudeWorkerAdapter,
  CodexWorkerAdapter,
  ClaudeReviewAdapter,
  CodexReviewAdapter,
  type WorkerAdapter,
  type ReviewAdapter,
} from "./WorkerAdapter.js";
import type { Task, SubTaskRecord } from "../memory/types.js";
import type {
  LoopState,
  StatusSnapshot,
  CycleStep,
  CycleStepStatus,
  TaskPlan,
  PlanTask,
  TaskType,
} from "./types.js";
import { CYCLE_PIPELINE } from "./types.js";
import {
  createBranch,
  switchBranch,
  commitAll,
  getHeadCommit,
  getCurrentBranch,
  branchExists,
  getChangedFilesSince,
  getModifiedAndAddedFiles,
  mergeBranch,
  deleteBranch,
  listBranches,
  forceDeleteBranch,
  getBranchHeadCommit,
  getDiffStats,
  getDiffSince,
} from "../utils/git.js";
import { log } from "../utils/logger.js";
import { truncate, extractJsonFromText, isRecord } from "../utils/parse.js";
import {
  SUMMARY_PREVIEW_LEN,
  TASK_DESC_MAX_LENGTH,
} from "../types/constants.js";
import {
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { safeBuild } from "../utils/safeBuild.js";
import { CycleEventBus } from "./CycleEventBus.js";
import type { CycleEvent, CyclePhase, CycleTiming } from "./CycleEvents.js";
import {
  PersonaLoader,
  formatWorkInstructions,
  type WorkInstructions,
  type StructuredWorkInstructions,
} from "./PersonaLoader.js";
import { ChainScanner } from "./ChainScanner.js";

const PAUSE_INTERVAL_MS = 5000;
const ERROR_RECOVERY_MS = 30_000;
const BRANCH_ID_LENGTH = 8;

const COMPLEXITY_CONFIG: Record<
  string,
  { maxTurns: number; maxBudget: number; timeout: number }
> = {
  S: { maxTurns: 100, maxBudget: 5.0, timeout: 600_000 }, // 10 min
  M: { maxTurns: 200, maxBudget: 10.0, timeout: 1_200_000 }, // 20 min
  L: { maxTurns: 200, maxBudget: 15.0, timeout: 2_400_000 }, // 40 min
  XL: { maxTurns: 200, maxBudget: 20.0, timeout: 3_600_000 }, // 60 min
};

type RunProcessFn = (
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
    input?: string;
  },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

type CountTscErrorsDeps = {
  existsSync: (path: string) => boolean;
  runProcess: RunProcessFn;
};

const defaultCountTscErrorsDeps: CountTscErrorsDeps = {
  existsSync,
  runProcess: async (command, args, options) => {
    const { runProcess } = await import("../utils/process.js");
    return runProcess(command, args, options);
  },
};

let countTscErrorsDeps: CountTscErrorsDeps = defaultCountTscErrorsDeps;

export function setCountTscErrorsDepsForTests(
  overrides?: Partial<CountTscErrorsDeps>,
): void {
  countTscErrorsDeps = overrides
    ? { ...defaultCountTscErrorsDeps, ...overrides }
    : defaultCountTscErrorsDeps;
}

type StatusListener = (status: StatusSnapshot) => void;

export class MainLoop {
  private state: LoopState = "idle";
  private running = false;
  private paused = false;
  private currentTaskId: string | null = null;
  private currentTaskDescription: string | null = null;
  private cycleNumber = 0;
  private currentPhase: string | null = null;
  private cycleSteps: CycleStep[] = [];
  private statusListeners = new Set<StatusListener>();
  private lockFile: string;
  private restartPending = false;
  private restartListeners = new Set<() => void>();
  private stoppedPromise: Promise<void> | null = null;
  private stoppedResolve: (() => void) | null = null;
  private tasksCompleted = 0;
  private consecutiveRejections = 0;
  private brainSession!: ClaudeCodeSession;
  private workerSession!: ClaudeCodeSession;
  private chainScanner: ChainScanner;
  private personaLoader: PersonaLoader;
  private worker: WorkerAdapter;
  private reviewer: ReviewAdapter;

  constructor(
    private config: Config,
    private taskQueue: TaskQueue,
    private codex: CodexBridge,
    private taskStore: TaskStore,
    private costTracker: CostTracker,
    private eventBus: CycleEventBus = CycleEventBus.noop(),
    private sdkExtras?: SdkExtras,
    workerAdapter?: WorkerAdapter,
    reviewAdapter?: ReviewAdapter,
  ) {
    const hash = createHash("md5")
      .update(config.projectPath)
      .digest("hex")
      .slice(0, BRANCH_ID_LENGTH);
    const lockDir = join(homedir(), ".db-coder");
    this.lockFile = join(lockDir, `${hash}.lock`);
    this.personaLoader = new PersonaLoader(
      taskStore,
      join(config.projectPath, "personas"),
    );
    this.brainSession = new ClaudeCodeSession(sdkExtras);
    this.workerSession = new ClaudeCodeSession(sdkExtras);
    this.chainScanner = new ChainScanner(this.brainSession, taskStore, config);

    // Wire up WorkerAdapter + ReviewAdapter (defaults from config if not injected)
    if (workerAdapter && reviewAdapter) {
      this.worker = workerAdapter;
      this.reviewer = reviewAdapter;
    } else {
      const workerType = config.values.autonomy.worker;
      if (workerType === "codex") {
        this.worker = new CodexWorkerAdapter(codex);
        this.reviewer = new ClaudeReviewAdapter(this.brainSession);
      } else {
        this.worker = new ClaudeWorkerAdapter(this.workerSession);
        this.reviewer = new CodexReviewAdapter(codex);
      }
    }
  }

  private makeEvent(
    phase: CyclePhase,
    timing: CycleTiming,
    data: Record<string, unknown> = {},
  ): CycleEvent {
    return {
      phase,
      timing,
      taskId: this.currentTaskId ?? undefined,
      data,
      timestamp: Date.now(),
    };
  }

  // --- Public interface (backward compatible) ---

  getState(): LoopState {
    return this.state;
  }
  getCurrentTaskId(): string | null {
    return this.currentTaskId;
  }
  isPaused(): boolean {
    return this.paused;
  }
  isRunning(): boolean {
    return this.running;
  }

  /** Return a full status snapshot for initial SSE push. */
  getStatusSnapshot(): StatusSnapshot {
    return {
      state: this.state,
      currentTaskId: this.currentTaskId,
      patrolling: this.running,
      paused: this.paused,
      cycleNumber: this.cycleNumber,
      currentPhase: this.currentPhase ?? undefined,
      cycleSteps: [...this.cycleSteps],
      taskDescription: this.currentTaskDescription ?? undefined,
    };
  }

  onRestart(listener: () => void): () => void {
    this.restartListeners.add(listener);
    return () => {
      this.restartListeners.delete(listener);
    };
  }

  addStatusListener(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  pause(): void {
    this.setPaused(true);
    log.info("Loop paused");
  }
  resume(): void {
    this.setPaused(false);
    log.info("Loop resumed");
  }

  // Legacy setters — kept for backward compatibility, no-ops in v2
  setEvolutionEngine(_engine: unknown): void {
    /* no-op in v2 */
  }
  setPluginMonitor(_monitor: unknown): void {
    /* no-op in v2 */
  }
  setPromptRegistry(_registry: unknown): void {
    /* no-op in v2 */
  }

  /** Run a manual scan via chain scanner (not allowed while patrol is running) */
  async triggerScan(
    depth: "quick" | "normal" | "deep" = "normal",
  ): Promise<void> {
    if (this.running)
      throw new Error(
        "Cannot trigger manual scan while patrol loop is running",
      );
    this.setState("scanning");
    try {
      if (depth === "deep") {
        await this.chainScanner.fullScan(this.config.projectPath);
      } else if (depth === "normal") {
        await this.chainScanner.scanNext(this.config.projectPath);
      } else {
        await this.chainScanner.discoverEntryPoints(this.config.projectPath);
      }
    } finally {
      this.setState("idle");
    }
  }

  /** Manually trigger entry point discovery via chain scanner */
  async triggerIdentifyModules(): Promise<void> {
    if (this.running)
      throw new Error("Cannot identify modules while patrol loop is running");
    this.setState("scanning");
    try {
      await this.chainScanner.discoverEntryPoints(this.config.projectPath);
    } finally {
      this.setState("idle");
    }
  }

  /** Manually trigger a chain scan (moduleName ignored, delegates to scanNext) */
  async triggerModuleScan(
    _moduleName: string,
    _depth: "quick" | "normal" = "normal",
  ): Promise<void> {
    if (this.running)
      throw new Error(
        "Cannot trigger module scan while patrol loop is running",
      );
    this.setState("scanning");
    try {
      await this.chainScanner.scanNext(this.config.projectPath);
    } finally {
      this.setState("idle");
    }
  }

  // --- Lifecycle ---

  async start(): Promise<void> {
    if (this.running) return;
    if (this.stoppedPromise) await this.waitForStopped();
    if (!this.acquireLock()) {
      log.error("Another instance is running. Lock file: " + this.lockFile);
      return;
    }

    this.setRunning(true);
    this.stoppedPromise = new Promise<void>((resolve) => {
      this.stoppedResolve = resolve;
    });
    log.info("Main loop started");

    // Recover zombie tasks from previous crash
    try {
      const recovered = await this.taskStore.recoverActiveTasks(
        this.config.projectPath,
      );
      if (recovered > 0)
        log.warn(`Recovered ${recovered} active task(s) back to queued`);
    } catch (err) {
      log.warn(`Failed to recover active tasks: ${err}`);
    }

    // Clean up orphaned branches
    try {
      await this.cleanupOrphanedBranches();
    } catch (err) {
      log.warn(`Failed to cleanup orphaned branches: ${err}`);
    }

    // Seed personas from files
    try {
      const seeded = await this.personaLoader.seedFromFiles();
      if (seeded > 0) log.info(`Seeded ${seeded} persona(s) from files`);
    } catch (err) {
      log.warn(`Failed to seed personas: ${err}`);
    }

    try {
      while (this.running) {
        if (this.paused) {
          this.setState("paused");
          await sleep(PAUSE_INTERVAL_MS);
          continue;
        }

        let wasProductive = false;
        try {
          wasProductive = await this.runCycle();
        } catch (err) {
          log.error("Cycle error", err);
          this.setState("error");
          await sleep(ERROR_RECOVERY_MS);
        }

        if (this.restartPending) {
          log.info("Restart pending after self-build, exiting loop");
          break;
        }

        // Productive cycle → short pause then continue; idle → scanInterval
        await sleep(
          wasProductive ? 10_000 : this.config.values.brain.scanInterval * 1000,
        );
      }
    } finally {
      this.releaseLock();
      this.setRunning(false);
      this.setState("idle");
      log.info("Main loop stopped");
      this.stoppedResolve?.();
      this.stoppedResolve = null;
      this.stoppedPromise = null;

      if (this.restartPending) {
        for (const listener of this.restartListeners) {
          try {
            listener();
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.setRunning(false);
    this.brainSession.kill();
    this.workerSession.kill();
  }

  async waitForStopped(timeoutMs = 120_000): Promise<void> {
    if (!this.stoppedPromise) return;
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(
        () => reject(new Error("Timeout waiting for MainLoop to stop")),
        timeoutMs,
      ),
    );
    await Promise.race([this.stoppedPromise, timeout]).catch((err) => {
      log.warn(`${err}`);
    });
  }

  // --- Core cycle: Brain → Worker → Verify → Review → Reflect ---

  async runCycle(): Promise<boolean> {
    const projectPath = this.config.projectPath;
    this.resetCycleSteps();

    // 0. Drain queued tasks first — skip brain entirely if work is waiting
    this.setState("scanning");
    this.beginStep("decide");
    const queued = await this.taskQueue.getNext(projectPath);
    let task: Task;
    let brainOpts:
      | {
          persona?: string;
          taskType?: string;
          complexity?: string;
          subtasks?: Array<{ description: string; order: number }>;
          workInstructions?: WorkInstructions;
        }
      | undefined;

    if (queued) {
      task = queued;
      await this.taskStore.updateTask(task.id, {
        status: "active",
        phase: "executing",
      });
      this.setCurrentTaskId(task.id);

      // Reconstruct brainOpts from stored plan (JSONB)
      const plan = task.plan as Record<string, unknown> | null;
      if (plan) {
        brainOpts = {
          persona: typeof plan.persona === "string" ? plan.persona : undefined,
          taskType: typeof plan.type === "string" ? plan.type : undefined,
          complexity:
            typeof plan.estimatedComplexity === "string"
              ? (
                  { low: "S", medium: "M", high: "L" } as Record<string, string>
                )[plan.estimatedComplexity]
              : undefined,
          workInstructions:
            typeof plan.workInstructions === "string"
              ? plan.workInstructions
              : undefined,
        };
      }

      log.info(
        `Queue pickup: ${truncate(task.task_description, TASK_DESC_MAX_LENGTH)}`,
      );
      this.currentTaskDescription = task.task_description;
      this.eventBus.emit(
        this.makeEvent("decide", "after", {
          taskDescription: task.task_description,
        }),
      );
      this.endStep("decide", "done", "Queue pickup");
      this.endStep("create-task", "skipped");
    } else {
      // 1. Brain decides what to do
      this.eventBus.emit(this.makeEvent("decide", "before"));
      let decision = await this.brainDecide(projectPath);
      if (decision.costUsd > 0)
        await this.taskStore.addDailyCost(decision.costUsd);

      // Layer 2: directive fallback if brain returned null
      if (!decision.taskDescription) {
        log.warn("Brain returned no task — retrying with directive prompt");
        const directive = await this.brainDecideDirective(projectPath);
        if (directive.costUsd > 0)
          await this.taskStore.addDailyCost(directive.costUsd);
        if (directive.taskDescription) {
          decision = directive;
        }
      }

      // Layer 3: if still null, short sleep will retry (handled by start())
      if (!decision.taskDescription) {
        log.warn(
          "Brain: no task after directive retry. Short sleep then retry.",
        );
        this.endStep("decide", "failed", "No task found");
        this.skipRemainingSteps("decide");
        this.setState("idle");
        return false;
      }

      // Dedup check: avoid creating duplicate or recently-failed tasks
      const similar = await this.taskStore.findSimilarTask(
        projectPath,
        decision.taskDescription,
      );
      if (
        similar &&
        (similar.status === "queued" ||
          similar.status === "active" ||
          similar.status === "done")
      ) {
        log.info(
          `Dedup: skipping task similar to [${similar.status}] "${truncate(similar.task_description, 80)}"`,
        );
        this.endStep("decide", "skipped", "Dedup");
        this.skipRemainingSteps("decide");
        this.setState("idle");
        return false;
      }
      if (
        await this.taskStore.hasRecentlyFailedSimilar(
          projectPath,
          decision.taskDescription,
        )
      ) {
        log.info(
          `Cooldown: skipping task similar to recently failed one: "${truncate(decision.taskDescription, 80)}"`,
        );
        this.endStep("decide", "skipped", "Cooldown");
        this.skipRemainingSteps("decide");
        this.setState("idle");
        return false;
      }

      this.currentTaskDescription = decision.taskDescription;
      this.eventBus.emit(
        this.makeEvent("decide", "after", {
          taskDescription: decision.taskDescription,
        }),
      );
      this.endStep("decide", "done");

      // 2. Create task record
      this.beginStep("create-task");
      this.setState("planning");
      task = await this.taskStore.createTask(
        projectPath,
        decision.taskDescription,
        decision.priority ?? 2,
      );
      this.setCurrentTaskId(task.id);
      log.info(
        `Task: ${truncate(decision.taskDescription, TASK_DESC_MAX_LENGTH)}`,
      );
      this.eventBus.emit(
        this.makeEvent("create-task", "after", {
          taskId: task.id,
          taskDescription: decision.taskDescription,
        }),
      );

      // Store complexity and subtasks metadata from brain decision
      if (
        decision.complexity ||
        (decision.subtasks && decision.subtasks.length > 0)
      ) {
        const updates: Record<string, unknown> = {};
        if (decision.complexity) {
          updates.plan = { complexity: decision.complexity };
        }
        if (decision.subtasks && decision.subtasks.length > 0) {
          updates.subtasks = decision.subtasks.map((st, i) => ({
            id: String(i + 1),
            description: st.description,
            executor: "claude" as const,
            status: "pending" as const,
          }));
        }
        await this.taskStore.updateTask(task.id, updates);
      }

      brainOpts = {
        persona: decision.persona,
        taskType: decision.taskType,
        complexity: decision.complexity,
        subtasks: decision.subtasks,
        workInstructions: decision.workInstructions,
      };

      // Enqueue extra tasks from brain's batch output
      if (decision.extraTasks && decision.extraTasks.length > 0) {
        try {
          const planTasks: PlanTask[] = decision.extraTasks.map((et, i) => ({
            id: `extra-${i + 1}`,
            description: et.task,
            priority: et.priority ?? 2,
            executor: "claude" as const,
            subtasks: (et.subtasks ?? []).map((st, si) => ({
              id: `extra-${i + 1}-sub-${si + 1}`,
              description: st.description,
              executor: "claude" as const,
            })),
            dependsOn: [],
            estimatedComplexity:
              (
                { S: "low", M: "medium", L: "high", XL: "high" } as Record<
                  string,
                  "low" | "medium" | "high"
                >
              )[et.complexity ?? "M"] ?? "medium",
            type: et.taskType as TaskType | undefined,
            // BMAD: pass through workInstructions + persona to queue
            workInstructions: et.workInstructions
              ? typeof et.workInstructions === "string"
                ? et.workInstructions
                : formatWorkInstructions(et.workInstructions) || undefined
              : undefined,
            persona: et.persona,
          }));
          const plan: TaskPlan = {
            tasks: planTasks,
            reasoning: "Extra tasks from brain batch output",
          };
          const enqueuedIds = await this.taskQueue.enqueue(projectPath, plan);
          if (enqueuedIds.length > 0) {
            log.info(
              `Enqueued ${enqueuedIds.length} extra task(s) from brain batch`,
            );
          }
        } catch (err) {
          log.warn(`Failed to enqueue extra tasks: ${err}`);
        }
      }

      this.endStep("create-task", "done");
    }

    // 3. Budget check
    if (await this.checkBudgetOrAbort(task.id)) {
      this.skipRemainingSteps();
      this.setCurrentTaskId(null);
      this.currentTaskDescription = null;
      this.setState("idle");
      return false;
    }

    const branchName = `${this.config.values.git.branchPrefix}${task.id.slice(0, BRANCH_ID_LENGTH)}`;
    let originalBranch = "main";
    let startCommit = "";

    try {
      // 4. Prepare git branch
      originalBranch = await getCurrentBranch(projectPath).catch(() => "main");
      startCommit = await getHeadCommit(projectPath).catch(() => "");
      const baselineErrors = await countTscErrors(projectPath);

      if (await branchExists(branchName, projectPath)) {
        await switchBranch(branchName, projectPath);
      } else {
        await createBranch(branchName, projectPath);
      }

      await this.taskStore.updateTask(task.id, {
        status: "active",
        phase: "executing",
        git_branch: branchName,
        start_commit: startCommit,
      });

      // 4.5 Analysis phase (M/L/XL only) — produce and review a plan before coding
      const complexity = brainOpts?.complexity ?? "M";
      const needsAnalysis = complexity !== "S";
      let approvedPlan: string | undefined;

      if (needsAnalysis) {
        this.beginStep("analyze");
        this.setState("planning");
        await this.taskStore.updateTask(task.id, { phase: "analyzing" });

        // Analyze → Review → Synthesize loop (with up to 2 REVISE rounds)
        const maxRevisions = 2;
        let revisionRound = 0;
        let analyzeSessionId: string | undefined;
        let revisionCtx:
          | { resumeSessionId: string; revisionPrompt: string }
          | undefined;
        let planApproved = false;

        while (revisionRound <= maxRevisions) {
          // Worker produces a concrete change proposal (read-only)
          const analyzeResult = await this.workerAnalyze(
            task,
            brainOpts,
            revisionCtx,
          );
          analyzeSessionId = analyzeResult.sessionId;

          if (analyzeResult.isError) {
            const maxAnalyzeRetries = 2;
            const nextIteration = task.iteration + 1;
            if (nextIteration > maxAnalyzeRetries) {
              log.warn(
                `Worker analyze failed ${nextIteration} times — blocking task (max ${maxAnalyzeRetries} retries)`,
              );
              this.endStep(
                "analyze",
                "failed",
                "Empty or error proposal (retries exhausted)",
              );
              this.skipRemainingSteps("analyze");
              await this.taskStore.updateTask(task.id, {
                status: "blocked",
                phase: "blocked",
                iteration: nextIteration,
              });
            } else {
              log.warn(
                `Worker analyze failed — requeuing task (attempt ${nextIteration}/${maxAnalyzeRetries})`,
              );
              this.endStep(
                "analyze",
                "failed",
                `Empty or error proposal, requeuing (attempt ${nextIteration})`,
              );
              this.skipRemainingSteps("analyze");
              await this.taskStore.updateTask(task.id, {
                status: "queued",
                phase: "init",
                iteration: nextIteration,
              });
            }
            await switchBranch(originalBranch, projectPath).catch(() => {});
            await this.cleanupTaskBranch(branchName, { force: true });
            this.setCurrentTaskId(null);
            this.currentTaskDescription = null;
            this.setState("idle");
            return false;
          }

          // Reviewer evaluates the proposal (mutually exclusive with worker)
          const planReview = await this.reviewPlan(
            analyzeResult.proposal,
            task,
          );

          // Brain synthesizes proposal + feedback into final plan
          const synthesis = await this.brainSynthesizePlan(
            analyzeResult.proposal,
            planReview,
            task,
          );

          if (synthesis.decision === "approved") {
            approvedPlan = synthesis.finalPlan;
            planApproved = true;
            break;
          }

          if (synthesis.decision === "revise" && analyzeSessionId) {
            revisionRound++;
            if (revisionRound > maxRevisions) {
              log.warn(
                `Plan revisions exhausted (${maxRevisions} rounds) — blocking task`,
              );
              break;
            }
            log.info(
              `Brain requested plan revision (round ${revisionRound}/${maxRevisions})`,
            );

            // Build full revision context: brain instructions + reviewer issues
            const reviewerIssues = planReview.issues
              .map((i) => `- [${i.severity}] ${i.description}`)
              .join("\n");
            const revisionPrompt = `## Revision Required (Round ${revisionRound}/${maxRevisions})

### Brain's Direction
${synthesis.reviseInstructions ?? "Revise the proposal to address reviewer concerns."}

### Reviewer's Specific Issues
${reviewerIssues || "No specific issues listed."}

Revise your previous proposal to address ALL issues above. Produce a complete updated proposal in the same structured format.`;

            revisionCtx = {
              resumeSessionId: analyzeSessionId,
              revisionPrompt,
            };
            continue;
          }

          // REJECTED or REVISE without sessionId (e.g. Codex)
          log.warn("Brain rejected analysis plan — blocking task");
          break;
        }

        if (!planApproved) {
          this.endStep("analyze", "failed", "Plan rejected by brain");
          this.skipRemainingSteps("analyze");
          await this.taskStore.updateTask(task.id, {
            status: "blocked",
            phase: "blocked",
          });
          await switchBranch(originalBranch, projectPath).catch(() => {});
          await this.cleanupTaskBranch(branchName, { force: true });
          this.setCurrentTaskId(null);
          this.currentTaskDescription = null;
          this.setState("idle");
          return false;
        }

        this.endStep("analyze", "done");
      }

      // 5. Execute (subtask loop or single shot)
      this.beginStep("execute");
      this.setState("executing");
      const guardErrors = await this.eventBus.emitAndWait(
        this.makeEvent("execute", "before", {
          taskDescription: task.task_description,
        }),
      );
      if (guardErrors.length > 0) {
        log.warn(`Guard blocked execution: ${guardErrors[0].message}`);
        this.endStep("execute", "failed", "Guard blocked");
        this.skipRemainingSteps("execute");
        await this.taskStore.updateTask(task.id, {
          status: "blocked",
          phase: "blocked",
        });
        await switchBranch(originalBranch, projectPath).catch(() => {});
        await this.cleanupTaskBranch(branchName, { force: true });
        this.setCurrentTaskId(null);
        this.currentTaskDescription = null;
        this.setState("idle");
        return false;
      }

      let workerPassed: boolean;
      let workerSessionId: string | undefined;
      const verification: { passed: boolean; reason?: string } = {
        passed: true,
      };

      if (brainOpts?.subtasks && brainOpts.subtasks.length > 0) {
        // Subtask execution loop
        const result = await this.executeSubtasks(task, brainOpts.subtasks, {
          persona: brainOpts.persona,
          taskType: brainOpts.taskType,
          complexity: brainOpts.complexity,
          workInstructions: brainOpts.workInstructions,
          baselineErrors,
          startCommit,
        });
        workerPassed = result.success;
        verification.passed = result.success;
        if (!result.success)
          verification.reason = result.reason || "Subtask verification failed";
        this.endStep("execute", result.success ? "done" : "failed");
        this.endStep(
          "verify",
          result.success ? "done" : "failed",
          verification.reason,
        );
        this.eventBus.emit(
          this.makeEvent("execute", "after", {
            startCommit,
            result: { costUsd: 0, durationMs: 0 },
          }),
        );
      } else {
        // Single-shot execution (with optional approved plan)
        const workerResult = await this.workerExecute(task, {
          ...brainOpts,
          approvedPlan,
        });
        if (workerResult.costUsd > 0)
          await this.costTracker.addCost(task.id, workerResult.costUsd);

        await this.taskStore.addLog({
          task_id: task.id,
          phase: "execute",
          agent: "claude-code",
          input_summary: truncate(task.task_description, SUMMARY_PREVIEW_LEN),
          output_summary: workerResult.text.slice(0, SUMMARY_PREVIEW_LEN),
          cost_usd: workerResult.costUsd,
          duration_ms: workerResult.durationMs,
        });
        // isError is a warning, not a gate — hardVerify makes the final call
        let workerErrMsg: string | undefined;
        if (workerResult.isError) {
          workerErrMsg = `Worker reported error: ${workerResult.errors.join("; ") || "unknown error"}`;
          log.warn(workerErrMsg);
          await this.taskStore.addLog({
            task_id: task.id,
            phase: "execute",
            agent: "worker",
            input_summary: "worker reported isError",
            output_summary: workerErrMsg,
            cost_usd: 0,
            duration_ms: 0,
          });
        }
        this.eventBus.emit(
          this.makeEvent("execute", "after", {
            startCommit,
            result: {
              costUsd: workerResult.costUsd,
              durationMs: workerResult.durationMs,
            },
          }),
        );

        // Hard verification — always runs regardless of workerResult.isError
        this.beginStep("verify");
        this.setState("reviewing");
        const verifyStart = Date.now();
        const singleVerify = await this.hardVerify(
          baselineErrors,
          startCommit,
          projectPath,
        );
        await this.taskStore.addLog({
          task_id: task.id,
          phase: "verify",
          agent: "tsc",
          input_summary: `baseline=${baselineErrors}, startCommit=${startCommit}${workerResult.isError ? ", workerError=true" : ""}`,
          output_summary: singleVerify.passed
            ? "PASS"
            : `FAIL: ${singleVerify.reason}`,
          cost_usd: 0,
          duration_ms: Date.now() - verifyStart,
        });
        this.eventBus.emit(
          this.makeEvent("verify", "after", {
            verification: singleVerify,
            startCommit,
          }),
        );

        // HALT retry loop: fix up to maxRetries times
        const maxRetries = this.config.values.autonomy.maxRetries;
        let fixAttempts = 0;
        let currentSessionId = workerResult.sessionId;

        while (
          !singleVerify.passed &&
          currentSessionId &&
          fixAttempts < maxRetries
        ) {
          fixAttempts++;
          log.warn(
            `Hard verification failed (attempt ${fixAttempts}/${maxRetries}): ${singleVerify.reason}`,
          );
          const fixResult = await this.workerFix(
            currentSessionId,
            singleVerify.reason ?? "Unknown error",
            task,
          );
          if (fixResult.costUsd > 0)
            await this.costTracker.addCost(task.id, fixResult.costUsd);
          currentSessionId = fixResult.sessionId ?? currentSessionId;

          const changedFilesForCommit = await getModifiedAndAddedFiles(
            projectPath,
          ).catch(() => []);
          try {
            await commitAll(
              "db-coder: fix verification issues",
              projectPath,
              changedFilesForCommit,
            );
          } catch (commitErr) {
            log.error(
              `commitAll failed during verification retry ${fixAttempts}: ${commitErr}`,
            );
            singleVerify.reason = `commitAll failed: ${commitErr}`;
            break;
          }
          const reVerify = await this.hardVerify(
            baselineErrors,
            startCommit,
            projectPath,
          );
          singleVerify.passed = reVerify.passed;
          singleVerify.reason = reVerify.reason;
          this.eventBus.emit(
            this.makeEvent("fix", "after", { verification: singleVerify }),
          );
        }

        if (!singleVerify.passed && fixAttempts >= maxRetries) {
          log.warn(
            `HALT after ${fixAttempts} fix attempts: ${singleVerify.reason}`,
          );
          if (brainOpts?.persona) {
            await this.taskStore.addLog({
              task_id: task.id,
              phase: "halt-learning",
              agent: "system",
              input_summary: `persona=${brainOpts.persona}`,
              output_summary: `HALT triggered: ${singleVerify.reason} (after ${fixAttempts} attempts)`,
              cost_usd: 0,
              duration_ms: 0,
            });
          }
        }

        workerPassed = singleVerify.passed;
        workerSessionId = currentSessionId;
        verification.passed = singleVerify.passed;
        verification.reason = singleVerify.reason;

        // endStep execute based on hardVerify result, not worker report
        this.endStep(
          "execute",
          singleVerify.passed ? "done" : "failed",
          singleVerify.passed ? undefined : workerErrMsg,
        );
        this.endStep(
          "verify",
          singleVerify.passed ? "done" : "failed",
          singleVerify.reason,
        );
      }

      // 7. Code review (reviewer auto-selects based on worker config — mutual exclusion)
      this.beginStep("review");
      let shouldMerge = false;

      if (workerPassed) {
        this.setState("reviewing");
        const reviewResult = await this.codeReview(
          task,
          startCommit,
          projectPath,
        );

        // Store review results for traceability
        await this.taskStore.updateTask(task.id, {
          review_results: reviewResult.issues ?? [],
        });

        if (!reviewResult.passed) {
          log.info(`Code review: FAIL — ${reviewResult.summary}`, {
            issues: (reviewResult.issues ?? []).length,
            reviewer: this.reviewer.name,
          });
        } else {
          log.info(`Code review: PASS — ${reviewResult.summary}`);
        }

        // 8. Brain decision phase
        if (workerPassed && reviewResult.passed) {
          // Both verify and review passed → merge
          shouldMerge = true;
        } else if (workerPassed) {
          // Verify passed but review failed → brain decides
          const decision = await this.brainReviewDecision(
            task,
            reviewResult,
            reviewResult.reviewDiff,
            false,
          );
          log.info(
            `Brain decision: ${decision.decision} — ${decision.reasoning}`,
          );

          switch (decision.decision) {
            case "ignore":
              shouldMerge = true;
              break;

            case "block":
              // Leave shouldMerge = false
              break;

            case "split": {
              shouldMerge = true; // merge current work
              // Create new tasks for unresolved issues
              if (decision.newTasks) {
                for (const newTaskDesc of decision.newTasks) {
                  await this.taskStore.createTask(projectPath, newTaskDesc, 2);
                  log.info(
                    `Split: created follow-up task: ${truncate(newTaskDesc, 100)}`,
                  );
                }
              }
              break;
            }

            case "fix":
            case "rewrite": {
              // Fix/rewrite loop (at most maxReviewFixes rounds)
              const maxFixes = this.config.values.autonomy.maxReviewFixes;
              let fixSessionId: string | undefined = workerSessionId;

              for (let fixRound = 0; fixRound < maxFixes; fixRound++) {
                const fixResult = await this.workerReviewFix(
                  task,
                  decision.fixInstructions ?? decision.reasoning,
                  fixSessionId,
                );
                fixSessionId = fixResult.sessionId;

                // Commit fix changes
                const changedFilesForCommit = await getModifiedAndAddedFiles(
                  projectPath,
                ).catch(() => []);
                try {
                  await commitAll(
                    "db-coder: fix review issues",
                    projectPath,
                    changedFilesForCommit,
                  );
                } catch (commitErr) {
                  log.error(
                    `commitAll failed during review fix round ${fixRound + 1}: ${commitErr}`,
                  );
                  shouldMerge = false;
                  break;
                }

                // Re-verify
                const reVerify = await this.hardVerify(
                  baselineErrors,
                  startCommit,
                  projectPath,
                );
                if (!reVerify.passed) {
                  log.warn(
                    `Review fix: hardVerify failed — ${reVerify.reason}`,
                  );
                  break; // Will fall through to block
                }

                // Re-review
                const reReview = await this.codeReview(
                  task,
                  startCommit,
                  projectPath,
                );
                if (reReview.passed) {
                  shouldMerge = true;
                  break;
                }

                // Still failing — brain makes final decision (only ignore/block/split)
                const finalDecision = await this.brainReviewDecision(
                  task,
                  reReview,
                  reReview.reviewDiff,
                  true, // isRetry: restricts to ignore/block/split
                );
                log.info(
                  `Brain final decision: ${finalDecision.decision} — ${finalDecision.reasoning}`,
                );

                if (finalDecision.decision === "ignore") {
                  shouldMerge = true;
                } else if (finalDecision.decision === "split") {
                  shouldMerge = true;
                  if (finalDecision.newTasks) {
                    for (const newTaskDesc of finalDecision.newTasks) {
                      await this.taskStore.createTask(
                        projectPath,
                        newTaskDesc,
                        2,
                      );
                      log.info(
                        `Split: created follow-up task: ${truncate(newTaskDesc, 100)}`,
                      );
                    }
                  }
                }
                // else: block (shouldMerge stays false)
                break; // Only 1 retry round in the loop
              }
              break;
            }
          }
        }
      }

      this.endStep(
        "review",
        shouldMerge ? "done" : "failed",
        shouldMerge ? "PASS" : "Review rejected",
      );
      this.eventBus.emit(
        this.makeEvent("review", "after", { passed: shouldMerge }),
      );

      // 9. Brain reflects and learns
      this.beginStep("reflect");
      this.setState("reflecting");
      const outcome = shouldMerge ? "success" : "failed";
      try {
        await this.brainReflect(
          task,
          outcome,
          verification,
          projectPath,
          brainOpts?.persona,
        );
        this.endStep("reflect", "done");
        this.eventBus.emit(this.makeEvent("reflect", "after"));
      } catch (reflectErr) {
        log.warn(
          `brainReflect failed (non-fatal, continuing merge flow): ${reflectErr}`,
        );
        this.endStep("reflect", "failed", `brainReflect error: ${reflectErr}`);
        this.eventBus.emit(this.makeEvent("reflect", "after", { error: true }));
      }

      // 10. Merge or cleanup
      this.beginStep("merge");
      if (shouldMerge) {
        await switchBranch(originalBranch, projectPath);
        await mergeBranch(branchName, projectPath);
        try {
          await deleteBranch(branchName, projectPath);
        } catch (delErr) {
          log.warn(
            `deleteBranch failed (non-fatal, merge already succeeded): ${delErr}`,
          );
        }
        log.info(
          `Task completed and merged: ${truncate(task.task_description, TASK_DESC_MAX_LENGTH)}`,
        );
        await this.taskStore.updateTask(task.id, {
          status: "done",
          phase: "done",
        });
        this.endStep("merge", "done", "Merged");
        this.consecutiveRejections = 0;
        this.eventBus.emit(
          this.makeEvent("merge", "after", {
            merged: true,
            taskDescription: task.task_description,
          }),
        );

        // Self-modification: rebuild after merging own code changes
        if (this.isSelfProject()) {
          const buildResult = await safeBuild(projectPath);
          if (buildResult.success) {
            this.restartPending = true;
            log.info("Self-build succeeded, restart pending");
          } else {
            this.writeBuildError(buildResult.error);
          }
        }
      } else {
        await switchBranch(originalBranch, projectPath).catch(() => {});
        await this.cleanupTaskBranch(branchName, { startCommit });
        log.warn(
          `Task rejected: ${truncate(task.task_description, TASK_DESC_MAX_LENGTH)}`,
        );
        await this.taskStore.updateTask(task.id, {
          status: "blocked",
          phase: "blocked",
        });
        this.endStep("merge", "failed", "Rejected");
        this.eventBus.emit(this.makeEvent("merge", "after", { merged: false }));

        this.consecutiveRejections++;
        if (this.consecutiveRejections >= 5) {
          try {
            await this.pipelineHealthCheck(projectPath);
          } catch (err) {
            log.warn("Pipeline health check failed", err);
          }
          this.consecutiveRejections = 0;
        }
      }

      // 12. Periodic chain scan
      this.tasksCompleted++;
      const { chainScan } = this.config.values.brain;
      if (chainScan.enabled && this.tasksCompleted % chainScan.interval === 0) {
        try {
          this.eventBus.emit(this.makeEvent("deep-review", "before"));
          await this.chainScanner.scanNext(projectPath);
          this.eventBus.emit(this.makeEvent("deep-review", "after"));
        } catch (err) {
          log.warn("Chain scan failed", err);
        }
      }

      // 13. Periodic CLAUDE.md maintenance
      const {
        claudeMdMaintenanceEnabled: maintEnabled,
        claudeMdMaintenanceInterval: maintInterval,
      } = this.config.values.brain;
      if (
        maintEnabled &&
        maintInterval > 0 &&
        this.tasksCompleted % maintInterval === 0
      ) {
        try {
          await this.claudeMdMaintenance(projectPath);
        } catch (err) {
          log.warn("CLAUDE.md maintenance failed", err);
        }
      }
    } catch (err) {
      log.error("Task execution error", err);
      // Mark the currently active step as failed and skip the rest
      const activeStep = this.cycleSteps.find((s) => s.status === "active");
      if (activeStep) {
        this.endStep(activeStep.phase, "failed", String(err));
      }
      this.skipRemainingSteps();
      this.eventBus.emit(
        this.makeEvent("execute", "error", { error: String(err) }),
      );
      await this.taskStore.updateTask(task.id, {
        status: "failed",
        phase: "failed",
      });
      await switchBranch(originalBranch, projectPath).catch(() => {});
      await this.cleanupTaskBranch(branchName, { startCommit });
    } finally {
      await switchBranch(originalBranch, projectPath).catch(() => {});
      this.setCurrentTaskId(null);
      this.currentTaskDescription = null;
    }

    this.setState("idle");
    return true;
  }

  // --- Brain session ---

  private async brainDecide(projectPath: string): Promise<{
    taskDescription: string | null;
    priority?: number;
    persona?: string;
    taskType?: string;
    complexity?: string;
    subtasks?: Array<{ description: string; order: number }>;
    workInstructions?: WorkInstructions;
    extraTasks?: Array<{
      task: string;
      priority: number;
      persona?: string;
      taskType?: string;
      complexity?: string;
      subtasks?: Array<{ description: string; order: number }>;
      workInstructions?: WorkInstructions;
    }>;
    costUsd: number;
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

    const context = await this.gatherBrainContext(projectPath);
    let totalCost = 0;

    // --- Phase 1: Free exploration (no jsonSchema, tools enabled) ---
    const explorationPrompt = `You are the brain of an autonomous coding agent in EVOLUTION MODE.
Your job is to continuously improve the project — you are NOT a passive monitor.

Read CLAUDE.md for project context, current status, and priorities.
Use claude-mem to search for relevant past experiences.
Actually explore the codebase — read files, search for patterns, trace call sites.

${context}

## EVOLUTION DIMENSIONS (scan for opportunities in this order):
1. **功能完善** — Read CLAUDE.md/README for unchecked items ([ ]), complete missing features
2. **功能增强** — Improve existing features: better UX, error messages, config options, edge cases
3. **模块深度扫描** — Focus on the current rotation module, review its internal logic and boundaries
4. **类型安全** — Eliminate any/unknown, strengthen return types, add missing generics
5. **错误处理** — Find catch-ignore patterns, add error propagation, ensure errors are visible
6. **测试覆盖** — Add tests for untested functions, especially pure functions and edge cases
7. **代码质量** — Split long functions (>80 lines), reduce nesting, eliminate dead/duplicate code
8. **性能** — N+1 queries, unnecessary awaits in loops, missing parallelization
9. **韧性** — Timeout handling, retry logic, graceful degradation for external services
10. **安全** — Input validation, injection prevention, sensitive data in logs

## YOUR TASK:
Explore the project and identify 1-5 concrete improvement opportunities.
For each, describe: what to change, which files/functions, why it matters, and how to verify.
Be specific — name exact files, functions, line ranges. Vague findings waste worker time.
Avoid duplicating recent tasks (see context above).
If budget is low, focus on small targeted improvements.

## SELF-CRITIQUE (apply BEFORE writing your report)
After exploring, pick ONE of these lenses to stress-test your findings:
- **Pre-mortem**: Assume each proposed change fails in production. What would cause it?
- **Red Team**: Attack your own findings. What's the weakest recommendation?
- **Inversion**: What should we NOT change? What's working well that we might break?

State which lens you chose and what it revealed. Discard or revise weak findings.

Write your analysis as a natural language report.`;

    const phase1Result = await this.brainThink(explorationPrompt);
    totalCost += phase1Result.costUsd;
    log.info(
      `Brain phase1 (explore): cost=$${phase1Result.costUsd.toFixed(4)}, turns=${phase1Result.numTurns}, text=${phase1Result.text.length}chars`,
    );
    if (phase1Result.isError || phase1Result.exitCode !== 0) {
      log.warn(
        `Brain phase1 errors (exitCode=${phase1Result.exitCode}, isError=${phase1Result.isError}): ${phase1Result.errors.join("; ")}`,
      );
    }

    const phase1SessionId =
      !phase1Result.isError && phase1Result.exitCode === 0
        ? phase1Result.sessionId
        : undefined;
    const analysisReport = phase1Result.text.slice(0, 12000);

    // --- Phase 2: Structured output (jsonSchema, converts analysis to tasks) ---
    const structuredPrompt = phase1SessionId
      ? `--- PHASE 2: STRUCTURED DECISION ---
Based on YOUR exploration above, produce 1-5 prioritized tasks for the worker to execute.

## OUTPUT RULES:`
      : `Based on the analysis below, produce 1-5 prioritized tasks for the worker to execute.

## Analysis Report
${analysisReport}

## OUTPUT RULES:
- tasks[0] is the HIGHEST priority task — it will be executed immediately.
- tasks[1..4] are extra tasks — they will be queued for later execution.
- Each task needs: task (specific description), priority (0-3), persona, taskType, complexity (S/M/L/XL).
- workInstructions: guidance for the worker. Can be:
  - a plain string with free-form instructions, OR
  - a structured object with fields: acceptanceCriteria (testable "done" statements),
    filesToModify (explicit paths), guardrails (what NOT to do), verificationSteps,
    references (related files/docs to read first)
- subtasks: ONLY for complex tasks needing 2+ independent steps. Most tasks should NOT have subtasks.
- persona: feature-builder, refactoring-expert, bugfix-debugger, test-engineer, security-auditor, performance-optimizer, frontend-specialist
- taskType: feature, bugfix, refactoring, test, security, performance, frontend, code-quality, docs
- reasoning: brief explanation of why these tasks were chosen`;

    const brainDecideSchema = {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              task: { type: "string" },
              priority: { type: "number" },
              persona: { type: "string" },
              taskType: { type: "string" },
              complexity: { type: "string" },
              workInstructions: {
                oneOf: [
                  { type: "string" },
                  {
                    type: "object",
                    properties: {
                      acceptanceCriteria: {
                        type: "array",
                        items: { type: "string" },
                      },
                      filesToModify: {
                        type: "array",
                        items: { type: "string" },
                      },
                      guardrails: { type: "array", items: { type: "string" } },
                      verificationSteps: {
                        type: "array",
                        items: { type: "string" },
                      },
                      references: { type: "array", items: { type: "string" } },
                    },
                  },
                ],
              },
              subtasks: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    description: { type: "string" },
                    order: { type: "number" },
                  },
                  required: ["description"],
                },
              },
            },
            required: ["task"],
          },
        },
        reasoning: { type: "string" },
      },
      required: ["tasks"],
    };

    const phase2Result = await this.brainThink(structuredPrompt, {
      jsonSchema: brainDecideSchema,
      resumeSessionId: phase1SessionId,
    });
    totalCost += phase2Result.costUsd;
    log.info(
      `Brain phase2 (structured): cost=$${phase2Result.costUsd.toFixed(4)}, exit=${phase2Result.exitCode}, json=${phase2Result.json ? "yes" : "no"}, text="${truncate(phase2Result.text, 200)}"`,
    );
    if (phase2Result.isError || phase2Result.exitCode !== 0) {
      log.warn(`Brain phase2 errors: ${phase2Result.errors.join("; ")}`);
    }

    // --- Parse results with fallback chain ---
    const parseTaskArray = (
      obj: Record<string, unknown>,
    ): ReturnType<typeof this.brainDecide> extends Promise<infer R>
      ? R
      : never => {
      const tasks = Array.isArray(obj.tasks) ? obj.tasks : [];
      const first = tasks[0];
      if (!isRecord(first) || typeof first.task !== "string") {
        return { taskDescription: null, costUsd: totalCost };
      }

      const parseWorkInstructions = (
        v: unknown,
      ): WorkInstructions | undefined => {
        if (typeof v === "string") return v || undefined;
        if (isRecord(v)) {
          const parsed: StructuredWorkInstructions = {
            acceptanceCriteria: Array.isArray(v.acceptanceCriteria)
              ? v.acceptanceCriteria.filter(
                  (x): x is string => typeof x === "string",
                )
              : [],
            filesToModify: Array.isArray(v.filesToModify)
              ? v.filesToModify.filter(
                  (x): x is string => typeof x === "string",
                )
              : [],
            guardrails: Array.isArray(v.guardrails)
              ? v.guardrails.filter((x): x is string => typeof x === "string")
              : [],
            verificationSteps: Array.isArray(v.verificationSteps)
              ? v.verificationSteps.filter(
                  (x): x is string => typeof x === "string",
                )
              : [],
            references: Array.isArray(v.references)
              ? v.references.filter((x): x is string => typeof x === "string")
              : [],
          };
          const hasContent = Object.values(parsed).some(
            (arr) => arr && arr.length > 0,
          );
          return hasContent ? parsed : undefined;
        }
        return undefined;
      };

      const parseOne = (t: Record<string, unknown>) => ({
        task: String(t.task),
        priority: typeof t.priority === "number" ? t.priority : 2,
        persona: typeof t.persona === "string" ? t.persona : undefined,
        taskType: typeof t.taskType === "string" ? t.taskType : undefined,
        complexity:
          typeof t.complexity === "string" && t.complexity in COMPLEXITY_CONFIG
            ? t.complexity
            : undefined,
        workInstructions: parseWorkInstructions(t.workInstructions),
        subtasks: Array.isArray(t.subtasks) ? t.subtasks : undefined,
      });

      const primary = parseOne(first);
      const extra = tasks
        .slice(1)
        .filter((t: unknown) => isRecord(t) && typeof t.task === "string")
        .map((t: unknown) => parseOne(t as Record<string, unknown>));

      return {
        taskDescription: primary.task,
        priority: primary.priority,
        persona: primary.persona,
        taskType: primary.taskType,
        complexity: primary.complexity,
        subtasks: primary.subtasks,
        workInstructions: primary.workInstructions,
        extraTasks: extra.length > 0 ? extra : undefined,
        costUsd: totalCost,
      };
    };

    // Primary: structured output from --json-schema
    const parsed = isRecord(phase2Result.json) ? phase2Result.json : null;
    if (parsed) {
      const result = parseTaskArray(parsed);
      if (result.taskDescription) return result;
    }

    // Fallback: try extracting JSON from text
    const textParsed = extractJsonFromText(phase2Result.text, (v) => {
      if (!isRecord(v)) return false;
      const rec = v as Record<string, unknown>;
      // Support both { tasks: [...] } and legacy { task: "..." }
      return Array.isArray(rec.tasks) || typeof rec.task === "string";
    });
    if (isRecord(textParsed)) {
      // Legacy single-task format
      if (typeof textParsed.task === "string") {
        log.warn(
          "brainDecide: fell back to text extraction (legacy single-task)",
        );
        return {
          taskDescription: textParsed.task,
          priority:
            typeof textParsed.priority === "number" ? textParsed.priority : 2,
          persona:
            typeof textParsed.persona === "string"
              ? textParsed.persona
              : undefined,
          taskType:
            typeof textParsed.taskType === "string"
              ? textParsed.taskType
              : undefined,
          subtasks: Array.isArray(textParsed.subtasks)
            ? textParsed.subtasks
            : undefined,
          costUsd: totalCost,
        };
      }
      // Multi-task format from text
      if (Array.isArray(textParsed.tasks)) {
        log.warn("brainDecide: fell back to text extraction (multi-task)");
        const result = parseTaskArray(textParsed);
        if (result.taskDescription) return result;
      }
    }

    // Last resort: raw text as task description
    const rawText = phase2Result.text.trim();
    if (rawText.length > 20) {
      log.warn(
        "brainDecide: no valid JSON found, using raw text as task description",
      );
      return {
        taskDescription: rawText.slice(0, 500),
        costUsd: totalCost,
      };
    }
    return { taskDescription: null, costUsd: totalCost };
  }

  /** Gather rich context for brain decision-making */
  private async gatherBrainContext(projectPath: string): Promise<string> {
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

    // Recent 15 tasks (expanded from 5 to avoid repeats)
    const recentResult = await this.taskStore.listTasksPaged(
      projectPath,
      1,
      15,
    );
    const recentTasks = recentResult.tasks ?? [];
    if (recentTasks.length > 0) {
      parts.push(
        `Recent tasks (DO NOT duplicate these):\n${recentTasks.map((t: Task) => `- [${t.status}] ${t.task_description}`).join("\n")}`,
      );
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
    } catch {
      /* metrics not critical */
    }

    return parts.join("\n\n");
  }

  /** Layer 2: Extremely specific directive when brain returns no task */
  private async brainDecideDirective(projectPath: string): Promise<{
    taskDescription: string | null;
    priority?: number;
    costUsd: number;
  }> {
    const prompt = `You MUST pick ONE concrete improvement from this list. Search the codebase and find a SPECIFIC instance:

1. A function longer than 80 lines → split it
2. A catch block that ignores errors → add proper handling
3. A public function without JSDoc → add documentation
4. An \`any\` type → add proper typing
5. An untested pure function → write a test
6. A TODO/FIXME comment → resolve it
7. A file with duplicate logic → extract shared helper
8. A missing error message → add user-friendly error text

Be SPECIFIC: name the exact file and function. Do not be vague.

Respond with EXACTLY this JSON (no markdown):
{"task": "specific description", "priority": 2, "reasoning": "why"}`;

    const directiveSchema = {
      type: "object",
      properties: {
        task: { type: "string" },
        priority: { type: "number" },
        reasoning: { type: "string" },
      },
      required: ["task"],
    };

    const result = await this.brainThink(prompt, {
      jsonSchema: directiveSchema,
    });
    log.info(
      `Brain directive raw: cost=$${result.costUsd.toFixed(4)}, exit=${result.exitCode}, turns=${result.numTurns}, json=${result.json ? "yes" : "no"}, text="${truncate(result.text, 200)}"`,
    );

    // Primary: structured output
    const parsed = isRecord(result.json) ? result.json : null;
    if (parsed && typeof parsed.task === "string") {
      return {
        taskDescription: parsed.task,
        priority: typeof parsed.priority === "number" ? parsed.priority : 2,
        costUsd: result.costUsd,
      };
    }

    // Fallback: text extraction
    const textParsed = extractJsonFromText(
      result.text,
      (v) =>
        isRecord(v) && typeof (v as Record<string, unknown>).task === "string",
    );
    if (isRecord(textParsed) && typeof textParsed.task === "string") {
      log.warn(
        "brainDecideDirective: structured output empty, fell back to text extraction",
      );
      return {
        taskDescription: textParsed.task,
        priority:
          typeof textParsed.priority === "number" ? textParsed.priority : 2,
        costUsd: result.costUsd,
      };
    }

    const rawText = result.text.trim();
    if (rawText.length > 20) {
      log.warn(
        "brainDecideDirective: no valid JSON found in any output, using raw text",
      );
      return {
        taskDescription: rawText.slice(0, 500),
        costUsd: result.costUsd,
      };
    }
    return { taskDescription: null, costUsd: result.costUsd };
  }

  private async brainThink(
    prompt: string,
    opts?: { jsonSchema?: object; resumeSessionId?: string },
  ): Promise<SessionResult> {
    const isResume = !!opts?.resumeSessionId;
    const result = await this.brainSession.run(prompt, {
      permissionMode: "bypassPermissions",
      maxTurns: 200,
      cwd: this.config.projectPath,
      timeout: 300_000,
      model: resolveModelId(this.config.values.brain.model),
      disallowedTools: ["Edit", "Write", "NotebookEdit"],
      appendSystemPrompt: isResume
        ? undefined
        : "You are the brain of an autonomous coding agent. Read CLAUDE.md for context. Do not modify files — only analyze and decide.",
      jsonSchema: opts?.jsonSchema,
      resumeSessionId: opts?.resumeSessionId,
    });

    if (isResume) {
      const u = result.usage;
      const total = u.inputTokens || 1;
      log.info(
        `brainThink resume cache: read=${u.cacheReadInputTokens}/${total} (${((u.cacheReadInputTokens / total) * 100).toFixed(0)}%)`,
      );
    }

    return result;
  }

  // --- Worker session ---

  private async workerExecute(
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
  ): Promise<SessionResult> {
    const description = opts?.subtaskDescription ?? task.task_description;
    const { prompt: basePrompt, systemPrompt } =
      await this.personaLoader.buildWorkerPrompt({
        taskDescription: description,
        personaName: opts?.persona,
        taskType: opts?.taskType,
        workInstructions: opts?.workInstructions,
      });

    const isResume = !!opts?.resumeSessionId;

    // If an approved plan exists, prepend it to the worker prompt
    const prompt = isResume
      ? `--- NEXT SUBTASK ---\n${description}\n\n${opts?.approvedPlan ? `## Approved Plan\n${opts.approvedPlan}\n\n` : ""}Continue working in this session.`
      : opts?.approvedPlan
        ? `${basePrompt}\n\n## Approved Implementation Plan\nFollow this plan that was reviewed and approved:\n\n${opts.approvedPlan}`
        : basePrompt;

    const complexity =
      opts?.complexity ??
      ((task.plan as Record<string, unknown> | null)?.complexity as
        | string
        | undefined);
    const cConfig = COMPLEXITY_CONFIG[complexity ?? "M"];

    const result = await this.workerSession.run(prompt, {
      permissionMode: "bypassPermissions",
      maxTurns: cConfig.maxTurns,
      maxBudget: Math.min(
        cConfig.maxBudget,
        this.config.values.claude.maxTaskBudget,
      ),
      cwd: this.config.projectPath,
      timeout: cConfig.timeout,
      model: resolveModelId(this.config.values.claude.model),
      appendSystemPrompt: isResume ? undefined : systemPrompt,
      resumeSessionId: opts?.resumeSessionId,
    });

    if (isResume) {
      const u = result.usage;
      const total = u.inputTokens || 1;
      log.info(
        `workerExecute resume cache: read=${u.cacheReadInputTokens}/${total} (${((u.cacheReadInputTokens / total) * 100).toFixed(0)}%)`,
      );
    }

    return result;
  }

  private async executeSubtasks(
    task: Task,
    subtasks: Array<{ description: string; order: number }>,
    opts: {
      persona?: string;
      taskType?: string;
      complexity?: string;
      workInstructions?: WorkInstructions;
      baselineErrors: number;
      startCommit: string;
    },
  ): Promise<{ success: boolean; sessionId?: string; reason?: string }> {
    // Re-read task from DB to ensure subtasks array is fresh
    task = (await this.taskStore.getTask(task.id))!;

    // Build sorted array with id from task.subtasks (same order as original decision.subtasks)
    const withId = subtasks.map((st, i) => ({
      ...st,
      subtaskId: (task.subtasks ?? [])[i]?.id ?? String(i + 1),
    }));
    const sorted = withId.sort((a, b) => a.order - b.order);

    let lastSuccessfulSessionId: string | undefined;

    for (let i = 0; i < sorted.length; i++) {
      const st = sorted[i];
      log.info(
        `Subtask ${i + 1}/${sorted.length}: ${truncate(st.description, 100)}`,
      );

      // Update subtask status to running — match by id, not loop index
      const currentSubtasks = (task.subtasks ?? []).map((s) =>
        s.id === st.subtaskId ? { ...s, status: "running" as const } : s,
      );
      await this.taskStore.updateTask(task.id, { subtasks: currentSubtasks });

      // Execute worker — resume from previous subtask if available
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
        agent: "claude-code",
        input_summary: `subtask ${i + 1}/${sorted.length}: ${truncate(st.description, 80)}`,
        output_summary: result.text.slice(0, SUMMARY_PREVIEW_LEN),
        cost_usd: result.costUsd,
        duration_ms: result.durationMs,
      });

      // isError is a warning, not a gate — hardVerify makes the final call
      let subtaskWorkerErrMsg: string | undefined;
      if (result.isError) {
        subtaskWorkerErrMsg = `Subtask ${i + 1} worker reported error: ${result.errors.join("; ") || "unknown error"}`;
        log.warn(subtaskWorkerErrMsg);
        // Persist worker error in subtask history
        const updatedSubtasks = (task.subtasks ?? []).map((s) =>
          s.id === st.subtaskId
            ? { ...s, workerError: subtaskWorkerErrMsg }
            : s,
        );
        await this.taskStore.updateTask(task.id, { subtasks: updatedSubtasks });
        // Re-read task so in-memory subtasks include the workerError just persisted
        const refreshed = await this.taskStore.getTask(task.id);
        if (!refreshed) {
          log.warn(
            "Task disappeared during subtask processing, using stale data",
          );
        } else {
          task = refreshed;
        }
      }

      // Per-subtask hard verify with HALT retry loop — always runs
      const verification = await this.hardVerify(
        opts.baselineErrors,
        opts.startCommit,
        this.config.projectPath,
      );
      if (!verification.passed) {
        const maxRetries = this.config.values.autonomy.maxRetries;
        let fixAttempts = 0;
        let currentSessionId = result.sessionId;
        let lastVerification = verification;

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
            opts.baselineErrors,
            opts.startCommit,
            this.config.projectPath,
          );
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
              input_summary: `persona=${opts.persona}, subtask=${i + 1}`,
              output_summary: `HALT triggered: ${lastVerification.reason} (after ${fixAttempts} attempts)`,
              cost_usd: 0,
              duration_ms: 0,
            });
          }

          const failedSubtasks = (task.subtasks ?? []).map((s) =>
            s.id === st.subtaskId
              ? {
                  ...s,
                  status: "failed" as const,
                  result: lastVerification.reason,
                }
              : s,
          );
          await this.taskStore.updateTask(task.id, {
            subtasks: failedSubtasks,
          });
          const verifyReason = lastVerification.reason || "verification failed";
          const fullReason = subtaskWorkerErrMsg
            ? `${verifyReason} (worker also reported: ${result.errors.join("; ") || "unknown error"})`
            : verifyReason;
          return { success: false, reason: fullReason };
        }
      }

      // Mark subtask done
      const doneSubtasks = (task.subtasks ?? []).map((s) =>
        s.id === st.subtaskId ? { ...s, status: "done" as const } : s,
      );
      await this.taskStore.updateTask(task.id, { subtasks: doneSubtasks });
      // Re-read task for updated subtask state
      task = (await this.taskStore.getTask(task.id))!;

      // Capture session for next subtask resume (only on success)
      lastSuccessfulSessionId = result.sessionId;
    }

    return { success: true };
  }

  private async workerFix(
    sessionId: string,
    errors: string,
    task: Task,
  ): Promise<SessionResult> {
    return this.workerSession.run(
      `The previous changes failed verification:\n${errors}\n\nFix these issues. The original task was: ${task.task_description}\n\nUse superpowers:systematic-debugging to investigate the root cause.\nFollow all 4 phases: investigate → analyze → hypothesize → implement.\nDo NOT guess or "try changing X". Find the actual root cause first.`,
      {
        permissionMode: "bypassPermissions",
        maxTurns: 100,
        maxBudget: this.config.values.claude.maxTaskBudget,
        cwd: this.config.projectPath,
        timeout: 600_000,
        resumeSessionId: sessionId,
        model: resolveModelId(this.config.values.claude.model),
      },
    );
  }

  // --- Hard verification (zero LLM cost) ---

  private async hardVerify(
    baselineErrors: number,
    startCommit: string,
    projectPath: string,
  ): Promise<{ passed: boolean; reason?: string }> {
    // 1. TypeScript errors
    const currentErrors = await countTscErrors(projectPath);
    if (currentErrors < 0) {
      return { passed: false, reason: "TypeScript compilation crashed" };
    }
    if (baselineErrors >= 0 && currentErrors > baselineErrors) {
      return {
        passed: false,
        reason: `TypeScript errors increased: ${baselineErrors} → ${currentErrors} (+${currentErrors - baselineErrors})`,
      };
    }

    // 2. Diff anomaly check (warn only)
    try {
      const stats = await getDiffStats(startCommit, "HEAD", projectPath);
      if (stats.files_changed > 15) {
        log.warn(
          `Post-check warning: ${stats.files_changed} files changed (${stats.insertions}+ ${stats.deletions}-)`,
        );
      }
    } catch {
      /* non-critical */
    }

    return { passed: true };
  }

  // --- Spec compliance review (DEPRECATED: replaced by codeReview + brainReviewDecision) ---

  /** @deprecated Replaced by codeReview() + brainReviewDecision() in the new pipeline. */
  private async specReview(
    task: Task,
    startCommit: string,
    projectPath: string,
    workInstructions?: WorkInstructions,
  ): Promise<{
    passed: boolean;
    missing: string[];
    extra: string[];
    concerns: string[];
  }> {
    const diff = await getDiffSince(startCommit, projectPath, {
      ignoreWhitespace: true,
    }).catch(() => "(diff unavailable)");
    const subtaskList = (task.subtasks ?? [])
      .map((s) => `- ${s.description}`)
      .join("\n");

    // BMAD: inject acceptance criteria from structured workInstructions
    const acSection =
      workInstructions &&
      typeof workInstructions !== "string" &&
      workInstructions.acceptanceCriteria?.length
        ? `\n## Acceptance Criteria (verify against diff)\n${workInstructions.acceptanceCriteria.map((c) => `- [ ] ${c}`).join("\n")}\n`
        : "";

    const prompt = `You are a cynical, adversarial code reviewer. You EXPECT to find problems.
Your job is NOT to confirm quality — it's to find what's wrong, missing, or dangerous.
DO NOT trust commit messages — only examine the actual diff.
If you find zero issues, that is suspicious — re-analyze with more skepticism.

## Original Task
${task.task_description}
${acSection}
${subtaskList ? `## Subtasks\n${subtaskList}\n` : ""}## Git Diff
\`\`\`diff
${diff}
\`\`\`

## Review Checklist (check ALL categories)

### 1. Spec Compliance
- Does the diff fully implement every requirement in the task?
- Are there requirements mentioned but not implemented?

### 2. Scope Discipline
- Does the diff contain changes NOT requested by the task?
- Are there "while I'm here" cleanups, refactors, or improvements?

### 3. Correctness
- Are there logic errors, off-by-one, or missing edge cases?
- Are error paths handled explicitly (no catch-ignore)?

### 4. Safety
- Any new \`any\` types, unvalidated input, or injection vectors?
- Are there catch blocks that swallow errors silently?

### 5. Git Reality
- Does the actual diff match what the task asked for?
- Are there files changed that have no relation to the task?
- Do commit messages accurately describe the changes?

## Rules
- Find 3-10 specific issues. Be concrete — cite file names and line context.
- If you find fewer than 3 issues AND pass, you MUST explain why this code is exceptional.
- "Looks good" without specific analysis is NOT acceptable.

Respond with EXACTLY this JSON (no markdown, no extra text):
{"passed": true/false, "missing": ["..."], "extra": ["..."], "concerns": ["..."]}`;

    const result = await this.brainThink(prompt);
    if (result.costUsd > 0 && task.id) {
      await this.costTracker.addCost(task.id, result.costUsd);
    }

    await this.taskStore.addLog({
      task_id: task.id,
      phase: "review",
      agent: "brain-spec",
      input_summary: "Spec compliance review",
      output_summary: result.text.slice(0, SUMMARY_PREVIEW_LEN),
      cost_usd: result.costUsd,
      duration_ms: result.durationMs,
    });

    const parseSpecResult = (text: string) => {
      const parsed = extractJsonFromText(
        text,
        (v) => isRecord(v) && Object.prototype.hasOwnProperty.call(v, "passed"),
      );
      if (!isRecord(parsed)) return null;
      const res = {
        passed: parsed.passed === true,
        missing: Array.isArray(parsed.missing) ? parsed.missing : [],
        extra: Array.isArray(parsed.extra) ? parsed.extra : [],
        concerns: Array.isArray(parsed.concerns) ? parsed.concerns : [],
      };
      // BMAD: zero findings with PASS is suspicious — inject concern for visibility
      if (
        res.passed &&
        res.missing.length === 0 &&
        res.extra.length === 0 &&
        res.concerns.length === 0
      ) {
        res.concerns = [
          "Reviewer found zero issues — may indicate insufficient analysis",
        ];
      }
      return res;
    };

    const firstResult = parseSpecResult(result.text);
    if (firstResult) return firstResult;

    // extractJsonFromText couldn't find valid JSON — retry once then FAIL
    log.warn("Spec review returned unparseable JSON, retrying once");
    const retry = await this.brainThink(prompt);
    if (retry.costUsd > 0 && task.id) {
      await this.costTracker.addCost(task.id, retry.costUsd);
    }
    const retryResult = parseSpecResult(retry.text);
    if (retryResult) return retryResult;

    log.warn("Spec review retry also unparseable — treating as FAIL");
    return {
      passed: false,
      missing: ["spec review parse failure"],
      extra: [],
      concerns: [],
    };
  }

  // --- Analysis phase (M/L/XL only) ---

  /**
   * Worker analyzes code in read-only mode to produce a concrete change proposal.
   * Uses the WorkerAdapter.analyze() method (read-only).
   */
  private async workerAnalyze(
    task: Task,
    brainOpts?: {
      persona?: string;
      taskType?: string;
      complexity?: string;
      workInstructions?: WorkInstructions;
    },
    revision?: {
      resumeSessionId: string;
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
      // Revision round: resume session with feedback context
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
      input_summary: truncate(task.task_description, SUMMARY_PREVIEW_LEN),
      output_summary: result.text.slice(0, SUMMARY_PREVIEW_LEN),
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

  /**
   * Review a change proposal (reviewer is automatically the opposite of worker).
   * Uses the ReviewAdapter to ensure mutual exclusion.
   */
  private async reviewPlan(
    proposal: string,
    task: Task,
  ): Promise<ReviewResult> {
    const prompt = `You are reviewing a proposed code change plan. Assess feasibility and correctness.

## Task
${task.task_description}

## Proposed Changes
${proposal}

## Review Focus
1. **Feasibility** — Can these changes be made without breaking existing functionality?
2. **Completeness** — Does the proposal address all requirements?
3. **Architecture** — Are the proposed changes well-structured?
4. **Risk** — Are there unaddressed edge cases or breaking changes?
5. **Scope** — Does the proposal stay within the task's scope?

## Output Format (JSON)
{"passed": true/false, "issues": [{"severity": "critical|high|medium|low", "description": "..."}], "summary": "..."}`;

    const result = await this.reviewer.review(prompt, this.config.projectPath);

    if (result.cost_usd > 0) {
      await this.costTracker.addCost(task.id, result.cost_usd);
    }

    await this.taskStore.addLog({
      task_id: task.id,
      phase: "plan-review",
      agent: this.reviewer.name,
      input_summary: "Plan review",
      output_summary:
        `${result.passed ? "PASS" : "FAIL"}: ${result.summary ?? ""}`.slice(
          0,
          SUMMARY_PREVIEW_LEN,
        ),
      cost_usd: result.cost_usd,
      duration_ms: 0,
    });

    return result;
  }

  /**
   * Brain synthesizes the proposal + review feedback into a final approved plan.
   * Returns approved=true with the final plan, or approved=false to block.
   */
  private async brainSynthesizePlan(
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
${proposal.slice(0, 10000)}

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

    const result = await this.brainThink(prompt);

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

  // --- Decision phase (post-review) ---

  /**
   * Brain makes a 5-way decision after code review fails.
   * When isRetry=true, only ignore/block/split are allowed.
   */
  private async brainReviewDecision(
    task: Task,
    reviewResult: ReviewResult,
    diff: string,
    isRetry: boolean,
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

    const allowedDecisions = isRetry
      ? '"ignore", "block", "split"'
      : '"fix", "ignore", "block", "rewrite", "split"';

    const prompt = `You are the brain of an autonomous coding agent. A code review found issues.

## Task
${task.task_description}

## Review Results
${reviewSummary}
Summary: ${reviewResult.summary}

## Code Diff (truncated)
\`\`\`diff
${diff.slice(0, 8000)}
\`\`\`

## Available Decisions: ${allowedDecisions}
- **fix**: Send specific fix instructions to the worker (resume context)
- **ignore**: Issues are minor/false-positive, merge as-is
- **block**: Issues are severe, discard this work
- **rewrite**: Fundamental approach is wrong, provide new instructions
- **split**: Merge what works, create new tasks for unresolved issues

${isRetry ? "This is a RETRY — the worker already attempted one fix. Only ignore/block/split are available." : ""}

## Output (JSON only)
{"decision": "...", "reasoning": "...", "fixInstructions": "...", "newTasks": ["..."]}`;

    const result = await this.brainThink(prompt);

    if (result.costUsd > 0) {
      await this.costTracker.addCost(task.id, result.costUsd);
    }

    await this.taskStore.addLog({
      task_id: task.id,
      phase: "reviewing",
      agent: "brain-decision",
      input_summary: `Review decision (retry=${isRetry})`,
      output_summary: result.text.slice(0, SUMMARY_PREVIEW_LEN),
      cost_usd: result.costUsd,
      duration_ms: result.durationMs,
    });

    // Parse decision
    const parsed = extractJsonFromText(
      result.text,
      (v) =>
        isRecord(v) &&
        typeof (v as Record<string, unknown>).decision === "string",
    );

    if (isRecord(parsed)) {
      const decision = String(parsed.decision) as
        | "fix"
        | "ignore"
        | "block"
        | "rewrite"
        | "split";

      // Validate retry constraints
      const validRetryDecisions = ["ignore", "block", "split"];
      const validDecisions = ["fix", "ignore", "block", "rewrite", "split"];
      const allowed = isRetry ? validRetryDecisions : validDecisions;

      if (allowed.includes(decision)) {
        return {
          decision,
          reasoning: String(parsed.reasoning ?? ""),
          fixInstructions:
            typeof parsed.fixInstructions === "string"
              ? parsed.fixInstructions
              : undefined,
          newTasks: Array.isArray(parsed.newTasks)
            ? parsed.newTasks.map(String)
            : undefined,
        };
      }
    }

    // Parse failure — default to block
    log.warn("Brain review decision unparseable, defaulting to block");
    return {
      decision: "block",
      reasoning: "Decision parse failure — blocking for safety",
    };
  }

  /**
   * Worker fixes issues found in code review.
   * For Claude worker: resumes the original session for context continuity.
   * For Codex worker: starts fresh with full context.
   */
  private async workerReviewFix(
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
      output_summary: result.text.slice(0, SUMMARY_PREVIEW_LEN),
      cost_usd: result.costUsd,
      duration_ms: result.durationMs,
    });

    return {
      costUsd: result.costUsd,
      sessionId: result.sessionId,
      isError: result.isError,
    };
  }

  /**
   * Unified code review entry point.
   * Automatically selects the reviewer that is mutually exclusive with the worker.
   * worker=claude → codex reviews; worker=codex → claude reviews.
   */
  private async codeReview(
    task: Task,
    startCommit: string,
    projectPath: string,
  ): Promise<ReviewResult & { reviewDiff: string }> {
    const changedFiles = await getChangedFilesSince(
      startCommit,
      projectPath,
    ).catch(() => []);

    if (changedFiles.length === 0) {
      return {
        passed: true,
        issues: [],
        summary: "No changed files to review",
        cost_usd: 0,
        reviewDiff: "",
      };
    }

    const reviewDiff = await getDiffSince(startCommit, projectPath, {
      ignoreWhitespace: true,
    }).catch(() => "(diff unavailable)");

    const prompt = `You are an adversarial code reviewer. Review ONLY the changes in this diff.

## Task
${task.task_description}

## Changed Files
${changedFiles.join("\n")}

## Git Diff
\`\`\`diff
${reviewDiff}
\`\`\`

## Review Focus Areas (apply ONLY to the diff above, not pre-existing code)

### 1. Bugs & Logic Errors
- Off-by-one errors, null dereference, race conditions
- Missing await on async calls, unhandled promise rejections
- Incorrect boolean logic, missing break/return statements

### 2. Security
- Unvalidated input, injection vectors (SQL, command, XSS)
- Sensitive data in logs, hardcoded credentials
- Missing authentication/authorization checks

### 3. Error Handling
- Catch blocks that swallow errors silently
- Missing error propagation in async chains
- Default return values hiding failures

### 4. Type Safety
- New \`any\` types introduced
- Unsafe type assertions (as unknown as T)
- Missing null checks on optional values

### 5. Scope Creep
- Changes unrelated to the stated purpose
- "While I'm here" improvements mixed with the main change

## Rules
- ONLY report issues introduced or worsened by THIS diff in the "issues" array.
- If you notice pre-existing bugs/issues in touched files (NOT introduced by this diff), list them separately in "preExistingIssues".
- Find 3-10 specific issues with file names and descriptions.
- If fewer than 3 issues found, explain why the code quality is exceptional.
- Be concrete — cite specific code patterns, not vague concerns.

## Output Format (JSON)
{"passed": true/false, "issues": [...], "preExistingIssues": [{"description": "...", "file": "...", "severity": "high|medium|low"}], "summary": "..."}`;

    const result = await this.reviewer.review(prompt, projectPath);

    if (result.cost_usd > 0) {
      await this.costTracker.addCost(task.id, result.cost_usd);
    }

    // Warn on suspicious parse failure
    if (!result.passed && (result.issues ?? []).length === 0) {
      log.warn(
        "Code review returned passed=false with zero issues — likely output parse failure, treating as PASS",
      );
      return { ...result, passed: true, reviewDiff };
    }

    await this.taskStore.addLog({
      task_id: task.id,
      phase: "review",
      agent: this.reviewer.name,
      input_summary: `files: ${changedFiles.join(", ").slice(0, SUMMARY_PREVIEW_LEN)}`,
      output_summary:
        `${result.passed ? "PASS" : "FAIL"}: ${result.summary ?? ""}`.slice(
          0,
          SUMMARY_PREVIEW_LEN,
        ),
      cost_usd: result.cost_usd,
      duration_ms: 0,
    });

    // Queue pre-existing issues as new tasks
    const preExisting = result.preExistingIssues ?? [];
    for (const issue of preExisting) {
      const desc = issue.file
        ? `fix: ${issue.description} (${issue.file})`
        : `fix: ${issue.description}`;
      const isDuplicate = await this.taskStore.hasRecentlyFailedSimilar(
        projectPath,
        desc,
        48,
      );
      if (!isDuplicate) {
        await this.taskStore.createTask(projectPath, desc, 3);
        log.info(`Queued pre-existing issue: ${desc.slice(0, 100)}`);
      }
    }

    return { ...result, reviewDiff };
  }

  // --- Brain reflection ---

  private async brainReflect(
    task: Task,
    outcome: string,
    verification: { passed: boolean; reason?: string },
    projectPath: string,
    personaName?: string,
  ): Promise<void> {
    // Build persona context for evolution
    const personaData = personaName
      ? await this.taskStore.getPersona(personaName)
      : null;
    const personaContext = personaData
      ? `
## Current Persona: ${personaData.name}
Role: ${personaData.role}
Usage: ${personaData.usage_count} tasks, ${Math.round((personaData.success_rate ?? 0) * 100)}% success
Content:
${personaData.content}

If this task revealed a pattern (recurring failure, new anti-pattern, rule that should be added/removed),
you may update the persona content. Use this format to propose changes:

PERSONA_UPDATE:
[new full content for the persona, or "NO_CHANGE" if no update needed]
END_PERSONA_UPDATE
`
      : "";

    const prompt = `Reflect on this completed task:

Task: ${task.task_description}
Outcome: ${outcome}
Verification: ${verification.passed ? "PASSED" : `FAILED — ${verification.reason}`}
${personaContext}
1. What went well? What could be improved?
2. Do NOT edit CLAUDE.md unless you discover a critical, repeatable anti-pattern that would affect every future task (extremely rare, <5% of reflections).
${personaData ? "3. If the persona needs updating based on this experience, include a PERSONA_UPDATE block." : ""}`;

    const result = await this.brainSession.run(prompt, {
      permissionMode: "bypassPermissions",
      maxTurns: 50,
      cwd: projectPath,
      timeout: 300_000,
      model: resolveModelId(this.config.values.brain.model),
      appendSystemPrompt:
        "You are reflecting on a task. Do not modify source code. Do not edit CLAUDE.md unless absolutely necessary.",
      allowedTools: ["Read", "Glob", "Grep", "Bash", "Edit", "Write"],
    });

    if (result.costUsd > 0)
      await this.costTracker.addCost(task.id, result.costUsd);

    await this.taskStore.addLog({
      task_id: task.id,
      phase: "reflect",
      agent: "brain",
      input_summary: `Reflect on ${outcome}`,
      output_summary: result.text.slice(0, SUMMARY_PREVIEW_LEN),
      cost_usd: result.costUsd,
      duration_ms: result.durationMs,
    });

    // Parse and apply persona evolution
    if (personaName && personaData) {
      const updateMatch = result.text.match(
        /PERSONA_UPDATE:\s*\n([\s\S]*?)\nEND_PERSONA_UPDATE/,
      );
      if (updateMatch) {
        const newContent = updateMatch[1].trim();
        if (newContent && newContent !== "NO_CHANGE") {
          await this.taskStore.updatePersonaContent(personaName, newContent);
          log.info(`Persona ${personaName} evolved via brainReflect`);
          await this.taskStore.addLog({
            task_id: task.id,
            phase: "persona-evolution",
            agent: "brain",
            input_summary: `Persona ${personaName} updated`,
            output_summary: newContent.slice(0, SUMMARY_PREVIEW_LEN),
            cost_usd: 0,
            duration_ms: 0,
          });
        }
      }
    }

    // Update persona usage stats
    if (personaName) {
      await this.taskStore
        .updatePersonaStats(personaName, outcome === "success")
        .catch((err) =>
          log.warn(`Failed to update persona stats for ${personaName}:`, err),
        );
    }
  }

  // --- Pipeline health check (auto-diagnosis) ---

  private async pipelineHealthCheck(projectPath: string): Promise<void> {
    log.info("Pipeline health check triggered after consecutive rejections");

    const result = await this.brainSession.run(
      `## Pipeline Health Check

Multiple tasks have been rejected consecutively, suggesting a systemic pipeline issue.

## Instructions
1. Use the \`get_blocked_summary\` MCP tool to see how many tasks are blocked and their failure patterns
2. If blocked count < 3, respond "No systemic issue" and stop
3. Otherwise, use \`get_task_logs\` on a few failed tasks to understand the failure pattern
4. Use Read, Grep, Bash to investigate the pipeline code if failures point to a code bug
5. If you find a systemic bug, use \`create_task\` to create fix task(s) with:
   - Description prefixed with "[PIPELINE-FIX]"
   - Priority 0 (urgent)
6. Use \`requeue_blocked_tasks\` if blocked tasks should be retried after the fix
7. If failures are legitimate (bad task quality, not a bug), do nothing`,
      {
        permissionMode: "bypassPermissions",
        maxTurns: 30,
        cwd: projectPath,
        timeout: 600_000,
        model: resolveModelId(this.config.values.brain.model),
        allowedTools: [
          "Read",
          "Glob",
          "Grep",
          "Bash",
          "mcp__db-coder-system-data__get_blocked_summary",
          "mcp__db-coder-system-data__get_recent_tasks",
          "mcp__db-coder-system-data__get_task_detail",
          "mcp__db-coder-system-data__get_task_logs",
          "mcp__db-coder-system-data__get_operational_metrics",
          "mcp__db-coder-system-data__create_task",
          "mcp__db-coder-system-data__requeue_blocked_tasks",
        ],
        appendSystemPrompt:
          "You are diagnosing pipeline failures. Investigate thoroughly before taking action. Do not modify source files.",
      },
    );

    if (result.costUsd > 0) {
      await this.taskStore.addDailyCost(result.costUsd);
    }
    log.info(
      `Pipeline health check completed (cost: $${result.costUsd.toFixed(3)})`,
    );
  }

  // --- Periodic CLAUDE.md maintenance ---

  private async claudeMdMaintenance(projectPath: string): Promise<void> {
    log.info("Starting periodic CLAUDE.md maintenance");
    const result = await this.brainSession.run(
      `Perform a maintenance audit of CLAUDE.md. Keep it accurate, concise, and useful.

Read CLAUDE.md, then verify against actual code:
1. **文件结构** — Are listed files still accurate? Remove deleted, add important new ones.
2. **当前状态** — Are checklist items correct? Update "待运行验证" items if now verified.
3. **API 端点** — Do endpoints match actual routes in src/server/routes.ts?
4. **架构描述** — Does it match actual code structure?
5. **踩过的坑** — Remove entries for deleted code. Keep entries concise.
6. **DB Schema** — Are table descriptions still accurate?

Rules:
- DELETE outdated info rather than adding disclaimers.
- Keep the file concise — summarize growing sections.
- Only state what you verify in the code.
- Use claude-mem to note what you changed and why.`,
      {
        permissionMode: "bypassPermissions",
        maxTurns: 50,
        cwd: projectPath,
        timeout: 3_600_000,
        model: resolveModelId(this.config.values.brain.model),
        allowedTools: ["Read", "Glob", "Grep", "Bash", "Edit", "Write"],
        appendSystemPrompt:
          "You are maintaining CLAUDE.md. You CAN edit CLAUDE.md. Do not modify source code.",
      },
    );

    if (result.costUsd > 0) await this.taskStore.addDailyCost(result.costUsd);
    log.info(
      `CLAUDE.md maintenance completed (${Math.round(result.durationMs / 1000)}s, $${result.costUsd.toFixed(4)})`,
    );
  }

  // --- State management ---

  private setState(state: LoopState): void {
    if (this.state === state) return;
    this.state = state;
    this.broadcastStatus();
  }

  private setCurrentTaskId(taskId: string | null): void {
    if (this.currentTaskId === taskId) return;
    this.currentTaskId = taskId;
    this.broadcastStatus();
  }

  private setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.broadcastStatus();
  }

  private setRunning(running: boolean): void {
    if (this.running === running) return;
    this.running = running;
    this.broadcastStatus();
  }

  private resetCycleSteps(): void {
    this.cycleNumber++;
    this.cycleSteps = CYCLE_PIPELINE.map((phase) => ({
      phase,
      status: "pending" as CycleStepStatus,
    }));
    this.currentPhase = null;
    this.broadcastStatus();
  }

  private beginStep(phase: string): void {
    this.currentPhase = phase;
    this.cycleSteps = this.cycleSteps.map((s) =>
      s.phase === phase
        ? { ...s, status: "active" as CycleStepStatus, startedAt: Date.now() }
        : s,
    );
    this.broadcastStatus();
  }

  private endStep(
    phase: string,
    result: "done" | "failed" | "skipped",
    summary?: string,
  ): void {
    const now = Date.now();
    this.cycleSteps = this.cycleSteps.map((s) => {
      if (s.phase !== phase) return s;
      const durationMs = s.startedAt ? now - s.startedAt : undefined;
      return {
        ...s,
        status: result as CycleStepStatus,
        finishedAt: now,
        durationMs,
        summary,
      };
    });
    this.broadcastStatus();
  }

  private skipRemainingSteps(fromPhase?: string): void {
    let shouldSkip = !fromPhase;
    this.cycleSteps = this.cycleSteps.map((s) => {
      if (s.phase === fromPhase) {
        shouldSkip = true;
        return s;
      }
      if (shouldSkip && s.status === "pending") {
        return { ...s, status: "skipped" as CycleStepStatus };
      }
      return s;
    });
    this.broadcastStatus();
  }

  private broadcastStatus(): void {
    if (this.statusListeners.size === 0) return;
    const snapshot: StatusSnapshot = {
      state: this.state,
      currentTaskId: this.currentTaskId,
      patrolling: this.running,
      paused: this.paused,
      cycleNumber: this.cycleNumber,
      currentPhase: this.currentPhase ?? undefined,
      cycleSteps: [...this.cycleSteps],
      taskDescription: this.currentTaskDescription ?? undefined,
    };
    for (const listener of this.statusListeners) {
      try {
        listener(snapshot);
      } catch {
        /* ignore listener failures */
      }
    }
  }

  // --- Helpers ---

  private isSelfProject(): boolean {
    try {
      const pkgPath = join(this.config.projectPath, "package.json");
      if (!existsSync(pkgPath)) return false;
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      return pkg.name === "db-coder";
    } catch {
      return false;
    }
  }

  private writeBuildError(error: string): void {
    const dir = join(homedir(), ".db-coder");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "build-error.json"),
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          type: "build",
          error,
        },
        null,
        2,
      ),
    );
  }

  private acquireLock(): boolean {
    if (existsSync(this.lockFile)) {
      try {
        const pid = parseInt(readFileSync(this.lockFile, "utf-8"), 10);
        if (pid === process.pid) {
          /* same process restart */
        } else {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            /* stale lock */
          }
        }
      } catch {
        /* invalid lock file */
      }
    }
    const lockDir = join(homedir(), ".db-coder");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(this.lockFile, String(process.pid));
    return true;
  }

  private releaseLock(): void {
    try {
      unlinkSync(this.lockFile);
    } catch {
      /* ignore */
    }
  }

  private async checkBudgetOrAbort(taskId: string): Promise<boolean> {
    const budget = await this.costTracker.checkBudget(taskId);
    if (budget.allowed) return false;
    log.warn(`Budget exceeded: ${budget.reason}`);
    await this.taskStore.updateTask(taskId, {
      status: "blocked",
      phase: "blocked",
    });
    return true;
  }

  private async cleanupOrphanedBranches(): Promise<void> {
    const projectPath = this.config.projectPath;
    const prefix = this.config.values.git.branchPrefix;
    const branches = await listBranches(prefix, projectPath);
    if (branches.length === 0) return;

    const [queued, active, failed, blocked] = await Promise.all([
      this.taskStore.listTasks(projectPath, "queued"),
      this.taskStore.listTasks(projectPath, "active"),
      this.taskStore.listTasks(projectPath, "failed"),
      this.taskStore.listTasks(projectPath, "blocked"),
    ]);

    // queued/active branches are always protected
    const activeBranches = new Set(
      [...queued, ...active].map((t) => t.git_branch).filter(Boolean),
    );

    // failed/blocked branches are protected within retention period
    const retentionMs =
      this.config.values.git.branchRetentionDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const retainedBranches = new Set(
      [...failed, ...blocked]
        .filter(
          (t) =>
            t.git_branch &&
            now - new Date(t.updated_at).getTime() < retentionMs,
        )
        .map((t) => t.git_branch),
    );

    let cleaned = 0;
    let preserved = 0;
    for (const branch of branches) {
      if (activeBranches.has(branch)) continue;
      if (retainedBranches.has(branch)) {
        preserved++;
        continue;
      }
      await this.cleanupTaskBranch(branch, { force: true });
      const stillExists = await branchExists(branch, projectPath).catch(
        () => true,
      );
      if (!stillExists) cleaned++;
    }
    if (preserved > 0)
      log.info(
        `Preserved ${preserved} branch(es) for recent failed/blocked tasks`,
      );
    if (cleaned > 0) log.info(`Cleaned up ${cleaned} orphaned branch(es)`);
  }

  private async cleanupTaskBranch(
    branch: string,
    opts?: { force?: boolean; startCommit?: string },
  ): Promise<void> {
    try {
      if (opts?.force) {
        await forceDeleteBranch(branch, this.config.projectPath);
        return;
      }
      // Compare branch HEAD with startCommit: identical means no worker output
      if (opts?.startCommit) {
        const branchHead = await getBranchHeadCommit(
          branch,
          this.config.projectPath,
        );
        if (branchHead === opts.startCommit) {
          await forceDeleteBranch(branch, this.config.projectPath);
          return;
        }
      }
      // Has worker output or cannot determine → preserve
      log.info(`Preserving branch ${branch} (has worker commits)`);
    } catch (err) {
      log.warn(`Failed to cleanup branch ${branch}: ${err}`);
    }
  }
}

// --- Exported utilities (used by tests and routes) ---

export async function countTscErrors(cwd: string): Promise<number> {
  if (!countTscErrorsDeps.existsSync(join(cwd, "tsconfig.json"))) return 0;
  try {
    const result = await countTscErrorsDeps.runProcess(
      "npx",
      ["tsc", "--noEmit"],
      { cwd, timeout: 60_000 },
    );
    return (result.stdout + result.stderr)
      .split("\n")
      .filter((l) => l.includes(": error TS")).length;
  } catch (e) {
    log.warn("countTscErrors failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return -1;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
