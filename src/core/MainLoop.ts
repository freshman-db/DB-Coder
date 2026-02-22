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
import type { Task, SubTaskRecord, ReviewEvent } from '../memory/types.js';
import type { MergedReviewResult, LoopState, PlanTask } from './types.js';
import type { AgentResult, ReviewResult, ReviewIssue } from '../bridges/CodingAgent.js';
import { executorPrompt } from '../prompts/executor.js';
import { reviewerPrompt } from '../prompts/reviewer.js';
import { buildAgentGuidance } from '../prompts/agents.js';
import { createBranch, switchBranch, commitAll, getHeadCommit, getCurrentBranch, isWorkingClean, branchExists, getChangedFilesSince } from '../utils/git.js';
import { log } from '../utils/logger.js';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

export class MainLoop {
  private state: LoopState = 'idle';
  private running = false;
  private paused = false;
  private currentTaskId: string | null = null;
  private lockFile: string;

  private evolutionEngine?: EvolutionEngine;
  private pluginMonitor?: PluginMonitor;
  private lastPluginCheck = 0;

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
    const hash = createHash('md5').update(config.projectPath).digest('hex').slice(0, 8);
    const lockDir = join(homedir(), '.db-coder');
    this.lockFile = join(lockDir, `${hash}.lock`);
  }

  getState(): LoopState { return this.state; }
  getCurrentTaskId(): string | null { return this.currentTaskId; }
  isPaused(): boolean { return this.paused; }

  setEvolutionEngine(engine: EvolutionEngine): void {
    this.evolutionEngine = engine;
  }

  setPluginMonitor(monitor: PluginMonitor): void {
    this.pluginMonitor = monitor;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.acquireLock()) {
      log.error('Another instance is running. Lock file: ' + this.lockFile);
      return;
    }

    this.running = true;
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

    try {
      while (this.running) {
        if (this.paused) {
          this.state = 'paused';
          await sleep(5000);
          continue;
        }

        try {
          await this.runCycle();
        } catch (err) {
          log.error('Cycle error', err);
          this.state = 'error';
          await sleep(30000); // Wait before retry
        }

        // Sleep between cycles
        await sleep(this.config.values.brain.scanInterval * 1000);
      }
    } finally {
      this.releaseLock();
      this.running = false;
      this.state = 'idle';
      log.info('Main loop stopped');
    }
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  pause(): void {
    this.paused = true;
    log.info('Loop paused');
  }

  resume(): void {
    this.paused = false;
    log.info('Loop resumed');
  }

  /** Run a single scan→plan→execute→review→reflect cycle */
  async runCycle(): Promise<void> {
    const projectPath = this.config.projectPath;

    // Plugin marketplace check (every 24 hours)
    if (this.pluginMonitor && Date.now() - this.lastPluginCheck > 86400_000) {
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
    this.state = 'scanning';
    const hasChanges = await this.brain.hasChanges(projectPath);
    if (!hasChanges) {
      // Check if there are queued tasks to process
      const queued = await this.taskQueue.getQueued(projectPath);
      if (queued.length === 0) {
        log.info('No changes and no queued tasks. Sleeping.');
        this.state = 'idle';
        return;
      }
      log.info(`No new changes but ${queued.length} queued tasks.`);
    } else {
      const { analysis, cost } = await this.brain.scanProject(projectPath, 'normal');

      // EVOLVE: assess goal progress after scan
      if (this.evolutionEngine) {
        try {
          const lastScan = await this.taskStore.getLastScan(projectPath);
          await this.evolutionEngine.assessGoalProgress(projectPath, analysis, lastScan?.id ?? null);
          await this.evolutionEngine.applyPendingProposals(projectPath);
        } catch (err) {
          log.warn(`Evolution goal assessment failed: ${err}`);
        }
      }

      // PLAN
      if (analysis.issues.length > 0 || analysis.opportunities.length > 0) {
        this.state = 'planning';
        const { plan, cost: planCost } = await this.brain.createPlan(projectPath, analysis);

        if (plan.tasks.length > 0) {
          await this.taskQueue.enqueue(projectPath, plan);
          log.info(`Planned ${plan.tasks.length} new tasks`);
        }
      }
    }

    // EXECUTE + REVIEW queued tasks
    let task = await this.taskQueue.getNext(projectPath);
    while (task && this.running && !this.paused) {
      if (!(await this.enforceBudget(task.id))) {
        break;
      }

      await this.executeTask(task);
      task = await this.taskQueue.getNext(projectPath);
    }

    this.state = 'idle';
  }

  /** Run a single manually-triggered scan */
  async triggerScan(depth: 'quick' | 'normal' | 'deep' = 'normal'): Promise<void> {
    this.state = 'scanning';
    try {
      await this.brain.scanProject(this.config.projectPath, depth);
    } finally {
      this.state = 'idle';
    }
  }

  private async executeTask(task: Task): Promise<void> {
    const projectPath = this.config.projectPath;
    this.currentTaskId = task.id;
    this.state = 'executing';

    log.info(`Executing task [P${task.priority}]: ${task.task_description.slice(0, 80)}`);

    // Save original branch
    const originalBranch = await getCurrentBranch(projectPath).catch(() => 'main');
    const branchName = `${this.config.values.git.branchPrefix}${task.id.slice(0, 8)}`;
    const startCommit = await getHeadCommit(projectPath).catch(() => '');

    try {
      // Create isolated branch
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

      // Execute subtasks
      const plan = task.plan as PlanTask | null;
      const subtasks = task.subtasks as SubTaskRecord[];
      const standards = await this.globalMemory.getRelevant('coding standards');
      const stuckAdjustments: string[] = [];
      const retryCounts = new Map<string, number>();
      let stopSubtasks = false;

      for (const subtask of subtasks) {
        if (subtask.status === 'done') continue;

        while (true) {
          if (!(await this.enforceBudget(task.id))) return;

          subtask.status = 'running';
          await this.taskStore.updateTask(task.id, { subtasks });

          const result = await this.executeSubtask(task, subtask, standards, projectPath);

          if (!(await this.enforceBudget(task.id))) {
            subtask.status = 'failed';
            subtask.result = 'Blocked: budget exceeded';
            await this.taskStore.updateTask(task.id, { subtasks });
            return;
          }

          if (result.success) {
            subtask.status = 'done';
            subtask.result = result.output.slice(0, 200);
            await commitAll(`db-coder: ${subtask.description.slice(0, 50)}`, projectPath).catch(() => {});
            break;
          }

          subtask.status = 'failed';
          subtask.result = result.output.slice(0, 200);
          log.warn(`Subtask failed: ${subtask.description}`);
          const handled = await this.handleRetry(
            task,
            subtasks,
            subtask,
            result.output,
            stuckAdjustments,
            retryCounts,
            branchName,
            projectPath,
          );
          if (!handled) {
            stopSubtasks = true;
            break;
          }
        }

        await this.taskStore.updateTask(task.id, { subtasks });
        if (stopSubtasks) break;
      }

      // REVIEW (dual review)
      if (!(await this.enforceBudget(task.id))) return;

      this.state = 'reviewing';
      await this.taskStore.updateTask(task.id, { phase: 'reviewing' });

      let reviewRetries = 0;
      let changedFiles = await getChangedFilesSince(startCommit, projectPath).catch(() => []);
      let { merged: reviewResult, decision: reviewDecision } = await this.dualReview(task, changedFiles, reviewRetries);

      await this.taskStore.updateTask(task.id, {
        review_results: [...(task.review_results as unknown[] || []), reviewResult],
      });

      // Record initial review event
      await this.saveReviewEvent(task.id, 0, reviewResult, null);

      // Fix-and-re-review loop (in-place, no task re-queue)
      while (reviewDecision === 'retry') {
        if (!(await this.enforceBudget(task.id))) return;

        reviewRetries++;
        log.info(`Review found issues (attempt ${reviewRetries}/${this.config.values.autonomy.maxRetries}). Fixing...`);

        // Build rich fix prompt with full context
        const fixPrompt = await this.buildFixPrompt(task, reviewResult, reviewRetries, stuckAdjustments);

        // Adaptive agent routing: first try Codex, then escalate to Claude
        const useClaudeForFix = reviewRetries > 1;
        const fixAgent = useClaudeForFix ? this.claude : this.codex;
        const fixAgentName = useClaudeForFix ? 'claude' : 'codex';
        log.info(`Fix attempt ${reviewRetries} using ${fixAgentName}`);

        await fixAgent.execute(fixPrompt, projectPath, {});
        await commitAll(`db-coder: fix review issues (attempt ${reviewRetries}, ${fixAgentName})`, projectPath).catch(() => {});

        if (!(await this.enforceBudget(task.id))) return;

        changedFiles = await getChangedFilesSince(startCommit, projectPath).catch(() => []);
        ({ merged: reviewResult, decision: reviewDecision } = await this.dualReview(task, changedFiles, reviewRetries));

        // Record review event with fix agent info
        await this.saveReviewEvent(task.id, reviewRetries, reviewResult, fixAgentName);

        await this.taskStore.updateTask(task.id, {
          review_results: [...(task.review_results as unknown[] || []), reviewResult],
        });
      }

      // REFLECT
      this.state = 'reflecting';
      await this.taskStore.updateTask(task.id, { phase: 'reflecting' });

      const allResults = subtasks.map(st => `${st.description}: ${st.status} ${st.result ?? ''}`).join('\n');
      const outcome = reviewResult.passed ? 'success' as const : 'blocked_max_retries' as const;
      const retryContext = reviewRetries > 0 ? `\nReview retries: ${reviewRetries}. Stuck adjustments applied: ${stuckAdjustments.length}` : '';
      const { reflection } = await this.brain.reflect(projectPath, task.task_description, allResults + retryContext, reviewResult.summary, outcome);

      // EVOLVE: process adjustments from reflection
      if (this.evolutionEngine && reflection.adjustments.length > 0) {
        try {
          await this.evolutionEngine.processAdjustments(projectPath, task.id, reflection.adjustments, outcome);
        } catch (err) {
          log.warn(`Evolution processAdjustments failed: ${err}`);
        }
      }

      // Mark done
      const finalStatus = reviewResult.passed ? 'done' : 'blocked';
      await this.taskStore.updateTask(task.id, {
        status: finalStatus as Task['status'],
        phase: finalStatus === 'blocked' ? 'blocked' : 'done',
        iteration: task.iteration + reviewRetries,
      });

      log.info(`Task ${reviewResult.passed ? 'completed' : 'blocked'}: ${task.task_description.slice(0, 60)}`);
    } catch (err) {
      log.error('Task execution error', err);
      await this.taskStore.updateTask(task.id, { status: 'failed', phase: 'failed' });
      // Reflect on failure to extract lessons
      try {
        const { reflection } = await this.brain.reflect(
          projectPath, task.task_description,
          `Execution crashed: ${err}`, 'Task failed with exception', 'failed',
        );
        if (this.evolutionEngine && reflection.adjustments.length > 0) {
          await this.evolutionEngine.processAdjustments(projectPath, task.id, reflection.adjustments, 'failed');
        }
      } catch (reflectErr) {
        log.warn(`Reflect after failure failed: ${reflectErr}`);
      }
    } finally {
      // Return to original branch
      await switchBranch(originalBranch, projectPath).catch(() => {});
      this.currentTaskId = null;
    }
  }

  private async executeSubtask(
    task: Task,
    subtask: SubTaskRecord,
    standards: string,
    projectPath: string,
  ): Promise<AgentResult> {
    const agent = subtask.executor === 'claude' ? this.claude : this.codex;
    const mcpNames = subtask.executor === 'claude' ? this.claude.getMcpServerNames('execute') : [];
    const prompt = executorPrompt(task.task_description, subtask.description, standards, '', mcpNames);
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
      input_summary: subtask.description.slice(0, 200),
      output_summary: result.output.slice(0, 500),
      cost_usd: result.cost_usd,
      duration_ms: result.duration_ms,
    });

    return result;
  }

  private async handleRetry(
    task: Task,
    subtasks: SubTaskRecord[],
    subtask: SubTaskRecord,
    error: string,
    stuckAdjustments: string[],
    retryCounts: Map<string, number>,
    branchName: string,
    projectPath: string,
  ): Promise<boolean> {
    const attempt = (retryCounts.get(subtask.id) ?? 0) + 1;
    retryCounts.set(subtask.id, attempt);
    const shouldRetry = await this.handleStuck(task, subtask, error, stuckAdjustments, attempt);
    if (!shouldRetry) return false;
    const backoffMs = Math.min(8000, 1000 * 2 ** (attempt - 1));
    subtask.status = 'pending';
    subtask.result = `Retrying (attempt ${attempt + 1})`;
    await this.taskStore.updateTask(task.id, { subtasks });
    await sleep(backoffMs);
    await switchBranch(branchName, projectPath).catch(() => {});
    return true;
  }

  /** Dual review: Claude + Codex in parallel, then merge and decide next action */
  private async dualReview(
    task: Task,
    changedFiles: string[],
    reviewRetries: number,
  ): Promise<{ merged: MergedReviewResult; decision: 'approve' | 'retry' | 'reject' }> {
    const filesStr = changedFiles.join('\n');
    const reviewMcpNames = this.claude.getMcpServerNames('review');
    const agentGuide = buildAgentGuidance('review', this.claude.getLoadedPluginIds());
    const reviewPromptText = reviewerPrompt(task.task_description, filesStr, reviewMcpNames, agentGuide);

    // Run both reviews in parallel
    const [claudeReview, codexReview] = await Promise.all([
      this.claude.review(reviewPromptText, this.config.projectPath),
      this.codex.review(reviewPromptText, this.config.projectPath),
    ]);

    log.info(`Reviews: Claude ${claudeReview.passed ? 'PASS' : 'FAIL'}, Codex ${codexReview.passed ? 'PASS' : 'FAIL'}`);

    // Track costs
    if (claudeReview.cost_usd > 0) {
      await this.costTracker.addCost(task.id, claudeReview.cost_usd);
    }
    if (codexReview.cost_usd > 0) {
      await this.costTracker.addCost(task.id, codexReview.cost_usd);
    }

    return this.handleReviewResult(claudeReview, codexReview, reviewRetries);
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
  ): Promise<boolean> {
    if (iteration === 1) {
      log.info('Stuck: retrying subtask');
      return true; // Will retry in next iteration
    }

    if (iteration === 2) {
      log.info('Stuck: asking Brain to reflect and adjust');
      const { reflection } = await this.brain.reflect(
        this.config.projectPath,
        task.task_description,
        `Subtask "${subtask.description}" failed: ${error}`,
        'Failed during execution',
        'blocked_stuck',
      );
      if (reflection.adjustments.length > 0) {
        log.info(`Brain suggests: ${reflection.adjustments.join(', ')}`);
        // Inject adjustments into task-level context for immediate use
        stuckAdjustments.push(...reflection.adjustments);
        // EVOLVE: store stuck adjustments
        if (this.evolutionEngine) {
          try {
            await this.evolutionEngine.processAdjustments(
              this.config.projectPath, task.id, reflection.adjustments, 'blocked_stuck',
            );
          } catch (err) {
            log.warn(`Evolution processAdjustments (stuck) failed: ${err}`);
          }
        }
      }
      return true; // Will retry with new insights
    }

    // 3rd failure: reflect then skip
    log.warn(`Stuck: skipping subtask "${subtask.description}" after ${iteration} attempts`);
    try {
      const { reflection } = await this.brain.reflect(
        this.config.projectPath, task.task_description,
        `Subtask "${subtask.description}" failed ${iteration} times: ${error}`,
        'Permanently stuck — giving up', 'blocked_stuck',
      );
      if (reflection.adjustments.length > 0) {
        stuckAdjustments.push(...reflection.adjustments);
      }
      if (this.evolutionEngine && reflection.adjustments.length > 0) {
        await this.evolutionEngine.processAdjustments(
          this.config.projectPath, task.id, reflection.adjustments, 'blocked_stuck',
        );
      }
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
      .map((r, i) => `Attempt ${i + 1}: ${r.passed ? 'PASSED' : 'FAILED'} — ${r.summary?.slice(0, 200)}`)
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
        duration_ms: null,
        cost_usd: 0,
      });
    } catch (err) {
      log.warn(`Failed to save review event: ${err}`);
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

  private async enforceBudget(taskId: string): Promise<boolean> {
    const budget = await this.costTracker.checkBudget(taskId);
    if (budget.allowed) return true;

    log.warn(`Budget exceeded: ${budget.reason}`);
    await this.taskStore.updateTask(taskId, { status: 'blocked', phase: 'blocked' });
    return false;
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

  const passed = claude.passed && codex.passed && mustFix.filter(i => i.severity === 'critical' || i.severity === 'high').length === 0;

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
    // Fallback: use severity as category if this specific issue matched no pattern
    if (!matched) {
      categories.add(`severity-${issue.severity}`);
    }
  }
  return [...categories];
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
