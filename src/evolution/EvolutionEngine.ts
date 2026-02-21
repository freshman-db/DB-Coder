import type { TaskStore } from '../memory/TaskStore.js';
import type { GlobalMemory } from '../memory/GlobalMemory.js';
import type { Config } from '../config/Config.js';
import type { TrendAnalyzer } from './TrendAnalyzer.js';
import type { AdjustmentCategory, DynamicPromptContext } from './types.js';
import type { ProjectAnalysis } from '../memory/types.js';
import { log } from '../utils/logger.js';

// Keywords for categorizing adjustments
const CATEGORY_KEYWORDS: Record<AdjustmentCategory, string[]> = {
  routing: ['route', 'executor', 'claude', 'codex', 'frontend', 'backend', 'assign'],
  strategy: ['approach', 'strategy', 'method', 'technique', 'alternative', 'instead'],
  avoidance: ['avoid', 'skip', 'don\'t', 'never', 'prevent', 'stop', 'careful'],
  standard: ['always', 'ensure', 'must', 'require', 'enforce', 'standard', 'convention'],
  process: ['step', 'before', 'after', 'first', 'then', 'workflow', 'process', 'order'],
  config: ['timeout', 'budget', 'interval', 'config', 'setting', 'parameter', 'limit'],
};

// Config fields safe for auto-update
const SAFE_CONFIG_FIELDS = new Set(['brain.scanInterval', 'autonomy.subtaskTimeout']);

export class EvolutionEngine {
  constructor(
    private taskStore: TaskStore,
    private globalMemory: GlobalMemory,
    private config: Config,
    private trendAnalyzer: TrendAnalyzer,
  ) {}

  /**
   * Process adjustments from a reflection, store them, and update effectiveness of existing ones.
   */
  async processAdjustments(
    projectPath: string,
    taskId: string | null,
    adjustments: string[],
    outcome: 'success' | 'failed' | 'blocked_stuck' | 'blocked_max_retries',
  ): Promise<void> {
    // 1. Store new adjustments
    for (const text of adjustments) {
      const category = this.categorize(text);
      await this.taskStore.saveAdjustment({ project_path: projectPath, task_id: taskId, text, category });
      log.info(`Stored adjustment [${category}]: ${text.slice(0, 80)}`);
    }

    // 2. Update effectiveness: task-level adjustments get larger delta, global gets smaller
    if (taskId) {
      const taskDelta = outcome === 'success' ? 0.15 : -0.1;
      await this.taskStore.updateTaskAdjustmentEffectiveness(taskId, taskDelta);
    }
    const globalDelta = outcome === 'success' ? 0.05 : -0.02;
    await this.taskStore.updateAdjustmentEffectiveness(projectPath, globalDelta);

    // 3. Supersede weak adjustments
    const superseded = await this.taskStore.supersedeWeakAdjustments(projectPath);
    if (superseded > 0) {
      log.info(`Superseded ${superseded} weak adjustments (effectiveness < -0.3)`);
    }
  }

  /**
   * Synthesize dynamic prompt context from memories, adjustments, trends, and goals.
   */
  async synthesizePromptContext(projectPath: string): Promise<DynamicPromptContext> {
    const maxAdj = this.config.values.evolution?.maxAdjustmentsPerPrompt ?? 5;
    const windowSize = this.config.values.evolution?.trendWindowSize ?? 10;

    // Learned patterns: high-confidence memories
    const highConfMemories = await this.globalMemory.search('coding patterns standards', 20);
    const learnedPatterns = highConfMemories
      .filter(m => m.confidence >= 0.7)
      .slice(0, 10)
      .map(m => `[${m.category}] ${m.title}: ${m.content}`);

    // Anti-patterns: failure memories + avoidance adjustments + recurring review issues
    const failureMemories = await this.globalMemory.getByCategory('failure', 10);
    const avoidanceAdj = (await this.taskStore.getActiveAdjustments(projectPath))
      .filter(a => a.category === 'avoidance');
    const recurringIssues = await this.analyzeRecurringIssues(projectPath).catch(() => [] as string[]);
    const antiPatterns = [
      ...failureMemories.map(m => m.content),
      ...avoidanceAdj.map(a => a.text),
      ...recurringIssues,
    ].slice(0, 15);

    // Trend context
    const trendContext = await this.trendAnalyzer.formatTrendSummary(projectPath, windowSize);

    // Active adjustments (top N by effectiveness)
    const allActive = await this.taskStore.getActiveAdjustments(projectPath, maxAdj);
    const activeAdjustments = allActive.map(a => `[${a.category}] ${a.text}`);

    // Goal context
    const goalContext = await this.buildGoalContext(projectPath);

    log.info(`synthesizePromptContext: ${learnedPatterns.length} patterns, ${antiPatterns.length} anti-patterns, ${activeAdjustments.length} adjustments`);

    return { learnedPatterns, antiPatterns, trendContext, activeAdjustments, goalContext };
  }

