import type { DynamicPromptContext } from '../evolution/types.js';

export function formatDynamicContext(ctx?: DynamicPromptContext): string {
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

IMPORTANT: Be proactive. Even if there are no bugs or critical issues, look for improvement opportunities:
- Code that could be simplified or made more readable
- Missing error handling, edge cases, or input validation
- Functions that are too long (>50 lines) or do too much
- Missing or outdated tests
- Performance improvements (unnecessary allocations, N+1 queries, etc.)
- Documentation gaps for public APIs
- Dependency updates or security advisories
If the project health is below 80, you MUST report at least one issue or opportunity.

Your response MUST end with a JSON object (no markdown code fences). Output this exact structure:
{
  "issues": [{ "type": string, "severity": "critical"|"high"|"medium"|"low", "description": string, "file": string, "suggestion": string }],
  "opportunities": [{ "type": string, "severity": "medium"|"low", "description": string, "suggestion": string }],
  "codeMetrics": { "typeErrors": number, "longFunctions": [{ "file": string, "name": string, "lines": number }], "duplicatePatterns": [{ "files": [string], "description": string }], "deadCode": [{ "file": string, "description": string }] },
  "simplificationTargets": [{ "file": string, "description": string, "complexity": string, "suggestion": string }],
  "featureGaps": [{ "area": string, "description": string, "suggestion": string }],
  "projectHealth": number (0-100),
  "summary": string
}

Do NOT wrap the JSON in markdown code fences. Output the raw JSON object directly.`;
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

export function identifyModulesPrompt(projectPath: string, mcpGuidance: string = ''): string {
  return `Analyze the project at ${projectPath} and identify its main functional modules (feature flows).

A "module" is NOT a directory — it is a complete **functional data flow** through the codebase.
For example:
- "patrol-cycle": MainLoop.runCycle → Brain.scanProject → Brain.createPlan → executor → reviewer → Brain.reflectOnTask
- "evolution-feedback": EvolutionEngine.synthesizePromptContext → formatDynamicContext → prompt injection → reflectOnTask → adjustment update
- "plan-chat": PlanWorkflow → ChatSession → AsyncChannel → ClaudeBridge → SSE → routes → web UI

${mcpGuidance}

## Instructions
1. Read the project structure and key source files
2. Identify 3-8 major functional flows (not too many, not too few)
3. For each flow, trace the data path from entry to exit

## Output
Your response MUST end with a JSON array (no markdown code fences):
[
  {
    "name": "kebab-case-name",
    "description": "One-sentence description of what this flow does",
    "entryPoints": ["ClassName.methodName", "file.ts:functionName"],
    "involvedFiles": ["src/path/to/file.ts", ...],
    "dataFlow": "Step-by-step description: A calls B with X, B transforms to Y, Y is stored in Z..."
  }
]

Focus on flows that matter for correctness — where bugs are likely to hide at boundaries between components.
Do NOT wrap the JSON in markdown code fences. Output the raw JSON array directly.`;
}

export function moduleTracePrompt(
  projectPath: string,
  moduleName: string,
  description: string,
  entryPoints: string[],
  involvedFiles: string[],
  dataFlow: string,
  depth: 'quick' | 'normal' = 'normal',
  mcpGuidance: string = '',
  dynamicContext?: DynamicPromptContext,
): string {
  const depthGuidance = depth === 'quick'
    ? 'This is a quick scan. Focus on the most critical paths only. Spend less time on edge cases.'
    : 'This is a normal-depth scan. Thoroughly trace the data flow and check all boundary conditions.';

  return `Deep-audit the functional module **${moduleName}** in the project at ${projectPath}.

## Module Description
${description}

## Entry Points
${entryPoints.map(e => `- ${e}`).join('\n')}

## Involved Files
${involvedFiles.map(f => `- ${f}`).join('\n')}

## Data Flow
${dataFlow}
${mcpGuidance}
${formatDynamicContext(dynamicContext)}

## Scan Depth
${depthGuidance}

## Audit Requirements
1. **Trace the data flow**: Start from each entry point and follow the data through every function call in the chain
2. **Boundary checks**: At each function boundary, check:
   - Can parameters be null/undefined/empty array when they shouldn't be?
   - Are types correctly propagated (no implicit any, no unsafe casts)?
3. **First-run vs steady-state**: Check behavior differences when:
   - Database tables are empty (first run)
   - Previous data exists but is stale or corrupted
4. **Error propagation**: For each try-catch:
   - Is the error logged with enough context to debug?
   - Is it re-thrown when it should be, or silently swallowed?
   - Does the fallback behavior mask real problems?
5. **Data transformation correctness**: At each step where data is transformed:
   - Does the output type match what the next step expects?
   - Are edge cases handled (empty string, zero, negative numbers)?
6. **Logic completeness**: Check for:
   - Dead code or unreachable branches
   - Missing cases in switch/if-else chains
   - Race conditions in async code

## Output Format
Your response MUST end with a JSON object (no markdown code fences):
{
  "issues": [{ "type": string, "severity": "critical"|"high"|"medium"|"low", "description": string, "file": string, "line": number, "suggestion": string }],
  "opportunities": [{ "type": string, "severity": "medium"|"low", "description": string, "suggestion": string }],
  "projectHealth": number (0-100, for this module specifically),
  "summary": string
}

Focus on LOGIC-LEVEL issues (wrong behavior, missing checks, data corruption risks), not surface-level code style.
Do NOT wrap the JSON in markdown code fences. Output the raw JSON object directly.`;
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

## Adjustment Quality Guidelines

Each adjustment MUST be a specific, actionable instruction with a clear trigger condition.

Good examples:
- "When adding a new public method to a class, always add a corresponding unit test in the same PR"
- "When modifying TypeScript interfaces, run tsc --noEmit before committing to catch type errors early"
- "Avoid adding try-catch blocks that silently swallow errors — always log or re-throw"
- "When a review flags missing error handling, check all similar functions in the same file"

Bad examples (too vague — do NOT produce these):
- "Write better tests"
- "Improve code quality"
- "Be more careful"
- "Handle errors properly"

If specific review issues are listed above, extract concrete lessons from them.

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
