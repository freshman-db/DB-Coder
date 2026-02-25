# EXACT SIGNATURES AND STRUCTURES — db-coder

## 1. ClaudeCodeSession (src/bridges/ClaudeCodeSession.ts)

### SessionOptions Interface
```typescript
export interface SessionOptions {
  permissionMode: "bypassPermissions" | "acceptEdits";
  maxBudget?: number;
  resumeSessionId?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  appendSystemPrompt?: string;
  jsonSchema?: object;
  cwd?: string;
  timeout?: number;
  maxTurns?: number;
  onText?: (text: string) => void;
  onEvent?: (event: SDKMessage) => void;
  model?: string;
}
```

### SessionResult Interface
```typescript
export interface SessionResult {
  text: string;
  json?: unknown;
  costUsd: number;
  sessionId: string;
  exitCode: number;
  numTurns: number;
  durationMs: number;
  isError: boolean;
  errors: string[];
  usage: TokenUsage;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}
```

### ClaudeCodeSession.run() Signature
```typescript
async run(prompt: string, opts: SessionOptions): Promise<SessionResult>
```

### ClaudeCodeSession.kill() Signature
```typescript
kill(): void
```

## 2. CodexBridge (src/bridges/CodexBridge.ts)

### execute() Signature
```typescript
async execute(prompt: string, cwd: string, options?: {
  systemPrompt?: string;
  maxTurns?: number;
  maxBudget?: number;
  timeout?: number;
  sandboxOverride?: CodexConfig['sandbox'];
}): Promise<AgentResult>
```

### review() Signature
```typescript
async review(prompt: string, cwd: string): Promise<ReviewResult>
```

### AgentResult Type (from CodingAgent.ts)
- success: boolean
- output: string
- cost_usd: number
- duration_ms: number
- structured?: unknown
- numTurns?: number
- stopReason?: 'timeout' | 'error' | undefined

### ReviewResult Type
- passed: boolean
- issues: Array<{ severity: string; description: string; source: string }>
- summary: string
- cost_usd: number
- preExistingIssues?: Array<{ description: string; file?: string; severity: string }>

## 3. MainLoop Constructor (src/core/MainLoop.ts)

### Constructor Signature
```typescript
constructor(
  private config: Config,
  private taskQueue: TaskQueue,
  private codex: CodexBridge,
  private taskStore: TaskStore,
  private costTracker: CostTracker,
  private eventBus: CycleEventBus = CycleEventBus.noop(),
  private sdkExtras?: SdkExtras,
  workerAdapter?: WorkerAdapter,
  reviewAdapter?: ReviewAdapter,
)
```
If workerAdapter/reviewAdapter not provided, auto-created based on config.values.autonomy.worker:
- worker="claude" → ClaudeWorkerAdapter + CodexReviewAdapter
- worker="codex" → CodexWorkerAdapter + ClaudeReviewAdapter

### Key Instance Variables
- brainSession: ClaudeCodeSession
- workerSession: ClaudeCodeSession
- worker: WorkerAdapter (ClaudeWorkerAdapter or CodexWorkerAdapter)
- reviewer: ReviewAdapter (CodexReviewAdapter or ClaudeReviewAdapter)
- chainScanner: ChainScanner
- personaLoader: PersonaLoader

## 4. MainLoop Core Methods

### runCycle() Signature
```typescript
async runCycle(): Promise<boolean>
```
Returns true if productive (a task was processed), false if idle.

Main pipeline:
1. Queue pickup or brainDecide
2. Create task record + budget check
3. Prepare git branch
4. **Analysis Phase** (M/L/XL only): workerAnalyze → reviewPlan → brainSynthesizePlan
5. Execute (subtasks or single-shot, with optional approvedPlan)
6. Hard verify + HALT retry loop
7. codeReview (mutual exclusion: worker=claude→codex, worker=codex→claude)
8. brainReviewDecision (5-way: fix/ignore/block/rewrite/split)
9. Optional workerReviewFix loop (max maxReviewFixes rounds)
10. Brain reflect
11. Merge/block/split based on decision
12. Periodic chain scan + CLAUDE.md maintenance
Note: specReview DEPRECATED, no longer called in runCycle

### brainDecide() Signature
```typescript
private async brainDecide(projectPath: string): Promise<{
  taskDescription: string | null;
  priority?: number;
  persona?: string;
  taskType?: string;
  complexity?: string;
  subtasks?: Array<{ description: string; order: number }>;
  workInstructions?: WorkInstructions;
  extraTasks?: Array<{
    task: string;
    priority: number;
    persona?: string;
    taskType?: string;
    complexity?: string;
    subtasks?: Array<{ description: string; order: number }>;
    workInstructions?: WorkInstructions;
  }>;
  costUsd: number;
}>
```

### brainThink() Signature
```typescript
private async brainThink(
  prompt: string,
  opts?: { jsonSchema?: object },
): Promise<SessionResult>
```
Calls brainSession.run() with:
- permissionMode: "bypassPermissions"
- maxTurns: 200
- disallowedTools: ["Edit", "Write", "NotebookEdit"]
- timeout: 300_000ms
- model: resolveModelId(brain.model)
- appendSystemPrompt: (read-only agent)

