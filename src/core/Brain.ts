import type { ClaudeBridge } from '../bridges/ClaudeBridge.js';
import type { GlobalMemory } from '../memory/GlobalMemory.js';
import type { ProjectMemory } from '../memory/ProjectMemory.js';
import type { TaskStore } from '../memory/TaskStore.js';
import type { ProjectAnalysis, TaskPlan, ReflectionResult } from './types.js';
import { BRAIN_SYSTEM_PROMPT, scanPrompt, planPrompt, reflectPrompt, brainMcpGuidance } from '../prompts/brain.js';
import { getHeadCommit, getRecentLog, getChangedFilesSince } from '../utils/git.js';
import { log } from '../utils/logger.js';

export class Brain {
  constructor(
    private claude: ClaudeBridge,
    private globalMemory: GlobalMemory,
    private projectMemory: ProjectMemory,
    private taskStore: TaskStore,
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

    const mcpGuidance = brainMcpGuidance(this.claude.getMcpServerNames('scan'));
    const prompt = scanPrompt(projectPath, depth, recentChanges, allMemories, mcpGuidance);
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
    const existingTasks = await this.taskStore.listTasks(projectPath, 'queued');
    const existingDesc = existingTasks.map(t => `- [P${t.priority}] ${t.task_description}`).join('\n');

    const prompt = planPrompt(JSON.stringify(analysis, null, 2), memories, existingDesc);
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
  ): Promise<{ reflection: ReflectionResult; cost: number }> {
    log.info('Reflecting on task results...');

    const prompt = reflectPrompt(taskDescription, result, reviewSummary);
    const r = await this.claude.plan(prompt, projectPath, {
      systemPrompt: BRAIN_SYSTEM_PROMPT,
      maxTurns: 5,
    });

    const reflection = parseReflection(r.output);

    // Save extracted experiences to global memory
    for (const exp of reflection.experiences) {
      await this.globalMemory.add({
        category: exp.category,
        title: exp.title,
        content: exp.content,
        tags: exp.tags,
        source_project: projectPath,
        confidence: 0.5,
      });
      log.info(`Saved experience: ${exp.title}`);
    }

    // Save task summary to project memory
    await this.projectMemory.save(
      `Task completed: ${taskDescription}\n${reflection.taskSummary}`,
      `Task: ${taskDescription.slice(0, 50)}`,
    );

    return { reflection, cost: r.cost_usd };
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

function parseAnalysis(output: string): ProjectAnalysis {
  const jsonMatch = output.match(/\{[\s\S]*"projectHealth"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
        opportunities: Array.isArray(parsed.opportunities) ? parsed.opportunities : [],
        projectHealth: typeof parsed.projectHealth === 'number' ? parsed.projectHealth : 50,
        summary: parsed.summary ?? output.slice(0, 200),
      };
    } catch { /* fall through */ }
  }
  return {
    issues: [],
    opportunities: [],
    projectHealth: 50,
    summary: output.slice(0, 500),
  };
}

function parsePlan(output: string): TaskPlan {
  const jsonMatch = output.match(/\{[\s\S]*"tasks"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
        reasoning: parsed.reasoning ?? '',
      };
    } catch { /* fall through */ }
  }
  return { tasks: [], reasoning: output.slice(0, 500) };
}

function parseReflection(output: string): ReflectionResult {
  const jsonMatch = output.match(/\{[\s\S]*"experiences"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        experiences: Array.isArray(parsed.experiences) ? parsed.experiences : [],
        taskSummary: parsed.taskSummary ?? '',
        adjustments: Array.isArray(parsed.adjustments) ? parsed.adjustments : [],
      };
    } catch { /* fall through */ }
  }
  return { experiences: [], taskSummary: output.slice(0, 200), adjustments: [] };
}
