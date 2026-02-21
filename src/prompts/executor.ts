export function executorPrompt(
  taskDescription: string,
  subtaskDescription: string,
  standards: string,
  context: string,
  mcpServerNames?: string[],
): string {
  const mcpSection = buildMcpSection(mcpServerNames);

  return `You are executing a coding task. Complete it carefully and thoroughly.

## Task
${taskDescription}

## Current Subtask
${subtaskDescription}

## Coding Standards (from experience)
${standards || 'No specific standards yet. Follow best practices.'}

## Context
${context || 'No additional context.'}
${mcpSection}
## Skills & Memory
You have access to specialized skills and persistent memory. Use them proactively:
- Before starting complex work, search for past solutions: use \`/mem-search <query>\` to find relevant experiences from previous tasks
- For complex multi-file features, use \`/feature-dev\` for guided architecture-aware development
- PR review agents are available via the Task tool for specialized reviews (silent-failure-hunter, code-reviewer, pr-test-analyzer)
- Save important discoveries and patterns to memory using the save_memory tool

## Instructions
1. Read relevant files before making changes
2. Make focused, minimal changes for this subtask
3. Ensure code compiles/passes linting
4. Add tests if appropriate
5. Commit your changes with a clear message
6. Prefer simple, clear solutions — avoid over-engineering
7. Use available skills and agents when they add value:
   - \`/feature-dev\` for complex multi-file features
   - code-explorer agent (Task tool) for understanding unfamiliar code
   - code-architect agent (Task tool) for designing new components

Do NOT modify files outside the scope of this subtask.`;
}

function buildMcpSection(serverNames?: string[]): string {
  if (!serverNames?.length) return '';
  const tips: string[] = [];
  if (serverNames.includes('serena')) {
    tips.push(`- **Serena**: Use for precise refactoring — find_symbol to locate code, find_referencing_symbols to trace all callers before renaming/changing APIs, replace_symbol_body for safe edits.`);
  }
  if (serverNames.includes('context7')) {
    tips.push(`- **Context7**: Look up library documentation — resolve-library-id then query-docs when you need API details for unfamiliar packages.`);
  }
  if (serverNames.includes('playwright')) {
    tips.push(`- **Playwright**: For frontend tasks — use browser_navigate + browser_snapshot to verify UI changes visually.`);
  }
  if (serverNames.includes('github')) {
    tips.push(`- **GitHub**: Use for PR/issue operations if needed.`);
  }
  return `\n## Available MCP Tools\nYou have access to these MCP tool servers. Use them when they provide value:\n${tips.join('\n')}\n`;
}
