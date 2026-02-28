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
import type { Task } from "../memory/types.js";
import type {
  LoopState,
  StatusSnapshot,
  CycleStep,
  StepPhase,
  TaskPlan,
  PlanTask,
  TaskType,
} from "./types.js";
// CYCLE_PIPELINE is used by CycleStepTracker (StepTracker.ts)
import {
  createBranch,
  switchBranch,
  commitAll,
  getHeadCommit,
  getCurrentBranch,
  branchExists,
  getModifiedAndAddedFiles,
  mergeBranch,
  deleteBranch,
} from "../utils/git.js";
import { log } from "../utils/logger.js";
import { truncate } from "../utils/parse.js";
import { TASK_DESC_MAX_LENGTH } from "../types/constants.js";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { safeBuild } from "../utils/safeBuild.js";
import { CycleEventBus } from "./CycleEventBus.js";
import type { CycleEvent, CyclePhase, CycleTiming } from "./CycleEvents.js";
import {
  PersonaLoader,
  formatWorkInstructions,
  type WorkInstructions,
} from "./PersonaLoader.js";
import { ChainScanner } from "./ChainScanner.js";
import { ProjectVerifier, type VerifyBaseline } from "./ProjectVerifier.js";
import type { RegisteredStrategies } from "./strategies/index.js";
import { ProjectMemory } from "../memory/ProjectMemory.js";
import { MaintenancePhase } from "./phases/MaintenancePhase.js";
import { ReviewPhase } from "./phases/ReviewPhase.js";
import { WorkerPhase, COMPLEXITY_CONFIG } from "./phases/WorkerPhase.js";
import {
  BrainPhase,
  coerceSubtaskOrder,
  normalizeSubtasks,
} from "./phases/BrainPhase.js";
// Re-export pure functions from StepTracker for backward compatibility
export {
  applyStepStatusUpdate,
  applyBeginStep,
  failAllActiveSteps,
} from "./StepTracker.js";
// Re-export countTscErrors from MaintenancePhase for backward compatibility
export {
  countTscErrors,
  setCountTscErrorsDepsForTests,
} from "./phases/MaintenancePhase.js";
// Internal import for use within this file
import {
  applyStepStatusUpdate as _applyStepStatusUpdate,
  applyBeginStep as _applyBeginStep,
  failAllActiveSteps as _failAllActiveSteps,
  findFinishedStepsByPhase,
  CycleStepTracker,
} from "./StepTracker.js";

const PAUSE_INTERVAL_MS = 5000;
const ERROR_RECOVERY_MS = 30_000;
const BRANCH_ID_LENGTH = 8;
// COMPLEXITY_CONFIG is imported from WorkerPhase
// coerceSubtaskOrder + normalizeSubtasks are imported from BrainPhase

// countTscErrors + setCountTscErrorsDepsForTests are defined in
// phases/MaintenancePhase.ts and re-exported above for backward compatibility.

// Pure functions (applyStepStatusUpdate, failAllActiveSteps, applyBeginStep)
// are defined in StepTracker.ts and re-exported above for backward compatibility.

// StatusListener type is defined in StepTracker.ts
import type { StatusListener } from "./StepTracker.js";

export class MainLoop {
  // All mutable cycle/state fields are managed by the tracker
  private tracker = new CycleStepTracker();
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
  private projectVerifier: ProjectVerifier;
  private worker: WorkerAdapter;
  private reviewer: ReviewAdapter;
  private claudeReviewer: ClaudeReviewAdapter;
  private codexReviewer: CodexReviewAdapter;
  private strategies?: RegisteredStrategies;
  private projectMemory: ProjectMemory | null = null;
  private memoryProject = "default-project";
  private maintenance!: MaintenancePhase;
  private review!: ReviewPhase;
  private workerPhase!: WorkerPhase;
  private brain!: BrainPhase;

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
    strategies?: RegisteredStrategies,
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
    this.projectVerifier = new ProjectVerifier();
    this.claudeReviewer = new ClaudeReviewAdapter(this.brainSession);
    this.codexReviewer = new CodexReviewAdapter(codex);
    this.strategies = strategies;

