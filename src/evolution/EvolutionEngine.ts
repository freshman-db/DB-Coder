import type { TaskStore } from '../memory/TaskStore.js';
import type { GlobalMemory } from '../memory/GlobalMemory.js';
import type { Config } from '../config/Config.js';
import type { TrendAnalyzer } from './TrendAnalyzer.js';
import type { AdjustmentCategory, DynamicPromptContext, HealthTrend, PromptMetrics, PromptName, PromptPatch, PromptVersion } from './types.js';
import type { ProjectAnalysis, RecurringIssueCategory, ReviewEvent, Task } from '../memory/types.js';
import type { ClaudeBridge } from '../bridges/ClaudeBridge.js';
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

interface GoalKeywordRule {
  goalIndicators: string[];
  taskKeywords: string[];
}

const GOAL_KEYWORD_RULES: GoalKeywordRule[] = [
  {
    goalIndicators: ['代码质量', '类型', '编码规范', 'quality', 'lint'],
    taskKeywords: ['type', '类型', 'lint', '编码'],
  },
  {
    goalIndicators: ['代码重复', '重复模式', 'dedup', 'duplicate', 'extract'],
    taskKeywords: ['extract', '重复', 'dedup', 'duplicat'],
  },
  {
    goalIndicators: ['简化', '嵌套', '复杂代码', 'simplify', 'refactor'],
    taskKeywords: ['simplify', '简化', '嵌套', 'refactor'],
  },
  {
    goalIndicators: ['测试覆盖', '测试', 'coverage', 'test'],
    taskKeywords: ['test', '测试', 'coverage'],
  },
  {
    goalIndicators: ['开发功能', '功能', 'feature'],
    taskKeywords: ['feature', '功能', 'add'],
  },
];

const GOAL_FALLBACK_KEYWORDS = Array.from(
  new Set(GOAL_KEYWORD_RULES.flatMap(rule => rule.taskKeywords.map(keyword => keyword.toLowerCase()))),
);

interface MetaReflectData {
  reviewEvents: ReviewEvent[];
  recentTasks: Task[];
  healthTrend: HealthTrend | null;
  activeVersions: PromptVersion[];
  passRate: number;
  avgCost: number;
  issueCategories: RecurringIssueCategory[];
}

