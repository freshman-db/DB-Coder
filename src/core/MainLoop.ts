import type { Config } from '../config/Config.js';
import type { Brain } from './Brain.js';
import type { TaskQueue } from './TaskQueue.js';
import type { ClaudeBridge } from '../bridges/ClaudeBridge.js';
import type { CodexBridge } from '../bridges/CodexBridge.js';
import type { TaskStore } from '../memory/TaskStore.js';
import type { GlobalMemory } from '../memory/GlobalMemory.js';
import type { CostTracker } from '../utils/cost.js';
import type { Task, SubTaskRecord } from '../memory/types.js';
import type { MergedReviewResult, LoopState, PlanTask } from './types.js';
import type { ReviewResult, ReviewIssue } from '../bridges/CodingAgent.js';
import { executorPrompt } from '../prompts/executor.js';
import { reviewerPrompt } from '../prompts/reviewer.js';
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

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.acquireLock()) {
      log.error('Another instance is running. Lock file: ' + this.lockFile);
      return;
    }

    this.running = true;
    log.info('Main loop started');

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
      // Budget check
      const budget = await this.costTracker.checkBudget(task.id);
      if (!budget.allowed) {
        log.warn(`Budget exceeded: ${budget.reason}`);
        await this.taskStore.updateTask(task.id, { status: 'blocked', phase: 'blocked' });
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

      for (const subtask of subtasks) {
        if (subtask.status === 'done') continue;
        subtask.status = 'running';
        await this.taskStore.updateTask(task.id, { subtasks });

        const agent = subtask.executor === 'claude' ? this.claude : this.codex;
        const mcpNames = subtask.executor === 'claude' ? this.claude.getMcpServerNames('execute') : [];
        const prompt = executorPrompt(task.task_description, subtask.description, standards, '', mcpNames);

        const result = await agent.execute(prompt, projectPath, {
          timeout: this.config.values.autonomy.subtaskTimeout * 1000,
        });

        // Track cost
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

        if (result.success) {
          subtask.status = 'done';
          subtask.result = result.output.slice(0, 200);
          await commitAll(`db-coder: ${subtask.description.slice(0, 50)}`, projectPath).catch(() => {});
        } else {
          subtask.status = 'failed';
          subtask.result = result.output.slice(0, 200);
          log.warn(`Subtask failed: ${subtask.description}`);
          // Attempt retry with stuckHandling
          const handled = await this.handleStuck(task, subtask, result.output);
          if (!handled) break;
        }

        await this.taskStore.updateTask(task.id, { subtasks });
      }

      // REVIEW (dual review)
      this.state = 'reviewing';
      await this.taskStore.updateTask(task.id, { phase: 'reviewing' });

      const changedFiles = await getChangedFilesSince(startCommit, projectPath).catch(() => []);
      const reviewResult = await this.dualReview(task, changedFiles);

      await this.taskStore.updateTask(task.id, {
        review_results: [...(task.review_results as unknown[] || []), reviewResult],
        iteration: task.iteration + 1,
      });

      if (!reviewResult.passed && task.iteration < this.config.values.autonomy.maxRetries) {
        // Fix review issues and re-review
        log.info('Review found issues. Attempting fixes...');
        const issuesToFix = dedupeIssues([...reviewResult.mustFix, ...reviewResult.shouldFix]);
        const issueLines = issuesToFix.length > 0
          ? issuesToFix.map(i => `- [${i.severity}] ${i.description}${i.file ? ` (${i.file}${i.line ? `:${i.line}` : ''})` : ''}${i.suggestion ? `: ${i.suggestion}` : ''}`).join('\n')
          : `- No structured issues were returned.\n- Review summary: ${reviewResult.summary}`;
        const fixPrompt = `Fix these review issues:\n${issueLines}`;
        const fixAgent = this.codex;
        await fixAgent.execute(fixPrompt, projectPath, {});
        await commitAll('db-coder: fix review issues', projectPath).catch(() => {});
        // Re-execute task for next iteration
        await this.taskStore.updateTask(task.id, { status: 'queued', phase: 'init' });
      } else {
        // REFLECT
        this.state = 'reflecting';
        await this.taskStore.updateTask(task.id, { phase: 'reflecting' });

        const allResults = subtasks.map(st => `${st.description}: ${st.status} ${st.result ?? ''}`).join('\n');
        await this.brain.reflect(projectPath, task.task_description, allResults, reviewResult.summary);

        // Mark done
        const finalStatus = reviewResult.passed ? 'done' : (task.iteration >= this.config.values.autonomy.maxRetries ? 'blocked' : 'done');
        await this.taskStore.updateTask(task.id, {
          status: finalStatus as Task['status'],
          phase: finalStatus === 'blocked' ? 'blocked' : 'done',
        });

        log.info(`Task ${reviewResult.passed ? 'completed' : 'blocked'}: ${task.task_description.slice(0, 60)}`);
      }
    } catch (err) {
      log.error(`Task execution error: ${err}`);
      await this.taskStore.updateTask(task.id, { status: 'failed', phase: 'failed' });
    } finally {
      // Return to original branch
      await switchBranch(originalBranch, projectPath).catch(() => {});
      this.currentTaskId = null;
    }
  }

  /** Dual review: Claude + Codex in parallel, merge results */
  private async dualReview(task: Task, changedFiles: string[]): Promise<MergedReviewResult> {
    const filesStr = changedFiles.join('\n');
    const reviewMcpNames = this.claude.getMcpServerNames('review');
    const reviewPromptText = reviewerPrompt(task.task_description, filesStr, reviewMcpNames);

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

    // Merge: intersection = must fix, single = should fix
    return mergeReviews(claudeReview, codexReview);
  }

  /** Graduated stuck handling: retry → reflect → skip */
  private async handleStuck(task: Task, subtask: SubTaskRecord, error: string): Promise<boolean> {
    const iteration = task.iteration + 1;

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
      );
      if (reflection.adjustments.length > 0) {
        log.info(`Brain suggests: ${reflection.adjustments.join(', ')}`);
      }
      return true; // Will retry with new insights
    }

    // 3rd failure: skip
    log.warn(`Stuck: skipping subtask "${subtask.description}" after ${iteration} attempts`);
    await this.taskStore.updateTask(task.id, { status: 'blocked', phase: 'blocked' });
    return false;
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