    // Wire up WorkerAdapter + ReviewAdapter (defaults from config if not injected)
    if (workerAdapter && reviewAdapter) {
      this.worker = workerAdapter;
      this.reviewer = reviewAdapter;
    } else {
      const workerType = config.values.autonomy.worker;
      if (workerType === "codex") {
        this.worker = new CodexWorkerAdapter(codex);
        this.reviewer = this.claudeReviewer;
      } else {
        this.worker = new ClaudeWorkerAdapter(this.workerSession);
        this.reviewer = this.codexReviewer;
      }
    }

    this.memoryProject = this.deriveMemoryProject(config.projectPath);

    // MaintenancePhase handles verification, cleanup, locking, health checks
    this.maintenance = new MaintenancePhase(
      config,
      taskStore,
      costTracker,
      this.brainSession,
      this.projectVerifier,
      this.lockFile,
    );
    this.review = new ReviewPhase(
      config,
      taskStore,
      costTracker,
      this.brainSession,
      this.reviewer,
    );
    this.workerPhase = new WorkerPhase(
      config,
      taskStore,
      costTracker,
      this.worker,
      this.workerSession,
      codex,
      this.personaLoader,
      (baseline, startCommit, projectPath) =>
        this.maintenance.hardVerify(baseline, startCommit, projectPath),
    );

    // claude-mem integration (optional, non-critical)
    const memUrl = config.values.memory.claudeMemUrl;
    this.projectMemory = memUrl ? new ProjectMemory(memUrl) : null;

