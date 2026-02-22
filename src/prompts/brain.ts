import type { DynamicPromptContext } from '../evolution/types.js';

function formatDynamicContext(ctx?: DynamicPromptContext): string {
  if (!ctx) return '';
  const sections: string[] = [];

  if (ctx.learnedPatterns.length > 0) {
    sections.push(`## Learned Patterns\n${ctx.learnedPatterns.map(p => `- ${p}`).join('\n')}`);
  }
  if (ctx.antiPatterns.length > 0) {
    sections.push(`## Anti-Patterns (avoid these)\n${ctx.antiPatterns.map(p => `- ${p}`).join('\n')}`);
  }
  if (ctx.trendContext) {
    sections.push(`## Project Trends\n${ctx.trendContext}`);
  }
  if (ctx.activeAdjustments.length > 0) {
    sections.push(`## Active Adjustments\n${ctx.activeAdjustments.map(a => `- ${a}`).join('\n')}`);
  }
  if (ctx.goalContext) {
    sections.push(`## ${ctx.goalContext}`);
  }

  return sections.length > 0 ? '\n' + sections.join('\n\n') + '\n' : '';
}

export const BRAIN_SYSTEM_PROMPT = `You are the Brain of db-coder, an autonomous AI coding agent.
You act as a "technical lead" — you analyze codebases, identify improvements, plan tasks, and extract lessons learned.

Your core principles:
1. Quality over quantity — prefer fewer, high-impact changes
2. Safety first — never modify protected branches directly
3. Incremental improvement — small, reviewable changes
4. Learn from mistakes — extract reusable patterns
5. Continuous simplification — reduce complexity, remove unnecessary abstractions
6. Eliminate duplication — consolidate repeated patterns into shared utilities
7. Proactive improvement — improve architecture, coverage, and code quality, not just fix bugs

You have access to read-only tools AND the Task tool for spawning specialized agents.
Use actual tools (tsc, grep, find) and specialized agents to gather concrete data, not just surface impressions.`;

export function brainMcpGuidance(serverNames: string[]): string {
  if (serverNames.length === 0) return '';
  const tips: string[] = [];
  if (serverNames.includes('serena')) {
    tips.push(`- **Serena** (semantic code analysis): Use find_symbol, get_symbols_overview, find_referencing_symbols for precise code understanding. Prefer Serena over blind Grep for locating classes, methods, and their relationships.`);
  }
  if (serverNames.includes('context7')) {
    tips.push(`- **Context7** (library docs): Use resolve-library-id + query-docs to look up API documentation for unfamiliar libraries.`);
  }
  return tips.length > 0 ? `\n## Available MCP Tools\n${tips.join('\n')}` : '';
}

export function scanPrompt(projectPath: string, depth: string, recentChanges: string, memories: string, mcpGuidance: string = '', goalsSection: string = '', dynamicContext?: DynamicPromptContext, agentGuidance: string = '', inProgressTasks: string[] = []): string {
  const inProgressSection = inProgressTasks.length > 0
    ? `\nTasks already in progress (DO NOT report these as new issues):\n${inProgressTasks.map(t => `- ${t}`).join('\n')}\n`
    : '';
  return `Scan the project at ${projectPath}.
Scan depth: ${depth}

Recent changes:
${recentChanges || 'No recent changes detected.'}

Relevant memories from past experience:
${memories || 'No relevant memories yet.'}
${mcpGuidance}
${agentGuidance}
${goalsSection}
${inProgressSection}
${formatDynamicContext(dynamicContext)}
Analyze the project by:
1. Reading key files (package.json, README, config files, main source files)
2. Running git log to understand recent activity
3. Running \`tsc --noEmit\` to check for type errors
4. Searching for TODO/FIXME/HACK comments
5. Checking for common code quality issues
6. Evaluating test coverage structure
7. Looking for security concerns
${goalsSection ? '8. Evaluating progress toward evolution goals' : ''}

If specialized agents are available (listed above), spawn them via the Task tool for deeper analysis.
Launch agents in parallel for efficiency. Synthesize their reports into your analysis.

Output your analysis as JSON with this exact structure:
{
  "issues": [{ "type": string, "severity": "critical"|"high"|"medium"|"low", "description": string, "file": string, "suggestion": string }],
  "opportunities": [{ "type": string, "severity": "medium"|"low", "description": string, "suggestion": string }],
  "codeMetrics": { "typeErrors": number, "longFunctions": [{ "file": string, "name": string, "lines": number }], "duplicatePatterns": [{ "files": [string], "description": string }], "deadCode": [{ "file": string, "description": string }] },
  "simplificationTargets": [{ "file": string, "description": string, "complexity": string, "suggestion": string }],
  "featureGaps": [{ "area": string, "description": string, "suggestion": string }],
  "projectHealth": number (0-100),
  "summary": string
}`;
}

