export function executorPrompt(
  taskDescription: string,
  subtaskDescription: string,
  standards: string,
  context: string,
): string {
  return `You are executing a coding task. Complete it carefully and thoroughly.

## Task
${taskDescription}

## Current Subtask
${subtaskDescription}

## Coding Standards (from experience)
${standards || 'No specific standards yet. Follow best practices.'}

## Context
${context || 'No additional context.'}

## Instructions
1. Read relevant files before making changes
2. Make focused, minimal changes for this subtask
3. Ensure code compiles/passes linting
4. Add tests if appropriate
5. Commit your changes with a clear message

Do NOT modify files outside the scope of this subtask.`;
}
