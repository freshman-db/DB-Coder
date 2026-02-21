import type { TaskStore } from '../memory/TaskStore.js';
import type { BudgetConfig } from '../config/types.js';
import { log } from './logger.js';

export class CostTracker {
  private sessionCost = 0;
  private warnedTaskThreshold = new Set<string>();
  private warnedDailyThreshold = false;

  constructor(
    private store: TaskStore,
    private budget: BudgetConfig,
  ) {}

  async addCost(taskId: string, costUsd: number): Promise<void> {
    this.sessionCost += costUsd;
    await this.store.addDailyCost(costUsd);
    await this.store.incrementTaskCost(taskId, costUsd);
  }

  async checkBudget(taskId: string): Promise<{ allowed: boolean; reason?: string }> {
    const task = await this.store.getTask(taskId);
    if (task) {
      const taskCost = Number(task.total_cost_usd);
      const taskRatio = this.budget.maxPerTask > 0 ? taskCost / this.budget.maxPerTask : 0;

      if (taskRatio >= this.budget.warningThreshold && taskRatio < 1 && !this.warnedTaskThreshold.has(taskId)) {
        log.warn(`Task cost at ${(taskRatio * 100).toFixed(0)}% of budget ($${taskCost}/$${this.budget.maxPerTask})`);
        this.warnedTaskThreshold.add(taskId);
      }

      if (taskCost >= this.budget.maxPerTask) {
        this.warnedTaskThreshold.delete(taskId);
        return { allowed: false, reason: `Task budget exceeded: $${taskCost}/$${this.budget.maxPerTask}` };
      }
    }

    const daily = await this.store.getDailyCost();
    if (daily.total_cost_usd >= this.budget.maxPerDay) {
      return { allowed: false, reason: `Daily budget exceeded: $${daily.total_cost_usd}/$${this.budget.maxPerDay}` };
    }

    // Warning threshold (only warn once per session)
    const dailyRatio = daily.total_cost_usd / this.budget.maxPerDay;
    if (dailyRatio >= this.budget.warningThreshold && !this.warnedDailyThreshold) {
      log.warn(`Daily cost at ${(dailyRatio * 100).toFixed(0)}% of budget ($${daily.total_cost_usd}/$${this.budget.maxPerDay})`);
      this.warnedDailyThreshold = true;
    }

    return { allowed: true };
  }

  async getDailySummary(): Promise<{ date: string; total_cost_usd: number; task_count: number }[]> {
    return this.store.getRecentCosts(7);
  }

  getSessionCost(): number {
    return this.sessionCost;
  }
}
