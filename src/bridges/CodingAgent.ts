export interface AgentResult {
  success: boolean;
  output: string;
  cost_usd: number;
  duration_ms: number;
  structured?: unknown;
  toolSummaries?: string[];  // SDK tool_use_summary messages (zero-cost)
  numTurns?: number;         // SDK result.num_turns
  stopReason?: string;       // SDK result.stop_reason (e.g. 'maxTurns')
}

export interface ReviewResult {
  passed: boolean;
  issues: ReviewIssue[];
  summary: string;
  cost_usd: number;
}

export interface ReviewIssue {
  severity: 'critical' | 'high' | 'medium' | 'low';
  description: string;
  file?: string;
  line?: number;
  suggestion?: string;
  source: 'claude' | 'codex';
}

export interface CodingAgent {
  name: string;

  /** Execute a task in the given working directory */
  execute(prompt: string, cwd: string, options?: {
    systemPrompt?: string;
    maxTurns?: number;
    maxBudget?: number;
    timeout?: number;
  }): Promise<AgentResult>;

  /** Plan mode: analyze without modifying files */
  plan(prompt: string, cwd: string, options?: {
    systemPrompt?: string;
    maxTurns?: number;
  }): Promise<AgentResult>;

  /** Review code changes */
  review(prompt: string, cwd: string): Promise<ReviewResult>;

  /** Check if the agent is available */
  isAvailable(): Promise<boolean>;
}
