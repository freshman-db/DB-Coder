/**
 * StepTracker — Cycle step lifecycle and mutable state management.
 *
 * Contains:
 * - Pure functions for step manipulation (applyBeginStep, applyStepStatusUpdate, failAllActiveSteps)
 * - StepTracker interface (phase use by phases)
 * - StateAccessor interface (state read/write by MainLoop + phases)
 *
 * CycleStepTracker implementation will be added in PR 2.
 */

import type {
  LoopState,
  StatusSnapshot,
  CycleStep,
  CycleStepStatus,
  StepPhase,
} from "./types.js";
import { CYCLE_PIPELINE } from "./types.js";
import type { CycleEvent, CyclePhase, CycleTiming } from "./CycleEvents.js";
import { log } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// StatusListener type
// ---------------------------------------------------------------------------

export type StatusListener = (status: StatusSnapshot) => void;

// ---------------------------------------------------------------------------
// Pure functions — moved from MainLoop.ts
// ---------------------------------------------------------------------------

/**
 * Return all steps matching `phase` whose finishedAt is set, or null if
 * the precondition is not met (no matching steps, or any match lacks finishedAt).
 * Exported for internal use by MainLoop (will become private to StepTracker in PR 2+).
 */
export function findFinishedStepsByPhase(
  steps: CycleStep[],
  phase: StepPhase,
): CycleStep[] | null {
  const matched = steps.filter((s) => s.phase === phase);
  if (matched.length === 0) return null;
  if (matched.some((s) => s.finishedAt == null)) return null;
  return matched;
}

/** Pure logic for applyStepStatusUpdate — exported for testing. */
export function applyStepStatusUpdate(
  steps: CycleStep[],
  phase: StepPhase,
  status: "done" | "failed",
  summary?: string,
): CycleStep[] {
  const finished = findFinishedStepsByPhase(steps, phase);
  if (finished === null) {
    const exists = steps.some((s) => s.phase === phase);
    if (!exists) {
      throw new Error(
        `applyStepStatusUpdate: phase "${phase}" not found in cycleSteps`,
      );
    }
    throw new Error(
      `applyStepStatusUpdate: step "${phase}" has no finishedAt — only finished steps can be updated`,
    );
  }
  return steps.map((s) => (s.phase === phase ? { ...s, status, summary } : s));
}

/** Marks ALL active steps as failed in one pass. Only touches status==="active". */
export function failAllActiveSteps(
  steps: CycleStep[],
  errorMsg: string,
  now?: number,
): CycleStep[] {
  const ts = now ?? Date.now();
  return steps.map((s) => {
    if (s.status !== "active") return s;
    const durationMs = s.startedAt != null ? ts - s.startedAt : undefined;
    return {
      ...s,
      status: "failed" as CycleStepStatus,
      finishedAt: ts,
      durationMs,
      summary: errorMsg,
    };
  });
}

/**
 * Pure helper for beginStep: activates a pending step.
 * Returns the updated steps array, or null if the step is not "pending"
 * (which means the caller should reject re-entry and log a warning).
 */
export function applyBeginStep(
  steps: CycleStep[],
  phase: StepPhase,
  now: number,
): CycleStep[] | null {
  const existing = steps.find((s) => s.phase === phase);
  if (!existing || existing.status !== "pending") {
    return null;
  }
  return steps.map((s) =>
    s.phase === phase
      ? { ...s, status: "active" as CycleStepStatus, startedAt: now }
      : s,
  );
}

// ---------------------------------------------------------------------------
// Interfaces — phase-facing step lifecycle operations
// ---------------------------------------------------------------------------

/** Step lifecycle operations used by phase classes. */
export interface StepTracker {
  beginStep(phase: StepPhase): void;
  endStep(
    phase: StepPhase,
    result: "done" | "failed" | "skipped",
    summary?: string,
    durationOverrideMs?: number,
  ): void;
  updateStepStatus(
    phase: StepPhase,
    status: "done" | "failed",
    summary?: string,
  ): void;
  skipRemainingSteps(fromPhase?: StepPhase): void;
  resetCycleSteps(): void;
}

/** State read/write used by MainLoop orchestrator + phases. */
export interface StateAccessor {
  // State read/write
  setState(state: LoopState): void;
  getState(): LoopState;
  setCurrentTaskId(taskId: string | null): void;
  getCurrentTaskId(): string | null;
  setCurrentTaskDescription(desc: string | null): void;
  getCurrentTaskDescription(): string | null;
  setRunning(running: boolean): void;
  isRunning(): boolean;
  setPaused(paused: boolean): void;
  isPaused(): boolean;
  // Cycle state
  getCycleNumber(): number;
  getCycleSteps(): readonly CycleStep[];
  setCycleSteps(steps: CycleStep[]): void;
  // Event factory
  makeEvent(
    phase: CyclePhase,
    timing: CycleTiming,
    data?: Record<string, unknown>,
  ): CycleEvent;
  // Snapshot & broadcast
  getStatusSnapshot(): StatusSnapshot;
  addStatusListener(listener: StatusListener): () => void;
  broadcastStatus(): void;
}

// ---------------------------------------------------------------------------
// CycleStepTracker — full mutable state implementation
// ---------------------------------------------------------------------------

