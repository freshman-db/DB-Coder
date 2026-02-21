export function reviewerPrompt(
  taskDescription: string,
  changedFiles: string,
  mcpServerNames?: string[],
  agentGuidance: string = '',
): string {
  const mcpSection = buildReviewMcpSection(mcpServerNames);

  return `Review the code changes for this task.

## Task Description
${taskDescription}

## Changed Files
${changedFiles}
${mcpSection}
${agentGuidance}
## Review Strategy
If specialized review agents are available above, use the Task tool to spawn 2-3 most relevant agents in parallel based on the nature of changes. Synthesize their reports with your own assessment.

## Your Direct Review (always do these yourself)
1. **Correctness**: Does the code do what the task requires?
2. **Security**: Any injection, XSS, path traversal, or auth issues?
3. **Breaking changes**: Does it break existing functionality?
4. **Convention consistency**: Does it follow project patterns?

Run tests if a test command is available (npm test, pytest, etc.).
Check for linting issues if a linter is configured.

## Skills & Memory
You have access to specialized review skills and persistent memory:
- Search past review patterns: use \`/mem-search <query>\` to find common issues and review feedback from previous tasks
- Save discovered patterns and recurring issues to memory for future reference

Output your review as JSON:
{
  "passed": boolean,
  "issues": [{
    "severity": "critical"|"high"|"medium"|"low",
    "description": string,
    "file": string,
    "line": number,
    "suggestion": string
  }],
  "summary": string
}`;
}

function buildReviewMcpSection(serverNames?: string[]): string {
  if (!serverNames?.length) return '';
  const tips: string[] = [];
  if (serverNames.includes('serena')) {
    tips.push(`- **Serena**: Use find_referencing_symbols to verify that changed APIs don't break callers. Use get_symbols_overview to check structural integrity.`);
  }
  if (serverNames.includes('playwright')) {
    tips.push(`- **Playwright**: For frontend changes — navigate to the page and take a snapshot to verify UI renders correctly.`);
  }
  if (serverNames.includes('greptile')) {
    tips.push(`- **Greptile**: Search for related patterns or similar past review feedback.`);
  }
  return `\n## Available MCP Tools for Review\n${tips.join('\n')}\n`;
}
