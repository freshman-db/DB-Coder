export interface AgentResult {
  success: boolean;
  output: string;
  cost_usd: number;
  duration_ms: number;
  structured?: unknown;
  sessionId?: string; // session/thread ID for resume support
  toolSummaries?: string[]; // SDK tool_use_summary messages (zero-cost)
  numTurns?: number; // SDK result.num_turns
  stopReason?: string; // SDK result.stop_reason (e.g. 'maxTurns')
}

export interface PreExistingIssue {
  description: string;
  file?: string;
  severity?: string;
}

export interface ReviewResult {
  passed: boolean;
  issues: ReviewIssue[];
  summary: string;
  cost_usd: number;
  preExistingIssues?: PreExistingIssue[];
}

export interface ReviewIssue {
  severity: "critical" | "high" | "medium" | "low";
  description: string;
  file?: string;
  line?: number;
  suggestion?: string;
  source: "claude" | "codex";
  confidence?: number; // 0-1, undefined treated as 1.0
}

export interface CodingAgent {
  name: string;

  /** Execute a task in the given working directory */
  execute(
    prompt: string,
    cwd: string,
    options?: {
      systemPrompt?: string;
      maxTurns?: number;
      maxBudget?: number;
      timeout?: number;
    },
  ): Promise<AgentResult>;

  /** Plan mode: analyze without modifying files */
  plan(
    prompt: string,
    cwd: string,
    options?: {
      systemPrompt?: string;
      maxTurns?: number;
    },
  ): Promise<AgentResult>;

  /** Review code changes */
  review(prompt: string, cwd: string): Promise<ReviewResult>;

  /** Check if the agent is available */
  isAvailable(): Promise<boolean>;
}