interface ParsedMetaReflectOutput {
  patches: Array<{
    promptName: string;
    patches: PromptPatch[];
    rationale: string;
    confidence: number;
  }>;
  analysis: string;
}

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
      const relatedTasks = await this.taskStore.listTasks(projectPath, 'done') ?? [];
      const goalKeywords = this.extractGoalKeywords(goal.description ?? '');
      const relevantCount = relatedTasks.filter(t => {
        const taskDescription = t?.task_description?.toLowerCase() ?? '';
        return goalKeywords.some(keyword => taskDescription.includes(keyword));
      }).length;

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

  /**
   * Meta-reflect: analyze recent results and propose prompt patches.
   * Called every N completed tasks.
   */
  async metaReflect(projectPath: string, claude: ClaudeBridge): Promise<void> {
    log.info('Starting meta-reflect: analyzing prompt effectiveness...');
    try {
      const data = await this.collectMetaReflectData(projectPath);
      const metaPrompt = this.buildMetaReflectPrompt(data);
      const result = await claude.plan(metaPrompt, projectPath, { maxTurns: 5 });
      const resultCost = Number(result?.cost_usd ?? 0);
      if (resultCost > 0) {
        await this.taskStore.addDailyCost(resultCost);
      }

      const parsed = this.parseMetaReflectOutput(result?.output ?? '');
      if (!parsed) {
        log.info('Meta-reflect: no actionable patches proposed');
        return;
      }

      const maxActive = this.resolveMaxActivePromptPatches();
      await this.storeProposedPatches(parsed, projectPath, maxActive);
    } catch (err) {
      log.warn(`Meta-reflect failed: ${err}`);
    }
  }

  private resolveMaxActivePromptPatches(): number {
    const configuredMaxActive = this.config.values.evolution?.maxActivePromptPatches;
    return typeof configuredMaxActive === 'number' && Number.isFinite(configuredMaxActive) && configuredMaxActive > 0
      ? configuredMaxActive
      : 3;
  }

  private async collectPromptPatchBaselineMetrics(projectPath: string): Promise<PromptMetrics> {
    const [reviewEventsResult, recentTasksResult, issueCategoriesResult] = await Promise.all([
      this.taskStore.getRecentReviewEvents(projectPath, 20),
      this.taskStore.listTasks(projectPath, 'done'),
      this.taskStore.getRecurringIssueCategories(projectPath, 10),
    ]);

    const reviewEvents = reviewEventsResult ?? [];
    const recentTasks = recentTasksResult ?? [];
    const issueCategories = issueCategoriesResult ?? [];

    const totalReviews = reviewEvents.length;
    const passedReviews = reviewEvents.filter(event => event?.passed === true).length;
    const passRate = totalReviews > 0 ? passedReviews / totalReviews : 1;

    const costWindowSize = Math.min(recentTasks.length, 20);
    const avgCostUsd = costWindowSize > 0
      ? recentTasks
        .slice(-costWindowSize)
        .reduce((sum, task) => sum + Number(task?.total_cost_usd ?? 0), 0) / costWindowSize
      : 0;

    const issueCount = issueCategories.reduce((sum, category) => sum + Number(category?.count ?? 0), 0);
    const tasksEvaluated = reviewEvents.length;

    return { passRate, avgCostUsd, issueCount, tasksEvaluated };
  }

  private async storeProposedPatches(
    parsed: ParsedMetaReflectOutput,
    projectPath: string,
    maxActive: number,
  ): Promise<void> {
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.patches)) {
      throw new Error('parsed meta-reflect output is required for prompt patch storage');
    }
    if (typeof projectPath !== 'string' || projectPath.trim().length === 0) {
      throw new Error('projectPath is required for prompt patch storage');
    }
    if (!Number.isFinite(maxActive) || maxActive <= 0) {
      throw new Error('maxActive must be a positive number');
    }

    const baselineMetrics = await this.collectPromptPatchBaselineMetrics(projectPath);

    for (const proposal of parsed.patches.slice(0, 3)) {
      if (!proposal || typeof proposal.promptName !== 'string') {
        continue;
      }

      const activeVersions = await this.taskStore.getActivePromptVersions(projectPath);
      const activeCount = (activeVersions ?? [])
        .filter(version => version?.prompt_name === proposal.promptName).length;
      if (activeCount >= maxActive) {
        log.info(`Skipping ${proposal.promptName} patch: max active patches reached (${maxActive})`);
        continue;
      }

      const promptName = proposal.promptName as PromptName;
      const version = await this.taskStore.getNextPromptVersion(projectPath, promptName);
      await this.taskStore.savePromptVersion({
        project_path: projectPath,
        prompt_name: promptName,
        version,
        patches: Array.isArray(proposal.patches) ? proposal.patches : [],
        rationale: proposal.rationale ?? '',
        confidence: Number.isFinite(proposal.confidence) ? proposal.confidence : 0,
        baseline_metrics: baselineMetrics,
      });
      log.info(`Meta-reflect: stored candidate patch for "${proposal.promptName}" v${version} (confidence=${proposal.confidence})`);
    }

    await this.promoteReadyCandidates(projectPath);
    await this.rollbackDegradedVersions(projectPath);
  }

  private async collectMetaReflectData(projectPath: string): Promise<MetaReflectData> {
    if (typeof projectPath !== 'string' || projectPath.trim().length === 0) {
      throw new Error('projectPath is required for meta-reflection');
    }

    const [reviewEventsResult, recentTasksResult, healthTrendResult, activeVersionsResult, issueCategoriesResult] = await Promise.all([
      this.taskStore.getRecentReviewEvents(projectPath, 20),
      this.taskStore.listTasks(projectPath, 'done'),
      this.trendAnalyzer.getHealthTrend(projectPath),
      this.taskStore.getActivePromptVersions(projectPath),
      this.taskStore.getRecurringIssueCategories(projectPath, 10),
    ]);

    const reviewEvents = reviewEventsResult ?? [];
    const recentTasks = recentTasksResult ?? [];
    const healthTrend = healthTrendResult ?? null;
    const activeVersions = activeVersionsResult ?? [];
    const issueCategories = issueCategoriesResult ?? [];

    const totalReviews = reviewEvents.length;
    const passedReviews = reviewEvents.filter(event => event?.passed === true).length;
    const passRate = totalReviews > 0 ? passedReviews / totalReviews : 1;

    const costWindowSize = Math.min(recentTasks.length, 20);
    const avgCost = costWindowSize > 0
      ? recentTasks
        .slice(-costWindowSize)
        .reduce((sum, task) => sum + Number(task?.total_cost_usd ?? 0), 0) / costWindowSize
      : 0;

    return {
      reviewEvents,
      recentTasks,
      healthTrend,
      activeVersions,
      passRate,
      avgCost,
      issueCategories,
    };
  }

  private buildMetaReflectPrompt(data: MetaReflectData): string {
    if (!data || typeof data !== 'object') {
      throw new Error('meta-reflect data is required to build prompt');
    }

    const reviewEvents = Array.isArray(data.reviewEvents) ? data.reviewEvents : [];
    const recentTasks = Array.isArray(data.recentTasks) ? data.recentTasks : [];
    const healthTrend = data.healthTrend ?? null;
    const activeVersions = Array.isArray(data.activeVersions) ? data.activeVersions : [];
    const passRate = Number.isFinite(data.passRate) ? data.passRate : 0;
    const avgCost = Number.isFinite(data.avgCost) ? data.avgCost : 0;
    const issueCategories = Array.isArray(data.issueCategories) ? data.issueCategories : [];

    const activeVersionsSummary = activeVersions.length > 0
      ? activeVersions
        .map(version => `- ${version.prompt_name} v${version.version}: effectiveness=${Number(version.effectiveness ?? 0).toFixed(2)}, tasks=${version.tasks_evaluated ?? 0}`)
        .join('\n')
      : 'No active prompt patches.';

    const issueCategorySummary = issueCategories
      .map(category => `${category?.category ?? 'unknown'}(${Number(category?.count ?? 0)})`)
      .join(', ') || 'none';

    const failureSummary = reviewEvents
      .filter(event => event?.passed === false)
      .slice(0, 5)
      .map((event) => {
        const taskId = typeof event?.task_id === 'string' ? event.task_id.slice(0, 8) : 'unknown';
        const mustFixCount = Number(event?.must_fix_count ?? 0);
        const shouldFixCount = Number(event?.should_fix_count ?? 0);
        const issueList = JSON.stringify(event?.issue_categories ?? []);
        return `- Task ${taskId}: must_fix=${mustFixCount}, should_fix=${shouldFixCount}, categories=${issueList}`;
      })
      .join('\n') || 'None';

    return `You are analyzing the effectiveness of an AI coding agent's prompt templates.

## Current Performance Metrics
- Review pass rate: ${(passRate * 100).toFixed(1)}%
- Average task cost: $${avgCost.toFixed(4)}
- Health trend: ${healthTrend?.direction ?? 'unknown'} (${healthTrend?.current ?? 'N/A'}/100)
- Recurring issue categories: ${issueCategorySummary}
- Total completed tasks: ${recentTasks.length}

## Active Prompt Patches
${activeVersionsSummary}

## Recent Review Failures
${failureSummary}

## Available Prompt Names
brain_system, scan, plan, reflect, executor, reviewer

## Instructions
Analyze the data and propose 0-3 prompt patches to improve performance.
Each patch modifies a section of a prompt template using these operations:
- prepend: Add content before the prompt
- append: Add content after the prompt
- replace_section: Replace content under a ## heading
- remove_section: Remove a ## heading and its content

Only propose patches when there's clear evidence of a problem.
Focus on the most impactful changes.

Output as JSON:
{
  "patches": [{
    "promptName": "scan"|"plan"|"reflect"|"executor"|"reviewer"|"brain_system",
    "patches": [{ "op": "prepend"|"append"|"replace_section"|"remove_section", "section": string|null, "content": string, "reason": string }],
    "rationale": string,
    "confidence": number (0-1)
  }],
  "analysis": string
}`;
  }

  /**
   * Promote candidate prompt versions with confidence ≥ 0.7 to active.
   */
  async promoteReadyCandidates(projectPath: string): Promise<number> {
    const autoApply = this.config.values.evolution?.promptPatchAutoApply ?? true;
    if (!autoApply) return 0;

    const maxActive = this.config.values.evolution?.maxActivePromptPatches ?? 3;
    const candidates = await this.taskStore.getCandidatePromptVersions(projectPath);
    let promoted = 0;

    for (const c of candidates) {
      if (c.confidence < 0.7) continue;

      const activeVersions = await this.taskStore.getActivePromptVersions(projectPath);
      const activeForPrompt = activeVersions.filter(v => v.prompt_name === c.prompt_name);
      if (activeForPrompt.length >= maxActive) continue;

      // Supersede existing active version for this prompt
      await this.taskStore.supersedeActivePromptVersion(projectPath, c.prompt_name);
      await this.taskStore.activatePromptVersion(c.id);
      promoted++;
      log.info(`Promoted prompt patch: "${c.prompt_name}" v${c.version} (confidence=${c.confidence})`);
    }

    return promoted;
  }

  /**
   * Roll back active prompt versions that show degraded effectiveness.
   */
  async rollbackDegradedVersions(projectPath: string): Promise<number> {
    const activeVersions = await this.taskStore.getActivePromptVersions(projectPath);
    let rolledBack = 0;

    for (const v of activeVersions) {
      if (v.tasks_evaluated < 3) continue;

      // Effectiveness-based rollback
      if (v.effectiveness < -0.3) {
        await this.taskStore.updatePromptVersionStatus(v.id, 'rolled_back');
        rolledBack++;
        log.info(`Rolled back prompt patch: "${v.prompt_name}" v${v.version} (effectiveness=${v.effectiveness.toFixed(2)})`);
        continue;
      }

      // Metrics-based rollback: pass rate dropped > 15% compared to baseline
      if (v.tasks_evaluated >= 5 && v.baseline_metrics && v.current_metrics) {
        const baselinePassRate = v.baseline_metrics.passRate;
        const currentPassRate = v.current_metrics.passRate;
        if (baselinePassRate - currentPassRate > 0.15) {
          await this.taskStore.updatePromptVersionStatus(v.id, 'rolled_back');
          rolledBack++;
          log.info(`Rolled back prompt patch: "${v.prompt_name}" v${v.version} (pass rate drop: ${(baselinePassRate * 100).toFixed(0)}% → ${(currentPassRate * 100).toFixed(0)}%)`);
        }
      }
    }

    return rolledBack;
  }

  private parseMetaReflectOutput(output: string): ParsedMetaReflectOutput | null {
    try {
      // Find JSON in output
      const jsonMatch = output.match(/\{[\s\S]*"patches"[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed.patches) || parsed.patches.length === 0) return null;

      // Validate each patch proposal
      const validPatches = parsed.patches.filter((p: any) =>
        typeof p.promptName === 'string' &&
        Array.isArray(p.patches) &&
        p.patches.length > 0 &&
        typeof p.confidence === 'number'
      );

      return validPatches.length > 0 ? { patches: validPatches, analysis: parsed.analysis ?? '' } : null;
    } catch {
      return null;
    }
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

  private extractGoalKeywords(description: string): string[] {
    const normalizedDescription = description?.toLowerCase() ?? '';
    if (!normalizedDescription) return [];

    const keywords = new Set<string>();

    for (const rule of GOAL_KEYWORD_RULES) {
      if (rule.goalIndicators.some(indicator => normalizedDescription.includes(indicator))) {
        for (const keyword of rule.taskKeywords) {
          keywords.add(keyword.toLowerCase());
        }
      }
    }

    const tokens = normalizedDescription
      .split(/[\s,:：，。；;、()（）]+/)
      .map(token => token.trim())
      .filter(token => token.length >= 2);

    for (const token of tokens) {
      for (const fallbackKeyword of GOAL_FALLBACK_KEYWORDS) {
        if (token.includes(fallbackKeyword)) {
          keywords.add(fallbackKeyword);
        }
      }
    }

    return Array.from(keywords);
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