### workerExecute() Signature
```typescript
private async workerExecute(
  task: Task,
  opts?: {
    persona?: string;
    taskType?: string;
    complexity?: string;
    subtaskDescription?: string;
    workInstructions?: WorkInstructions;
    approvedPlan?: string;  // NEW: prepended to prompt if analysis phase produced a plan
  },
): Promise<SessionResult>
```
Now delegates to this.worker.execute() (WorkerAdapter) instead of direct workerSession.run().

### workerAnalyze() Signature (NEW)
```typescript
private async workerAnalyze(
  task: Task,
  brainOpts?: { persona?: string; complexity?: string; workInstructions?: WorkInstructions },
): Promise<{ proposal: string; costUsd: number }>
```
Read-only analysis via this.worker.analyze(). Produces code change proposal.

### reviewPlan() Signature (NEW)
```typescript
private async reviewPlan(
  proposal: string,
  task: Task,
): Promise<{ review: ReviewResult; costUsd: number }>
```
Reviews proposal via this.reviewer.review(). Uses mutually exclusive reviewer.

### brainSynthesizePlan() Signature (NEW)
```typescript
private async brainSynthesizePlan(
  proposal: string,
  reviewFeedback: ReviewResult,
  task: Task,
): Promise<{ approved: boolean; finalPlan: string; costUsd: number }>
```
Brain approves/rejects plan via brainThink(). Returns synthesized plan.

### brainReviewDecision() Signature (NEW)
```typescript
private async brainReviewDecision(
  task: Task,
  reviewResult: ReviewResult,
  diff: string,
  isRetry: boolean,
): Promise<{
  decision: "fix" | "ignore" | "block" | "rewrite" | "split";
  reasoning: string;
  fixInstructions?: string;
  newTasks?: string[];
  costUsd: number;
}>
```
5-way decision after review failure. isRetry=true limits to ignore/block/split.

### workerReviewFix() Signature (NEW)
```typescript
private async workerReviewFix(
  task: Task,
  fixInstructions: string,
  sessionId?: string,
): Promise<{ result: WorkerResult; costUsd: number }>
```
Executes fix via this.worker.fix(). Supports resume (Claude only).

### codeReview() Signature (NEW)
```typescript
private async codeReview(
  task: Task,
  startCommit: string,
  projectPath: string,
): Promise<ReviewResult>
```
Unified review entry point. Auto-selects mutually exclusive reviewer.

### workerFix() Signature
```typescript
private async workerFix(
  sessionId: string,
  errors: string,
  task: Task,
): Promise<SessionResult>
```
Calls workerSession.run() with resumeSessionId to continue fixing verification failures.

### hardVerify() Signature
```typescript
private async hardVerify(
  baselineErrors: number,
  startCommit: string,
  projectPath: string,
): Promise<{ passed: boolean; reason?: string }>
```
Compares tsc error count against baseline.

## NEW: WorkerAdapter & ReviewAdapter (src/core/WorkerAdapter.ts)

### WorkerResult Interface
```typescript
export interface WorkerResult {
  text: string;
  costUsd: number;
  durationMs: number;
  sessionId?: string;  // only Claude has this
  isError: boolean;
  errors: string[];
}
```

### WorkerAdapter Interface
```typescript
export interface WorkerAdapter {
  readonly name: 'claude' | 'codex';
  execute(prompt: string, opts: WorkerExecOpts): Promise<WorkerResult>;
  fix(prompt: string, opts: WorkerExecOpts): Promise<WorkerResult>;
  analyze(prompt: string, opts: WorkerAnalyzeOpts): Promise<WorkerResult>;
}
```

### ReviewAdapter Interface
```typescript
export interface ReviewAdapter {
  readonly name: 'claude' | 'codex';
  review(prompt: string, cwd: string): Promise<ReviewResult>;
}
```

### Implementations
- ClaudeWorkerAdapter: wraps ClaudeCodeSession, supports resume via resumeSessionId
- CodexWorkerAdapter: wraps CodexBridge, no resume
- ClaudeReviewAdapter: wraps ClaudeCodeSession in read-only mode
- CodexReviewAdapter: wraps CodexBridge.review()

### specReview() Signature (DEPRECATED)
```typescript
private async specReview(
  task: Task,
  startCommit: string,
  projectPath: string,
  workInstructions?: WorkInstructions,
): Promise<{
  passed: boolean;
  missing: string[];
  extra: string[];
  concerns: string[];
}>
```
Calls brainThink() to check if implementation matches task requirements.
Returns parsed JSON with compliance issues.

### brainReflect() Signature
```typescript
private async brainReflect(
  task: Task,
  outcome: string,
  verification: { passed: boolean; reason?: string },
  projectPath: string,
  personaName?: string,
): Promise<void>
```
Calls brainSession.run() with:
- permissionMode: "bypassPermissions"
- allowedTools: ["Read", "Glob", "Grep", "Bash", "Edit", "Write"]
- Can edit CLAUDE.md and use claude-mem
- Looks for PERSONA_UPDATE block to update persona content