  /**
   * Assess progress toward evolution goals based on scan analysis.
   */
  async assessGoalProgress(
    projectPath: string,
    analysis: ProjectAnalysis,
    scanId: number | null,
  ): Promise<void> {
    const goals = this.config.values.evolution?.goals ?? [];

    for (let i = 0; i < goals.length; i++) {
      const goal = goals[i];
      if (goal.status === 'done' || goal.status === 'paused') continue;

      // Estimate progress from related completed tasks and health score
      const relatedTasks = await this.taskStore.listTasks(projectPath, 'done');
      const relevantCount = relatedTasks.filter(t =>
        t.task_description.toLowerCase().includes(goal.description.toLowerCase().split(' ')[0])
      ).length;

      // Simple heuristic: each relevant completed task adds ~15% progress, capped at 100
      const taskProgress = Math.min(100, relevantCount * 15);
      // Blend with health score if relevant
      const progressPct = Math.min(100, Math.round(taskProgress * 0.7 + (analysis.projectHealth / 100) * 30));

      const evidence = `${relevantCount} related tasks done, health=${analysis.projectHealth}`;
      await this.taskStore.saveGoalProgress({
        project_path: projectPath,
        goal_index: i,
        progress_pct: progressPct,
        evidence,
        scan_id: scanId,
      });

      // Check for completion: 3 consecutive scans at ≥90%
      const history = await this.taskStore.getGoalProgressHistory(projectPath, i, 3);
      if (history.length >= 3 && history.every(h => h.progress_pct >= 90)) {
        goal.status = 'done';
        goal.progress = 100;
        goal.completedAt = new Date().toISOString();
        log.info(`Goal completed: ${goal.description}`);
      } else {
        goal.progress = progressPct;
      }
    }
  }

  /**
   * Analyze review events to identify recurring issue patterns.
   * Returns human-readable descriptions of patterns that appear ≥3 times.
   */
  async analyzeRecurringIssues(projectPath: string): Promise<string[]> {
    const events = await this.taskStore.getRecurringIssueCategories(projectPath, 10);
    return events
      .filter(e => e.count >= 3)
      .map(e => `Recurring issue: "${e.category}" appeared ${e.count} times. Consider addressing root cause.`);
  }

  /**
   * Store a config change proposal.
   */
  async proposeConfigChange(
    projectPath: string,
    fieldPath: string,
    currentValue: unknown,
    proposedValue: unknown,
    reason: string,
    confidence: number,
  ): Promise<void> {
    await this.taskStore.saveConfigProposal({
      project_path: projectPath,
      field_path: fieldPath,
      current_value: currentValue,
      proposed_value: proposedValue,
      reason,
      confidence,
    });
    log.info(`Config proposal: ${fieldPath} ${JSON.stringify(currentValue)} → ${JSON.stringify(proposedValue)} (confidence=${confidence})`);
  }

  /**
   * Apply pending proposals if autoConfigUpdate is enabled. Only safe fields are auto-applied.
   */
  async applyPendingProposals(projectPath: string): Promise<number> {
    if (!this.config.values.evolution?.autoConfigUpdate) return 0;

    const proposals = await this.taskStore.getPendingProposals(projectPath);
    let applied = 0;

    for (const p of proposals) {
      if (!SAFE_CONFIG_FIELDS.has(p.field_path)) {
        log.info(`Skipping unsafe config proposal: ${p.field_path} (requires manual approval)`);
        continue;
      }
      if (p.confidence < 0.7) {
        log.info(`Skipping low-confidence proposal: ${p.field_path} (confidence=${p.confidence})`);
        continue;
      }

      // Apply via config (setNestedValue on config.values)
      try {
        setNestedValue(this.config.values, p.field_path, p.proposed_value);
        await this.taskStore.updateProposalStatus(p.id, 'applied');
        log.info(`Auto-applied config: ${p.field_path} = ${JSON.stringify(p.proposed_value)}`);
        applied++;
      } catch (err) {
        log.warn(`Failed to apply config proposal ${p.field_path}: ${err}`);
      }
    }

    return applied;
  }

  /**
   * Get a full evolution summary for API consumers.
   */
  async getSummary(projectPath: string) {
    const [adjustments, goals, proposals, healthTrend, areaTrends] = await Promise.all([
      this.taskStore.getActiveAdjustments(projectPath),
      this.taskStore.getLatestGoalProgress(projectPath),
      this.taskStore.getPendingProposals(projectPath),
      this.trendAnalyzer.getHealthTrend(projectPath),
      this.trendAnalyzer.computeAreaTrends(projectPath),
    ]);

    return {
      adjustments: { active: adjustments.length, items: adjustments },
      goals: goals.map(g => ({ goalIndex: g.goal_index, progress: g.progress_pct, evidence: g.evidence })),
      proposals: { pending: proposals.length, items: proposals },
      trends: { health: healthTrend, areas: areaTrends },
    };
  }

  private categorize(text: string): AdjustmentCategory {
    const lower = text.toLowerCase();
    let bestCategory: AdjustmentCategory = 'strategy';
    let bestScore = 0;

    for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
      const score = keywords.filter(kw => lower.includes(kw)).length;
      if (score > bestScore) {
        bestScore = score;
        bestCategory = cat as AdjustmentCategory;
      }
    }

    return bestCategory;
  }

  private async buildGoalContext(projectPath: string): Promise<string> {
    const goals = this.config.values.evolution?.goals ?? [];
    if (goals.length === 0) return '';

    const progress = await this.taskStore.getLatestGoalProgress(projectPath);
    const progressMap = new Map(progress.map(p => [p.goal_index, p]));

    const lines: string[] = ['Goal progress:'];
    for (let i = 0; i < goals.length; i++) {
      const g = goals[i];
      const p = progressMap.get(i);
      const pct = p ? `${Math.round(p.progress_pct)}%` : 'not assessed';
      const status = g.status === 'done' ? 'DONE' : g.status === 'paused' ? 'paused' : 'active';
      lines.push(`- [P${g.priority}] ${g.description}: ${pct} (${status})`);
    }

    return lines.join('\n');
  }
}

function setNestedValue(obj: Record<string, any>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current)) throw new Error(`Path not found: ${path}`);
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}