/**
 * Manages all cycle-related mutable state: step progression, loop state,
 * task tracking, status listeners, and broadcasting.
 *
 * This is the single source of truth for step state in the system.
 */
export class CycleStepTracker implements StepTracker, StateAccessor {
  private state: LoopState = "idle";
  private running = false;
  private paused = false;
  private currentTaskId: string | null = null;
  private currentTaskDescription: string | null = null;
  private cycleNumber = 0;
  private currentPhase: StepPhase | null = null;
  private cycleSteps: CycleStep[] = [];
  private statusListeners = new Set<StatusListener>();

  // --- StepTracker interface ---

  beginStep(phase: StepPhase): void {
    if (!CYCLE_PIPELINE.includes(phase)) {
      log.warn(`beginStep called with unknown phase "${phase}", ignoring`);
      return;
    }
    const updated = applyBeginStep(this.cycleSteps, phase, Date.now());
    if (updated === null) {
      const existing = this.cycleSteps.find((s) => s.phase === phase);
      log.warn(
        `beginStep called on phase "${phase}" which is already "${existing?.status ?? "unknown"}", ignoring to preserve timing/history`,
      );
      return;
    }
    this.currentPhase = phase;
    this.cycleSteps = updated;
    this.broadcastStatus();
  }

  endStep(
    phase: StepPhase,
    result: "done" | "failed" | "skipped",
    summary?: string,
    durationOverrideMs?: number,
  ): void {
    if (!CYCLE_PIPELINE.includes(phase)) {
      log.warn(`endStep called with unknown phase "${phase}", ignoring`);
      return;
    }
    const now = Date.now();
    this.cycleSteps = this.cycleSteps.map((s) => {
      if (s.phase !== phase) return s;
      const durationMs =
        durationOverrideMs ??
        (s.startedAt != null ? now - s.startedAt : undefined);
      return {
        ...s,
        status: result as CycleStepStatus,
        finishedAt: now,
        durationMs,
        summary,
      };
    });
    this.currentPhase = null;
    this.broadcastStatus();
  }

  updateStepStatus(
    phase: StepPhase,
    status: "done" | "failed",
    summary?: string,
  ): void {
    this.cycleSteps = applyStepStatusUpdate(
      this.cycleSteps,
      phase,
      status,
      summary,
    );
    this.broadcastStatus();
  }

  skipRemainingSteps(fromPhase?: StepPhase): void {
    let shouldSkip = !fromPhase;
    this.cycleSteps = this.cycleSteps.map((s) => {
      if (s.phase === fromPhase) {
        shouldSkip = true;
        return s;
      }
      if (shouldSkip && s.status === "pending") {
        return { ...s, status: "skipped" as CycleStepStatus };
      }
      return s;
    });
    this.broadcastStatus();
  }

  resetCycleSteps(): void {
    this.cycleNumber++;
    this.cycleSteps = CYCLE_PIPELINE.map((phase) => ({
      phase,
      status: "pending" as CycleStepStatus,
    }));
    this.currentPhase = null;
    this.broadcastStatus();
  }

  // --- StateAccessor interface ---

  setState(state: LoopState): void {
    if (this.state === state) return;
    this.state = state;
    this.broadcastStatus();
  }

  getState(): LoopState {
    return this.state;
  }

  setCurrentTaskId(taskId: string | null): void {
    if (this.currentTaskId === taskId) return;
    this.currentTaskId = taskId;
    this.broadcastStatus();
  }

  getCurrentTaskId(): string | null {
    return this.currentTaskId;
  }

  setCurrentTaskDescription(desc: string | null): void {
    this.currentTaskDescription = desc;
  }

  getCurrentTaskDescription(): string | null {
    return this.currentTaskDescription;
  }

  setRunning(running: boolean): void {
    if (this.running === running) return;
    this.running = running;
    this.broadcastStatus();
  }

  isRunning(): boolean {
    return this.running;
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.broadcastStatus();
  }

  isPaused(): boolean {
    return this.paused;
  }

  getCycleNumber(): number {
    return this.cycleNumber;
  }

  getCycleSteps(): readonly CycleStep[] {
    return this.cycleSteps;
  }

  setCycleSteps(steps: CycleStep[]): void {
    this.cycleSteps = steps;
    this.broadcastStatus();
  }

  makeEvent(
    phase: CyclePhase,
    timing: CycleTiming,
    data: Record<string, unknown> = {},
  ): CycleEvent {
    return {
      phase,
      timing,
      taskId: this.currentTaskId ?? undefined,
      data,
      timestamp: Date.now(),
    };
  }

  getStatusSnapshot(): StatusSnapshot {
    return {
      state: this.state,
      currentTaskId: this.currentTaskId,
      patrolling: this.running,
      paused: this.paused,
      cycleNumber: this.cycleNumber,
      currentPhase: this.currentPhase ?? undefined,
      cycleSteps: [...this.cycleSteps],
      taskDescription: this.currentTaskDescription ?? undefined,
    };
  }

  addStatusListener(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  broadcastStatus(): void {
    if (this.statusListeners.size === 0) return;
    const snapshot = this.getStatusSnapshot();
    for (const listener of this.statusListeners) {
      try {
        listener(snapshot);
      } catch {
        /* ignore listener failures */
      }
    }
  }
}