## 5. Config Types (src/config/types.ts)

### AutonomyConfig
```typescript
export interface AutonomyConfig {
  level: "full" | "supervised";
  maxRetries: number;        // default 3
  retryBaseDelayMs: number;   // default 1000
  subtaskTimeout: number;     // seconds, default 600
  worker: "claude" | "codex"; // default "claude", which model executes tasks
  maxReviewFixes: number;     // default 1, max review fix rounds
}
```

### BrainConfig
```typescript
export interface BrainConfig {
  model: string;                              // default "opus"
  scanInterval: number;                       // seconds
  maxScanBudget: number;                      // USD
  claudeMdMaintenanceInterval: number;        // trigger every N tasks
  claudeMdMaintenanceEnabled: boolean;        // default true
  chainScan: ChainScanConfig;
}
```

### CodexConfig
```typescript
export interface CodexConfig {
  model: string;                              // default "gpt-5.3-codex"
  sandbox: "workspace-write" | "workspace-read" | "full-auto";  // default "workspace-write"
  tokenPricing?: TokenPricing;
  reviewTimeout?: number;                     // seconds, default 1800
  planTimeout?: number;                       // seconds, default 900
}
```

## 6. Task Types (src/memory/types.ts)

### TaskPhase
```typescript
export type TaskPhase = 'init' | 'scanning' | 'planning' | 'analyzing' | 'plan-review' | 'executing' | 'reviewing' | 'reflecting' | 'done' | 'failed' | 'blocked';
```

### TaskStatus
```typescript
export type TaskStatus = 'queued' | 'active' | 'done' | 'failed' | 'blocked' | 'skipped' | 'pending_review';
```

### Task Interface (key fields)
```typescript
export interface Task {
  id: string;
  project_path: string;
  task_description: string;
  phase: TaskPhase;
  priority: number;               // 0=P0 urgent, 3=P3 optional
  plan: unknown;                  // JSONB with complexity, subtasks, etc
  subtasks: SubTaskRecord[];
  review_results: unknown[];
  iteration: number;
  total_cost_usd: number;
  git_branch: string | null;
  start_commit: string | null;
  depends_on: string[];
  status: TaskStatus;
  created_at: Date;
  updated_at: Date;
}

export interface SubTaskRecord {
  id: string;
  description: string;
  executor: 'claude' | 'codex';
  status: 'pending' | 'running' | 'done' | 'failed';
  result?: string;
}
```

## 7. Index.ts Initialization

### MainLoop Construction (lines 122-130)
```typescript
const mainLoop = new MainLoop(
  config,
  taskQueue,
  codexBridge,
  taskStore,
  costTracker,
  eventBus,
  sdkExtras,
);
```

### SdkExtras Type (passed to MainLoop)
```typescript
export interface SdkExtras {
  plugins?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
  mcpServers?: Record<string, unknown>;
}
```

## COMPLEXITY_CONFIG (lines 71-79)
```typescript
const COMPLEXITY_CONFIG: Record<
  string,
  { maxTurns: number; maxBudget: number; timeout: number }
> = {
  S: { maxTurns: 100, maxBudget: 5.0, timeout: 600_000 },      // 10 min
  M: { maxTurns: 200, maxBudget: 10.0, timeout: 1_200_000 },   // 20 min
  L: { maxTurns: 200, maxBudget: 15.0, timeout: 2_400_000 },   // 40 min
  XL: { maxTurns: 200, maxBudget: 20.0, timeout: 3_600_000 },  // 60 min
};
```

## 8. Key Method Patterns

### Brain Decision Flow (2-phase)
1. Phase 1: Free exploration (read CLAUDE.md, search claude-mem, explore code)
   - No jsonSchema, tools enabled
   - Returns analysis + opportunity candidates
2. Phase 2: Structured decision (jsonSchema + decision prompt)
   - Extract taskDescription, persona, taskType, complexity, subtasks, workInstructions
   - Fallback to text extraction if JSON fails
   - Last resort: raw text as task description

### Worker Execution Loop
1. workerExecute() initial attempt
2. If hardVerify fails:
   - workerFix() with resumeSessionId (up to maxRetries)
   - commitAll() after each fix
   - Re-verify until pass or retries exhausted
3. If still failing: HALT, mark persona for learning, mark task failed

### Review Pipeline
1. hardVerify (TypeScript errors)
2. specReview (Brain checks task compliance)
3. codexReview (Codex checks for issues)
4. All must pass to merge

### Review Signatures in runCycle() (v3 pipeline)
- specReview: DEPRECATED, no longer called in runCycle
- codeReview() called with (task, startCommit, projectPath) — delegates to this.reviewer.review()
- brainReviewDecision() called with (task, reviewResult, diff, isRetry) — brain 5-way decision
- Mutual exclusion: worker=claude → CodexReviewAdapter; worker=codex → ClaudeReviewAdapter
