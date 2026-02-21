export const BRAIN_SYSTEM_PROMPT = `You are the Brain of db-coder, an autonomous AI coding agent.
You act as a "technical lead" — you analyze codebases, identify improvements, plan tasks, and extract lessons learned.

Your core principles:
1. Quality over quantity — prefer fewer, high-impact changes
2. Safety first — never modify protected branches directly
3. Incremental improvement — small, reviewable changes
4. Learn from mistakes — extract reusable patterns

You have access to read-only tools. Analyze code but DO NOT modify files.`;

export function scanPrompt(projectPath: string, depth: string, recentChanges: string, memories: string, goalsSection: string = ''): string {
  return `Scan the project at ${projectPath}.
Scan depth: ${depth}

Recent changes:
${recentChanges || 'No recent changes detected.'}

Relevant memories from past experience:
${memories || 'No relevant memories yet.'}
${goalsSection}
Analyze the project by:
1. Reading key files (package.json, README, config files, main source files)
2. Running git log to understand recent activity
3. Searching for TODO/FIXME/HACK comments
4. Checking for common code quality issues
5. Evaluating test coverage structure
6. Looking for security concerns
${goalsSection ? '7. Evaluating progress toward evolution goals' : ''}

Output your analysis as JSON with this exact structure:
{
  "issues": [{ "type": string, "severity": "critical"|"high"|"medium"|"low", "description": string, "file": string, "suggestion": string }],
  "opportunities": [{ "type": string, "severity": "medium"|"low", "description": string, "suggestion": string }],
  "projectHealth": number (0-100),
  "summary": string
}`;
}

export function planPrompt(analysis: string, memories: string, existingTasks: string, goalsSection: string = ''): string {
  return `Based on this project analysis, create a prioritized task plan.

Analysis:
${analysis}

Relevant memories:
${memories || 'None'}

Existing tasks (queued, completed, and blocked — DO NOT create duplicates):
${existingTasks || 'None'}
${goalsSection}
Create tasks with priorities:
- P0: Critical bugs, security issues
- P1: Important improvements, failing tests
- P2: Code quality, refactoring
- P3: Nice-to-have, optimizations

IMPORTANT: Do NOT create tasks that duplicate or closely resemble existing tasks listed above (regardless of their status). If a task was already done or blocked, do not retry it unless you have a fundamentally different approach.

Route each task:
- Frontend tasks (UI, components, styles, pages) → executor: "claude"
- Backend tasks (API, database, logic, tests) → executor: "codex"
- Full-stack → split into subtasks with appropriate executors

Output as JSON:
{
  "tasks": [{
    "id": string,
    "description": string,
    "priority": number (0-3),
    "executor": "claude"|"codex",
    "subtasks": [{ "id": string, "description": string, "executor": "claude"|"codex" }],
    "dependsOn": [task_id],
    "estimatedComplexity": "low"|"medium"|"high"
  }],
  "reasoning": string
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

Output as JSON:
{
  "experiences": [{
    "category": "habit"|"experience"|"standard"|"workflow"|"framework"|"failure",
    "title": string,
    "content": string,
    "tags": [string]
  }],
  "taskSummary": string,
  "adjustments": [string]
}`;
}
