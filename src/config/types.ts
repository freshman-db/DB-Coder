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
  disabled?: string[];                       // servers to skip
  custom?: Record<string, { command?: string; args?: string[]; type?: string; url?: string; headers?: Record<string, string> }>;
}

export interface ServerConfig {
  port: number;
  host: string;
}

export interface DbCoderConfig {
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
}

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};
