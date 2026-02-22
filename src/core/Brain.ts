import type { Config } from '../config/Config.js';
import type { ClaudeBridge } from '../bridges/ClaudeBridge.js';
import type { GlobalMemory } from '../memory/GlobalMemory.js';
import type { ProjectMemory } from '../memory/ProjectMemory.js';
import type { TaskStore } from '../memory/TaskStore.js';
import type { ProjectAnalysis, TaskPlan, ReflectionResult } from './types.js';
import type { QuestionHandler } from '../bridges/MessageHandler.js';
import type { EvolutionEngine } from '../evolution/EvolutionEngine.js';
import type { PromptRegistry } from '../prompts/PromptRegistry.js';
import { BRAIN_SYSTEM_PROMPT, scanPrompt, planPrompt, reflectPrompt, brainMcpGuidance, researchPrompt, planWithMarkdownPrompt } from '../prompts/brain.js';
import type { PlanRequest } from '../prompts/brain.js';
import type { PlanDraft } from '../memory/types.js';
import { buildAgentGuidance } from '../prompts/agents.js';
import { getHeadCommit, getRecentLog, getChangedFilesSince } from '../utils/git.js';
import { log } from '../utils/logger.js';
import { extractJsonFromText, isRecord } from '../utils/parse.js';

export class Brain implements QuestionHandler {
  private evolutionEngine?: EvolutionEngine;
  private promptRegistry?: PromptRegistry;

  constructor(
    private claude: ClaudeBridge,
    private globalMemory: GlobalMemory,
    private projectMemory: ProjectMemory,
    private taskStore: TaskStore,
    private config?: Config,
  ) {}

  setEvolutionEngine(engine: EvolutionEngine): void {
    this.evolutionEngine = engine;
  }

  setPromptRegistry(registry: PromptRegistry): void {
    this.promptRegistry = registry;
  }

  async scanProject(
    projectPath: string,
    depth: 'quick' | 'normal' | 'deep' = 'normal',
  ): Promise<{ analysis: ProjectAnalysis; cost: number }> {
    log.info(`Scanning project (${depth}): ${projectPath}`);

    // Get recent changes for context
    const lastScan = await this.taskStore.getLastScan(projectPath);
    let recentChanges = '';
    if (lastScan) {
      try {
        const files = await getChangedFilesSince(lastScan.commit_hash, projectPath);
        recentChanges = files.length > 0
          ? `Changed files since last scan:\n${files.join('\n')}`
          : 'No file changes since last scan.';
      } catch {
        recentChanges = await getRecentLog(projectPath, 10);
      }
    } else {
      recentChanges = await getRecentLog(projectPath, 20);
    }

    // Get relevant memories
    const memories = await this.globalMemory.getRelevant('code quality security testing');
    const projectMems = await this.projectMemory.search('architecture structure', 5);
    const allMemories = memories + '\n' + projectMems.map(m => m.text).join('\n');

    const mcpGuidance = brainMcpGuidance(this.claude.getMcpServerNames('scan'));
    const goalsSection = this.buildGoalsSection();
    const dynamicContext = this.evolutionEngine
      ? await this.evolutionEngine.synthesizePromptContext(projectPath)
      : undefined;
    const pluginIds = this.claude.getLoadedPluginIds();
    const agentGuide = buildAgentGuidance('scan', pluginIds);

    // Pass in-progress tasks so scanner knows what's already being worked on
    const [queuedTasks, activeTasks] = await Promise.all([
      this.taskStore.listTasks(projectPath, 'queued'),
      this.taskStore.listTasks(projectPath, 'active'),
    ]);
    const inProgressTasks = [...queuedTasks, ...activeTasks].map(t => t.task_description);

    const basePrompt = scanPrompt(projectPath, depth, recentChanges, allMemories, mcpGuidance, goalsSection, dynamicContext, agentGuide, inProgressTasks);
    const prompt = this.promptRegistry ? await this.promptRegistry.resolve('scan', basePrompt) : basePrompt;
    const baseSystem = BRAIN_SYSTEM_PROMPT;
    const systemPrompt = this.promptRegistry ? await this.promptRegistry.resolve('brain_system', baseSystem) : baseSystem;
    const result = await this.claude.plan(prompt, projectPath, {
      systemPrompt,
      maxTurns: depth === 'deep' ? 30 : depth === 'normal' ? 20 : 10,
    });

    log.debug(`Scan output length: ${result.output.length} chars, success: ${result.success}`);
    const analysis = parseAnalysis(result.output);
    const commitHash = await getHeadCommit(projectPath).catch(() => 'unknown');

    // Save scan result
    await this.taskStore.saveScanResult({
      project_path: projectPath,
      commit_hash: commitHash,
      depth,
      result: analysis,
      health_score: analysis.projectHealth,
      cost_usd: result.cost_usd,
    });

    log.info(`Scan complete. Health: ${analysis.projectHealth}/100, Issues: ${analysis.issues.length}, Opportunities: ${analysis.opportunities.length}`);
    return { analysis, cost: result.cost_usd };
  }

