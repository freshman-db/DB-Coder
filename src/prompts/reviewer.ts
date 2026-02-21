export function reviewerPrompt(
  taskDescription: string,
  changedFiles: string,
): string {
  return `Review the code changes for this task.

## Task Description
${taskDescription}

## Changed Files
${changedFiles}

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
