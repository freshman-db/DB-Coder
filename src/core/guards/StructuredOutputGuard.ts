import type { CycleEvent } from '../CycleEvents.js';
import { log } from '../../utils/logger.js';

const CONVERSATIONAL_PREFIXES = [
  'sure', 'i think', 'i believe', 'great', 'ok', 'okay',
  'absolutely', 'of course', 'no problem', 'let me',
  'i\'ll', 'i will', 'i can', 'well,',
];

const MIN_TASK_LENGTH = 20;

export class StructuredOutputGuard {
  async handle(event: CycleEvent): Promise<void> {
    const rawText = event.data.rawText as string | undefined;
    if (!rawText) return;

    const trimmed = rawText.trim();

    try {
      JSON.parse(trimmed);
      return;
    } catch {
      // not JSON, check as plain text
    }

    if (trimmed.length < MIN_TASK_LENGTH) {
      log.warn('StructuredOutputGuard: text too short', { length: trimmed.length });
      throw new Error(`Brain output too short (${trimmed.length} chars)`);
    }

    const lower = trimmed.toLowerCase();
    for (const prefix of CONVERSATIONAL_PREFIXES) {
      if (lower.startsWith(prefix)) {
        log.warn('StructuredOutputGuard: conversational text detected', { prefix, text: trimmed.slice(0, 80) });
        throw new Error(`Brain output looks conversational (starts with "${prefix}")`);
      }
    }
  }
}