  async createPlan(
    projectPath: string,
    analysis: ProjectAnalysis,
  ): Promise<{ plan: TaskPlan; cost: number }> {
    log.info('Creating task plan...');

    const memories = await this.globalMemory.getRelevant('task planning prioritization');

    // Include all task statuses so LLM knows what's been done/failed/blocked
    const [queued, done, blocked, failed] = await Promise.all([
      this.taskStore.listTasks(projectPath, 'queued'),
      this.taskStore.listTasks(projectPath, 'done'),
      this.taskStore.listTasks(projectPath, 'blocked'),
      this.taskStore.listTasks(projectPath, 'failed'),
    ]);
    const allTasks = [
      ...queued.map(t => `- [P${t.priority}] [queued] ${t.task_description}`),
      ...done.map(t => `- [P${t.priority}] [done] ${t.task_description}`),
      ...blocked.map(t => `- [P${t.priority}] [blocked] ${t.task_description}`),
      ...failed.map(t => `- [P${t.priority}] [failed] ${t.task_description}`),
    ].join('\n');

    // Build goals section
    const goalsSection = this.buildGoalsSection();

    const dynamicContext = this.evolutionEngine
      ? await this.evolutionEngine.synthesizePromptContext(projectPath)
      : undefined;
    const agentGuide = buildAgentGuidance('plan', this.claude.getLoadedPluginIds());
    const basePrompt = planPrompt(JSON.stringify(analysis, null, 2), memories, allTasks, goalsSection, dynamicContext, agentGuide);
    const prompt = this.promptRegistry ? await this.promptRegistry.resolve('plan', basePrompt) : basePrompt;
    const systemPrompt = this.promptRegistry ? await this.promptRegistry.resolve('brain_system', BRAIN_SYSTEM_PROMPT) : BRAIN_SYSTEM_PROMPT;
    const result = await this.claude.plan(prompt, projectPath, {
      systemPrompt,
    });

    const plan = parsePlan(result.output);

    log.info(`Plan created: ${plan.tasks.length} tasks`);
    return { plan, cost: result.cost_usd };
  }

  async reflect(
    projectPath: string,
    taskDescription: string,
    result: string,
    reviewSummary: string,
    outcome: 'success' | 'failed' | 'blocked_stuck' | 'blocked_max_retries' = 'success',
  ): Promise<{ reflection: ReflectionResult; cost: number }> {
    log.info(`Reflecting on task (outcome=${outcome})...`);

    const basePrompt = reflectPrompt(taskDescription, result, reviewSummary, outcome);
    const prompt = this.promptRegistry ? await this.promptRegistry.resolve('reflect', basePrompt) : basePrompt;
    const systemPrompt = this.promptRegistry ? await this.promptRegistry.resolve('brain_system', BRAIN_SYSTEM_PROMPT) : BRAIN_SYSTEM_PROMPT;
    const r = await this.claude.plan(prompt, projectPath, {
      systemPrompt,
      maxTurns: 5,
    });

    const reflection = parseReflection(r.output);

    // Save extracted experiences to global memory
    const validCategories = new Set(['habit', 'experience', 'standard', 'workflow', 'framework', 'failure', 'simplification']);
    const savedTitles: string[] = [];
    for (const exp of reflection.experiences) {
      const category = validCategories.has(exp.category) ? exp.category : 'experience';
      try {
        await this.globalMemory.add({
          category: category as any,
          title: exp.title,
          content: exp.content,
          tags: exp.tags ?? [],
          source_project: projectPath,
          confidence: 0.5,
        });
        savedTitles.push(exp.title);
        log.info(`Saved experience: ${exp.title}`);
      } catch (err) {
        log.warn(`Failed to save experience "${exp.title}": ${err}`);
      }
    }

    // Adjust confidence of related memories based on outcome
    try {
      const relatedMemories = await this.globalMemory.search(taskDescription, 5);
      const delta = outcome === 'success' ? 0.1 : -0.05;
      for (const mem of relatedMemories) {
        if (savedTitles.includes(mem.title)) continue; // skip just-created
        await this.globalMemory.updateConfidence(mem.id, delta);
        log.info(`Memory confidence ${delta > 0 ? 'boosted' : 'reduced'}: "${mem.title}" (${delta > 0 ? '+' : ''}${delta})`);
      }
    } catch (err) {
      log.warn(`Confidence update failed: ${err}`);
    }

    // Save task summary to project memory
    const prefix = outcome === 'success' ? 'Task completed' : `Task ${outcome}`;
    await this.projectMemory.save(
      `${prefix}: ${taskDescription}\n${reflection.taskSummary}`,
      `Task: ${taskDescription.slice(0, 50)}`,
    );

    return { reflection, cost: r.cost_usd };
  }