    this.brain = new BrainPhase(
      config,
      taskStore,
      costTracker,
      this.brainSession,
      this.taskQueue,
      this.strategies,
      this.projectMemory,
      this.memoryProject,
    );
  }

  /** Select the reviewer that's opposite to the given worker type */
  private reviewerFor(workerType: "claude" | "codex"): ReviewAdapter {
    return workerType === "codex" ? this.claudeReviewer : this.codexReviewer;
  }

  private makeEvent(
    phase: CyclePhase,
    timing: CycleTiming,
    data: Record<string, unknown> = {},
  ): CycleEvent {
    return this.tracker.makeEvent(phase, timing, data);
  }

  // --- Public interface (backward compatible, delegates to tracker) ---

  getState(): LoopState {
    return this.tracker.getState();
  }
  getCurrentTaskId(): string | null {
    return this.tracker.getCurrentTaskId();
  }
  isPaused(): boolean {
    return this.tracker.isPaused();
  }
  isRunning(): boolean {
    return this.tracker.isRunning();
  }

  /** Return a full status snapshot for initial SSE push. */
  getStatusSnapshot(): StatusSnapshot {
    return this.tracker.getStatusSnapshot();
  }

  onRestart(listener: () => void): () => void {
    this.restartListeners.add(listener);
    return () => {
      this.restartListeners.delete(listener);
    };
  }

  addStatusListener(listener: StatusListener): () => void {
    return this.tracker.addStatusListener(listener);
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
    if (this.tracker.isRunning())
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
    if (this.tracker.isRunning())
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
    if (this.tracker.isRunning())
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
    if (this.tracker.isRunning()) return;
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

    try {
      while (this.tracker.isRunning()) {
        if (this.tracker.isPaused()) {
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
      this.tracker.setCurrentTaskDescription(task.task_description);
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

      this.tracker.setCurrentTaskDescription(decision.taskDescription);
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
          const rawOrders = decision.subtasks.map((st, i) =>
            coerceSubtaskOrder(st.order, i + 1),
          );
          const hasDuplicates = new Set(rawOrders).size !== rawOrders.length;
          updates.subtasks = decision.subtasks.map((st, i) => {
            const coerced = coerceSubtaskOrder(st.order, i + 1);
            return {
              id: String(i + 1),
              description: st.description,
              executor: "claude" as const,
              status: "pending" as const,
              order: hasDuplicates ? i + 1 : coerced,
            };
          });
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
      this.tracker.setCurrentTaskDescription(null);
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
      const baseline = await this.projectVerifier.baseline(projectPath);

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
      const cConfigForTask = COMPLEXITY_CONFIG[complexity];
      const taskReviewer = this.reviewerFor(cConfigForTask.worker);
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
            this.tracker.setCurrentTaskDescription(null);
            this.setState("idle");
            return false;
          }

          // Reviewer evaluates the proposal (mutually exclusive with worker)
          const planReview = await this.reviewPlan(
            analyzeResult.proposal,
            task,
            taskReviewer,
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
          this.tracker.setCurrentTaskDescription(null);
          this.setState("idle");
          return false;
        }

        this.endStep("analyze", "done");
      } else {
        this.endStep("analyze", "skipped");
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
        this.tracker.setCurrentTaskDescription(null);
        this.setState("idle");
        return false;
      }

      let workerPassed: boolean;
      let workerSessionId: string | undefined;
      const verification: { passed: boolean; reason?: string } = {
        passed: true,
      };

      if (brainOpts?.subtasks && brainOpts.subtasks.length > 0) {
        // Normalize orders to match persisted subtasks
        const normalizedSubtasks = brainOpts.subtasks.map((st, i) => ({
          ...st,
          order: coerceSubtaskOrder(st.order, i + 1),
        }));
        // Deduplicate: if any orders collide, fall back to sequential
        const orderSet = new Set(normalizedSubtasks.map((s) => s.order));
        const subtasksForExec =
          orderSet.size !== normalizedSubtasks.length
            ? normalizedSubtasks.map((st, i) => ({ ...st, order: i + 1 }))
            : normalizedSubtasks;
        // Subtask execution loop
        const executeStart = Date.now();
        const result = await this.executeSubtasks(task, subtasksForExec, {
          persona: brainOpts.persona,
          taskType: brainOpts.taskType,
          complexity: brainOpts.complexity,
          workInstructions: brainOpts.workInstructions,
          baseline,
          startCommit,
        });
        workerPassed = result.success;
        verification.passed = result.success;
        if (!result.success)
          verification.reason = result.reason || "Subtask verification failed";
        const executeDurationMs =
          Date.now() - executeStart - result.totalVerifyMs;
        this.endStep(
          "execute",
          result.success ? "done" : "failed",
          undefined,
          Math.max(0, executeDurationMs),
        );
        this.eventBus.emit(
          this.makeEvent("execute", "after", {
            startCommit,
            result: { costUsd: 0, durationMs: 0 },
          }),
        );
        this.beginStep("verify");
        this.eventBus.emit(
          this.makeEvent("verify", "after", { verification, startCommit }),
        );
        this.endStep(
          "verify",
          result.success ? "done" : "failed",
          verification.reason,
          result.totalVerifyMs,
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
          input_summary: task.task_description,
          output_summary: workerResult.text,
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
        // Hard verification — always runs regardless of workerResult.isError
        this.endStep("execute", "done");
        this.eventBus.emit(
          this.makeEvent("execute", "after", {
            startCommit,
            result: {
              costUsd: workerResult.costUsd,
              durationMs: workerResult.durationMs,
            },
          }),
        );
        try {
          this.beginStep("verify");
          this.setState("reviewing");
          const verifyStart = Date.now();
          const singleVerify = await this.hardVerify(
            baseline,
            startCommit,
            projectPath,
          );
          await this.taskStore.addLog({
            task_id: task.id,
            phase: "verify",
            agent: "tsc",
            input_summary: `baseline=${JSON.stringify(baseline)}, startCommit=${startCommit}${workerResult.isError ? ", workerError=true" : ""}`,
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
              baseline,
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
            await this.taskStore.addLog({
              task_id: task.id,
              phase: "halt-learning",
              agent: "system",
              input_summary: "HALT triggered",
              output_summary: `HALT triggered: ${singleVerify.reason} (after ${fixAttempts} attempts)`,
              cost_usd: 0,
              duration_ms: 0,
            });
          }

          workerPassed = singleVerify.passed;
          workerSessionId = currentSessionId;
          verification.passed = singleVerify.passed;
          verification.reason = singleVerify.reason;

          this.endStep(
            "verify",
            singleVerify.passed ? "done" : "failed",
            singleVerify.reason,
          );
          if (!singleVerify.passed) {
            const executeStep = this.tracker
              .getCycleSteps()
              .find((s) => s.phase === "execute");
            if (executeStep?.finishedAt != null) {
              this.updateStepStatus("execute", "failed", singleVerify.reason);
            } else if (executeStep) {
              log.info(
                "Skipping execute step status update: step not yet finished",
                {
                  hasStep: !!executeStep,
                  finishedAt: executeStep?.finishedAt,
                },
              );
            } else {
              log.info("Skipping execute step status update: step not found");
            }
          }
        } catch (verifyErr) {
          const errMsg =
            verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
          try {
            this.endStep("verify", "failed", `Exception: ${errMsg}`);
          } catch (statusErr) {
            log.warn(
              "endStep('verify') failed in catch(verifyErr), preserving original error",
              { statusErr },
            );
          }
          const finished = findFinishedStepsByPhase(
            [...this.tracker.getCycleSteps()],
            "execute",
          );
          if (finished) {
            try {
              this.updateStepStatus(
                "execute",
                "failed",
                `Verification phase exception: ${errMsg}`,
              );
            } catch (statusErr) {
              log.warn(
                "updateStepStatus('execute') failed in catch(verifyErr), preserving original error",
                { statusErr },
              );
            }
          } else {
            const execStepExists = this.tracker
              .getCycleSteps()
              .some((s) => s.phase === "execute");
            log.warn(
              "Skipping updateStepStatus('execute') in catch(verifyErr): execute step not found or not finished",
              { exists: execStepExists },
            );
            if (execStepExists) {
              try {
                await this.taskStore.addLog({
                  task_id: task.id,
                  phase: "execute",
                  agent: "system",
                  input_summary: "execute step status persistence fallback",
                  output_summary: `execute step not finished when verification threw: ${errMsg}`,
                  cost_usd: 0,
                  duration_ms: 0,
                });
              } catch (logErr) {
                log.warn(
                  "taskStore.addLog fallback failed in catch(verifyErr)",
                  { logErr },
                );
              }
            }
          }
          throw verifyErr;
        }
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
          taskReviewer,
        );

        // Store review results for traceability
        await this.taskStore.updateTask(task.id, {
          review_results: reviewResult.issues ?? [],
        });

        if (!reviewResult.passed) {
          log.info(`Code review: FAIL — ${reviewResult.summary}`, {
            issues: (reviewResult.issues ?? []).length,
            reviewer: taskReviewer.name,
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
                  const { duplicate, reason } =
                    await this.taskStore.isDuplicateTask(
                      projectPath,
                      newTaskDesc,
                    );
                  if (duplicate) {
                    log.info(
                      `Split dedup: ${reason} — "${truncate(newTaskDesc, 100)}"`,
                    );
                    continue;
                  }
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
                  baseline,
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
                  taskReviewer,
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
                      const { duplicate, reason } =
                        await this.taskStore.isDuplicateTask(
                          projectPath,
                          newTaskDesc,
                        );
                      if (duplicate) {
                        log.info(
                          `Split dedup: ${reason} — "${truncate(newTaskDesc, 100)}"`,
                        );
                        continue;
                      }
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
        await this.brainReflect(task, outcome, verification, projectPath);
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
      // Mark ALL active steps as failed (not just the first one)
      this.tracker.setCycleSteps(
        _failAllActiveSteps([...this.tracker.getCycleSteps()], String(err)),
      );
      this.broadcastStatus();
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
      this.tracker.setCurrentTaskDescription(null);
    }

    this.setState("idle");
    return true;
  }

  // --- Brain session (delegated to BrainPhase) ---

  private async brainDecide(projectPath: string) {
    return this.brain.brainDecide(projectPath);
  }

  private async gatherBrainContext(projectPath: string): Promise<string> {
    return this.brain.gatherBrainContext(projectPath);
  }

  private async brainDecideDirective(projectPath: string) {
    return this.brain.brainDecideDirective(projectPath);
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
    return this.workerPhase.workerExecute(task, opts);
  }

  private async executeSubtasks(
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
    return this.workerPhase.executeSubtasks(task, subtasks, opts);
  }

  private async workerFix(
    sessionId: string,
    errors: string,
    task: Task,
  ): Promise<SessionResult> {
    return this.workerPhase.workerFix(sessionId, errors, task);
  }

  // --- Hard verification (delegates to MaintenancePhase) ---

  private async hardVerify(
    baseline: VerifyBaseline,
    startCommit: string,
    projectPath: string,
  ): Promise<{ passed: boolean; reason?: string }> {
    return this.maintenance.hardVerify(baseline, startCommit, projectPath);
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
    return this.review.specReview(
      task,
      startCommit,
      projectPath,
      workInstructions,
    );
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
    return this.workerPhase.workerAnalyze(task, brainOpts, revision);
  }

  /**
   * Review a change proposal (reviewer is automatically the opposite of worker).
   * Uses the ReviewAdapter to ensure mutual exclusion.
   */
  private async reviewPlan(
    proposal: string,
    task: Task,
    reviewerOverride?: ReviewAdapter,
  ): Promise<ReviewResult> {
    return this.review.reviewPlan(proposal, task, reviewerOverride);
  }

  private async brainSynthesizePlan(
    proposal: string,
    planReview: ReviewResult,
    task: Task,
  ) {
    return this.brain.brainSynthesizePlan(proposal, planReview, task);
  }

  // --- Decision phase (post-review) ---

  private async brainReviewDecision(
    task: Task,
    reviewResult: ReviewResult,
    diff: string,
    isRetry: boolean,
  ) {
    return this.brain.brainReviewDecision(task, reviewResult, diff, isRetry);
  }

  /**
   * Worker fixes issues found in code review (delegates to WorkerPhase).
   */
  private async workerReviewFix(
    task: Task,
    fixInstructions: string,
    sessionId?: string,
  ): Promise<{ costUsd: number; sessionId?: string; isError: boolean }> {
    return this.workerPhase.workerReviewFix(task, fixInstructions, sessionId);
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
    reviewerOverride?: ReviewAdapter,
  ): Promise<ReviewResult & { reviewDiff: string }> {
    return this.review.codeReview(
      task,
      startCommit,
      projectPath,
      reviewerOverride,
    );
  }

  // --- Brain reflection (delegated to BrainPhase) ---

  private async brainReflect(
    task: Task,
    outcome: string,
    verification: { passed: boolean; reason?: string },
    projectPath: string,
  ): Promise<void> {
    return this.brain.brainReflect(task, outcome, verification, projectPath);
  }

  // --- Pipeline health check (auto-diagnosis) ---

  private async pipelineHealthCheck(projectPath: string): Promise<void> {
    return this.maintenance.pipelineHealthCheck(projectPath);
  }

  // --- Periodic CLAUDE.md maintenance ---

  private async claudeMdMaintenance(projectPath: string): Promise<void> {
    return this.maintenance.claudeMdMaintenance(projectPath);
  }

  // --- State management (delegates to CycleStepTracker) ---

  private setState(state: LoopState): void {
    this.tracker.setState(state);
  }

  private setCurrentTaskId(taskId: string | null): void {
    this.tracker.setCurrentTaskId(taskId);
  }

  private setPaused(paused: boolean): void {
    this.tracker.setPaused(paused);
  }

  private setRunning(running: boolean): void {
    this.tracker.setRunning(running);
  }

  private resetCycleSteps(): void {
    this.tracker.resetCycleSteps();
  }

  private beginStep(phase: StepPhase): void {
    this.tracker.beginStep(phase);
  }

  private endStep(
    phase: StepPhase,
    result: "done" | "failed" | "skipped",
    summary?: string,
    durationOverrideMs?: number,
  ): void {
    this.tracker.endStep(phase, result, summary, durationOverrideMs);
  }

  private updateStepStatus(
    phase: StepPhase,
    status: "done" | "failed",
    summary?: string,
  ): void {
    this.tracker.updateStepStatus(phase, status, summary);
  }

  private skipRemainingSteps(fromPhase?: StepPhase): void {
    this.tracker.skipRemainingSteps(fromPhase);
  }

  private broadcastStatus(): void {
    this.tracker.broadcastStatus();
  }

  // --- Helpers ---

  private isSelfProject(): boolean {
    return this.maintenance.isSelfProject();
  }

  private deriveMemoryProject(projectPath: string): string {
    const value = basename(projectPath)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return value || "default-project";
  }

  private writeBuildError(error: string): void {
    this.maintenance.writeBuildError(error);
  }

  private acquireLock(): boolean {
    return this.maintenance.acquireLock();
  }

  private releaseLock(): void {
    this.maintenance.releaseLock();
  }

  private async checkBudgetOrAbort(taskId: string): Promise<boolean> {
    return this.maintenance.checkBudgetOrAbort(taskId);
  }

  private async cleanupOrphanedBranches(): Promise<void> {
    return this.maintenance.cleanupOrphanedBranches();
  }

  private async cleanupTaskBranch(
    branch: string,
    opts?: { force?: boolean; startCommit?: string },
  ): Promise<void> {
    return this.maintenance.cleanupTaskBranch(branch, opts);
  }
}

// --- Utility functions ---

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
