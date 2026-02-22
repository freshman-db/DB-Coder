import type { Config } from '../config/Config.js';
import type { Brain } from './Brain.js';
import type { TaskQueue } from './TaskQueue.js';
import type { ClaudeBridge } from '../bridges/ClaudeBridge.js';
import type { CodexBridge } from '../bridges/CodexBridge.js';
import type { TaskStore } from '../memory/TaskStore.js';
import type { GlobalMemory } from '../memory/GlobalMemory.js';
import type { CostTracker } from '../utils/cost.js';
import type { EvolutionEngine } from '../evolution/EvolutionEngine.js';
import type { PluginMonitor } from '../plugins/PluginMonitor.js';
import type { PromptRegistry } from '../prompts/PromptRegistry.js';
import type { Task, SubTaskRecord, ReviewEvent } from '../memory/types.js';
import type { MergedReviewResult, LoopState, ProjectAnalysis, StatusSnapshot, EvaluationResult } from './types.js';
import type { AgentResult, ReviewResult, ReviewIssue } from '../bridges/CodingAgent.js';
import { parseEvaluation } from './Brain.js';
import { evaluatorPrompt } from '../prompts/evaluator.js';
import { executorPrompt } from '../prompts/executor.js';
import { reviewerPrompt } from '../prompts/reviewer.js';
import { buildAgentGuidance } from '../prompts/agents.js';
import { createSystemDataMcpServer } from '../mcp/SystemDataMcp.js';
import { createBranch, switchBranch, commitAll, getHeadCommit, getCurrentBranch, isWorkingClean, branchExists, getChangedFilesSince, getModifiedAndAddedFiles, mergeBranch, deleteBranch, listBranches, forceDeleteBranch, getDiffStats } from '../utils/git.js';
import { log } from '../utils/logger.js';
import { calculateRetryDelay } from '../utils/retry.js';
import { readFileSync, existsSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { safeBuild } from '../utils/safeBuild.js';

const PAUSE_INTERVAL_MS = 5000;
const ERROR_RECOVERY_MS = 30000;
const PLUGIN_CHECK_INTERVAL_MS = 86400_000;
const BRANCH_ID_LENGTH = 8;
const TASK_DESC_MAX_LENGTH = 80;
const SUBTASK_RESULT_MAX_LENGTH = 200;
const COMMIT_MSG_MAX_LENGTH = 50;
const REVIEW_SUMMARY_MAX_LENGTH = 200;
const LOG_OUTPUT_MAX_LENGTH = 500;
const PROMPT_SUCCESS_DELTA = 0.1;
const PROMPT_FAILURE_DELTA = -0.15;

type StatusListener = (status: StatusSnapshot) => void;
type AdjustmentOutcome = 'success' | 'failed' | 'blocked_stuck' | 'blocked_max_retries';

export class MainLoop {
  private state: LoopState = 'idle';
  private running = false;
  private paused = false;
  private currentTaskId: string | null = null;
  private statusListeners = new Set<StatusListener>();
  private lockFile: string;

  private restartPending = false;
  private restartListeners = new Set<() => void>();

  private stoppedPromise: Promise<void> | null = null;
  private stoppedResolve: (() => void) | null = null;

  private evolutionEngine?: EvolutionEngine;
  private pluginMonitor?: PluginMonitor;
  private promptRegistry?: PromptRegistry;
  private lastPluginCheck = 0;
  private tasksCompletedSinceMetaReflect = 0;

  constructor(
    private config: Config,
    private brain: Brain,
    private taskQueue: TaskQueue,
    private claude: ClaudeBridge,
    private codex: CodexBridge,
    private taskStore: TaskStore,
    private globalMemory: GlobalMemory,
    private costTracker: CostTracker,
  ) {
    const hash = createHash('md5').update(config.projectPath).digest('hex').slice(0, BRANCH_ID_LENGTH);
    const lockDir = join(homedir(), '.db-coder');
    this.lockFile = join(lockDir, `${hash}.lock`);
  }

  getState(): LoopState { return this.state; }
  getCurrentTaskId(): string | null { return this.currentTaskId; }
  isPaused(): boolean { return this.paused; }
  isRunning(): boolean { return this.running; }

  /** Register a callback invoked when the loop exits due to a pending self-restart. */
  onRestart(listener: () => void): () => void {
    this.restartListeners.add(listener);
    return () => { this.restartListeners.delete(listener); };
  }

  /** Check if this project is db-coder itself (self-modification scenario). */
  private isSelfProject(): boolean {
    try {
      const pkgPath = join(this.config.projectPath, 'package.json');
      if (!existsSync(pkgPath)) return false;
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      return pkg.name === 'db-coder';
    } catch {
      return false;
    }
  }

  /** Write a build error file so the next startup can create a P0 recovery task. */
  private writeBuildError(error: string): void {
    const dir = join(homedir(), '.db-coder');
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, 'build-error.json');
    const data = { timestamp: new Date().toISOString(), type: 'build', error };
    writeFileSync(filePath, JSON.stringify(data, null, 2));
    log.warn('Build error written to ' + filePath);
  }

  addStatusListener(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

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

  private broadcastStatus(): void {
    if (this.statusListeners.size === 0) return;
    const snapshot: StatusSnapshot = {
      state: this.state,
      currentTaskId: this.currentTaskId,
      patrolling: this.running,
      paused: this.paused,
    };
    for (const listener of this.statusListeners) {
      try {
        listener(snapshot);
      } catch {
        // Ignore listener failures so one consumer cannot block others.
      }
    }
  }

  setEvolutionEngine(engine: EvolutionEngine): void {
    this.evolutionEngine = engine;
  }

  setPluginMonitor(monitor: PluginMonitor): void {
    this.pluginMonitor = monitor;
  }

  setPromptRegistry(registry: PromptRegistry): void {
    this.promptRegistry = registry;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.acquireLock()) {
      log.error('Another instance is running. Lock file: ' + this.lockFile);
      return;
    }

    this.setRunning(true);
    this.stoppedPromise = new Promise<void>(resolve => { this.stoppedResolve = resolve; });
    log.info('Main loop started');

    // Recover zombie tasks left in 'active' state from a previous crash
    try {
      const recovered = await this.taskStore.recoverActiveTasks(this.config.projectPath);
      if (recovered > 0) {
        log.warn(`Recovered ${recovered} active task(s) back to queued`);
      }
    } catch (err) {
      log.warn(`Failed to recover active tasks: ${err}`);
    }

    // Clean up orphaned branches from previous runs
    try {
      await this.cleanupOrphanedBranches();
    } catch (err) {
      log.warn(`Failed to cleanup orphaned branches: ${err}`);
    }

    try {
      while (this.running) {
        if (this.paused) {
          this.setState('paused');
          await sleep(PAUSE_INTERVAL_MS);
          continue;
        }

        try {
          await this.runCycle();
        } catch (err) {
          log.error('Cycle error', err);
          this.setState('error');
          await sleep(ERROR_RECOVERY_MS); // Wait before retry
        }

        // Exit loop if a self-build requires a process restart
        if (this.restartPending) {
          log.info('Restart pending after self-build, exiting loop');
          break;
        }

        // Sleep between cycles
        await sleep(this.config.values.brain.scanInterval * 1000);
      }
    } finally {
      this.releaseLock();
      this.setRunning(false);
      this.setState('idle');
      log.info('Main loop stopped');
      this.stoppedResolve?.();
      this.stoppedResolve = null;
      this.stoppedPromise = null;

      if (this.restartPending) {
        for (const listener of this.restartListeners) {
          try { listener(); } catch { /* ignore */ }
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.setRunning(false);
  }

  /** Wait for start() to fully exit (including finally block). Use after stop(). */
  async waitForStopped(timeoutMs = 120_000): Promise<void> {
    if (!this.stoppedPromise) return;
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('Timeout waiting for MainLoop to stop')), timeoutMs),
    );
    await Promise.race([this.stoppedPromise, timeout]).catch(err => {
      log.warn(`${err}`);
    });
  }

  pause(): void {
    this.setPaused(true);
    log.info('Loop paused');
  }

  resume(): void {
    this.setPaused(false);
    log.info('Loop resumed');
  }

  /** Run a single scan→plan→execute→review→reflect cycle */
  async runCycle(): Promise<void> {
    const projectPath = this.config.projectPath;

    // Plugin marketplace check (every 24 hours)
    if (this.pluginMonitor && Date.now() - this.lastPluginCheck > PLUGIN_CHECK_INTERVAL_MS) {
      try {
        const result = await this.pluginMonitor.checkForUpdates();
        if (result.newPlugins.length > 0 || result.updatable.length > 0) {
          log.info(`Plugin updates: ${result.newPlugins.length} new, ${result.updatable.length} updatable`);
        }
        this.lastPluginCheck = Date.now();
      } catch (err) {
        log.warn(`Plugin check failed: ${err}`);
      }
    }

    // SCAN
    this.setState('scanning');
    const hasChanges = await this.brain.hasChanges(projectPath);
    if (!hasChanges) {
      // Check if there are queued tasks to process
      const queued = await this.taskQueue.getQueued(projectPath);
      if (queued.length === 0) {
        log.info('No changes and no queued tasks. Sleeping.');
        this.setState('idle');
        return;
      }
      log.info(`No new changes but ${queued.length} queued tasks.`);
    } else {
      const { analysis, cost: scanCost } = await this.brain.scanProject(projectPath, 'normal');
      if (scanCost > 0) await this.taskStore.addDailyCost(scanCost);

      // PLAN
      const actionableItems = analysis.issues.length + analysis.opportunities.length;
      if (actionableItems > 0) {
        this.setState('planning');
        const { plan, cost: planCost } = await this.brain.createPlan(projectPath, analysis);
        if (planCost > 0) await this.taskStore.addDailyCost(planCost);

        if (plan.tasks.length > 0) {
          await this.taskQueue.enqueue(projectPath, plan);
          log.info(`Planned ${plan.tasks.length} new tasks`);
        }
      } else {
        log.info(`Scan found no actionable items (health: ${analysis.projectHealth}/100). Skipping planning.`);
      }
    }

    // EVOLVE: assess goal progress (use fresh scan or last saved scan)
    if (this.evolutionEngine) {
      try {
        const lastScan = await this.taskStore.getLastScan(projectPath);
        if (lastScan) {
          await this.evolutionEngine.assessGoalProgress(projectPath, lastScan.result, lastScan.id);
          await this.evolutionEngine.applyPendingProposals(projectPath);
        }
      } catch (err) {
        log.warn(`Evolution goal assessment failed: ${err}`);
      }
    }

    // EXECUTE + REVIEW queued tasks (with pre-execution evaluation)
    let task = await this.taskQueue.getNext(projectPath);
    while (task && this.running && !this.paused) {
      if (await this.checkBudgetOrAbort(task.id)) {
        break;
      }

      // Pre-execution evaluation: is this task worth doing?
      const evaluation = await this.evaluateTaskValue(task, projectPath);
      if (!evaluation.passed) {
        log.info(`Task rejected by evaluation (score=${evaluation.score.total}): ${task.task_description.slice(0, 60)}`);
        await this.taskStore.updateTask(task.id, {
          status: 'pending_review',
          evaluation_score: evaluation.score,
          evaluation_reasoning: evaluation.reasoning,
        });
        await this.taskStore.saveEvaluationEvent({
          task_id: task.id,
          passed: evaluation.passed,
          score: evaluation.score,
          reasoning: evaluation.reasoning,
          cost_usd: evaluation.cost_usd,
          duration_ms: evaluation.duration_ms,
        });
        if (evaluation.cost_usd > 0) await this.taskStore.addDailyCost(evaluation.cost_usd);
        task = await this.taskQueue.getNext(projectPath);
        continue;
      }
      // Evaluation passed — record it and proceed
      await this.taskStore.saveEvaluationEvent({
        task_id: task.id,
        passed: evaluation.passed,
        score: evaluation.score,
        reasoning: evaluation.reasoning,
        cost_usd: evaluation.cost_usd,
        duration_ms: evaluation.duration_ms,
      });
      if (evaluation.cost_usd > 0) await this.taskStore.addDailyCost(evaluation.cost_usd);

      await this.executeTask(task);
      task = await this.taskQueue.getNext(projectPath);
    }

    this.setState('idle');
  }

  /** Run a single manually-triggered scan (not allowed while patrol loop is running) */
  async triggerScan(depth: 'quick' | 'normal' | 'deep' = 'normal'): Promise<void> {
    if (this.running) {
      throw new Error('Cannot trigger manual scan while patrol loop is running');
    }
    this.setState('scanning');
    try {
      const { cost } = await this.brain.scanProject(this.config.projectPath, depth);
      if (cost > 0) await this.taskStore.addDailyCost(cost);
    } finally {
      this.setState('idle');
    }
  }

  private async evaluateTaskValue(task: Task, projectPath: string): Promise<EvaluationResult> {
    this.setState('evaluating');
    const start = Date.now();

    try {
      // Build context for the evaluator
      const planSummary = task.subtasks && (task.subtasks as SubTaskRecord[]).length > 0
        ? (task.subtasks as SubTaskRecord[]).map(st => `- ${st.description}`).join('\n')
        : task.plan ? JSON.stringify(task.plan, null, 2).slice(0, 1000) : 'No plan available';

      const lastScan = await this.taskStore.getLastScan(projectPath);
      const scanContext = lastScan?.result?.summary ?? 'No recent scan data';

      // Create System Data MCP server for historical data access
      const systemDataMcp = createSystemDataMcpServer({
        projectPath,
        taskStore: this.taskStore,
        globalMemory: this.globalMemory,
      });

      const basePrompt = evaluatorPrompt(
        task.task_description,
        planSummary,
        scanContext,
        ['db-coder-system-data'],
      );
      const prompt = this.promptRegistry
        ? await this.promptRegistry.resolve('evaluator', basePrompt)
        : basePrompt;

      const result = await this.claude.plan(prompt, projectPath, {
        systemPrompt: 'You are a task value assessor. Use the available MCP tools to query historical data, then output your evaluation as JSON.',
        maxTurns: 10,
        internalMcpServers: { 'db-coder-system-data': systemDataMcp },
      });

      const parsed = parseEvaluation(result.output);
      return {
        ...parsed,
        cost_usd: result.cost_usd,
        duration_ms: Date.now() - start,
      };
    } catch (err) {
      log.warn(`Evaluation failed, defaulting to pass: ${err}`);
      // On error, default to PASS so we don't block tasks
      return {
        passed: true,
        score: { problemLegitimacy: 0, solutionProportionality: 0, expectedComplexity: 0, historicalSuccess: 0, total: 1 },
        reasoning: `Evaluation error: ${err}`,
        cost_usd: 0,
        duration_ms: Date.now() - start,
      };
    }
  }

  private async executeTask(task: Task): Promise<void> {
    const projectPath = this.config.projectPath;
    this.setCurrentTaskId(task.id);
    this.setState('executing');

    log.info(`Executing task [P${task.priority}]: ${task.task_description.slice(0, TASK_DESC_MAX_LENGTH)}`);

    const branchName = `${this.config.values.git.branchPrefix}${task.id.slice(0, BRANCH_ID_LENGTH)}`;
    let originalBranch = 'main';
    let startCommit = '';

    try {
      ({ originalBranch, startCommit } = await this.prepareTaskBranch(task, branchName, projectPath));

      // Record baseline tsc error count before any changes
      const baselineErrors = await countTscErrors(projectPath);

      // Auto-decompose: if task has no subtasks, use Brain to generate them
      if (!task.subtasks || (task.subtasks as SubTaskRecord[]).length === 0) {
        log.info('Task has no subtasks, auto-decomposing...');
        const analysis: ProjectAnalysis = {
          issues: [{ type: 'feature', severity: 'medium', description: task.task_description, suggestion: '' }],
          opportunities: [],
          projectHealth: 50,
          summary: task.task_description,
        };
        const { plan, cost: decomposeCost } = await this.brain.createPlan(projectPath, analysis);
        if (decomposeCost > 0) await this.costTracker.addCost(task.id, decomposeCost);
        const planTask = plan.tasks[0];
        if (planTask?.subtasks?.length) {
          const subtaskRecords: SubTaskRecord[] = planTask.subtasks.map(st => ({
            id: st.id, description: st.description, executor: st.executor, status: 'pending' as const,
          }));
          task.subtasks = subtaskRecords;
          await this.taskStore.updateTask(task.id, { subtasks: subtaskRecords, plan: planTask });
        } else {
          task.subtasks = [{ id: 'S1', description: task.task_description, executor: 'codex', status: 'pending' }];
          await this.taskStore.updateTask(task.id, { subtasks: task.subtasks });
        }
      }

      const { subtasks, stuckAdjustments, aborted } = await this.executeSubtasks(task, branchName, projectPath);
      if (aborted) return;

      const reviewCycle = await this.runReviewCycle(task, startCommit, stuckAdjustments, projectPath);
      if (reviewCycle.aborted) return;
      let { reviewResult, reviewRetries } = reviewCycle;

      // Post-execution check: hard metrics gate (zero LLM cost)
      let shouldMerge = reviewResult.passed;
      if (reviewResult.passed) {
        const postCheck = await this.postExecutionCheck(baselineErrors, startCommit, projectPath);
        if (!postCheck.passed) {
          log.warn(`Post-execution check failed: ${postCheck.reason}`);
          shouldMerge = false;
          // Override reviewResult for reflection
          reviewResult = { ...reviewResult, passed: false, summary: `${reviewResult.summary}\nPost-check: ${postCheck.reason}` };
        }
      }

      await this.reflectOnTask(task, subtasks, reviewResult, reviewRetries, stuckAdjustments, projectPath);

      // Merge completed task branch back to main
      if (shouldMerge) {
        try {
          await switchBranch(originalBranch, projectPath);
          await mergeBranch(branchName, projectPath);
          await deleteBranch(branchName, projectPath);

          // Self-modification: rebuild after merging our own code changes
          if (this.isSelfProject()) {
            const buildResult = await safeBuild(projectPath);
            if (buildResult.success) {
              this.restartPending = true;
              log.info('Self-build succeeded, restart pending after cycle completes');
            } else {
              this.writeBuildError(buildResult.error);
            }
          }
        } catch (mergeErr) {
          log.warn(`Auto-merge failed for ${branchName}: ${mergeErr}`);
        }
      } else {
        // Review failed or post-check failed — clean up task branch
        await switchBranch(originalBranch, projectPath).catch(cleanupErr => {
          log.warn(`Failed to cleanup branch ${branchName}: ${cleanupErr}`);
        });
        await this.cleanupTaskBranch(branchName);
      }

      // PROMPT EVOLUTION: update effectiveness of active prompt versions
      await this.updatePromptVersionEffectiveness(shouldMerge);

      // PROMPT EVOLUTION: trigger meta-reflect after N completed tasks
      this.tasksCompletedSinceMetaReflect++;
      const metaReflectInterval = this.config.values.evolution?.metaReflectInterval ?? 5;
      if (this.evolutionEngine && this.tasksCompletedSinceMetaReflect >= metaReflectInterval) {
        this.tasksCompletedSinceMetaReflect = 0;
        try {
          await this.evolutionEngine.metaReflect(projectPath, this.claude);
        } catch (err) {
          log.warn(`Meta-reflect failed: ${err}`);
        }
      }
    } catch (err) {
      log.error('Task execution error', err);
      await this.taskStore.updateTask(task.id, { status: 'failed', phase: 'failed' });
      // Clean up task branch after crash
      await switchBranch(originalBranch, projectPath).catch(cleanupErr => {
        log.warn(`Failed to cleanup branch ${branchName} after error: ${cleanupErr}`);
      });
      await this.cleanupTaskBranch(branchName);
      // Reflect on failure to extract lessons
      try {
        const { reflection, cost: reflectCost } = await this.brain.reflect(
          projectPath, task.task_description,
          `Execution crashed: ${err}`, 'Task failed with exception', 'failed',
        );
        if (reflectCost > 0) await this.costTracker.addCost(task.id, reflectCost);
        if (this.evolutionEngine && reflection.adjustments.length > 0) {
          await this.evolutionEngine.processAdjustments(projectPath, task.id, reflection.adjustments, 'failed');
        }
      } catch (reflectErr) {
        log.warn(`Reflect after failure failed: ${reflectErr}`);
      }
    } finally {
      // Return to original branch
      await switchBranch(originalBranch, projectPath).catch(() => {});
      this.setCurrentTaskId(null);
    }
  }

  private async prepareTaskBranch(
    task: Task,
    branchName: string,
    projectPath: string,
  ): Promise<{ originalBranch: string; startCommit: string }> {
    const originalBranch = await getCurrentBranch(projectPath).catch(() => 'main');
    const startCommit = await getHeadCommit(projectPath).catch(() => '');

    if (await branchExists(branchName, projectPath)) {
      await switchBranch(branchName, projectPath);
    } else {
      await createBranch(branchName, projectPath);
    }

    await this.taskStore.updateTask(task.id, {
      status: 'active',
      phase: 'executing',
      git_branch: branchName,
      start_commit: startCommit,
    });

    return { originalBranch, startCommit };
  }

  private async executeSubtasks(
    task: Task,
    branchName: string,
    projectPath: string,
  ): Promise<{ subtasks: SubTaskRecord[]; stuckAdjustments: string[]; aborted: boolean }> {
    const subtasks = task.subtasks as SubTaskRecord[];
    const standards = await this.globalMemory.getRelevant('coding standards');
    const stuckAdjustments: string[] = [];
    const retryCounts = new Map<string, number>();
    let stopSubtasks = false;

    for (const subtask of subtasks) {
      if (subtask.status === 'done') continue;

      while (true) {
        if (await this.checkBudgetOrAbort(task.id)) {
          return { subtasks, stuckAdjustments, aborted: true };
        }

        subtask.status = 'running';
        await this.taskStore.updateTask(task.id, { subtasks });
        const result = await this.executeSubtask(task, subtask, standards, projectPath);

        if (await this.checkBudgetOrAbort(task.id)) {
          subtask.status = 'failed';
          subtask.result = 'Blocked: budget exceeded';
          await this.taskStore.updateTask(task.id, { subtasks });
          return { subtasks, stuckAdjustments, aborted: true };
        }

        if (result.success) {
          subtask.status = 'done';
          subtask.result = result.output.slice(0, SUBTASK_RESULT_MAX_LENGTH);
          const changedFiles = await getModifiedAndAddedFiles(projectPath).catch(() => []);
          await commitAll(`db-coder: ${subtask.description.slice(0, COMMIT_MSG_MAX_LENGTH)}`, projectPath, changedFiles).catch(() => {});
          break;
        }

        subtask.status = 'failed';
        subtask.result = result.output.slice(0, SUBTASK_RESULT_MAX_LENGTH);
        log.warn(`Subtask failed: ${subtask.description}`);
        const handled = await this.handleRetry(task, subtask, {
          subtasks,
          error: result.output,
          stuckAdjustments,
          retryCounts,
          branchName,
          projectPath,
        });
        if (!handled) {
          stopSubtasks = true;
          break;
        }
      }

      await this.taskStore.updateTask(task.id, { subtasks });
      if (stopSubtasks) break;
    }

    return { subtasks, stuckAdjustments, aborted: false };
  }

  private async runReviewCycle(
    task: Task,
    startCommit: string,
    stuckAdjustments: string[],
    projectPath: string,
  ): Promise<{ aborted: true } | { aborted: false; reviewResult: MergedReviewResult; reviewRetries: number }> {
    if (await this.checkBudgetOrAbort(task.id)) {
      return { aborted: true };
    }

    this.setState('reviewing');
    await this.taskStore.updateTask(task.id, { phase: 'reviewing' });

    let reviewRetries = 0;
    let changedFiles = await getChangedFilesSince(startCommit, projectPath).catch(() => []);
    let { merged: reviewResult, decision: reviewDecision, cost_usd: reviewCost, duration_ms: reviewDuration } = await this.dualReview(task, changedFiles, reviewRetries);

    await this.taskStore.updateTask(task.id, {
      review_results: [...(task.review_results as unknown[] || []), reviewResult],
    });
    await this.saveReviewEvent(task.id, 0, reviewResult, null, reviewCost, reviewDuration);

    while (reviewDecision === 'retry') {
      if (await this.checkBudgetOrAbort(task.id)) {
        return { aborted: true };
      }

      reviewRetries++;
      log.info(`Review found issues (attempt ${reviewRetries}/${this.config.values.autonomy.maxRetries}). Fixing...`);
      const fixPrompt = await this.buildFixPrompt(task, reviewResult, reviewRetries, stuckAdjustments);
      const useClaudeForFix = reviewRetries > 1;
      const fixAgent = useClaudeForFix ? this.claude : this.codex;
      const fixAgentName = useClaudeForFix ? 'claude' : 'codex';
      log.info(`Fix attempt ${reviewRetries} using ${fixAgentName}`);

      await fixAgent.execute(fixPrompt, projectPath, {});
      const changedFilesForCommit = await getModifiedAndAddedFiles(projectPath).catch(() => []);
      await commitAll(`db-coder: fix review issues (attempt ${reviewRetries}, ${fixAgentName})`, projectPath, changedFilesForCommit).catch(() => {});
      if (await this.checkBudgetOrAbort(task.id)) {
        return { aborted: true };
      }

      changedFiles = await getChangedFilesSince(startCommit, projectPath).catch(() => []);
      ({ merged: reviewResult, decision: reviewDecision, cost_usd: reviewCost, duration_ms: reviewDuration } = await this.dualReview(task, changedFiles, reviewRetries));
      await this.saveReviewEvent(task.id, reviewRetries, reviewResult, fixAgentName, reviewCost, reviewDuration);
      await this.taskStore.updateTask(task.id, {
        review_results: [...(task.review_results as unknown[] || []), reviewResult],
      });
    }

    return { aborted: false, reviewResult, reviewRetries };
  }

  private async reflectOnTask(
    task: Task,
    subtasks: SubTaskRecord[],
    reviewResult: MergedReviewResult,
    reviewRetries: number,
    stuckAdjustments: string[],
    projectPath: string,
  ): Promise<void> {
    this.setState('reflecting');
    await this.taskStore.updateTask(task.id, { phase: 'reflecting' });

    const allResults = subtasks.map(st => `${st.description}: ${st.status} ${st.result ?? ''}`).join('\n');
    const outcome = reviewResult.passed ? 'success' as const : 'blocked_max_retries' as const;
    const retryContext = reviewRetries > 0 ? `\nReview retries: ${reviewRetries}. Stuck adjustments applied: ${stuckAdjustments.length}` : '';
    const { reflection, cost: reflectCost } = await this.brain.reflect(projectPath, task.task_description, allResults + retryContext, reviewResult.summary, outcome);
    if (reflectCost > 0) await this.costTracker.addCost(task.id, reflectCost);

    if (this.evolutionEngine && reflection.adjustments.length > 0) {
      await this.tryProcessAdjustments(task.id, reflection.adjustments, outcome);
    }

    const finalStatus = reviewResult.passed ? 'done' : 'blocked';
    await this.taskStore.updateTask(task.id, {
      status: finalStatus as Task['status'],
      phase: finalStatus === 'blocked' ? 'blocked' : 'done',
      iteration: task.iteration + reviewRetries,
    });

    log.info(`Task ${reviewResult.passed ? 'completed' : 'blocked'}: ${task.task_description.slice(0, 60)}`);
  }

  private async executeSubtask(
    task: Task,
    subtask: SubTaskRecord,
    standards: string,
    projectPath: string,
  ): Promise<AgentResult> {
    const agent = subtask.executor === 'claude' ? this.claude : this.codex;
    const mcpNames = subtask.executor === 'claude' ? this.claude.getMcpServerNames('execute') : [];
    const basePrompt = executorPrompt(task.task_description, subtask.description, standards, '', mcpNames);
    const prompt = this.promptRegistry ? await this.promptRegistry.resolve('executor', basePrompt) : basePrompt;
    const result = await agent.execute(prompt, projectPath, {
      timeout: this.config.values.autonomy.subtaskTimeout * 1000,
    });

    if (result.cost_usd > 0) {
      await this.costTracker.addCost(task.id, result.cost_usd);
    }

    await this.taskStore.addLog({
      task_id: task.id,
      phase: 'execute',
      agent: subtask.executor,
      input_summary: subtask.description.slice(0, SUBTASK_RESULT_MAX_LENGTH),
      output_summary: result.output.slice(0, LOG_OUTPUT_MAX_LENGTH),
      cost_usd: result.cost_usd,
      duration_ms: result.duration_ms,
    });

    return result;
  }

  private async handleRetry(
    task: Task,
    subtask: SubTaskRecord,
    context: {
      subtasks: SubTaskRecord[];
      error: string;
      stuckAdjustments: string[];
      retryCounts: Map<string, number>;
      branchName: string;
      projectPath: string;
    },
  ): Promise<boolean> {
    const attempt = (context.retryCounts.get(subtask.id) ?? 0) + 1;
    context.retryCounts.set(subtask.id, attempt);
    const maxRetries = this.config.values.autonomy.maxRetries;
    const shouldRetry = await this.handleStuck(task, subtask, context.error, context.stuckAdjustments, attempt, maxRetries);
    if (!shouldRetry) return false;

    const baseDelayMs = this.config.values.autonomy.retryBaseDelayMs;
    const maxDelayMs = baseDelayMs * 2 ** Math.max(0, maxRetries);
    const backoffMs = calculateRetryDelay({
      attempt: attempt - 1,
      baseDelayMs,
      maxDelayMs,
    });

    subtask.status = 'pending';
    subtask.result = `Retrying (attempt ${attempt + 1})`;
    await this.taskStore.updateTask(task.id, { subtasks: context.subtasks });
    await sleep(backoffMs);
    await switchBranch(context.branchName, context.projectPath).catch(() => {});
    return true;
  }

  /** Dual review: Claude + Codex in parallel, then merge and decide next action */
  private async dualReview(
    task: Task,
    changedFiles: string[],
    reviewRetries: number,
  ): Promise<{ merged: MergedReviewResult; decision: 'approve' | 'retry' | 'reject'; cost_usd: number; duration_ms: number }> {
    const filesStr = changedFiles.join('\n');
    const reviewMcpNames = this.claude.getMcpServerNames('review');
    const agentGuide = buildAgentGuidance('review', this.claude.getLoadedPluginIds());
    const baseReviewPrompt = reviewerPrompt(task.task_description, filesStr, reviewMcpNames, agentGuide);
    const reviewPromptText = this.promptRegistry ? await this.promptRegistry.resolve('reviewer', baseReviewPrompt) : baseReviewPrompt;

    // Run both reviews in parallel
    const reviewStart = Date.now();
    const [claudeReview, codexReview] = await Promise.all([
      this.claude.review(reviewPromptText, this.config.projectPath),
      this.codex.review(reviewPromptText, this.config.projectPath),
    ]);
    const duration_ms = Date.now() - reviewStart;

    log.info(`Reviews: Claude ${claudeReview.passed ? 'PASS' : 'FAIL'}, Codex ${codexReview.passed ? 'PASS' : 'FAIL'} (${Math.round(duration_ms / 1000)}s)`);

    // Track costs
    const cost_usd = claudeReview.cost_usd + codexReview.cost_usd;
    if (claudeReview.cost_usd > 0) {
      await this.costTracker.addCost(task.id, claudeReview.cost_usd);
    }
    if (codexReview.cost_usd > 0) {
      await this.costTracker.addCost(task.id, codexReview.cost_usd);
    }

    return { ...this.handleReviewResult(claudeReview, codexReview, reviewRetries), cost_usd, duration_ms };
  }

  private handleReviewResult(
    claudeReview: ReviewResult,
    codexReview: ReviewResult,
    reviewRetries: number,
  ): { merged: MergedReviewResult; decision: 'approve' | 'retry' | 'reject' } {
    const merged = mergeReviews(claudeReview, codexReview);
    if (merged.passed) {
      return { merged, decision: 'approve' };
    }
    if (reviewRetries >= this.config.values.autonomy.maxRetries) {
      return { merged, decision: 'reject' };
    }
    return { merged, decision: 'retry' };
  }

  /** Graduated stuck handling: retry → reflect → skip. Populates stuckAdjustments for downstream use. */
  private async handleStuck(
    task: Task,
    subtask: SubTaskRecord,
    error: string,
    stuckAdjustments: string[],
    iteration: number,
    maxRetries: number,
  ): Promise<boolean> {
    if (iteration < maxRetries && iteration === 1) {
      log.info('Stuck: retrying subtask');
      return true; // Will retry in next iteration
    }

    if (iteration < maxRetries && iteration === 2) {
      log.info('Stuck: asking Brain to reflect and adjust');
      const { reflection, cost: reflectCost } = await this.brain.reflect(
        this.config.projectPath,
        task.task_description,
        `Subtask "${subtask.description}" failed: ${error}`,
        'Failed during execution',
        'blocked_stuck',
      );
      if (reflectCost > 0) await this.costTracker.addCost(task.id, reflectCost);
      if (reflection.adjustments.length > 0) {
        log.info(`Brain suggests: ${reflection.adjustments.join(', ')}`);
        // Inject adjustments into task-level context for immediate use
        stuckAdjustments.push(...reflection.adjustments);
        // EVOLVE: store stuck adjustments
        await this.tryProcessAdjustments(
          task.id,
          reflection.adjustments,
          'blocked_stuck',
          'Evolution processAdjustments (stuck) failed',
        );
      }
      return true; // Will retry with new insights
    }

    if (iteration < maxRetries) {
      log.info(`Stuck: retrying subtask (attempt ${iteration}/${maxRetries})`);
      return true;
    }

    // Max retries reached: reflect then skip
    log.warn(`Stuck: skipping subtask "${subtask.description}" after ${iteration} attempts (max: ${maxRetries})`);
    try {
      const { reflection, cost: reflectCost } = await this.brain.reflect(
        this.config.projectPath, task.task_description,
        `Subtask "${subtask.description}" failed ${iteration} times: ${error}`,
        'Permanently stuck — giving up', 'blocked_stuck',
      );
      if (reflectCost > 0) await this.costTracker.addCost(task.id, reflectCost);
      if (reflection.adjustments.length > 0) {
        stuckAdjustments.push(...reflection.adjustments);
      }
      await this.tryProcessAdjustments(task.id, reflection.adjustments, 'blocked_stuck');
    } catch (reflectErr) {
      log.warn(`Reflect on stuck failed: ${reflectErr}`);
    }
    await this.taskStore.updateTask(task.id, { status: 'blocked', phase: 'blocked' });
    return false;
  }

  /** Build a rich fix prompt with task context, previous attempts, and learned patterns */
  private async buildFixPrompt(
    task: Task,
    reviewResult: MergedReviewResult,
    attempt: number,
    stuckAdjustments: string[],
  ): Promise<string> {
    const issuesToFix = dedupeIssues([...reviewResult.mustFix, ...reviewResult.shouldFix]);
    const issueLines = issuesToFix.length > 0
      ? issuesToFix.map(i => `- [${i.severity}] ${i.description}${i.file ? ` (${i.file}${i.line ? `:${i.line}` : ''})` : ''}${i.suggestion ? `: ${i.suggestion}` : ''}`).join('\n')
      : `- No structured issues were returned.\n- Review summary: ${reviewResult.summary}`;

    // Previous review attempts summary
    const prevResults = (task.review_results as MergedReviewResult[] || []).slice(-2);
    const previousAttempts = prevResults
      .map((r, i) => `Attempt ${i + 1}: ${r.passed ? 'PASSED' : 'FAILED'} — ${r.summary?.slice(0, REVIEW_SUMMARY_MAX_LENGTH)}`)
      .join('\n');

    // Coding standards from memory
    const standards = await this.globalMemory.getRelevant('coding standards').catch(() => null);

    // Active adjustments from evolution engine
    let activeAdj: string[] = [];
    if (this.evolutionEngine) {
      try {
        const ctx = await this.evolutionEngine.synthesizePromptContext(this.config.projectPath);
        activeAdj = ctx.activeAdjustments;
      } catch { /* ignore */ }
    }

    const stuckContext = stuckAdjustments.length > 0
      ? `\n## Lessons from Previous Failures\n${stuckAdjustments.map(a => `- ${a}`).join('\n')}`
      : '';

    return `You are fixing review issues for a coding task.

## Task Description
${task.task_description}

## Coding Standards
${standards || 'Follow best practices.'}

## Previous Review Attempts
${previousAttempts || 'First attempt.'}

## Current Issues to Fix (Attempt ${attempt})
${issueLines}

${activeAdj.length > 0 ? `## Learned Patterns\n${activeAdj.join('\n')}` : ''}${stuckContext}

Fix these issues while maintaining code quality. Do not introduce new issues.`;
  }

  /** Record a structured review event */
  private async saveReviewEvent(
    taskId: string,
    attempt: number,
    result: MergedReviewResult,
    fixAgent: string | null,
    cost_usd: number,
    duration_ms: number,
  ): Promise<void> {
    try {
      const allIssues = [...result.mustFix, ...result.shouldFix];
      const categories = extractIssueCategories(allIssues);

      await this.taskStore.saveReviewEvent({
        task_id: taskId,
        attempt,
        passed: result.passed,
        must_fix_count: result.mustFix.length,
        should_fix_count: result.shouldFix.length,
        issue_categories: categories,
        fix_agent: fixAgent,
        duration_ms,
        cost_usd,
      });
    } catch (err) {
      log.warn(`Failed to save review event: ${err}`);
    }
  }

  /** Update effectiveness of all active prompt versions based on task outcome */
  private async updatePromptVersionEffectiveness(passed: boolean): Promise<void> {
    if (!this.promptRegistry) return;
    const projectPath = this.config.projectPath;
    try {
      const versions = await this.taskStore.getActivePromptVersions(projectPath);
      const delta = passed ? PROMPT_SUCCESS_DELTA : PROMPT_FAILURE_DELTA;
      for (const v of versions) {
        await this.taskStore.updatePromptVersionEffectiveness(v.id, delta);
      }
    } catch (err) {
      log.warn(`Failed to update prompt version effectiveness: ${err}`);
    }
  }

  private acquireLock(): boolean {
    if (existsSync(this.lockFile)) {
      // Check if PID in lock file is still running
      try {
        const pid = parseInt(readFileSync(this.lockFile, 'utf-8'), 10);
        try { process.kill(pid, 0); return false; } catch { /* PID not running, stale lock */ }
      } catch { /* invalid lock file, overwrite */ }
    }
    writeFileSync(this.lockFile, String(process.pid));
    return true;
  }

  private releaseLock(): void {
    try { unlinkSync(this.lockFile); } catch { /* ignore */ }
  }

  /**
   * Post-execution check: compare hard metrics (tsc errors) before and after.
   * Zero LLM cost — purely mechanical check.
   */
  private async postExecutionCheck(
    baselineErrors: number,
    startCommit: string,
    projectPath: string,
  ): Promise<{ passed: boolean; reason?: string }> {
    // Check tsc error count
    const currentErrors = await countTscErrors(projectPath);
    if (currentErrors > baselineErrors) {
      return {
        passed: false,
        reason: `TypeScript errors increased: ${baselineErrors} → ${currentErrors} (+${currentErrors - baselineErrors})`,
      };
    }

    // Check diff anomaly: if task looks small but touches many files, warn (but don't block)
    try {
      const stats = await getDiffStats(startCommit, 'HEAD', projectPath);
      if (stats.files_changed > 15) {
        log.warn(`Post-check warning: ${stats.files_changed} files changed (${stats.insertions}+ ${stats.deletions}-)`);
      }
    } catch {
      // Non-critical, ignore
    }

    return { passed: true };
  }

  /** Remove branches matching the prefix that don't belong to any queued/active task */
  private async cleanupOrphanedBranches(): Promise<void> {
    const projectPath = this.config.projectPath;
    const prefix = this.config.values.git.branchPrefix;
    const branches = await listBranches(prefix, projectPath);
    if (branches.length === 0) return;

    // Gather task IDs that are still in progress
    const [queued, active] = await Promise.all([
      this.taskStore.listTasks(projectPath, 'queued'),
      this.taskStore.listTasks(projectPath, 'active'),
    ]);
    const activeBranches = new Set(
      [...queued, ...active]
        .map(t => t.git_branch)
        .filter(Boolean),
    );

    let cleaned = 0;
    for (const branch of branches) {
      if (activeBranches.has(branch)) continue;
      await this.cleanupTaskBranch(branch);
      const stillExists = await branchExists(branch, projectPath).catch(() => true);
      if (!stillExists) {
        cleaned++;
      }
    }
    if (cleaned > 0) {
      log.info(`Cleaned up ${cleaned} orphaned branch(es)`);
    }
  }

  private async checkBudgetOrAbort(taskId: string): Promise<boolean> {
    const budget = await this.costTracker.checkBudget(taskId);
    if (budget.allowed) return false;

    log.warn(`Budget exceeded: ${budget.reason}`);
    await this.taskStore.updateTask(taskId, { status: 'blocked', phase: 'blocked' });
    return true;
  }

  private async cleanupTaskBranch(branch: string): Promise<void> {
    const projectPath = this.config.projectPath;
    try {
      await forceDeleteBranch(branch, projectPath);
    } catch (cleanupErr) {
      log.warn(`Failed to cleanup branch ${branch}: ${cleanupErr}`);
    }
  }

  private async tryProcessAdjustments(
    taskId: string | null,
    adjustments: string[],
    outcome: AdjustmentOutcome,
    errorContext = 'Evolution processAdjustments failed',
  ): Promise<void> {
    if (!this.evolutionEngine || adjustments.length === 0) return;
    try {
      await this.evolutionEngine.processAdjustments(this.config.projectPath, taskId, adjustments, outcome);
    } catch (err) {
      log.warn(`${errorContext}: ${err}`);
    }
  }
}

function mergeReviews(claude: ReviewResult, codex: ReviewResult): MergedReviewResult {
  const mustFix: ReviewIssue[] = [];
  const shouldFix: ReviewIssue[] = [];

  // Find intersection: issues flagged by both reviewers
  for (const ci of claude.issues) {
    const match = codex.issues.find(xi =>
      xi.file === ci.file && (
        xi.description.toLowerCase().includes(ci.description.toLowerCase().slice(0, 20)) ||
        ci.description.toLowerCase().includes(xi.description.toLowerCase().slice(0, 20))
      )
    );
    if (match) {
      mustFix.push({ ...ci, severity: higherSeverity(ci.severity, match.severity) });
    } else {
      shouldFix.push(ci);
    }
  }

  // Add codex-only issues as shouldFix
  for (const xi of codex.issues) {
    const alreadyMerged = mustFix.some(m => m.file === xi.file && m.description === xi.description);
    if (!alreadyMerged) {
      shouldFix.push(xi);
    }
  }

  // Pass if no must-fix issues (intersection of both reviewers).
  // Individual reviewer shouldFix items don't block — they're logged for future reference.
  const hasCriticalMustFix = mustFix.some(i => i.severity === 'critical' || i.severity === 'high');
  const passed = mustFix.length === 0 || !hasCriticalMustFix;

  return {
    passed,
    mustFix,
    shouldFix,
    summary: `Claude: ${claude.summary}\nCodex: ${codex.summary}\nMust fix: ${mustFix.length}, Should fix: ${shouldFix.length}`,
  };
}

function higherSeverity(a: ReviewIssue['severity'], b: ReviewIssue['severity']): ReviewIssue['severity'] {
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  return order[a] <= order[b] ? a : b;
}

function dedupeIssues(issues: ReviewIssue[]): ReviewIssue[] {
  const seen = new Set<string>();
  const order = { critical: 0, high: 1, medium: 2, low: 3 };

  return [...issues]
    .sort((a, b) => order[a.severity] - order[b.severity])
    .filter(issue => {
      const key = `${issue.file ?? ''}:${issue.line ?? 0}:${issue.description.trim().toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Extract issue categories from review issues for structured tracking */
export function extractIssueCategories(issues: ReviewIssue[]): string[] {
  const CATEGORY_PATTERNS: Record<string, RegExp> = {
    'type-error': /type\s*(error|mismatch|incompatible)/i,
    'null-safety': /null|undefined|optional/i,
    'error-handling': /error\s*handl|try.catch|exception/i,
    'security': /security|injection|xss|csrf|sanitiz/i,
    'performance': /performance|slow|memory\s*leak|O\(n/i,
    'code-style': /style|format|naming|convention|lint/i,
    'logic-error': /logic|incorrect|wrong|bug/i,
    'missing-test': /test|coverage|assert/i,
    'import': /import|require|module|dependency/i,
    'api-design': /api|interface|contract|signature/i,
  };

  const categories = new Set<string>();
  for (const issue of issues) {
    const text = `${issue.description} ${issue.suggestion ?? ''}`;
    let matched = false;
    for (const [cat, pattern] of Object.entries(CATEGORY_PATTERNS)) {
      if (pattern.test(text)) {
        categories.add(cat);
        matched = true;
      }
    }
    // Fallback: use severity as category if no pattern matched
    if (!matched) {
      categories.add(`severity-${issue.severity}`);
    }
  }
  return [...categories];
}

async function countTscErrors(cwd: string): Promise<number> {
  if (!existsSync(join(cwd, 'tsconfig.json'))) return 0;
  try {
    const { runProcess } = await import('../utils/process.js');
    const result = await runProcess('npx', ['tsc', '--noEmit'], { cwd, timeout: 60_000 });
    // Count lines containing ': error TS'
    const lines = (result.stdout + result.stderr).split('\n');
    return lines.filter(l => l.includes(': error TS')).length;
  } catch {
    return 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
