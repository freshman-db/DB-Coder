import type { Config } from '../config/Config.js';
import type { TaskQueue } from './TaskQueue.js';
import type { CodexBridge } from '../bridges/CodexBridge.js';
import type { TaskStore } from '../memory/TaskStore.js';
import type { CostTracker } from '../utils/cost.js';
import { ClaudeCodeSession, type SessionResult } from '../bridges/ClaudeCodeSession.js';
import type { Task, SubTaskRecord } from '../memory/types.js';
import type { MergedReviewResult, LoopState, StatusSnapshot } from './types.js';
import type { ReviewResult, ReviewIssue } from '../bridges/CodingAgent.js';
import { createBranch, switchBranch, commitAll, getHeadCommit, getCurrentBranch, branchExists, getChangedFilesSince, getModifiedAndAddedFiles, mergeBranch, deleteBranch, listBranches, forceDeleteBranch, getDiffStats, getDiffSince } from '../utils/git.js';
import { log } from '../utils/logger.js';
import { truncate, extractJsonFromText, isRecord } from '../utils/parse.js';
import { wordJaccard } from '../utils/similarity.js';
import { SUMMARY_PREVIEW_LEN, TASK_DESC_MAX_LENGTH } from '../types/constants.js';
import { readFileSync, existsSync, writeFileSync, mkdirSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { safeBuild } from '../utils/safeBuild.js';
import { CycleEventBus } from './CycleEventBus.js';
import type { CycleEvent, CyclePhase, CycleTiming } from './CycleEvents.js';
import { PersonaLoader } from './PersonaLoader.js';

const PAUSE_INTERVAL_MS = 5000;
const ERROR_RECOVERY_MS = 30_000;
const BRANCH_ID_LENGTH = 8;

type RunProcessFn = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: Record<string, string>; timeout?: number; input?: string },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

type CountTscErrorsDeps = {
  existsSync: (path: string) => boolean;
  runProcess: RunProcessFn;
};

const defaultCountTscErrorsDeps: CountTscErrorsDeps = {
  existsSync,
  runProcess: async (command, args, options) => {
    const { runProcess } = await import('../utils/process.js');
    return runProcess(command, args, options);
  },
};

let countTscErrorsDeps: CountTscErrorsDeps = defaultCountTscErrorsDeps;

export function setCountTscErrorsDepsForTests(overrides?: Partial<CountTscErrorsDeps>): void {
  countTscErrorsDeps = overrides
    ? { ...defaultCountTscErrorsDeps, ...overrides }
    : defaultCountTscErrorsDeps;
}

