import type { CycleEventBus } from '../CycleEventBus.js';
import { EmptyDiffGuard, type GetDiffStatsFn } from './EmptyDiffGuard.js';
import { StructuredOutputGuard } from './StructuredOutputGuard.js';
import { BudgetGuard, type GetBudgetInfoFn } from './BudgetGuard.js';
import { WorkerFixResultGuard } from './WorkerFixResultGuard.js';
import { ConcurrencyGuard } from './ConcurrencyGuard.js';

export interface GuardDeps {
  getDiffStats: GetDiffStatsFn;
  getBudgetInfo: GetBudgetInfoFn;
  lockFile: string;
}

export function registerGuards(bus: CycleEventBus, deps: GuardDeps): void {
  const emptyDiff = new EmptyDiffGuard(deps.getDiffStats);
  const structuredOutput = new StructuredOutputGuard();
  const budget = new BudgetGuard(deps.getBudgetInfo);
  const workerFix = new WorkerFixResultGuard();
  const concurrency = new ConcurrencyGuard(deps.lockFile);

  bus.on('after:execute', (e) => emptyDiff.handle(e));
  bus.on('after:decide', (e) => structuredOutput.handle(e));
  bus.on('before:execute', (e) => budget.handle(e));
  bus.on('after:fix', (e) => workerFix.handle(e));
  bus.on('before:decide', (e) => concurrency.handle(e));
}

export { EmptyDiffGuard, StructuredOutputGuard, BudgetGuard, WorkerFixResultGuard, ConcurrencyGuard };
