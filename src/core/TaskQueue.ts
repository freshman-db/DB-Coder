import type { TaskStore } from '../memory/TaskStore.js';
import type { Task } from '../memory/types.js';
import type { TaskPlan, PlanTask } from './types.js';
import { TASK_DESC_MAX_LENGTH } from '../types/constants.js';
import { truncate } from '../utils/parse.js';
import { log } from '../utils/logger.js';

export class TaskQueue {
  constructor(private store: TaskStore) {}

  async enqueue(projectPath: string, plan: TaskPlan): Promise<string[]> {
    const taskIds: string[] = [];

    // Sort by priority (P0 first) then by dependency order
    const sorted = topologicalSort(plan.tasks);

    // Map plan IDs (e.g. "T001") to database UUIDs for dependency tracking
    const planIdToDbId = new Map<string, string>();

    for (const planTask of sorted) {
      // Cooldown: skip if a similar task recently failed/blocked
      const recentlyFailed = await this.store.hasRecentlyFailedSimilar(projectPath, planTask.description);
      if (recentlyFailed) {
        log.info(`Skipping task (cooldown): "${truncate(planTask.description, TASK_DESC_MAX_LENGTH)}" — similar task recently failed`);
        continue;
      }

      // Dedup: skip if a similar task already exists
      const similar = await this.store.findSimilarTask(projectPath, planTask.description);
      if (similar) {
        log.info(`Skipping duplicate task: "${truncate(planTask.description, TASK_DESC_MAX_LENGTH)}" (similar to "${similar.task_description.slice(0, 40)}" [${similar.status}])`);
        planIdToDbId.set(planTask.id, similar.id);
        continue;
      }

      const completedSimilar = await this.store.findSimilarCompletedTask(projectPath, planTask.description);
      const recurrence = completedSimilar
        ? {
            previousTaskId: completedSimilar.id,
            completedAt: completedSimilar.updated_at,
          }
        : undefined;
      if (completedSimilar) {
        log.warn(`Recurring issue detected: "${truncate(planTask.description, TASK_DESC_MAX_LENGTH)}" — similar to completed task ${completedSimilar.id}`);
      }

      // Resolve dependency plan IDs to database UUIDs
      const dependsOn = planTask.dependsOn
        .map(depId => planIdToDbId.get(depId))
        .filter((id): id is string => id !== undefined);

      const task = await this.store.createTask(
        projectPath,
        planTask.description,
        planTask.priority,
        dependsOn,
      );
      planIdToDbId.set(planTask.id, task.id);
      taskIds.push(task.id);

      // Store subtasks in the task record
      await this.store.updateTask(task.id, {
        plan: { ...planTask, recurrence },
        subtasks: planTask.subtasks.map(st => ({
          id: st.id,
          description: st.description,
          executor: st.executor,
          status: 'pending' as const,
        })),
      });

      log.info(`Queued task [P${planTask.priority}]: ${truncate(planTask.description, TASK_DESC_MAX_LENGTH)}`);
    }

    return taskIds;
  }

  async getNext(projectPath: string): Promise<Task | null> {
    return this.store.getNextTask(projectPath);
  }

  async getAll(projectPath: string): Promise<Task[]> {
    return this.store.listTasks(projectPath);
  }

  async getQueued(projectPath: string): Promise<Task[]> {
    return this.store.listTasks(projectPath, 'queued');
  }

  async getBlocked(projectPath: string): Promise<Task[]> {
    return this.store.listTasks(projectPath, 'blocked');
  }
}

function topologicalSort(tasks: PlanTask[]): PlanTask[] {
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const visited = new Set<string>();
  const sorted: PlanTask[] = [];

  function visit(id: string): void {
    if (visited.has(id)) return;
    visited.add(id);
    const task = taskMap.get(id);
    if (!task) return;
    for (const dep of task.dependsOn) {
      visit(dep);
    }
    sorted.push(task);
  }

  // Visit in priority order first
  const byPriority = [...tasks].sort((a, b) => a.priority - b.priority);
  for (const task of byPriority) {
    visit(task.id);
  }

  return sorted;
}
