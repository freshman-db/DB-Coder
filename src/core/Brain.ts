import type { Config } from '../config/Config.js';
import type { ClaudeBridge } from '../bridges/ClaudeBridge.js';
import type { GlobalMemory } from '../memory/GlobalMemory.js';
import type { ProjectMemory } from '../memory/ProjectMemory.js';
import type { TaskStore } from '../memory/TaskStore.js';
import type { ProjectAnalysis, TaskPlan, ReflectionResult } from './types.js';
import { BRAIN_SYSTEM_PROMPT, scanPrompt, planPrompt, reflectPrompt } from '../prompts/brain.js';
import { getHeadCommit, getRecentLog, getChangedFilesSince } from '../utils/git.js';
import { log } from '../utils/logger.js';

export class Brain {
  constructor(
    private claude: ClaudeBridge,
    private globalMemory: GlobalMemory,
    private projectMemory: ProjectMemory,
    private taskStore: TaskStore,
    private config?: Config,
  ) {}

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

    const goalsSection = this.buildGoalsSection();
    const prompt = scanPrompt(projectPath, depth, recentChanges, allMemories, goalsSection);
    const result = await this.claude.plan(prompt, projectPath, {
      systemPrompt: BRAIN_SYSTEM_PROMPT,
      maxTurns: depth === 'deep' ? 30 : depth === 'normal' ? 20 : 10,
    });

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

    log.info(`Scan complete. Health: ${analysis.projectHealth}/100, Issues: ${analysis.issues.length}`);
    return { analysis, cost: result.cost_usd };
  }

  async createPlan(
    projectPath: string,
    analysis: ProjectAnalysis,
  ): Promise<{ plan: TaskPlan; cost: number }> {
    log.info('Creating task plan...');

    const memories = await this.globalMemory.getRelevant('task planning prioritization');

    // Include all task statuses so LLM knows what's been done/failed
    const [queued, done, blocked] = await Promise.all([
      this.taskStore.listTasks(projectPath, 'queued'),
      this.taskStore.listTasks(projectPath, 'done'),
      this.taskStore.listTasks(projectPath, 'blocked'),
    ]);
    const allTasks = [
      ...queued.map(t => `- [P${t.priority}] [queued] ${t.task_description}`),
      ...done.map(t => `- [P${t.priority}] [done] ${t.task_description}`),
      ...blocked.map(t => `- [P${t.priority}] [blocked] ${t.task_description}`),
    ].join('\n');

    // Build goals section
    const goalsSection = this.buildGoalsSection();

    const prompt = planPrompt(JSON.stringify(analysis, null, 2), memories, allTasks, goalsSection);
    const result = await this.claude.plan(prompt, projectPath, {
      systemPrompt: BRAIN_SYSTEM_PROMPT,
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

    const prompt = reflectPrompt(taskDescription, result, reviewSummary, outcome);
    const r = await this.claude.plan(prompt, projectPath, {
      systemPrompt: BRAIN_SYSTEM_PROMPT,
      maxTurns: 5,
    });

    const reflection = parseReflection(r.output);

    // Save extracted experiences to global memory
    const savedTitles: string[] = [];
    for (const exp of reflection.experiences) {
      const category = exp.category === 'failure' ? 'failure' : exp.category;
      await this.globalMemory.add({
        category: category as any,
        title: exp.title,
        content: exp.content,
        tags: exp.tags,
        source_project: projectPath,
        confidence: 0.5,
      });
      savedTitles.push(exp.title);
      log.info(`Saved experience: ${exp.title}`);
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

/** Extract a balanced JSON object containing requiredKey from LLM output */
function extractJson(text: string, requiredKey: string, parserName: string): unknown | null {
  const keyIdx = text.indexOf(`"${requiredKey}"`);
  if (keyIdx === -1) return null;

  // Walk backward from the key to find the opening brace
  let start = -1;
  for (let i = keyIdx - 1; i >= 0; i--) {
    if (text[i] === '{') { start = i; break; }
  }
  if (start === -1) return null;

  // Walk forward counting braces to find the balanced closing brace
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"' && !escape) { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch (error) {
          const rawJson = text.slice(start, i + 1);
          const snippet = rawJson.length > 400
            ? `${rawJson.slice(0, 400)}...(truncated)`
            : rawJson;
          const reason = error instanceof Error ? error.message : String(error);
          log.warn(`${parserName}: JSON.parse failed for "${requiredKey}" (${reason}). Raw snippet: ${snippet}`);
          return null;
        }
      }
    }
  }
  log.warn(`extractJson: unbalanced braces for "${requiredKey}"`);
  return null;
}

function parseAnalysis(output: string): ProjectAnalysis {
  const parsed = extractJson(output, 'projectHealth', 'parseAnalysis') as Record<string, unknown> | null;
  if (parsed) {
    return {
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      opportunities: Array.isArray(parsed.opportunities) ? parsed.opportunities : [],
      projectHealth: typeof parsed.projectHealth === 'number' ? parsed.projectHealth : 50,
      summary: (parsed.summary as string) ?? output.slice(0, 200),
    };
  }
  return {
    issues: [],
    opportunities: [],
    projectHealth: 50,
    summary: output.slice(0, 500),
  };
}

function parsePlan(output: string): TaskPlan {
  const parsed = extractJson(output, 'tasks', 'parsePlan') as Record<string, unknown> | null;
  if (parsed) {
    return {
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      reasoning: (parsed.reasoning as string) ?? '',
    };
  }
  return { tasks: [], reasoning: output.slice(0, 500) };
}

function parseReflection(output: string): ReflectionResult {
  const parsed = extractJson(output, 'experiences', 'parseReflection') as Record<string, unknown> | null;
  if (parsed) {
    return {
      experiences: Array.isArray(parsed.experiences) ? parsed.experiences : [],
      taskSummary: (parsed.taskSummary as string) ?? '',
      adjustments: Array.isArray(parsed.adjustments) ? parsed.adjustments : [],
    };
  }
  return { experiences: [], taskSummary: output.slice(0, 200), adjustments: [] };
}
