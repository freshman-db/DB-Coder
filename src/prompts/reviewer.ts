export function reviewerPrompt(
  taskDescription: string,
  changedFiles: string,
  mcpServerNames?: string[],
): string {
  const mcpSection = buildReviewMcpSection(mcpServerNames);

  return `Review the code changes for this task.

## Task Description
${taskDescription}

## Changed Files
${changedFiles}
${mcpSection}
## Review Checklist
1. **Correctness**: Does the code do what the task requires?
2. **Quality**: Is it clean, readable, and well-structured?
3. **Security**: Any injection, XSS, path traversal, or auth issues?
4. **Tests**: Are there adequate tests? Do existing tests still pass?
5. **Performance**: Any obvious performance issues?
6. **Breaking changes**: Does it break existing functionality?

Run tests if a test command is available (npm test, pytest, etc.).
Check for linting issues if a linter is configured.

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