  async research(
    projectPath: string,
    request: PlanRequest,
  ): Promise<{ report: string; cost: number }> {
    log.info(`Researching: ${request.description.slice(0, 80)}...`);

    const memories = await this.globalMemory.getRelevant(request.description);
    const projectMems = await this.projectMemory.search(request.description, 5);
    const allMemories = memories + '\n' + projectMems.map(m => m.text).join('\n');
    const mcpGuidance = brainMcpGuidance(this.claude.getMcpServerNames('scan'));

    const basePrompt = researchPrompt(projectPath, request, allMemories, mcpGuidance);
    const prompt = this.promptRegistry ? await this.promptRegistry.resolve('research', basePrompt) : basePrompt;
    const systemPrompt = this.promptRegistry
      ? await this.promptRegistry.resolve('brain_system', BRAIN_SYSTEM_PROMPT)
      : BRAIN_SYSTEM_PROMPT;

    const result = await this.claude.plan(prompt, projectPath, {
      systemPrompt,
      maxTurns: 30,
    });

    log.info('Research complete');
    return { report: result.output, cost: result.cost_usd };
  }

  async createPlanWithMarkdown(
    projectPath: string,
    researchReport: string,
    request: PlanRequest,
  ): Promise<{ plan: TaskPlan; markdown: string; reasoning: string; cost: number }> {
    log.info('Generating plan with markdown...');

    const [queued, done, blocked, failed] = await Promise.all([
      this.taskStore.listTasks(projectPath, 'queued'),
      this.taskStore.listTasks(projectPath, 'done'),
      this.taskStore.listTasks(projectPath, 'blocked'),
      this.taskStore.listTasks(projectPath, 'failed'),
    ]);
    const allTasks = [
      ...queued.map(t => `- [P${t.priority}] [queued] ${t.task_description}`),
      ...done.map(t => `- [P${t.priority}] [done] ${t.task_description}`),
      ...blocked.map(t => `- [P${t.priority}] [blocked] ${t.task_description}`),
      ...failed.map(t => `- [P${t.priority}] [failed] ${t.task_description}`),
    ].join('\n');

    const basePrompt = planWithMarkdownPrompt(researchReport, request, allTasks);
    const prompt = this.promptRegistry ? await this.promptRegistry.resolve('plan_markdown', basePrompt) : basePrompt;
    const systemPrompt = this.promptRegistry
      ? await this.promptRegistry.resolve('brain_system', BRAIN_SYSTEM_PROMPT)
      : BRAIN_SYSTEM_PROMPT;

    const result = await this.claude.plan(prompt, projectPath, { systemPrompt });
    const parsed = parsePlan(result.output);

    // Extract markdown from parsed result if present
    const rawParsed = extractJsonFromText(
      result.output,
      (value) => isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'tasks'),
    );
    const markdown = isRecord(rawParsed) && typeof rawParsed.markdown === 'string'
      ? rawParsed.markdown
      : result.output;

