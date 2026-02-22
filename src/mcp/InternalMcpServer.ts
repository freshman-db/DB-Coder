import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { GlobalMemory } from '../memory/GlobalMemory.js';
import type { TaskStore } from '../memory/TaskStore.js';
import type { Memory, Task, TaskStatus } from '../memory/types.js';

const MCP_SERVER_NAME = 'db-coder-internal';
const TASK_STATUSES = ['queued', 'active', 'done', 'failed', 'blocked', 'skipped', 'pending_review'] as const;
const TASK_STATUS_SCHEMA = z.enum(TASK_STATUSES);

type InternalTaskStore = Pick<TaskStore, 'createTask' | 'listTasks'>;
type InternalGlobalMemory = Pick<GlobalMemory, 'search'>;

type ToolResponse = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
};

export interface InternalMcpDeps {
  projectPath: string;
  taskStore: InternalTaskStore;
  globalMemory: InternalGlobalMemory;
}

function createToolSuccess(message: string, structuredContent?: unknown): ToolResponse {
  return {
    content: [{ type: 'text', text: message }],
    ...(structuredContent !== undefined ? { structuredContent } : {}),
  };
}

function createToolError(toolName: string, error: unknown): ToolResponse {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text', text: `${toolName} failed: ${message}` }],
    isError: true,
  };
}

function toIsoString(value: Date | string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

function mapTask(task: Task): {
  id: string;
  description: string;
  priority: number;
  status: TaskStatus;
  phase: Task['phase'];
  createdAt: string | null;
  updatedAt: string | null;
} {
  return {
    id: task.id,
    description: task.task_description,
    priority: task.priority,
    status: task.status,
    phase: task.phase,
    createdAt: toIsoString(task.created_at),
    updatedAt: toIsoString(task.updated_at),
  };
}

function mapMemory(memory: Memory): {
  id: number;
  category: Memory['category'];
  title: string;
  content: string;
  tags: string[];
  confidence: number;
  sourceProject: string | null;
  createdAt: string | null;
  updatedAt: string | null;
} {
  return {
    id: memory.id,
    category: memory.category,
    title: memory.title,
    content: memory.content,
    tags: memory.tags,
    confidence: memory.confidence,
    sourceProject: memory.source_project,
    createdAt: toIsoString(memory.created_at),
    updatedAt: toIsoString(memory.updated_at),
  };
}

function isKnownTaskStatus(status: unknown): status is TaskStatus {
  return typeof status === 'string' && (TASK_STATUSES as readonly string[]).includes(status);
}

export function createInternalMcpServer(deps: InternalMcpDeps) {
  const { projectPath, taskStore, globalMemory } = deps;

  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: '1.0.0',
    tools: [
      tool(
        'add_task',
        'Create a new task in the db-coder task queue.',
        {
          description: z.string().min(1),
          priority: z.number().int().min(0).max(3).optional(),
        },
        async ({ description, priority }) => {
          try {
            const normalizedDescription = description.trim();
            if (!normalizedDescription) {
              return createToolError('add_task', new Error('description cannot be empty'));
            }

            const createdTask = await taskStore.createTask(projectPath, normalizedDescription, priority ?? 2);
            return createToolSuccess(`Task ${createdTask.id} created.`, { task: mapTask(createdTask) });
          } catch (error) {
            return createToolError('add_task', error);
          }
        },
      ),
      tool(
        'list_tasks',
        'List tasks for the current project, optionally filtered by status.',
        {
          status: TASK_STATUS_SCHEMA.optional(),
        },
        async ({ status }) => {
          try {
            const tasks = await taskStore.listTasks(projectPath, status);
            const mappedTasks = tasks.map(mapTask);
            return createToolSuccess(`Found ${mappedTasks.length} task(s).`, {
              status: status ?? null,
              count: mappedTasks.length,
              tasks: mappedTasks,
            });
          } catch (error) {
            return createToolError('list_tasks', error);
          }
        },
      ),
      tool(
        'search_memory',
        'Search global memory for relevant experiences and patterns.',
        {
          query: z.string().min(1),
        },
        async ({ query }) => {
          try {
            const normalizedQuery = query.trim();
            if (!normalizedQuery) {
              return createToolError('search_memory', new Error('query cannot be empty'));
            }

            const memories = await globalMemory.search(normalizedQuery, 10);
            const mappedMemories = memories.map(mapMemory);
            return createToolSuccess(`Found ${mappedMemories.length} memory item(s).`, {
              query: normalizedQuery,
              count: mappedMemories.length,
              memories: mappedMemories,
            });
          } catch (error) {
            return createToolError('search_memory', error);
          }
        },
      ),
      tool(
        'get_status',
        'Get a quick status snapshot of the current db-coder project queue.',
        {},
        async () => {
          try {
            const tasks = await taskStore.listTasks(projectPath);
            const counts = TASK_STATUSES.reduce<Record<TaskStatus, number>>((acc, status) => {
              acc[status] = 0;
              return acc;
            }, {} as Record<TaskStatus, number>);

            for (const task of tasks) {
              if (isKnownTaskStatus(task.status)) {
                counts[task.status] += 1;
              }
            }

            return createToolSuccess('Internal status retrieved.', {
              projectPath,
              totalTasks: tasks.length,
              counts,
            });
          } catch (error) {
            return createToolError('get_status', error);
          }
        },
      ),
    ],
  });
}
