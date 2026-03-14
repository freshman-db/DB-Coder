import type { Config } from "../config/Config.js";
import type { TaskQueue } from "./TaskQueue.js";
import type { TaskStore } from "../memory/TaskStore.js";
import type { CostTracker } from "../utils/cost.js";
import type { SdkExtras } from "../bridges/buildSdkOptions.js";
import { RuntimeReviewAdapter, type ReviewAdapter } from "./WorkerAdapter.js";
import type { RuntimeAdapter } from "../runtime/RuntimeAdapter.js";
import {
  createRuntimeSet,
  type Killable,
  getRuntimeSync,
  normalizeRuntimeName,
} from "../runtime/runtimeFactory.js";
import type { SubTaskRecord, Task } from "../memory/types.js";
import type {
  LoopState,
  StatusSnapshot,
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
import {
  SUMMARY_PREVIEW_LEN,
  TASK_DESC_MAX_LENGTH,
} from "../types/constants.js";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { safeBuild } from "../utils/safeBuild.js";
import { CycleEventBus } from "./CycleEventBus.js";
import type { CycleEvent, CyclePhase, CycleTiming } from "./CycleEvents.js";
import { PersonaLoader, type WorkInstructions } from "./PersonaLoader.js";
import { ChainScanner } from "./ChainScanner.js";
import { ProjectVerifier, type VerifyBaseline } from "./ProjectVerifier.js";
import type { RegisteredStrategies } from "./strategies/index.js";
import { ProjectMemory } from "../memory/ProjectMemory.js";
import { MaintenancePhase } from "./phases/MaintenancePhase.js";
import { ReviewPhase } from "./phases/ReviewPhase.js";
import {
  WorkerPhase,
  COMPLEXITY_CONFIG,
  safeComplexity,
} from "./phases/WorkerPhase.js";
import { BrainPhase, coerceSubtaskOrder } from "./phases/BrainPhase.js";
import type { ReviewIssue } from "../bridges/ReviewTypes.js";
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
// coerceSubtaskOrder is imported from BrainPhase

// countTscErrors + setCountTscErrorsDepsForTests are defined in
// phases/MaintenancePhase.ts and re-exported above for backward compatibility.

// Pure functions (applyStepStatusUpdate, failAllActiveSteps, applyBeginStep)
// are defined in StepTracker.ts and re-exported above for backward compatibility.

// StatusListener type is defined in StepTracker.ts
import type { StatusListener } from "./StepTracker.js";

/** Shared options from the brain decision, threaded through the pipeline. */
type BrainOpts = {
  complexity?: string;
  subtasks?: Array<{ description: string; order: number }>;
  directive?: string;
  resourceRequest?: import("../memory/types.js").ResourceRequest;
  // Legacy fields preserved for queue-stored task compatibility
  persona?: string;
  taskType?: string;
  workInstructions?: WorkInstructions;
  // Review lesson checklist injected before execution
  reviewChecklist?: string;
};

/** Context shared across pipeline sub-methods within a single cycle. */
type PipelineCtx = {
  branchName: string;
  originalBranch: string;
  baseline: VerifyBaseline;
  startCommit: string;
  taskReviewer: ReviewAdapter;
  projectPath: string;
};

// ---------------------------------------------------------------------------
// Review-fix loop helpers (pure functions, independently testable)
// ---------------------------------------------------------------------------

/** Single fix round record for cumulative context. */
export interface FixRoundRecord {
  round: number;
  decision: "fix" | "rewrite";
  instructions: string;
  prevIssueCount: number;
  currentIssueCount: number;
  resolvedDescriptions: string[];
  persistedDescriptions: string[];
  stillOpenIssues: Array<{
    severity: string;
    file?: string;
    description: string;
  }>;
}

/** Unique key for a review issue: file + severity + full description. */
export function issueKey(issue: ReviewIssue): string {
  return `${issue.file ?? "?"}|${issue.severity}|${issue.description}`;
}

/** Constrain a reviewer-provided file path: strip control chars, limit length. */
function constrainFile(file: string | undefined): string | undefined {
  if (!file) return undefined;
  const cleaned = file.replace(/[\x00-\x1f]+/g, "").trim();
  return cleaned.length > 0 && cleaned.length <= 200 ? cleaned : undefined;
}

/**
 * Build cumulative context as a structured JSON data block.
 *
 * Reviewer text (description) is NOT echoed back — action items come from
 * the brain's fixInstructions only.  Open issues carry severity + constrained
 * file path so the worker knows WHERE to look; the brain tells it WHAT to do.
 */
export function buildCumulativeContext(
  history: readonly FixRoundRecord[],
): string {
  if (history.length === 0) return "";

  const data = {
    rounds: history.map((r) => ({
      round: r.round,
      decision: r.decision,
      prevIssues: r.prevIssueCount,
      currentIssues: r.currentIssueCount,
      resolved: r.resolvedDescriptions.length,
      persisted: r.persistedDescriptions.length,
      instructions: r.instructions.slice(0, 300),
    })),
    openIssues: history[history.length - 1].stillOpenIssues.map((i) => {
      const file = constrainFile(i.file);
      return {
        severity: i.severity,
        ...(file != null ? { file } : {}),
      };
    }),
  };

  return [
    "## Previous Fix Attempts (data summary — not action items)",
    "```json",
    JSON.stringify(data, null, 2),
    "```",
  ].join("\n");
}

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
  private brainRuntime!: RuntimeAdapter;
  private workerRuntime!: RuntimeAdapter;
  /** Plan phase runtime (resolved with fallback). Used by PlanChatManager. */
  readonly planRuntime!: RuntimeAdapter;
  /** Underlying sessions for lifecycle management (kill on stop). */
  private sessions: Killable[] = [];
  private chainScanner: ChainScanner;
  private personaLoader: PersonaLoader;
  private projectVerifier: ProjectVerifier;
  private reviewer: ReviewAdapter;
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
    private taskStore: TaskStore,
    private costTracker: CostTracker,
    private eventBus: CycleEventBus = CycleEventBus.noop(),
    private sdkExtras?: SdkExtras,
    workerRuntimeOverride?: RuntimeAdapter,
    reviewAdapter?: ReviewAdapter,
    strategies?: RegisteredStrategies,
    private cliCmd?: string,
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

    // Create and register all runtimes via factory.
    const runtimeSet = createRuntimeSet(config, sdkExtras);
    this.sessions = runtimeSet.sessions;
    const localRuntimes = runtimeSet.runtimes;
    const routing = config.values.routing;

    /** Pick the correct RuntimeAdapter for a given phase routing entry.
     *  Handles claude-sdk brain/worker split and codex-sdk→codex-cli fallback. */
    const resolvePhaseRuntime = (
      phaseName: string,
      runtimeName: string,
      preferWorkerSession: boolean,
    ): RuntimeAdapter => {
      // Runtime names are already normalized at Config construction.
      // But handle raw aliases for safety.
      const canonical = normalizeRuntimeName(runtimeName);

      if (canonical === "claude-sdk") {
        return preferWorkerSession
          ? localRuntimes["claude-sdk-worker"]
          : localRuntimes["claude-sdk-brain"];
      }
      // Try local first (has both codex-sdk and codex-cli when available)
      if (localRuntimes[canonical]) return localRuntimes[canonical];
      // Try factory (includes codex-sdk→codex-cli fallback)
      try {
        return getRuntimeSync(canonical);
      } catch {
        log.warn(
          `routing.${phaseName}.runtime="${runtimeName}" not available, falling back to claude-sdk`,
        );
        return preferWorkerSession
          ? localRuntimes["claude-sdk-worker"]
          : localRuntimes["claude-sdk-brain"];
      }
    };

    // Runtime availability is validated at startup (validateRuntimeAvailability)
    // before MainLoop is constructed — no need for a redundant check here.

    // --- Resolve phase runtimes from routing config ---
    this.brainRuntime = resolvePhaseRuntime(
      "brain",
      routing.brain.runtime,
      false,
    );
    const executeRuntime = resolvePhaseRuntime(
      "execute",
      routing.execute.runtime,
      true,
    );
    // Resolve review runtime and wrap in RuntimeReviewAdapter (unified Phase 3).
    const reviewRuntime = resolvePhaseRuntime(
      "review",
      routing.review.runtime,
      false,
    );

    // Resolve phase-specific runtimes for thinking phases.
    // These all default to brain session but can be independently configured.
    const planRuntime = resolvePhaseRuntime(
      "plan",
      routing.plan.runtime,
      false,
    );
    this.planRuntime = planRuntime;
    const reflectRuntime = resolvePhaseRuntime(
      "reflect",
      routing.reflect.runtime,
      false,
    );
    const scanRuntime = resolvePhaseRuntime(
      "scan",
      routing.scan.runtime,
      false,
    );

    this.chainScanner = new ChainScanner(
      this.brainRuntime,
      taskStore,
      config,
      scanRuntime,
    );
    this.projectVerifier = new ProjectVerifier();
    this.strategies = strategies;

    // Wire up worker RuntimeAdapter + ReviewAdapter
    if (workerRuntimeOverride && reviewAdapter) {
      this.workerRuntime = workerRuntimeOverride;
      this.reviewer = reviewAdapter;
    } else {
      this.workerRuntime = executeRuntime;
      this.reviewer = new RuntimeReviewAdapter(reviewRuntime);
    }

    this.memoryProject = this.deriveMemoryProject(config.projectPath);

    // MaintenancePhase handles verification, cleanup, locking, health checks
    this.maintenance = new MaintenancePhase(
      config,
      taskStore,
      costTracker,
      this.brainRuntime,
      this.projectVerifier,
      this.lockFile,
      this.cliCmd,
    );
    this.review = new ReviewPhase(
      config,
      taskStore,
      costTracker,
      this.brainRuntime,
      this.reviewer,
      reviewRuntime,
    );
    this.workerPhase = new WorkerPhase(
      config,
      taskStore,
      costTracker,
      this.workerRuntime,
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
      this.brainRuntime,
      this.taskQueue,
      this.strategies,
      this.projectMemory,
      this.memoryProject,
      { plan: planRuntime, reflect: reflectRuntime },
    );
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
    for (const session of this.sessions) {
      session.kill();
    }
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

    // 1. Decide task (queue or brain)
    const decision = await this.decideTask(projectPath);
    if (!decision) return false;
    const { task, brainOpts } = decision;

    // 2. Budget check
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

      const complexity = brainOpts?.complexity ?? "M";
      const pipeCtx: PipelineCtx = {
        branchName,
        originalBranch,
        baseline,
        startCommit,
        taskReviewer: this.reviewer,
        projectPath,
      };

      // 4.5 Analysis (M/L/XL)
      const analysis = await this.analyzeTask(task, brainOpts, pipeCtx);
      if (!analysis) return false;

      // Inject review lesson checklist
      const reviewChecklist =
        this.strategies?.reviewLessons?.getChecklistForWorker() ?? "";
      const executeOpts = reviewChecklist
        ? { ...brainOpts, reviewChecklist }
        : brainOpts;

      // 5-6. Execute + Verify
      const execution = await this.executeAndVerify(task, executeOpts, {
        ...pipeCtx,
        approvedPlan: analysis.approvedPlan,
      });
      if (!execution) return false;

      // 7-8. Review
      const shouldMerge = await this.reviewTask(task, {
        ...pipeCtx,
        ...execution,
      });

      // 9-10. Reflect + Merge
      await this.reflectAndMerge(task, shouldMerge, {
        ...pipeCtx,
        verification: execution.verification,
      });

      // 12-13. Periodic tasks
      await this.doPeriodicTasks(projectPath);
    } catch (err) {
      log.error("Task execution error", err);
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

  // --- Pipeline sub-methods (called only from runCycle) ---

  /** Drain queue or ask brain for a new task. Returns null to abort the cycle. */
  private async decideTask(
    projectPath: string,
  ): Promise<{ task: Task; brainOpts?: BrainOpts } | null> {
    this.setState("scanning");
    this.beginStep("decide");

    // 0. Drain queued tasks first — skip brain entirely if work is waiting
    const queued = await this.taskQueue.getNext(projectPath);

    if (queued) {
      const task = queued;
      await this.taskStore.updateTask(task.id, {
        status: "active",
        phase: "executing",
      });
      this.setCurrentTaskId(task.id);

      // Reconstruct brainOpts from stored plan (JSONB)
      let brainOpts: BrainOpts | undefined;
      const plan = task.plan as Record<string, unknown> | null;
      if (plan) {
        brainOpts = {
          persona: typeof plan.persona === "string" ? plan.persona : undefined,
          taskType: typeof plan.type === "string" ? plan.type : undefined,
          complexity: resolveTaskComplexity(task),
          workInstructions:
            typeof plan.workInstructions === "string"
              ? plan.workInstructions
              : undefined,
          // Restore brain-driven fields (B-1)
          directive:
            typeof plan.directive === "string" ? plan.directive : undefined,
          resourceRequest:
            plan.resourceRequest != null &&
            typeof plan.resourceRequest === "object" &&
            !Array.isArray(plan.resourceRequest)
              ? (plan.resourceRequest as BrainOpts["resourceRequest"])
              : undefined,
        };
      }

      // Also restore directive from task column (written by brain-decide path)
      if (!brainOpts?.directive && task.directive) {
        if (!brainOpts) brainOpts = {};
        brainOpts.directive = task.directive;
        if (task.resource_request) {
          brainOpts.resourceRequest = task.resource_request;
        }
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
      return { task, brainOpts };
    }

    // 1. Brain decides what to do
    this.eventBus.emit(this.makeEvent("decide", "before"));
    let decision = await this.brain.brainDecide(projectPath);
    if (decision.costUsd > 0)
      await this.taskStore.addDailyCost(decision.costUsd);

    // If brain returned null, short sleep will retry (handled by start())
    if (!decision.taskDescription) {
      log.warn("Brain: no task found. Short sleep then retry.");
      this.endStep("decide", "failed", "No task found");
      this.skipRemainingSteps("decide");
      this.setState("idle");
      return null;
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
      return null;
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
      return null;
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
    const task = await this.taskStore.createTask(
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
      // Sync to in-memory task so downstream readers (resolveTaskComplexity) see current values
      if (updates.plan) task.plan = updates.plan;
      if (updates.subtasks) task.subtasks = updates.subtasks as SubTaskRecord[];
    }

    // Store brain-driven fields
    await this.taskStore.updateTask(task.id, {
      directive: decision.directive ?? null,
      strategy_note: decision.strategyNote ?? null,
      verification_plan: decision.verificationPlan ?? null,
      resource_request: decision.resourceRequest ?? null,
    });

    // Audit log for brain decision (symmetric with reflect/review addLog)
    await this.taskStore.addLog({
      task_id: task.id,
      phase: "decide",
      agent: "brain",
      input_summary: "Brain decision (brain-driven)",
      output_summary: truncate(decision.taskDescription, SUMMARY_PREVIEW_LEN),
      cost_usd: decision.costUsd,
      duration_ms: null,
      details: {
        strategy_note: decision.strategyNote ?? null,
        verification_plan: decision.verificationPlan ?? null,
        resource_request: decision.resourceRequest ?? null,
        directive_length: decision.directive?.length ?? 0,
        extra_tasks_count: decision.extraDirectiveTasks?.length ?? 0,
      },
    });

    const brainOpts: BrainOpts = {
      complexity: decision.complexity,
      subtasks: decision.subtasks,
      directive: decision.directive,
      resourceRequest: decision.resourceRequest,
    };

    // Enqueue extra tasks from brain-driven batch output
    if (
      decision.extraDirectiveTasks &&
      decision.extraDirectiveTasks.length > 0
    ) {
      try {
        const planTasks: PlanTask[] = decision.extraDirectiveTasks.map(
          (et, i) => ({
            id: `extra-bd-${i + 1}`,
            description: et.directive.slice(0, 120), // summary for queue display
            priority: 2,
            executor: "claude" as const,
            subtasks: [],
            dependsOn: [],
            estimatedComplexity: "medium" as const,
            // Brain-driven fields preserved in plan JSONB for queue pickup
            directive: et.directive,
            resourceRequest: et.resourceRequest,
            isBrainDriven: true,
          }),
        );
        const plan: TaskPlan = {
          tasks: planTasks,
          reasoning: "Extra tasks from brain-driven batch output",
        };
        const enqueuedIds = await this.taskQueue.enqueue(projectPath, plan);
        if (enqueuedIds.length > 0) {
          log.info(`Enqueued ${enqueuedIds.length} extra brain-driven task(s)`);
        }
      } catch (err) {
        log.warn(`Failed to enqueue brain-driven extra tasks: ${err}`);
      }
    }

    this.endStep("create-task", "done");
    return { task, brainOpts };
  }

  /** Analyze → Review → Synthesize loop for M/L/XL tasks. Returns null to abort. */
  private async analyzeTask(
    task: Task,
    brainOpts: BrainOpts | undefined,
    ctx: PipelineCtx,
  ): Promise<{ approvedPlan?: string } | null> {
    const complexity = brainOpts?.complexity ?? "M";
    if (complexity === "S") {
      this.endStep("analyze", "skipped");
      return {};
    }

    this.beginStep("analyze");
    this.setState("planning");
    await this.taskStore.updateTask(task.id, { phase: "analyzing" });

    const maxRevisions = 2;
    let revisionRound = 0;
    let analyzeSessionId: string | undefined;
    let revisionCtx:
      | { resumeSessionId?: string; revisionPrompt: string }
      | undefined;
    let planApproved = false;
    let approvedPlan: string | undefined;

    while (revisionRound <= maxRevisions) {
      // Worker produces a concrete change proposal (read-only)
      const analyzeResult = await this.workerPhase.workerAnalyze(
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
        await switchBranch(ctx.originalBranch, ctx.projectPath).catch(() => {});
        await this.cleanupTaskBranch(ctx.branchName, { force: true });
        this.setCurrentTaskId(null);
        this.tracker.setCurrentTaskDescription(null);
        this.setState("idle");
        return null;
      }

      // Reviewer evaluates the proposal (mutually exclusive with worker)
      const planReview = await this.review.reviewPlan(
        analyzeResult.proposal,
        task,
        ctx.taskReviewer,
      );

      // Brain synthesizes proposal + feedback into final plan
      const synthesis = await this.brain.brainSynthesizePlan(
        analyzeResult.proposal,
        planReview,
        task,
      );

      if (synthesis.decision === "approved") {
        approvedPlan = synthesis.finalPlan;
        planApproved = true;
        break;
      }

      if (synthesis.decision === "revise") {
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

        // Build self-contained revision context so it works with or without
        // session resume (Codex analyze can't resume in read-only mode).
        const reviewerIssues = planReview.issues
          .map((i) => `- [${i.severity}] ${i.description}`)
          .join("\n");
        const revisionPrompt = `## Revision Required (Round ${revisionRound}/${maxRevisions})

### Original Task
${task.task_description}

### Previous Proposal
${analyzeResult.proposal}

### Brain's Direction
${synthesis.reviseInstructions ?? "Revise the proposal to address reviewer concerns."}

### Reviewer's Specific Issues
${reviewerIssues || "No specific issues listed."}

Revise the previous proposal to address ALL issues above. Produce a complete updated proposal in the same structured format.`;

        revisionCtx = {
          resumeSessionId: analyzeSessionId,
          revisionPrompt,
        };
        continue;
      }

      // REJECTED
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
      await switchBranch(ctx.originalBranch, ctx.projectPath).catch(() => {});
      await this.cleanupTaskBranch(ctx.branchName, { force: true });
      this.setCurrentTaskId(null);
      this.tracker.setCurrentTaskDescription(null);
      this.setState("idle");
      return null;
    }

    this.endStep("analyze", "done");
    return { approvedPlan };
  }

  /** Execute task (subtasks or single-shot) + hard verification + fix retries. Returns null to abort. */
  private async executeAndVerify(
    task: Task,
    brainOpts: BrainOpts | undefined,
    ctx: PipelineCtx & { approvedPlan?: string },
  ): Promise<{
    workerPassed: boolean;
    workerSessionId?: string;
    verification: { passed: boolean; reason?: string };
  } | null> {
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
      await switchBranch(ctx.originalBranch, ctx.projectPath).catch(() => {});
      await this.cleanupTaskBranch(ctx.branchName, { force: true });
      this.setCurrentTaskId(null);
      this.tracker.setCurrentTaskDescription(null);
      this.setState("idle");
      return null;
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
      const result = await this.workerPhase.executeSubtasks(
        task,
        subtasksForExec,
        {
          persona: brainOpts.persona,
          taskType: brainOpts.taskType,
          complexity: brainOpts.complexity,
          workInstructions: brainOpts.workInstructions,
          baseline: ctx.baseline,
          startCommit: ctx.startCommit,
          reviewChecklist: brainOpts.reviewChecklist,
        },
      );
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
          startCommit: ctx.startCommit,
          result: { costUsd: 0, durationMs: 0 },
        }),
      );
      this.beginStep("verify");
      this.eventBus.emit(
        this.makeEvent("verify", "after", {
          verification,
          startCommit: ctx.startCommit,
        }),
      );
      this.endStep(
        "verify",
        result.success ? "done" : "failed",
        verification.reason,
        result.totalVerifyMs,
      );
    } else {
      // Single-shot execution (with optional approved plan)
      const workerResult = await this.workerPhase.workerExecute(task, {
        ...brainOpts,
        approvedPlan: ctx.approvedPlan,
      });
      if (workerResult.costUsd > 0)
        await this.costTracker.addCost(task.id, workerResult.costUsd);

      await this.taskStore.addLog({
        task_id: task.id,
        phase: "execute",
        agent: this.workerPhase.effectiveRuntimeName,
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
          startCommit: ctx.startCommit,
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
        const singleVerify = await this.maintenance.hardVerify(
          ctx.baseline,
          ctx.startCommit,
          ctx.projectPath,
        );
        await this.taskStore.addLog({
          task_id: task.id,
          phase: "verify",
          agent: "tsc",
          input_summary: `baseline=${JSON.stringify(ctx.baseline)}, startCommit=${ctx.startCommit}${workerResult.isError ? ", workerError=true" : ""}`,
          output_summary: singleVerify.passed
            ? "PASS"
            : `FAIL: ${singleVerify.reason}`,
          cost_usd: 0,
          duration_ms: Date.now() - verifyStart,
        });
        this.eventBus.emit(
          this.makeEvent("verify", "after", {
            verification: singleVerify,
            startCommit: ctx.startCommit,
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
          const fixResult = await this.workerPhase.workerFix(
            currentSessionId,
            singleVerify.reason ?? "Unknown error",
            task,
          );
          if (fixResult.costUsd > 0)
            await this.costTracker.addCost(task.id, fixResult.costUsd);
          currentSessionId = fixResult.sessionId ?? currentSessionId;

          const changedFilesForCommit = await getModifiedAndAddedFiles(
            ctx.projectPath,
          ).catch(() => []);
          try {
            await commitAll(
              "db-coder: fix verification issues",
              ctx.projectPath,
              changedFilesForCommit,
            );
          } catch (commitErr) {
            log.error(
              `commitAll failed during verification retry ${fixAttempts}: ${commitErr}`,
            );
            singleVerify.reason = `commitAll failed: ${commitErr}`;
            break;
          }
          const reVerify = await this.maintenance.hardVerify(
            ctx.baseline,
            ctx.startCommit,
            ctx.projectPath,
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
              log.warn("taskStore.addLog fallback failed in catch(verifyErr)", {
                logErr,
              });
            }
          }
        }
        throw verifyErr;
      }
    }

    return { workerPassed, workerSessionId, verification };
  }

  /** Code review + brain decision + fix/rewrite loop. Returns whether to merge. */
  private async reviewTask(
    task: Task,
    ctx: PipelineCtx & {
      workerPassed: boolean;
      workerSessionId?: string;
      verification: { passed: boolean; reason?: string };
    },
  ): Promise<boolean> {
    this.beginStep("review");
    let shouldMerge = false;

    if (ctx.workerPassed) {
      this.setState("reviewing");
      const reviewResult = await this.review.codeReview(
        task,
        ctx.startCommit,
        ctx.projectPath,
        ctx.taskReviewer,
      );

      // Store review results for traceability
      await this.taskStore.updateTask(task.id, {
        review_results: reviewResult.issues ?? [],
      });

      // Record first-round review for lesson learning (once per task)
      this.strategies?.reviewLessons?.recordFirstRoundReview(
        reviewResult.issues,
      );

      if (!reviewResult.passed) {
        log.info(`Code review: FAIL — ${reviewResult.summary}`, {
          issues: (reviewResult.issues ?? []).length,
          reviewer: ctx.taskReviewer.name,
        });
      } else {
        log.info(`Code review: PASS — ${reviewResult.summary}`);
      }

      // 8. Brain decision phase
      if (ctx.workerPassed && reviewResult.passed) {
        // Both verify and review passed → merge
        shouldMerge = true;
      } else if (ctx.workerPassed) {
        // Verify passed but review failed → brain decides
        const decision = await this.brain.brainReviewDecision(
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
                    ctx.projectPath,
                    newTaskDesc,
                  );
                if (duplicate) {
                  log.info(
                    `Split dedup: ${reason} — "${truncate(newTaskDesc, 100)}"`,
                  );
                  continue;
                }
                await this.taskStore.createTask(
                  ctx.projectPath,
                  newTaskDesc,
                  2,
                );
                log.info(
                  `Split: created follow-up task: ${truncate(newTaskDesc, 100)}`,
                );
              }
            }
            break;
          }

          case "fix":
          case "rewrite": {
            const complexity = resolveTaskComplexity(task);
            const complexityMaxFixes =
              COMPLEXITY_CONFIG[complexity ?? "M"].maxReviewFixes;
            const maxFixes = Math.min(
              this.config.values.autonomy.maxReviewFixes,
              complexityMaxFixes,
            );
            let fixSessionId: string | undefined = ctx.workerSessionId;
            let prevIssueCount = reviewResult.issues.length;
            let prevIssueKeys = new Set(reviewResult.issues.map(issueKey));
            let currentDecision = decision;
            const fixHistory: FixRoundRecord[] = [];

            for (let fixRound = 0; fixRound < maxFixes; fixRound++) {
              // REWRITE: discard session, force fresh context
              if (currentDecision.decision === "rewrite") {
                fixSessionId = undefined;
              }

              // Cumulative context for round 2+
              const cumulativeCtx =
                fixRound > 0 ? buildCumulativeContext(fixHistory) : undefined;

              const fixResult = await this.workerPhase.workerReviewFix(
                task,
                currentDecision.fixInstructions ?? currentDecision.reasoning,
                fixSessionId,
                cumulativeCtx,
                currentDecision.decision === "rewrite",
              );
              fixSessionId = fixResult.sessionId;

              // Commit fix changes
              const changedFilesForCommit = await getModifiedAndAddedFiles(
                ctx.projectPath,
              ).catch(() => []);
              try {
                await commitAll(
                  "db-coder: fix review issues",
                  ctx.projectPath,
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
              const reVerify = await this.maintenance.hardVerify(
                ctx.baseline,
                ctx.startCommit,
                ctx.projectPath,
              );
              if (!reVerify.passed) {
                log.warn(
                  `Review fix round ${fixRound + 1}: hardVerify failed — ${reVerify.reason}`,
                );
                break;
              }

              // Re-review
              const reReview = await this.review.codeReview(
                task,
                ctx.startCommit,
                ctx.projectPath,
                ctx.taskReviewer,
              );

              // Update stored review results to latest
              await this.taskStore.updateTask(task.id, {
                review_results: reReview.issues ?? [],
              });

              // Telemetry log for every round (including PASS)
              await this.taskStore.addLog({
                task_id: task.id,
                phase: "review-fix",
                agent: "system",
                input_summary: `Fix round ${fixRound + 1}/${maxFixes}`,
                output_summary: reReview.passed
                  ? `PASS after ${fixRound + 1} rounds`
                  : `FAIL: ${reReview.issues.length} issues (prev: ${prevIssueCount})`,
                cost_usd: fixResult.costUsd,
                duration_ms: fixResult.durationMs,
              });

              if (reReview.passed) {
                shouldMerge = true;
                break;
              }

              // Record fix history for this round
              const currentKeys = new Set(reReview.issues.map(issueKey));
              const resolvedKeys = [...prevIssueKeys].filter(
                (k) => !currentKeys.has(k),
              );
              const persistedKeys = [...currentKeys].filter((k) =>
                prevIssueKeys.has(k),
              );
              fixHistory.push({
                round: fixRound + 1,
                decision: currentDecision.decision as "fix" | "rewrite",
                instructions:
                  currentDecision.fixInstructions ?? currentDecision.reasoning,
                prevIssueCount,
                currentIssueCount: reReview.issues.length,
                resolvedDescriptions: resolvedKeys,
                persistedDescriptions: persistedKeys,
                stillOpenIssues: reReview.issues.map((i) => ({
                  severity: i.severity,
                  file: i.file,
                  description: i.description,
                })),
              });

              // Convergence detection: stagnant when no progress (count not decreased)
              // AND most issues are the same ones as before (70%+ overlap)
              const overlapCount = persistedKeys.length;
              const stagnant =
                reReview.issues.length >= prevIssueCount &&
                overlapCount >= currentKeys.size * 0.7;
              const isLast = fixRound === maxFixes - 1;
              const isFinalRound = isLast || stagnant;

              // Brain decides next step
              const nextDecision = await this.brain.brainReviewDecision(
                task,
                reReview,
                reReview.reviewDiff,
                isFinalRound,
                fixRound + 1,
                maxFixes,
              );
              log.info(
                `Brain decision (round ${fixRound + 1}/${maxFixes}, final=${isFinalRound}): ${nextDecision.decision} — ${nextDecision.reasoning}`,
              );

              switch (nextDecision.decision) {
                case "fix":
                case "rewrite":
                  prevIssueCount = reReview.issues.length;
                  prevIssueKeys = currentKeys;
                  currentDecision = nextDecision;
                  continue;
                case "ignore":
                  shouldMerge = true;
                  break;
                case "split":
                  shouldMerge = true;
                  if (nextDecision.newTasks) {
                    for (const newTaskDesc of nextDecision.newTasks) {
                      const { duplicate, reason } =
                        await this.taskStore.isDuplicateTask(
                          ctx.projectPath,
                          newTaskDesc,
                        );
                      if (duplicate) {
                        log.info(
                          `Split dedup: ${reason} — "${truncate(newTaskDesc, 100)}"`,
                        );
                        continue;
                      }
                      await this.taskStore.createTask(
                        ctx.projectPath,
                        newTaskDesc,
                        2,
                      );
                      log.info(
                        `Split: created follow-up task: ${truncate(newTaskDesc, 100)}`,
                      );
                    }
                  }
                  break;
                case "block":
                  break;
              }
              break; // ignore/split/block all exit the loop
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
    return shouldMerge;
  }

  /** Brain reflects + merge or cleanup. */
  private async reflectAndMerge(
    task: Task,
    shouldMerge: boolean,
    ctx: PipelineCtx & { verification: { passed: boolean; reason?: string } },
  ): Promise<void> {
    // 9. Brain reflects and learns
    this.beginStep("reflect");
    this.setState("reflecting");
    const outcome = shouldMerge ? "success" : "failed";
    try {
      await this.brain.brainReflect(
        task,
        outcome,
        ctx.verification,
        ctx.projectPath,
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
      await switchBranch(ctx.originalBranch, ctx.projectPath);
      await mergeBranch(ctx.branchName, ctx.projectPath);
      try {
        await deleteBranch(ctx.branchName, ctx.projectPath);
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
        const buildResult = await safeBuild(ctx.projectPath);
        if (buildResult.success) {
          this.restartPending = true;
          log.info("Self-build succeeded, restart pending");
        } else {
          this.writeBuildError(buildResult.error);
        }
      }
    } else {
      await switchBranch(ctx.originalBranch, ctx.projectPath).catch(() => {});
      await this.cleanupTaskBranch(ctx.branchName, {
        startCommit: ctx.startCommit,
      });
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
          await this.maintenance.pipelineHealthCheck(ctx.projectPath);
        } catch (err) {
          log.warn("Pipeline health check failed", err);
        }
        this.consecutiveRejections = 0;
      }
    }
  }

  /** Periodic tasks (chain scan, CLAUDE.md maintenance). Non-fatal: errors are logged but do not abort the cycle. */
  private async doPeriodicTasks(projectPath: string): Promise<void> {
    this.tasksCompleted++;
    const { chainScan } = this.config.values.brain;
    if (
      chainScan.enabled &&
      chainScan.interval > 0 &&
      this.tasksCompleted % chainScan.interval === 0
    ) {
      try {
        this.eventBus.emit(this.makeEvent("deep-review", "before"));
        await this.chainScanner.scanNext(projectPath);
        this.eventBus.emit(this.makeEvent("deep-review", "after"));
      } catch (err) {
        log.warn("Chain scan failed", err);
        this.eventBus.emit(
          this.makeEvent("deep-review", "after", { error: true }),
        );
      }
    }

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
        await this.maintenance.claudeMdMaintenance(projectPath);
      } catch (err) {
        log.warn("CLAUDE.md maintenance failed", err);
      }
    }
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

const ESTIMATED_COMPLEXITY_MAP: Record<string, string> = {
  low: "S",
  medium: "M",
  high: "L",
};

/**
 * Resolve COMPLEXITY_CONFIG key from task.plan JSONB.
 *
 * New brain-driven tasks store `plan.complexity` directly ("S"/"M"/"L"/"XL").
 * Older queued tasks (PlanTask schema) store `plan.estimatedComplexity`
 * ("low"/"medium"/"high") which must be mapped.
 */
export function resolveTaskComplexity(task: Task): string | undefined {
  const plan = task.plan as Record<string, unknown> | null;
  if (!plan) return undefined;
  if (typeof plan.complexity === "string") {
    if (plan.complexity in COMPLEXITY_CONFIG) return plan.complexity;
    log.warn(`Unknown plan.complexity "${plan.complexity}", ignoring`);
    return undefined;
  }
  if (typeof plan.estimatedComplexity === "string") {
    return ESTIMATED_COMPLEXITY_MAP[plan.estimatedComplexity];
  }
  return undefined;
}