    log.info(`Plan generated: ${parsed.tasks.length} tasks`);
    return { plan: parsed, markdown, reasoning: parsed.reasoning, cost: result.cost_usd };
  }

  /** Auto-answer AskUserQuestion from subprocesses (skills, plugins) */
  async answerQuestion(question: string, options: string[], _taskContext: string): Promise<string> {
    if (options.length > 0) {
      // First option is typically marked as recommended by skills
      log.debug?.(`Auto-answering: "${question}" → "${options[0]}"`);
      return options[0];
    }
    // Open-ended question: provide a safe default
    return 'Proceed with the default approach.';
  }

  private buildGoalsSection(): string {
    const goals = this.config?.values.evolution?.goals?.filter(g => g.status !== 'done' && g.status !== 'paused') ?? [];
    if (goals.length === 0) return '';

    const archNotes = this.config?.values.evolution?.architectureNotes;
    let section = '\n## Evolution Goals\nThe project has the following active evolution goals:\n';
    for (const g of goals) {
      section += `- [P${g.priority}] ${g.description}\n`;
    }
    if (archNotes) {
      section += `\nArchitecture direction: ${archNotes}\n`;
    }
    section += '\nConsider creating tasks that advance these goals, not just fixing bugs.\n';
    return section;
  }

  async hasChanges(projectPath: string): Promise<boolean> {
    const lastScan = await this.taskStore.getLastScan(projectPath);
    if (!lastScan) return true; // First scan always needed
    try {
      const currentHead = await getHeadCommit(projectPath);
      return currentHead !== lastScan.commit_hash;
    } catch {
      return true;
    }
  }
}

/** Strip markdown code fences (```json ... ```) so the JSON parser can find the object. */
function stripCodeFences(text: string): string {
  return text.replace(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/g, '$1');
}

function extractObjectByKey(text: string, requiredKey: string): Record<string, unknown> | null {
  const matcher = (value: unknown) => isRecord(value) && Object.prototype.hasOwnProperty.call(value, requiredKey);
  // Try raw text first, then with code fences stripped
  let parsed = extractJsonFromText(text, matcher);
  if (!isRecord(parsed)) {
    parsed = extractJsonFromText(stripCodeFences(text), matcher);
  }
  return isRecord(parsed) ? parsed : null;
}

export function parseAnalysis(output: string): ProjectAnalysis {
  const parsed = extractObjectByKey(output, 'projectHealth');
  if (parsed) {
    return {
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      opportunities: Array.isArray(parsed.opportunities) ? parsed.opportunities : [],
      projectHealth: typeof parsed.projectHealth === 'number' ? parsed.projectHealth : 50,
      summary: (parsed.summary as string) ?? output.slice(0, 200),
      codeMetrics: parsed.codeMetrics && typeof parsed.codeMetrics === 'object' ? parsed.codeMetrics as ProjectAnalysis['codeMetrics'] : undefined,
      simplificationTargets: Array.isArray(parsed.simplificationTargets) ? parsed.simplificationTargets : undefined,
      featureGaps: Array.isArray(parsed.featureGaps) ? parsed.featureGaps : undefined,
    };
  }
  log.warn(`parseAnalysis: failed to extract JSON from scan output (${output.length} chars). Using fallback. First 300 chars: ${output.slice(0, 300)}`);
  return {
    issues: [],
    opportunities: [],
    projectHealth: 50,
    summary: output.slice(0, 500),
  };
}

export function parsePlan(output: string): TaskPlan {
  const parsed = extractObjectByKey(output, 'tasks');
  if (parsed) {
    return {
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      reasoning: (parsed.reasoning as string) ?? '',
    };
  }
  log.warn(`parsePlan: failed to extract JSON from plan output (${output.length} chars). First 300 chars: ${output.slice(0, 300)}`);
  return { tasks: [], reasoning: output.slice(0, 500) };
}

export function parseReflection(output: string): ReflectionResult {
  const parsed = extractObjectByKey(output, 'experiences');
  if (parsed) {
    return {
      experiences: Array.isArray(parsed.experiences) ? parsed.experiences : [],
      taskSummary: (parsed.taskSummary as string) ?? '',
      adjustments: Array.isArray(parsed.adjustments) ? parsed.adjustments : [],
    };
  }
  return { experiences: [], taskSummary: output.slice(0, 200), adjustments: [] };
}
