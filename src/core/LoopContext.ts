/**
 * LoopContext — Read-only service bag shared by all phases.
 *
 * Every phase receives a LoopContext at construction time.
 * The context is built once in MainLoop's constructor and never mutated.
 */

import type { Config } from "../config/Config.js";
import type { TaskStore } from "../memory/TaskStore.js";
import type { CostTracker } from "../utils/cost.js";
import type { TaskQueue } from "./TaskQueue.js";
import type { CycleEventBus } from "./CycleEventBus.js";
import type { ClaudeCodeSession } from "../bridges/ClaudeCodeSession.js";
import type { CodexBridge } from "../bridges/CodexBridge.js";
import type {
  WorkerAdapter,
  ReviewAdapter,
  ClaudeReviewAdapter,
  CodexReviewAdapter,
} from "./WorkerAdapter.js";
import type { ChainScanner } from "./ChainScanner.js";
import type { PersonaLoader } from "./PersonaLoader.js";
import type { ProjectVerifier } from "./ProjectVerifier.js";
import type { ProjectMemory } from "../memory/ProjectMemory.js";
import type { RegisteredStrategies } from "./strategies/index.js";

export interface LoopContext {
  readonly config: Config;
  readonly taskStore: TaskStore;
  readonly costTracker: CostTracker;
  readonly taskQueue: TaskQueue;
  readonly eventBus: CycleEventBus;
  readonly brainSession: ClaudeCodeSession;
  readonly workerSession: ClaudeCodeSession;
  readonly worker: WorkerAdapter;
  readonly reviewer: ReviewAdapter;
  readonly claudeReviewer: ClaudeReviewAdapter;
  readonly codexReviewer: CodexReviewAdapter;
  readonly chainScanner: ChainScanner;
  readonly personaLoader: PersonaLoader;
  readonly projectVerifier: ProjectVerifier;
  readonly projectMemory: ProjectMemory | null;
  readonly memoryProject: string;
  readonly strategies?: RegisteredStrategies;
  readonly codex: CodexBridge;
}
