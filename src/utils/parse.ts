import type {
  PreExistingIssue,
  ReviewIssue,
  ReviewResult,
} from "../bridges/CodingAgent.js";
import { SUMMARY_PREVIEW_LEN } from "../types/constants.js";

export const VALID_SEVERITIES = new Set([
  "critical",
  "high",
  "medium",
  "low",
] as const);
export type ValidSeverity = "critical" | "high" | "medium" | "low";

export function truncate(value: string, maxLen: number): string {
  return value.length <= maxLen ? value : value.slice(0, maxLen) + "…";
}

export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePreExistingIssues(raw: unknown): PreExistingIssue[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is Record<string, unknown> =>
        isRecord(item) && typeof item.description === "string",
    )
    .map((item) => ({
      description: String(item.description),
      file: typeof item.file === "string" ? item.file : undefined,
      severity: typeof item.severity === "string" ? item.severity : undefined,
    }));
}

export function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function findBalancedJson(
  text: string,
  matcher?: (value: unknown) => boolean,
): unknown | null {
  if (text.length === 0) return null;

  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{") continue;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let end = start; end < text.length; end++) {
      const ch = text[end];

      if (escape) {
        escape = false;
        continue;
      }

      if (ch === "\\" && inString) {
        escape = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === "{") {
        depth++;
        continue;
      }

      if (ch !== "}") continue;
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
  if (typeof text !== "string") return null;
  return findBalancedJson(text, matcher);
}

/**
 * Parse a reviewer response that may include prose around the JSON payload.
 *
 * @param text Raw reviewer output text.
 * @returns Parsed review result without `cost_usd`.
 */
export function tryParseReview(text: string): Omit<ReviewResult, "cost_usd"> {
  const output = typeof text === "string" ? text : "";
  const parsed = extractJsonFromText(
    output,
    (value) =>
      isRecord(value) && Object.prototype.hasOwnProperty.call(value, "passed"),
  );

  if (isRecord(parsed)) {
    return {
      passed: Boolean(parsed.passed),
      issues: Array.isArray(parsed.issues)
        ? parsed.issues
            .filter(
              (issue): issue is ReviewIssue =>
                isRecord(issue) &&
                typeof issue.description === "string" &&
                typeof issue.severity === "string" &&
                VALID_SEVERITIES.has(issue.severity as ValidSeverity),
            )
            .map((issue) => ({
              description: String(issue.description),
              severity: issue.severity as ReviewIssue["severity"],
              file: typeof issue.file === "string" ? issue.file : undefined,
              line: typeof issue.line === "number" ? issue.line : undefined,
              suggestion:
                typeof issue.suggestion === "string"
                  ? issue.suggestion
                  : undefined,
              source:
                issue.source === "claude" || issue.source === "codex"
                  ? issue.source
                  : "claude",
              confidence:
                typeof issue.confidence === "number"
                  ? issue.confidence
                  : undefined,
            }))
        : [],
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      preExistingIssues: parsePreExistingIssues(parsed.preExistingIssues),
    };
  }

  // Fallback: try to extract structured findings from Markdown-formatted text.
  // Codex often outputs numbered lists like:
  //   1. High — `src/file.ts:42`: description...
  //   2. Critical — description without file ref...
  const markdownIssues = extractMarkdownFindings(output);
  return {
    // fail-closed: without valid JSON, never auto-pass.
    // If Markdown issues were found, they become actionable; if not, we can't confirm a pass.
    passed: false,
    issues: markdownIssues,
    summary: output.slice(0, SUMMARY_PREVIEW_LEN),
  };
}

/**
 * Extract review findings from Markdown-formatted text.
 *
 * Supports two formats:
 *   Severity-prefixed: "1. High — `file.ts:10`: description"
 *   Codex style:       "- `file.ts:10` — description"
 */
function extractMarkdownFindings(text: string): ReviewIssue[] {
  const issues: ReviewIssue[] = [];

  // Pattern 1: severity-prefixed (numbered or bullet)
  //   "1. High — `file:line`: desc" or "- Critical — desc"
  const severityPattern =
    /^(?:\d+\.\s*|-\s*)\*{0,2}(critical|high|medium|low)\*{0,2}\s*(?:—|[-–:])\s*(?:`([^`]+?(?::(\d+))?)`[:\s]*)?(.+)/gim;

  for (const match of text.matchAll(severityPattern)) {
    const severity = match[1].toLowerCase();
    if (!VALID_SEVERITIES.has(severity as ValidSeverity)) continue;
    const description = match[4].trim();
    if (!description) continue;

    issues.push({
      severity: severity as ReviewIssue["severity"],
      description,
      file: match[2] ?? undefined,
      line: match[3] ? Number(match[3]) : undefined,
      source: "codex",
    });
  }

  if (issues.length > 0) return issues;

  // Pattern 2: Codex-style findings without explicit severity
  //   "- `file:line` — description"
  //   "- `file:line` + `file2:line2` — description"
  const codexPattern =
    /^[-*]\s+`([^`]+?):(\d+)`(?:\s*(?:\+|and|,)\s*`[^`]+`)*\s*(?:—|[-–])\s*(.+)/gim;

  for (const match of text.matchAll(codexPattern)) {
    const description = match[3].trim();
    if (!description) continue;

    issues.push({
      severity: inferSeverity(description),
      description,
      file: `${match[1]}:${match[2]}`,
      line: Number(match[2]),
      source: "codex",
    });
  }

  return issues;
}

/** Infer severity from description text when not explicitly provided. */
function inferSeverity(description: string): ReviewIssue["severity"] {
  const lower = description.toLowerCase();
  if (
    /\b(inject(?:ion)?|xss|sqli|rce|vulnerab|credential|secret|exploit)\b/.test(
      lower,
    )
  )
    return "critical";
  if (
    /\b(race\s*condition|null\s*deref|undefined\s*behavior|data\s*loss|hang|deadlock)\b/.test(
      lower,
    )
  )
    return "high";
  if (/\b(swallow|silent|ignor|under-validat|inconsisten)\b/.test(lower))
    return "medium";
  return "high";
}

export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
