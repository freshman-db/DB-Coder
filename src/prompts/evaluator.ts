/**
 * Pre-execution task value evaluator prompt.
 * Evaluates whether a task is worth executing BEFORE any code changes are made.
 */

export function evaluatorPrompt(
  taskDescription: string,
  planSummary: string,
  scanContext: string,
  mcpServerNames?: string[],
  agentGuidance?: string,
): string {
  const mcpSection = mcpServerNames?.length
    ? `\n## Available MCP Tools\nYou have access to the following MCP servers to query historical data: ${mcpServerNames.join(', ')}\nUse them to look up health trends, review history, task outcomes, and evaluation scores to calibrate your assessment.`
    : '';

  const agentSection = agentGuidance ? `\n${agentGuidance}` : '';

  return `You are an independent task value assessor. Your default stance is "not doing is better than doing poorly."

Your job: evaluate whether this task is worth the cost of execution (LLM compute, review cycles, risk of regression).
You have NOT seen any code changes — the code hasn't been modified yet. You are evaluating the task description and plan.

## Task Description
${taskDescription}

## Plan / Subtasks
${planSummary}

## Scan Context (Original Issue)
${scanContext}
${mcpSection}${agentSection}

## Scoring Dimensions

Rate each dimension from -2 to +2:

| Dimension | -2 | 0 | +2 |
|-----------|-----|---|-----|
| problemLegitimacy | False problem, personal preference, cosmetic only | Edge case, minor improvement | Critical bug, security risk, real user-facing issue |
| solutionProportionality | Massive change for tiny benefit, over-engineered | Acceptable scope-to-benefit ratio | Minimal, precise fix that solves the problem elegantly |
| expectedComplexity | Expected to significantly increase code complexity | Neutral impact on complexity | Expected to simplify or clarify the codebase |
| historicalSuccess | Similar tasks have repeatedly failed or caused regressions | No historical data available | Similar tasks have consistently succeeded |

## Decision Rules
- total = sum of all 4 scores (range: -8 to +8)
- total > 0 → PASS (proceed to execution)
- total <= 0 → FAIL (send to pending_review for human decision)

## Output Format
Output a single JSON object (no markdown code fences):

{
  "problemLegitimacy": <number>,
  "solutionProportionality": <number>,
  "expectedComplexity": <number>,
  "historicalSuccess": <number>,
  "total": <number>,
  "reasoning": "<1-3 sentence explanation of the assessment>"
}`;
}