export function planPrompt(analysis: string, memories: string, existingTasks: string, goalsSection: string = '', dynamicContext?: DynamicPromptContext, agentGuidance: string = ''): string {
  return `Based on this project analysis, create a prioritized task plan.

Analysis:
${analysis}

Relevant memories:
${memories || 'None'}

Existing tasks (queued, completed, blocked, and failed — DO NOT create duplicates):
${existingTasks || 'None'}
${goalsSection}
${agentGuidance}
${formatDynamicContext(dynamicContext)}
Create tasks with priorities:
- P0: Critical bugs, security issues
- P1: Important improvements, failing tests
- P2: Code quality, refactoring
- P3: Nice-to-have, optimizations

Classify each task with a type:
- bugfix / security / quality / refactor / simplify / feature / test / docs

Simplification philosophy: Prefer removing complexity over adding it. If a task can be solved by deleting code, simplifying abstractions, or consolidating duplicates, that is always better than adding new code.

IMPORTANT deduplication rules:
- Do NOT create tasks that duplicate or closely resemble existing tasks listed above (regardless of their status).
- If a task was already done or blocked, do not retry it unless you have a fundamentally different approach.
- Tasks marked [failed] should NOT be retried within 24 hours. They failed for a reason — only create a new task for the same area if you have a fundamentally different approach AND sufficient time has passed.

Route each task:
- Frontend tasks (UI, components, styles, pages) → executor: "claude"
- Backend tasks (API, database, logic, tests) → executor: "codex"
- Full-stack → split into subtasks with appropriate executors

Output as JSON:
{
  "tasks": [{
    "id": string,
    "description": string,
    "type": "bugfix"|"security"|"quality"|"refactor"|"simplify"|"feature"|"test"|"docs",
    "priority": number (0-3),
    "executor": "claude"|"codex",
    "subtasks": [{ "id": string, "description": string, "executor": "claude"|"codex" }],
    "dependsOn": [task_id],
    "estimatedComplexity": "low"|"medium"|"high"
  }],
  "reasoning": string
}`;
}

export interface PlanRequest {
  description: string;
  goals?: string[];
  constraints?: string[];
  targetModules?: string[];
}

export function researchPrompt(projectPath: string, request: PlanRequest, memories: string, mcpGuidance: string = ''): string {
  const goalsSection = request.goals?.length
    ? `\nGoals:\n${request.goals.map(g => `- ${g}`).join('\n')}`
    : '';
  const constraintsSection = request.constraints?.length
    ? `\nConstraints:\n${request.constraints.map(c => `- ${c}`).join('\n')}`
    : '';
  const modulesSection = request.targetModules?.length
    ? `\nTarget modules to focus on:\n${request.targetModules.map(m => `- ${m}`).join('\n')}`
    : '';

  return `You are conducting deep research on the project at ${projectPath} to prepare for implementing the following requirement:

## Requirement
${request.description}
${goalsSection}${constraintsSection}${modulesSection}

## Relevant memories
${memories || 'None'}
${mcpGuidance}

## Research Tasks
Perform a thorough analysis:
1. Read and understand the relevant source files, especially those in target modules
2. Map out the current architecture and how the requirement relates to existing code
3. Identify dependencies, interfaces, and potential breaking changes
4. Check for existing patterns, utilities, and conventions in the codebase
5. Evaluate testing strategy and existing test coverage in relevant areas
6. Identify risks, edge cases, and potential blockers

## Output
Write a detailed research report in Markdown covering:
- **Current State**: How the relevant code works today
- **Impact Analysis**: What files/modules will be affected
- **Dependencies**: Internal and external dependencies to consider
- **Risks**: Potential issues and edge cases
- **Recommendations**: Suggested approach and alternatives`;
}

export function planWithMarkdownPrompt(researchReport: string, request: PlanRequest, existingTasks: string): string {
  const goalsSection = request.goals?.length
    ? `\nGoals:\n${request.goals.map(g => `- ${g}`).join('\n')}`
    : '';

  return `Based on the following research report, create a detailed implementation plan.

## Requirement
${request.description}
${goalsSection}

## Research Report
${researchReport}

## Existing Tasks (avoid duplicates)
${existingTasks || 'None'}

Create both a structured JSON plan AND a human-readable Markdown version.

The Markdown plan should include:
- Overview and goals
- Step-by-step implementation tasks with clear descriptions
- Each task marked with estimated complexity and suggested executor
- Dependencies between tasks
- Testing strategy
- Rollback plan

Output as JSON:
{
  "tasks": [{
    "id": string,
    "description": string,
    "type": "bugfix"|"security"|"quality"|"refactor"|"simplify"|"feature"|"test"|"docs",
    "priority": number (0-3),
    "executor": "claude"|"codex",
    "subtasks": [{ "id": string, "description": string, "executor": "claude"|"codex" }],
    "dependsOn": [task_id],
    "estimatedComplexity": "low"|"medium"|"high"
  }],
  "reasoning": string,
  "markdown": string (the human-readable Markdown plan)
}`;
}

export function reflectPrompt(taskDescription: string, result: string, reviewSummary: string, outcome: string = 'success'): string {
  const outcomeGuidance = outcome === 'success'
    ? `Focus on:
- Patterns that worked well
- Tools/approaches that were effective
- Standards worth enforcing`
    : `This task ${outcome === 'failed' ? 'FAILED with an error' : 'was BLOCKED after multiple retries'}. Focus on:
- Root cause analysis: why did it fail?
- What approach should be used instead?
- Should this type of task be avoided or attempted differently?
- What preconditions were missing?`;

  return `Analyze this task and extract reusable programming experiences.

Task: ${taskDescription}
Outcome: ${outcome}
Result: ${result}
Review: ${reviewSummary}

${outcomeGuidance}

Also evaluate:
- Were there opportunities to simplify the approach?
- Did the task add unnecessary complexity?
- Could the same result be achieved with less code?

Output as JSON:
{
  "experiences": [{
    "category": "habit"|"experience"|"standard"|"workflow"|"framework"|"failure"|"simplification",
    "title": string,
    "content": string,
    "tags": [string]
  }],
  "taskSummary": string,
  "adjustments": [string]
}`;
}
