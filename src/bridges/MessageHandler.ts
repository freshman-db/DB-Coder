import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { log } from '../utils/logger.js';

/** Handler for auto-answering AskUserQuestion calls in non-interactive mode */
export interface QuestionHandler {
  answerQuestion(question: string, options: string[], taskContext: string): Promise<string>;
}

/**
 * Build a canUseTool callback that auto-answers AskUserQuestion.
 * In bypassPermissions mode, AskUserQuestion still triggers canUseTool
 * because requiresUserInteraction() returns true and short-circuits the bypass.
 */
export function buildCanUseTool(
  handler: QuestionHandler,
  taskContext: string,
): CanUseTool {
  return async (toolName, input, _options) => {
    if (toolName === 'AskUserQuestion') {
      try {
        const questions = (input.questions ?? []) as Array<{
          question: string;
          options: Array<{ label: string; description?: string }>;
          multiSelect?: boolean;
        }>;
        const answers: Record<string, string> = {};
        for (const q of questions) {
          const labels = (q.options ?? []).map(o => o.label);
          const answer = await handler.answerQuestion(q.question, labels, taskContext);
          answers[q.question] = answer;
        }
        log.info(`Auto-answered ${questions.length} question(s) from AskUserQuestion`);
        return { behavior: 'allow' as const, updatedInput: { ...input, answers } };
      } catch (err) {
        log.warn('Failed to auto-answer AskUserQuestion, allowing with defaults', err);
      }
    }
    // Allow all other tools (bypassPermissions handles most cases)
    return { behavior: 'allow' as const };
  };
}