type StatusListener = (status: StatusSnapshot) => void;

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
  private tasksCompleted = 0;
  private brainSession = new ClaudeCodeSession();
  private workerSession = new ClaudeCodeSession();
  private discoveredModules: string[] = [];
  private moduleIndex = 0;
  private personaLoader: PersonaLoader;

  constructor(
    private config: Config,
    private taskQueue: TaskQueue,
    private codex: CodexBridge,
    private taskStore: TaskStore,
    private costTracker: CostTracker,
    private eventBus: CycleEventBus = CycleEventBus.noop(),
  ) {
    const hash = createHash('md5').update(config.projectPath).digest('hex').slice(0, BRANCH_ID_LENGTH);
    const lockDir = join(homedir(), '.db-coder');
    this.lockFile = join(lockDir, `${hash}.lock`);
    this.personaLoader = new PersonaLoader(taskStore, join(config.projectPath, 'personas'));
  }

  private makeEvent(phase: CyclePhase, timing: CycleTiming, data: Record<string, unknown> = {}): CycleEvent {
    return { phase, timing, taskId: this.currentTaskId ?? undefined, data, timestamp: Date.now() };
  }

  // --- Public interface (backward compatible) ---

  getState(): LoopState { return this.state; }
  getCurrentTaskId(): string | null { return this.currentTaskId; }
  isPaused(): boolean { return this.paused; }
  isRunning(): boolean { return this.running; }

  onRestart(listener: () => void): () => void {
    this.restartListeners.add(listener);
    return () => { this.restartListeners.delete(listener); };
  }

  addStatusListener(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  }

  pause(): void { this.setPaused(true); log.info('Loop paused'); }
  resume(): void { this.setPaused(false); log.info('Loop resumed'); }

  // Legacy setters — kept for backward compatibility, no-ops in v2
  setEvolutionEngine(_engine: unknown): void { /* no-op in v2 */ }
  setPluginMonitor(_monitor: unknown): void { /* no-op in v2 */ }
  setPromptRegistry(_registry: unknown): void { /* no-op in v2 */ }

  /** Run a manual scan via brain session (not allowed while patrol is running) */
  async triggerScan(depth: 'quick' | 'normal' | 'deep' = 'normal'): Promise<void> {
    if (this.running) throw new Error('Cannot trigger manual scan while patrol loop is running');
    this.setState('scanning');
    try {
      const result = await this.brainThink(`Scan this project at "${depth}" depth. Identify issues and opportunities but do NOT create tasks. Just report what you find.`);
      if (result.costUsd > 0) await this.taskStore.addDailyCost(result.costUsd);
    } finally {
      this.setState('idle');
    }
  }

  /** Manually trigger module identification — delegates to brain */
  async triggerIdentifyModules(): Promise<void> {
    if (this.running) throw new Error('Cannot identify modules while patrol loop is running');
    this.setState('scanning');
    try {
      const result = await this.brainThink('Identify the functional modules/chains in this project. Update CLAUDE.md with the chain definitions.');
      if (result.costUsd > 0) await this.taskStore.addDailyCost(result.costUsd);
    } finally {
      this.setState('idle');
    }
  }

  /** Manually trigger a single module scan */
  async triggerModuleScan(moduleName: string, _depth: 'quick' | 'normal' = 'normal'): Promise<void> {
    if (this.running) throw new Error('Cannot trigger module scan while patrol loop is running');
    this.setState('scanning');
    try {
      const result = await this.brainThink(`Deep scan the "${moduleName}" functional chain. Trace data flow from entry point, check edge cases, error handling, and data transformations.`);
      if (result.costUsd > 0) await this.taskStore.addDailyCost(result.costUsd);
    } finally {
      this.setState('idle');
    }
  }

  // --- Lifecycle ---

  async start(): Promise<void> {
    if (this.running) return;
    if (this.stoppedPromise) await this.waitForStopped();
    if (!this.acquireLock()) {
      log.error('Another instance is running. Lock file: ' + this.lockFile);
      return;
    }

    this.setRunning(true);
    this.stoppedPromise = new Promise<void>(resolve => { this.stoppedResolve = resolve; });
    log.info('Main loop started');

    // Recover zombie tasks from previous crash
    try {
      const recovered = await this.taskStore.recoverActiveTasks(this.config.projectPath);
      if (recovered > 0) log.warn(`Recovered ${recovered} active task(s) back to queued`);
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
          this.setState('paused');
          await sleep(PAUSE_INTERVAL_MS);
          continue;
        }

        let wasProductive = false;
        try {
          wasProductive = await this.runCycle();
        } catch (err) {
          log.error('Cycle error', err);
          this.setState('error');
          await sleep(ERROR_RECOVERY_MS);
        }

        if (this.restartPending) {
          log.info('Restart pending after self-build, exiting loop');
          break;
        }

        // Productive cycle → short pause then continue; idle → scanInterval
        await sleep(wasProductive ? 10_000 : this.config.values.brain.scanInterval * 1000);
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
    this.brainSession.kill();
    this.workerSession.kill();
  }

  async waitForStopped(timeoutMs = 120_000): Promise<void> {
    if (!this.stoppedPromise) return;
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('Timeout waiting for MainLoop to stop')), timeoutMs),
    );
    await Promise.race([this.stoppedPromise, timeout]).catch(err => { log.warn(`${err}`); });
  }

  // --- Core cycle: Brain → Worker → Verify → Review → Reflect ---

  async runCycle(): Promise<boolean> {
    const projectPath = this.config.projectPath;

    // 0. Drain queued tasks first — skip brain entirely if work is waiting
    this.setState('scanning');
    const queued = await this.taskQueue.getNext(projectPath);
    let task: Task;
    let brainOpts: { persona?: string; taskType?: string; subtasks?: Array<{ description: string; order: number }> } | undefined;

    if (queued) {
      task = queued;
      await this.taskStore.updateTask(task.id, { status: 'active', phase: 'executing' });
      this.setCurrentTaskId(task.id);
      log.info(`Queue pickup: ${truncate(task.task_description, TASK_DESC_MAX_LENGTH)}`);
      this.eventBus.emit(this.makeEvent('decide', 'after', { taskDescription: task.task_description }));
    } else {
      // 1. Brain decides what to do
      this.eventBus.emit(this.makeEvent('decide', 'before'));
      let decision = await this.brainDecide(projectPath);
      if (decision.costUsd > 0) await this.taskStore.addDailyCost(decision.costUsd);

      // Layer 2: directive fallback if brain returned null
      if (!decision.taskDescription) {
        log.warn('Brain returned no task — retrying with directive prompt');
        const directive = await this.brainDecideDirective(projectPath);
        if (directive.costUsd > 0) await this.taskStore.addDailyCost(directive.costUsd);
        if (directive.taskDescription) {
          decision = directive;
        }
      }

      // Layer 3: if still null, short sleep will retry (handled by start())
      if (!decision.taskDescription) {
        log.warn('Brain: no task after directive retry. Short sleep then retry.');
        this.setState('idle');
        return false;
      }

      // Dedup check: avoid creating duplicate or recently-failed tasks
      const similar = await this.taskStore.findSimilarTask(projectPath, decision.taskDescription);
      if (similar && (similar.status === 'queued' || similar.status === 'active' || similar.status === 'done')) {
        log.info(`Dedup: skipping task similar to [${similar.status}] "${truncate(similar.task_description, 80)}"`);
        this.setState('idle');
        return false;
      }
      if (await this.taskStore.hasRecentlyFailedSimilar(projectPath, decision.taskDescription)) {
        log.info(`Cooldown: skipping task similar to recently failed one: "${truncate(decision.taskDescription, 80)}"`);
        this.setState('idle');
        return false;
      }

      this.eventBus.emit(this.makeEvent('decide', 'after', { taskDescription: decision.taskDescription }));

      // 2. Create task record
      this.setState('planning');
      task = await this.taskStore.createTask(projectPath, decision.taskDescription, decision.priority ?? 2);
      this.setCurrentTaskId(task.id);
      log.info(`Task: ${truncate(decision.taskDescription, TASK_DESC_MAX_LENGTH)}`);
      this.eventBus.emit(this.makeEvent('create-task', 'after', { taskId: task.id, taskDescription: decision.taskDescription }));

      // Store subtasks metadata from brain decision
      if (decision.subtasks && decision.subtasks.length > 0) {
        await this.taskStore.updateTask(task.id, {
          subtasks: decision.subtasks.map((st, i) => ({
            id: String(i + 1),
            description: st.description,
            executor: 'claude' as const,
            status: 'pending' as const,
          })),
        });
      }

      brainOpts = { persona: decision.persona, taskType: decision.taskType, subtasks: decision.subtasks };
    }

    // 3. Budget check
    if (await this.checkBudgetOrAbort(task.id)) {
      this.setCurrentTaskId(null);
      this.setState('idle');
      return false;
    }

    const branchName = `${this.config.values.git.branchPrefix}${task.id.slice(0, BRANCH_ID_LENGTH)}`;
    let originalBranch = 'main';

    try {
      // 4. Prepare git branch
      originalBranch = await getCurrentBranch(projectPath).catch(() => 'main');
      const startCommit = await getHeadCommit(projectPath).catch(() => '');
      const baselineErrors = await countTscErrors(projectPath);

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

      // 5. Execute (subtask loop or single shot)
      this.setState('executing');
      const guardErrors = await this.eventBus.emitAndWait(this.makeEvent('execute', 'before', { taskDescription: task.task_description }));
      if (guardErrors.length > 0) {
        log.warn(`Guard blocked execution: ${guardErrors[0].message}`);
        await this.taskStore.updateTask(task.id, { status: 'blocked', phase: 'blocked' });
        await switchBranch(originalBranch, projectPath).catch(() => {});
        await this.cleanupTaskBranch(branchName);
        this.setCurrentTaskId(null);
        this.setState('idle');
        return false;
      }

      let workerPassed: boolean;
      const verification: { passed: boolean; reason?: string } = { passed: true };

      if (brainOpts?.subtasks && brainOpts.subtasks.length > 0) {
        // Subtask execution loop
        const result = await this.executeSubtasks(task, brainOpts.subtasks, {
          persona: brainOpts.persona,
          taskType: brainOpts.taskType,
          baselineErrors,
          startCommit,
        });
        workerPassed = result.success;
        verification.passed = result.success;
        if (!result.success) verification.reason = 'Subtask verification failed';
        this.eventBus.emit(this.makeEvent('execute', 'after', { startCommit, result: { costUsd: 0, durationMs: 0 } }));
      } else {
        // Single-shot execution (existing flow)
        const workerResult = await this.workerExecute(task, brainOpts);
        if (workerResult.costUsd > 0) await this.costTracker.addCost(task.id, workerResult.costUsd);

        await this.taskStore.addLog({
          task_id: task.id,
          phase: 'execute',
          agent: 'claude-code',
          input_summary: truncate(task.task_description, SUMMARY_PREVIEW_LEN),
          output_summary: workerResult.text.slice(0, SUMMARY_PREVIEW_LEN),
          cost_usd: workerResult.costUsd,
          duration_ms: workerResult.durationMs,
        });
        this.eventBus.emit(this.makeEvent('execute', 'after', { startCommit, result: { costUsd: workerResult.costUsd, durationMs: workerResult.durationMs } }));

        // Hard verification
        this.setState('reviewing');
        const verifyStart = Date.now();
        const singleVerify = await this.hardVerify(baselineErrors, startCommit, projectPath);
        await this.taskStore.addLog({
          task_id: task.id,
          phase: 'verify',
          agent: 'tsc',
          input_summary: `baseline=${baselineErrors}, startCommit=${startCommit}`,
          output_summary: singleVerify.passed ? 'PASS' : `FAIL: ${singleVerify.reason}`,
          cost_usd: 0,
          duration_ms: Date.now() - verifyStart,
        });
        this.eventBus.emit(this.makeEvent('verify', 'after', { verification: singleVerify, startCommit }));

        // HALT retry loop: fix up to maxRetries times
        const maxRetries = this.config.values.autonomy.maxRetries;
        let fixAttempts = 0;
        let currentSessionId = workerResult.sessionId;

        while (!singleVerify.passed && currentSessionId && fixAttempts < maxRetries) {
          fixAttempts++;
          log.warn(`Hard verification failed (attempt ${fixAttempts}/${maxRetries}): ${singleVerify.reason}`);
          const fixResult = await this.workerFix(currentSessionId, singleVerify.reason ?? 'Unknown error', task);
          if (fixResult.costUsd > 0) await this.costTracker.addCost(task.id, fixResult.costUsd);
          currentSessionId = fixResult.sessionId ?? currentSessionId;

          const changedFilesForCommit = await getModifiedAndAddedFiles(projectPath).catch(() => []);
          await commitAll('db-coder: fix verification issues', projectPath, changedFilesForCommit).catch(() => {});
          const reVerify = await this.hardVerify(baselineErrors, startCommit, projectPath);
          singleVerify.passed = reVerify.passed;
          singleVerify.reason = reVerify.reason;
          this.eventBus.emit(this.makeEvent('fix', 'after', { verification: singleVerify }));
        }

        if (!singleVerify.passed && fixAttempts >= maxRetries) {
          log.warn(`HALT after ${fixAttempts} fix attempts: ${singleVerify.reason}`);
          if (brainOpts?.persona) {
            await this.taskStore.addLog({
              task_id: task.id, phase: 'halt-learning', agent: 'system',
              input_summary: `persona=${brainOpts.persona}`,
              output_summary: `HALT triggered: ${singleVerify.reason} (after ${fixAttempts} attempts)`,
              cost_usd: 0, duration_ms: 0,
            });
          }
        }

        workerPassed = singleVerify.passed;
        verification.passed = singleVerify.passed;
        verification.reason = singleVerify.reason;
      }

      // 7.5 Spec compliance review (Stage 1)
      let specReviewPassed = true;
      if (workerPassed) {
        this.setState('reviewing');
        const spec = await this.specReview(task, startCommit, projectPath);
        specReviewPassed = spec.passed;
        if (!specReviewPassed) {
          log.info(`Spec review: FAIL — missing: ${spec.missing.join(', ')}, extra: ${spec.extra.join(', ')}`);
        } else {
          log.info(`Spec review: PASS${spec.concerns.length > 0 ? ` (concerns: ${spec.concerns.join(', ')})` : ''}`);
        }
      }

      // 8. Codex review (only if worker + spec passed)
      let codexReviewPassed = true;
      if (workerPassed && specReviewPassed) {
        const changedFiles = await getChangedFilesSince(startCommit, projectPath).catch(() => []);
        if (changedFiles.length > 0) {
          const reviewStart = Date.now();
          const codexReview = await this.codex.review(
            `You are an adversarial code reviewer. Presume issues exist — find them.

## Changed Files
${changedFiles.join('\n')}

## Review Focus Areas

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
- Find 3-10 specific issues with file names and descriptions.
- If fewer than 3 issues found, explain why the code quality is exceptional.
- Be concrete — cite specific code patterns, not vague concerns.`,
            projectPath,
          );
          if (codexReview.cost_usd > 0) await this.costTracker.addCost(task.id, codexReview.cost_usd);
          codexReviewPassed = codexReview.passed;

          // Store review results and log for traceability
          const reviewIssues = codexReview.issues ?? [];
          await this.taskStore.updateTask(task.id, { review_results: reviewIssues });
          if (!codexReview.passed) {
            log.info(`Codex review: FAIL — ${codexReview.summary}`, { issues: reviewIssues.length, summary: codexReview.summary });
          } else {
            log.info(`Codex review: PASS — ${codexReview.summary}`);
          }
          // Warn on suspicious parse failure (no issues but failed = likely parse error)
          if (!codexReview.passed && reviewIssues.length === 0) {
            log.warn('Codex review returned passed=false with zero issues — likely output parse failure, treating as PASS');
            codexReviewPassed = true;
          }

          await this.taskStore.addLog({
            task_id: task.id,
            phase: 'review',
            agent: 'codex',
            input_summary: `files: ${changedFiles.join(', ').slice(0, SUMMARY_PREVIEW_LEN)}`,
            output_summary: `${codexReviewPassed ? 'PASS' : 'FAIL'}: ${codexReview.summary ?? ''}`.slice(0, SUMMARY_PREVIEW_LEN),
            cost_usd: codexReview.cost_usd,
            duration_ms: Date.now() - reviewStart,
          });
        }
      }

      // 9. Decide: merge or discard
      const shouldMerge = workerPassed && specReviewPassed && codexReviewPassed;
      this.eventBus.emit(this.makeEvent('review', 'after', { passed: codexReviewPassed }));

      // 10. Brain reflects and learns
      this.setState('reflecting');
      const outcome = shouldMerge ? 'success' : 'failed';
      await this.brainReflect(task, outcome, verification, projectPath, brainOpts?.persona);
      this.eventBus.emit(this.makeEvent('reflect', 'after'));

      // 11. Merge or cleanup
      if (shouldMerge) {
        await switchBranch(originalBranch, projectPath);
        await mergeBranch(branchName, projectPath);
        await deleteBranch(branchName, projectPath);
        log.info(`Task completed and merged: ${truncate(task.task_description, TASK_DESC_MAX_LENGTH)}`);
        await this.taskStore.updateTask(task.id, { status: 'done', phase: 'done' });
        this.eventBus.emit(this.makeEvent('merge', 'after', { merged: true, taskDescription: task.task_description }));

        // Self-modification: rebuild after merging own code changes
        if (this.isSelfProject()) {
          const buildResult = await safeBuild(projectPath);
          if (buildResult.success) {
            this.restartPending = true;
            log.info('Self-build succeeded, restart pending');
          } else {
            this.writeBuildError(buildResult.error);
          }
        }
      } else {
        await switchBranch(originalBranch, projectPath).catch(() => {});
        await this.cleanupTaskBranch(branchName);
        log.warn(`Task rejected: ${truncate(task.task_description, TASK_DESC_MAX_LENGTH)}`);
        await this.taskStore.updateTask(task.id, { status: 'blocked', phase: 'blocked' });
        this.eventBus.emit(this.makeEvent('merge', 'after', { merged: false }));
      }

      // 12. Periodic deep chain review
      this.tasksCompleted++;
      if (this.tasksCompleted % 5 === 0) {
        try { await this.deepChainReview(projectPath); }
        catch (err) { log.warn('Deep chain review failed', err); }
      }

      // 13. Periodic CLAUDE.md maintenance
      const { claudeMdMaintenanceEnabled: maintEnabled, claudeMdMaintenanceInterval: maintInterval } = this.config.values.brain;
      if (maintEnabled && maintInterval > 0 && this.tasksCompleted % maintInterval === 0) {
        try { await this.claudeMdMaintenance(projectPath); }
        catch (err) { log.warn('CLAUDE.md maintenance failed', err); }
      }
    } catch (err) {
      log.error('Task execution error', err);
      this.eventBus.emit(this.makeEvent('execute', 'error', { error: String(err) }));
      await this.taskStore.updateTask(task.id, { status: 'failed', phase: 'failed' });
      await switchBranch(originalBranch, projectPath).catch(() => {});
      await this.cleanupTaskBranch(branchName);
    } finally {
      await switchBranch(originalBranch, projectPath).catch(() => {});
      this.setCurrentTaskId(null);
    }

    this.setState('idle');
    return true;
  }

  // --- Brain session ---

  private async brainDecide(projectPath: string): Promise<{
    taskDescription: string | null;
    priority?: number;
    persona?: string;
    taskType?: string;
    subtasks?: Array<{ description: string; order: number }>;
    costUsd: number;
  }> {
    // Budget gate: if daily budget exhausted, don't spend on brain call
    const dailyCost = await this.taskStore.getDailyCost();
    const maxPerDay = this.config.values.budget.maxPerDay;
    if (dailyCost.total_cost_usd >= maxPerDay) {
      log.info(`Daily budget exhausted ($${dailyCost.total_cost_usd.toFixed(2)}/$${maxPerDay}). Skipping brain call.`);
      return { taskDescription: null, costUsd: 0 };
    }

    const context = await this.gatherBrainContext(projectPath);

    const prompt = `You are the brain of an autonomous coding agent in EVOLUTION MODE.
Your job is to continuously improve the project — you are NOT a passive monitor.
You MUST find an improvement task every cycle. "Nothing to do" is NOT acceptable.

Read CLAUDE.md for project context, current status, and priorities.
Use claude-mem to search for relevant past experiences.

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

## RULES:
- You MUST output exactly ONE task. Never say "nothing to do" or "project is healthy".
- Avoid duplicating recent tasks (see list above).
- If budget is low, pick small focused tasks (type safety, single function fix).
- Be specific: name the file, function, or module to change. Vague tasks waste worker time.

Respond with EXACTLY this JSON (no markdown, no extra text):
{"task": "specific description", "priority": 0-3, "persona": "persona-name", "taskType": "feature|bugfix|refactoring|test|security|performance|frontend|code-quality|docs", "subtasks": [{"description": "subtask 1", "order": 1}], "reasoning": "why"}

Rules for persona/taskType:
- persona: choose from available personas (feature-builder, refactoring-expert, bugfix-debugger, test-engineer, security-auditor, performance-optimizer, frontend-specialist)
- taskType: categorize the task (feature, bugfix, refactoring, test, security, performance, frontend, code-quality, docs)
- subtasks: ONLY for complex tasks that need 2+ independent steps. Most tasks should NOT have subtasks. Each subtask must be independently completable and verifiable.`;

    const result = await this.brainThink(prompt);
    log.info(`Brain decide raw: cost=$${result.costUsd.toFixed(4)}, exit=${result.exitCode}, isError=${result.isError}, turns=${result.numTurns}, text="${truncate(result.text, 200)}"`);
    if (result.isError || result.exitCode !== 0) {
      log.warn(`Brain session errors: ${result.errors.join('; ')}`);
    }
    const parsed = extractJsonFromText(
      result.text,
      (v) => isRecord(v) && typeof (v as Record<string, unknown>).task === 'string',
    );
    if (isRecord(parsed) && typeof parsed.task === 'string') {
      return {
        taskDescription: parsed.task,
        priority: typeof parsed.priority === 'number' ? parsed.priority : 2,
        persona: typeof parsed.persona === 'string' ? parsed.persona : undefined,
        taskType: typeof parsed.taskType === 'string' ? parsed.taskType : undefined,
        subtasks: Array.isArray(parsed.subtasks) ? parsed.subtasks : undefined,
        costUsd: result.costUsd,
      };
    }
    // Fallback: no valid JSON found — use raw text if substantive
    const rawText = result.text.trim();
    if (rawText.length > 20) {
      log.warn('brainDecide: no valid JSON found in brain output, using raw text as task description');
      return { taskDescription: rawText.slice(0, 500), costUsd: result.costUsd };
    }
    return { taskDescription: null, costUsd: result.costUsd };
  }

  /** Gather rich context for brain decision-making */
  private async gatherBrainContext(projectPath: string): Promise<string> {
    const parts: string[] = [];

    // Queued tasks
    const queuedTasks = await this.taskQueue.getQueued(projectPath);
    if (queuedTasks.length > 0) {
      parts.push(`Queued tasks (${queuedTasks.length}):\n${queuedTasks.slice(0, 5).map(t => `- [P${t.priority}] ${t.task_description}`).join('\n')}`);
    }

    // Recent 15 tasks (expanded from 5 to avoid repeats)
    const recentResult = await this.taskStore.listTasksPaged(projectPath, 1, 15);
    const recentTasks = recentResult.tasks ?? [];
    if (recentTasks.length > 0) {
      parts.push(`Recent tasks (DO NOT duplicate these):\n${recentTasks.map((t: Task) => `- [${t.status}] ${t.task_description}`).join('\n')}`);
    }

    // Budget remaining
    const dailyCost = await this.taskStore.getDailyCost();
    const remaining = this.config.values.budget.maxPerDay - dailyCost.total_cost_usd;
    parts.push(`Budget: $${remaining.toFixed(2)} remaining today (${dailyCost.task_count} tasks completed). ${remaining < 30 ? 'LOW BUDGET — pick small tasks.' : ''}`);

    // Health metrics
    try {
      const metrics = await this.taskStore.getOperationalMetrics(projectPath);
      parts.push(`Health: passRate=${metrics.taskPassRate}%, dailyCost=$${metrics.dailyCostUsd.toFixed(2)}, queue=${metrics.queueDepth}`);
    } catch { /* metrics not critical */ }

    // Module rotation
    const currentModule = await this.getNextModule(projectPath);
    if (currentModule) {
      parts.push(`Current focus module: ${currentModule}/\nDeeply scan this module for improvement opportunities. Prioritize other areas only if there's something more urgent.`);
    }

    return parts.join('\n\n');
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

    const result = await this.brainThink(prompt);
    log.info(`Brain directive raw: cost=$${result.costUsd.toFixed(4)}, exit=${result.exitCode}, turns=${result.numTurns}, text="${truncate(result.text, 200)}"`);
    const parsed = extractJsonFromText(
      result.text,
      (v) => isRecord(v) && typeof (v as Record<string, unknown>).task === 'string',
    );
    if (isRecord(parsed) && typeof parsed.task === 'string') {
      return {
        taskDescription: parsed.task,
        priority: typeof parsed.priority === 'number' ? parsed.priority : 2,
        costUsd: result.costUsd,
      };
    }
    const rawText = result.text.trim();
    if (rawText.length > 20) {
      log.warn('brainDecideDirective: no valid JSON found in brain output, using raw text');
      return { taskDescription: rawText.slice(0, 500), costUsd: result.costUsd };
    }
    return { taskDescription: null, costUsd: result.costUsd };
  }

  /** Discover project modules by scanning src/ or root directory */
  private discoverModules(projectPath: string): string[] {
    const srcDir = join(projectPath, 'src');
    const baseDir = existsSync(srcDir) ? srcDir : projectPath;
    try {
      const entries = readdirSync(baseDir, { withFileTypes: true });
      return entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist')
        .map(e => existsSync(srcDir) ? `src/${e.name}` : e.name);
    } catch {
      return [];
    }
  }

  /** Get the next module in rotation */
  private async getNextModule(projectPath: string): Promise<string> {
    if (this.discoveredModules.length === 0) {
      this.discoveredModules = this.discoverModules(projectPath);
    }
    if (this.discoveredModules.length === 0) return '';
    const mod = this.discoveredModules[this.moduleIndex % this.discoveredModules.length];
    this.moduleIndex++;
    return mod;
  }

  private async brainThink(prompt: string): Promise<SessionResult> {
    return this.brainSession.run(prompt, {
      permissionMode: 'bypassPermissions',
      maxTurns: 20,
      cwd: this.config.projectPath,
      timeout: 300_000,
      model: this.config.values.brain.model === 'opus' ? 'claude-opus-4-6' : 'claude-sonnet-4-6',
      disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
      appendSystemPrompt: 'You are the brain of an autonomous coding agent. Read CLAUDE.md for context. Do not modify files — only analyze and decide.',
    });
  }

  // --- Worker session ---

  private async workerExecute(task: Task, opts?: {
    persona?: string;
    taskType?: string;
    subtaskDescription?: string;
  }): Promise<SessionResult> {
    const description = opts?.subtaskDescription ?? task.task_description;
    const { prompt, systemPrompt } = await this.personaLoader.buildWorkerPrompt({
      taskDescription: description,
      personaName: opts?.persona,
      taskType: opts?.taskType,
    });

    return this.workerSession.run(prompt, {
      permissionMode: 'bypassPermissions',
      maxTurns: 30,
      maxBudget: this.config.values.claude.maxTaskBudget,
      cwd: this.config.projectPath,
      timeout: this.config.values.autonomy.subtaskTimeout * 1000,
      model: this.config.values.claude.model === 'opus' ? 'claude-opus-4-6' : 'claude-sonnet-4-6',
      appendSystemPrompt: systemPrompt,
    });
  }

  private async executeSubtasks(
    task: Task,
    subtasks: Array<{ description: string; order: number }>,
    opts: { persona?: string; taskType?: string; baselineErrors: number; startCommit: string },
  ): Promise<{ success: boolean; sessionId?: string }> {
    const sorted = [...subtasks].sort((a, b) => a.order - b.order);

    for (let i = 0; i < sorted.length; i++) {
      const st = sorted[i];
      log.info(`Subtask ${i + 1}/${sorted.length}: ${truncate(st.description, 100)}`);

      // Update subtask status to running
      const currentSubtasks = (task.subtasks ?? []).map((s, idx) =>
        idx === i ? { ...s, status: 'running' as const } : s,
      );
      await this.taskStore.updateTask(task.id, { subtasks: currentSubtasks });

      // Execute in fresh worker session
      const result = await this.workerExecute(task, {
        persona: opts.persona,
        taskType: opts.taskType,
        subtaskDescription: st.description,
      });

      if (result.costUsd > 0) await this.costTracker.addCost(task.id, result.costUsd);

      await this.taskStore.addLog({
        task_id: task.id,
        phase: 'execute',
        agent: 'claude-code',
        input_summary: `subtask ${i + 1}/${sorted.length}: ${truncate(st.description, 80)}`,
        output_summary: result.text.slice(0, SUMMARY_PREVIEW_LEN),
        cost_usd: result.costUsd,
        duration_ms: result.durationMs,
      });

      // Per-subtask hard verify with HALT retry loop
      const verification = await this.hardVerify(opts.baselineErrors, opts.startCommit, this.config.projectPath);
      if (!verification.passed) {
        const maxRetries = this.config.values.autonomy.maxRetries;
        let fixAttempts = 0;
        let currentSessionId = result.sessionId;
        let lastVerification = verification;

        while (!lastVerification.passed && currentSessionId && fixAttempts < maxRetries) {
          fixAttempts++;
          log.warn(`Subtask ${i + 1} verification failed (attempt ${fixAttempts}/${maxRetries}): ${lastVerification.reason}`);
          const fixResult = await this.workerFix(currentSessionId, lastVerification.reason ?? 'Unknown', task);
          if (fixResult.costUsd > 0) await this.costTracker.addCost(task.id, fixResult.costUsd);
          currentSessionId = fixResult.sessionId ?? currentSessionId;

          lastVerification = await this.hardVerify(opts.baselineErrors, opts.startCommit, this.config.projectPath);
        }

        if (!lastVerification.passed) {
          const haltMsg = currentSessionId
            ? `HALT after ${fixAttempts} fix attempts: ${lastVerification.reason}`
            : `Verification failed, no session to fix: ${lastVerification.reason}`;
          log.warn(`Subtask ${i + 1}: ${haltMsg}`);

          if (opts.persona) {
            await this.taskStore.addLog({
              task_id: task.id, phase: 'halt-learning', agent: 'system',
              input_summary: `persona=${opts.persona}, subtask=${i + 1}`,
              output_summary: `HALT triggered: ${lastVerification.reason} (after ${fixAttempts} attempts)`,
              cost_usd: 0, duration_ms: 0,
            });
          }

          const failedSubtasks = (task.subtasks ?? []).map((s, idx) =>
            idx === i ? { ...s, status: 'failed' as const, result: lastVerification.reason } : s,
          );
          await this.taskStore.updateTask(task.id, { subtasks: failedSubtasks });
          return { success: false };
        }
      }

      // Mark subtask done
      const doneSubtasks = (task.subtasks ?? []).map((s, idx) =>
        idx === i ? { ...s, status: 'done' as const } : s,
      );
      await this.taskStore.updateTask(task.id, { subtasks: doneSubtasks });
      // Re-read task for updated subtask state
      task = (await this.taskStore.getTask(task.id))!;
    }

    return { success: true };
  }

  private async workerFix(sessionId: string, errors: string, task: Task): Promise<SessionResult> {
    return this.workerSession.run(
      `The previous changes failed verification:\n${errors}\n\nFix these issues. The original task was: ${task.task_description}\n\nUse superpowers:systematic-debugging to investigate the root cause.\nFollow all 4 phases: investigate → analyze → hypothesize → implement.\nDo NOT guess or "try changing X". Find the actual root cause first.`,
      {
        permissionMode: 'bypassPermissions',
        maxTurns: 15,
        maxBudget: this.config.values.claude.maxTaskBudget / 2,
        cwd: this.config.projectPath,
        timeout: 120_000,
        resumeSessionId: sessionId,
        model: this.config.values.claude.model === 'opus' ? 'claude-opus-4-6' : 'claude-sonnet-4-6',
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
      return { passed: false, reason: 'TypeScript compilation crashed' };
    }
    if (baselineErrors >= 0 && currentErrors > baselineErrors) {
      return {
        passed: false,
        reason: `TypeScript errors increased: ${baselineErrors} → ${currentErrors} (+${currentErrors - baselineErrors})`,
      };
    }

    // 2. Diff anomaly check (warn only)
    try {
      const stats = await getDiffStats(startCommit, 'HEAD', projectPath);
      if (stats.files_changed > 15) {
        log.warn(`Post-check warning: ${stats.files_changed} files changed (${stats.insertions}+ ${stats.deletions}-)`);
      }
    } catch { /* non-critical */ }

    return { passed: true };
  }

  // --- Spec compliance review ---

  private async specReview(
    task: Task,
    startCommit: string,
    projectPath: string,
  ): Promise<{ passed: boolean; missing: string[]; extra: string[]; concerns: string[] }> {
    const diff = await getDiffSince(startCommit, projectPath).catch(() => '(diff unavailable)');
    const subtaskList = (task.subtasks ?? []).map(s => `- ${s.description}`).join('\n');

    const prompt = `You are an adversarial code reviewer. Presume issues exist — your job is to find them before you can pass.
DO NOT trust commit messages — only examine the actual diff.

## Original Task
${task.task_description}

${subtaskList ? `## Subtasks\n${subtaskList}\n` : ''}## Git Diff
\`\`\`diff
${diff.slice(0, 15000)}
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
      phase: 'review',
      agent: 'brain-spec',
      input_summary: 'Spec compliance review',
      output_summary: result.text.slice(0, SUMMARY_PREVIEW_LEN),
      cost_usd: result.costUsd,
      duration_ms: result.durationMs,
    });

    try {
      const parsed = JSON.parse(result.text);
      return {
        passed: parsed.passed === true,
        missing: Array.isArray(parsed.missing) ? parsed.missing : [],
        extra: Array.isArray(parsed.extra) ? parsed.extra : [],
        concerns: Array.isArray(parsed.concerns) ? parsed.concerns : [],
      };
    } catch {
      log.warn('Spec review returned unparseable JSON, treating as PASS');
      return { passed: true, missing: [], extra: [], concerns: [] };
    }
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
    const personaData = personaName ? await this.taskStore.getPersona(personaName) : null;
    const personaContext = personaData ? `
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
` : '';

    const prompt = `Reflect on this completed task:

Task: ${task.task_description}
Outcome: ${outcome}
Verification: ${verification.passed ? 'PASSED' : `FAILED — ${verification.reason}`}
${personaContext}
1. What went well? What could be improved?
2. If there are lessons learned, update CLAUDE.md "踩过的坑" section.
3. Use claude-mem to save important experiences for future reference.
4. If you notice patterns (recurring issues, good practices), add them to CLAUDE.md.
5. Use superpowers:requesting-code-review to review the code changes if the task was merged.
${personaData ? '6. If the persona needs updating based on this experience, include a PERSONA_UPDATE block.' : ''}

Keep CLAUDE.md concise — only add genuinely useful rules.`;

    const result = await this.brainSession.run(prompt, {
      permissionMode: 'bypassPermissions',
      maxTurns: 10,
      cwd: projectPath,
      timeout: 120_000,
      model: this.config.values.brain.model === 'opus' ? 'claude-opus-4-6' : 'claude-sonnet-4-6',
      appendSystemPrompt: 'You are reflecting on a task. You CAN edit CLAUDE.md and use claude-mem. Do not modify source code.',
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'],
    });

    if (result.costUsd > 0) await this.costTracker.addCost(task.id, result.costUsd);

    await this.taskStore.addLog({
      task_id: task.id,
      phase: 'reflect',
      agent: 'brain',
      input_summary: `Reflect on ${outcome}`,
      output_summary: result.text.slice(0, SUMMARY_PREVIEW_LEN),
      cost_usd: result.costUsd,
      duration_ms: result.durationMs,
    });

    // Parse and apply persona evolution
    if (personaName && personaData) {
      const updateMatch = result.text.match(/PERSONA_UPDATE:\s*\n([\s\S]*?)\nEND_PERSONA_UPDATE/);
      if (updateMatch) {
        const newContent = updateMatch[1].trim();
        if (newContent && newContent !== 'NO_CHANGE') {
          await this.taskStore.updatePersonaContent(personaName, newContent);
          log.info(`Persona ${personaName} evolved via brainReflect`);
          await this.taskStore.addLog({
            task_id: task.id, phase: 'persona-evolution', agent: 'brain',
            input_summary: `Persona ${personaName} updated`,
            output_summary: newContent.slice(0, SUMMARY_PREVIEW_LEN),
            cost_usd: 0, duration_ms: 0,
          });
        }
      }
    }

    // Update persona usage stats
    if (personaName) {
      await this.taskStore.updatePersonaStats(personaName, outcome === 'success').catch(err =>
        log.warn(`Failed to update persona stats for ${personaName}:`, err),
      );
    }
  }

  // --- Deep chain review (periodic) ---

  private async deepChainReview(projectPath: string): Promise<void> {
    log.info('Starting periodic deep chain review');
    const result = await this.brainSession.run(
      `Perform a deep review of the functional chains defined in CLAUDE.md.
For each chain, trace the data flow and check:
1. Error propagation — do errors bubble up or get silently swallowed?
2. Edge cases — first run, empty data, concurrent access
3. Data transformations — are conversions correct?
4. Cross-chain interactions — do chains interfere?

If you find issues, create tasks for them by reporting what needs fixing.
Update CLAUDE.md if you discover new patterns or pitfalls.`,
      {
        permissionMode: 'bypassPermissions',
        maxTurns: 50,
        cwd: projectPath,
        timeout: 3_600_000,
        model: this.config.values.brain.model === 'opus' ? 'claude-opus-4-6' : 'claude-sonnet-4-6',
        allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'],
        appendSystemPrompt: 'You are performing a deep code review. You CAN edit CLAUDE.md to add new patterns or pitfalls. Do not modify source code.',
      },
    );

    if (result.costUsd > 0) await this.taskStore.addDailyCost(result.costUsd);
    log.info(`Deep chain review completed (${Math.round(result.durationMs / 1000)}s, $${result.costUsd.toFixed(4)})`);
  }

  // --- Periodic CLAUDE.md maintenance ---

  private async claudeMdMaintenance(projectPath: string): Promise<void> {
    log.info('Starting periodic CLAUDE.md maintenance');
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
        permissionMode: 'bypassPermissions',
        maxTurns: 50,
        cwd: projectPath,
        timeout: 3_600_000,
        model: this.config.values.brain.model === 'opus' ? 'claude-opus-4-6' : 'claude-sonnet-4-6',
        allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'],
        appendSystemPrompt: 'You are maintaining CLAUDE.md. You CAN edit CLAUDE.md. Do not modify source code.',
      },
    );

    if (result.costUsd > 0) await this.taskStore.addDailyCost(result.costUsd);
    log.info(`CLAUDE.md maintenance completed (${Math.round(result.durationMs / 1000)}s, $${result.costUsd.toFixed(4)})`);
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

  private broadcastStatus(): void {
    if (this.statusListeners.size === 0) return;
    const snapshot: StatusSnapshot = {
      state: this.state,
      currentTaskId: this.currentTaskId,
      patrolling: this.running,
      paused: this.paused,
    };
    for (const listener of this.statusListeners) {
      try { listener(snapshot); } catch { /* ignore listener failures */ }
    }
  }

  // --- Helpers ---

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

  private writeBuildError(error: string): void {
    const dir = join(homedir(), '.db-coder');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'build-error.json'), JSON.stringify({
      timestamp: new Date().toISOString(), type: 'build', error,
    }, null, 2));
  }

  private acquireLock(): boolean {
    if (existsSync(this.lockFile)) {
      try {
        const pid = parseInt(readFileSync(this.lockFile, 'utf-8'), 10);
        if (pid === process.pid) { /* same process restart */ }
        else { try { process.kill(pid, 0); return false; } catch { /* stale lock */ } }
      } catch { /* invalid lock file */ }
    }
    const lockDir = join(homedir(), '.db-coder');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(this.lockFile, String(process.pid));
    return true;
  }

  private releaseLock(): void {
    try { unlinkSync(this.lockFile); } catch { /* ignore */ }
  }

  private async checkBudgetOrAbort(taskId: string): Promise<boolean> {
    const budget = await this.costTracker.checkBudget(taskId);
    if (budget.allowed) return false;
    log.warn(`Budget exceeded: ${budget.reason}`);
    await this.taskStore.updateTask(taskId, { status: 'blocked', phase: 'blocked' });
    return true;
  }

  private async cleanupOrphanedBranches(): Promise<void> {
    const projectPath = this.config.projectPath;
    const prefix = this.config.values.git.branchPrefix;
    const branches = await listBranches(prefix, projectPath);
    if (branches.length === 0) return;

    const [queued, active] = await Promise.all([
      this.taskStore.listTasks(projectPath, 'queued'),
      this.taskStore.listTasks(projectPath, 'active'),
    ]);
    const activeBranches = new Set([...queued, ...active].map(t => t.git_branch).filter(Boolean));

    let cleaned = 0;
    for (const branch of branches) {
      if (activeBranches.has(branch)) continue;
      await this.cleanupTaskBranch(branch);
      const stillExists = await branchExists(branch, projectPath).catch(() => true);
      if (!stillExists) cleaned++;
    }
    if (cleaned > 0) log.info(`Cleaned up ${cleaned} orphaned branch(es)`);
  }

  private async cleanupTaskBranch(branch: string): Promise<void> {
    try {
      await forceDeleteBranch(branch, this.config.projectPath);
    } catch (err) {
      log.warn(`Failed to cleanup branch ${branch}: ${err}`);
    }
  }
}

// --- Exported utilities (used by tests and routes) ---

export function mergeReviews(claude: ReviewResult, codex: ReviewResult): MergedReviewResult {
  const mustFix: ReviewIssue[] = [];
  const shouldFix: ReviewIssue[] = [];

  for (const ci of claude.issues) {
    const match = codex.issues.find(xi => {
      const fileMatch = !!(xi.file && ci.file && xi.file === ci.file);
      const descSim = wordJaccard(xi.description, ci.description);
      return fileMatch && descSim > 0.4;
    });
    if (match) {
      mustFix.push({ ...ci, severity: higherSeverity(ci.severity, match.severity) });
    } else {
      shouldFix.push(ci);
    }
  }

  for (const xi of codex.issues) {
    const alreadyMerged = mustFix.some(
      m => wordJaccard(m.description, xi.description) > 0.4 && ((m.file && xi.file) ? m.file === xi.file : true),
    );
    if (!alreadyMerged) shouldFix.push(xi);
  }

  const claudeRawFail = !claude.passed && claude.issues.length === 0;
  const codexRawFail = !codex.passed && codex.issues.length === 0;
  if (claudeRawFail) shouldFix.push({ description: 'Claude reviewer explicitly failed without structured issues', severity: 'medium', source: 'claude' });
  if (codexRawFail) shouldFix.push({ description: 'Codex reviewer explicitly failed without structured issues', severity: 'medium', source: 'codex' });

  const hasCriticalMustFix = mustFix.some(i => i.severity === 'critical' || i.severity === 'high');
  const hasRawFail = claudeRawFail || codexRawFail;
  const passed = !hasRawFail && (mustFix.length === 0 || !hasCriticalMustFix);

  return {
    passed,
    mustFix,
    shouldFix,
    summary: `Claude: ${claude.summary}\nCodex: ${codex.summary}\nMust fix: ${mustFix.length}, Should fix: ${shouldFix.length}`,
  };
}

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
      if (pattern.test(text)) { categories.add(cat); matched = true; }
    }
    if (!matched) categories.add(`severity-${issue.severity}`);
  }
  return [...categories];
}

export async function countTscErrors(cwd: string): Promise<number> {
  if (!countTscErrorsDeps.existsSync(join(cwd, 'tsconfig.json'))) return 0;
  try {
    const result = await countTscErrorsDeps.runProcess('npx', ['tsc', '--noEmit'], { cwd, timeout: 60_000 });
    return (result.stdout + result.stderr).split('\n').filter(l => l.includes(': error TS')).length;
  } catch (e) {
    log.warn('countTscErrors failed', { error: e instanceof Error ? e.message : String(e) });
    return -1;
  }
}

function higherSeverity(a: ReviewIssue['severity'], b: ReviewIssue['severity']): ReviewIssue['severity'] {
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  return order[a] <= order[b] ? a : b;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
