import type { TaskStore } from '../memory/TaskStore.js';
import type { Task } from '../memory/types.js';
import type { TaskPlan, PlanTask } from './types.js';
import { log } from '../utils/logger.js';

export class TaskQueue {
  constructor(private store: TaskStore) {}

  async enqueue(projectPath: string, plan: TaskPlan): Promise<string[]> {
    const taskIds: string[] = [];

    // Sort by priority (P0 first) then by dependency order
    const sorted = topologicalSort(plan.tasks);

    for (const planTask of sorted) {
      const task = await this.store.createTask(
        projectPath,
        planTask.description,
        planTask.priority,
      );
      taskIds.push(task.id);

      // Store subtasks in the task record
      await this.store.updateTask(task.id, {
        plan: planTask,
        subtasks: planTask.subtasks.map(st => ({
          id: st.id,
          description: st.description,
          executor: st.executor,
          status: 'pending' as const,
        })),
      });

      log.info(`Queued task [P${planTask.priority}]: ${planTask.description.slice(0, 60)}`);
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
