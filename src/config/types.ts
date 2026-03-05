export interface ChainScanConfig {
  enabled: boolean;
  interval: number; // trigger every N completed tasks (default 5)
  maxBudget: number; // max USD per scan trigger (default 3.0)
  chainsPerTrigger: number; // how many chains to scan per trigger (default 2)
  rediscoveryInterval: number; // re-discover entry points every N scans (default 10)
}

export interface BrainConfig {
  model: string;
  scanInterval: number; // seconds between scans
  maxScanBudget: number; // USD per scan
  claudeMdMaintenanceInterval: number; // trigger every N completed tasks (0=disabled)
  claudeMdMaintenanceEnabled: boolean;
  chainScan: ChainScanConfig;
  language: string; // task description language, default "简体中文"
}

export interface ClaudeConfig {
  model: string;
  maxTaskBudget: number; // USD per task
  maxTurns: number;
}

export interface TokenPricing {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
}

export interface CodexConfig {
  model: string;
  sandbox: "workspace-write" | "workspace-read" | "full-auto";
  tokenPricing?: TokenPricing;
  reviewTimeout?: number; // seconds, default 1800 (30min)
  planTimeout?: number; // seconds, default 900 (15min)
}

export interface AutonomyConfig {
  level: "full" | "supervised";
  maxRetries: number;
  retryBaseDelayMs: number;
  subtaskTimeout: number; // seconds
  worker: "claude" | "codex"; // which worker executes coding tasks; reviewer auto-selects the opposite (default "claude")
  maxReviewFixes: number; // max rounds of fix-after-review (default 1)
}

export interface RoutingConfig {
  scan: "brain";
  plan: "brain";
  execute_frontend: "claude";
  execute_backend: "codex";
  reflect: "brain";
}

export interface BudgetConfig {
  maxPerTask: number; // USD
  maxPerDay: number; // USD
  warningThreshold: number; // 0-1
}

export interface MemoryConfig {
  claudeMemUrl: string;
  pgConnectionString: string;
}

export interface GitConfig {
  branchPrefix: string;
  protectedBranches: string[];
  branchRetentionDays: number;
}

export interface McpConfig {
  enabled: boolean;
  serverPhases?: Record<string, string[]>; // override default phase routing
  disabled?: string[]; // MCP servers to skip
  disabledPlugins?: string[]; // plugins to not load into subprocesses
  custom?: Record<
    string,
    {
      command?: string;
      args?: string[];
      type?: string;
      url?: string;
      headers?: Record<string, string>;
    }
  >;
}

export interface ServerConfig {
  port: number;
  host: string;
}

export interface EvolutionGoal {
  description: string;
  priority: number; // 0-3
  status?: "active" | "paused" | "done";
  progress?: number; // 0-100, computed from goal_progress table
  completedAt?: string; // ISO date when marked done
}

export interface EvolutionConfig {
  goals: EvolutionGoal[];
}

export type PluginRelevance =
  | "essential"
  | "recommended"
  | "optional"
  | "irrelevant";

export interface PluginConfig {
  autoUpdate?: boolean; // default false — auto-update installed plugins
  autoInstallRecommended?: boolean; // default false — auto-install recommended plugins
  checkInterval?: number; // default 86400 (24h, seconds)
  relevanceOverrides?: Record<string, PluginRelevance>; // manual plugin relevance
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
  plugins: PluginConfig;
  evolution: EvolutionConfig;
}

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};
