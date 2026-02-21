export function extractorPrompt(
  taskDescription: string,
  result: string,
  reviewSummary: string,
): string {
  return `Analyze this completed coding task and extract reusable programming experiences.

## Task
${taskDescription}

## Result
${result}

## Review Feedback
${reviewSummary}

## What to Extract
Focus on general, cross-project lessons:
- **habit**: Personal coding practices (e.g., "always check null before access")
- **experience**: Problem-solving insights (e.g., "PostgreSQL JSONB queries need GIN index for performance")
- **standard**: Code quality rules (e.g., "always validate user input at API boundaries")
- **workflow**: Process improvements (e.g., "run tests before committing")
- **framework**: Framework-specific knowledge (e.g., "React useEffect cleanup prevents memory leaks")
- **simplification**: Code simplification insights (e.g., "replaced 3 utility functions with a single generic helper")

Only extract genuinely useful, non-obvious insights. Skip trivial observations.

Output as JSON:
{
  "experiences": [{
    "category": "habit"|"experience"|"standard"|"workflow"|"framework"|"simplification",
    "title": string (concise, action-oriented),
    "content": string (detailed explanation),
    "tags": [string]
  }],
  "taskSummary": string (brief summary of what was done),
  "adjustments": [string] (suggested changes to future behavior)
}`;
}
