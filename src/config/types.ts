export interface BrainConfig {
  model: string;
  scanInterval: number; // seconds between scans
  maxScanBudget: number; // USD per scan
}

export interface ClaudeConfig {
  model: string;
  maxTaskBudget: number; // USD per task
  maxTurns: number;
}

export interface CodexConfig {
  model: string;
  sandbox: 'workspace-write' | 'workspace-read' | 'full-auto';
}

export interface AutonomyConfig {
  level: 'full' | 'supervised';
  maxRetries: number;
  subtaskTimeout: number; // seconds
}

export interface RoutingConfig {
  scan: 'brain';
  plan: 'brain';
  execute_frontend: 'claude';
  execute_backend: 'codex';
  review: Array<'claude' | 'codex'>;
  reflect: 'brain';
}

export interface BudgetConfig {
  maxPerTask: number; // USD
  maxPerDay: number;  // USD
  warningThreshold: number; // 0-1
}

export interface MemoryConfig {
  claudeMemUrl: string;
  pgConnectionString: string;
}

export interface GitConfig {
  branchPrefix: string;
  protectedBranches: string[];
}

export interface McpConfig {
  enabled: boolean;
  serverPhases?: Record<string, string[]>;  // override default phase routing
  disabled?: string[];                       // MCP servers to skip
  disabledPlugins?: string[];                // plugins to not load into subprocesses
  custom?: Record<string, { command?: string; args?: string[]; type?: string; url?: string; headers?: Record<string, string> }>;
}

export interface ServerConfig {
  port: number;
  host: string;
}

export interface EvolutionGoal {
  description: string;
  priority: number; // 0-3
  status?: 'active' | 'paused' | 'done';
  progress?: number; // 0-100, computed from goal_progress table
  completedAt?: string; // ISO date when marked done
}

export interface EvolutionConfig {
  goals: EvolutionGoal[];
  architectureNotes?: string;
  autoConfigUpdate?: boolean; // default false — auto-apply safe config proposals
  maxAdjustmentsPerPrompt?: number; // default 5
  trendWindowSize?: number; // default 10 — number of recent scans for trend analysis
}

export interface DbCoderConfig {
  apiToken: string;
  brain: BrainConfig;
  claude: ClaudeConfig;
  codex: CodexConfig;
  autonomy: AutonomyConfig;
  routing: RoutingConfig;
  budget: BudgetConfig;
  memory: MemoryConfig;
  git: GitConfig;
  server: ServerConfig;
  mcp: McpConfig;
  evolution: EvolutionConfig;
}

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};
