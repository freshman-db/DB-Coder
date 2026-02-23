import type { ReviewResult } from '../bridges/CodingAgent.js';

export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findBalancedJson(
  text: string,
  matcher?: (value: unknown) => boolean,
): unknown | null {
  if (text.length === 0) return null;

  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{') continue;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let end = start; end < text.length; end++) {
      const ch = text[end];

      if (escape) {
        escape = false;
        continue;
      }

      if (ch === '\\' && inString) {
        escape = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === '{') {
        depth++;
        continue;
      }

      if (ch !== '}') continue;
      depth--;

      if (depth !== 0) continue;

      const candidate = text.slice(start, end + 1);
      try {
        const parsed = JSON.parse(candidate) as unknown;
        if (!matcher || matcher(parsed)) {
          return parsed;
        }
      } catch {
        // Ignore parse errors and continue scanning the remaining text.
      }
      break;
    }
  }

  return null;
}

/**
 * Find and parse the first valid balanced JSON object embedded in text.
 *
 * @param text Input text that may contain JSON and free-form commentary.
 * @param matcher Optional predicate used to pick a specific JSON object.
 * @returns Parsed JSON value, or `null` when none can be parsed.
 */
export function extractJsonFromText(
  text: string,
  matcher?: (value: unknown) => boolean,
): unknown | null {
  if (typeof text !== 'string') return null;
  return findBalancedJson(text, matcher);
}

/**
 * Parse a reviewer response that may include prose around the JSON payload.
 *
 * @param text Raw reviewer output text.
 * @returns Parsed review result without `cost_usd`.
 */
export function tryParseReview(text: string): Omit<ReviewResult, 'cost_usd'> {
  const output = typeof text === 'string' ? text : '';
  const parsed = extractJsonFromText(
    output,
    (value) => isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'passed'),
  );

  if (isRecord(parsed)) {
    return {
      passed: Boolean(parsed.passed),
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    };
  }

  const hasIssues = /critical|error|bug|vulnerability|security/i.test(output);
  return {
    passed: !hasIssues,
    issues: [],
    summary: output.slice(0, 500),
  };
}

export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
