import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MainLoop } from '../core/MainLoop.js';
import type { TaskStore } from '../memory/TaskStore.js';
import type { GlobalMemory } from '../memory/GlobalMemory.js';
import type { CostTracker } from '../utils/cost.js';
import type { Config } from '../config/Config.js';
import type { EvolutionEngine } from '../evolution/EvolutionEngine.js';
import type { PluginMonitor } from '../plugins/PluginMonitor.js';
import { log, type LogEntry } from '../utils/logger.js';

interface RouteContext {
  loop: MainLoop;
  taskStore: TaskStore;
  globalMemory: GlobalMemory;
  costTracker: CostTracker;
  config: Config;
  evolutionEngine?: EvolutionEngine;
  pluginMonitor?: PluginMonitor;
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse, ctx: RouteContext, params: Record<string, string>) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

const memoryCategories = ['habit', 'experience', 'standard', 'workflow', 'framework', 'failure', 'simplification'] as const;
type MemoryCategory = (typeof memoryCategories)[number];

const routes: Route[] = [];
const MAX_TASK_DESCRIPTION_LENGTH = 4_000;
const MAX_MEMORY_CONTENT_LENGTH = 32_000;
const MAX_MEMORY_TITLE_LENGTH = 200;
const MAX_MEMORY_TAG_LENGTH = 64;
const MAX_MEMORY_TAG_COUNT = 20;
const MAX_REQUEST_BODY_BYTES = 64 * 1024;

class PayloadTooLargeError extends Error {
  constructor(limitBytes: number) {
    super(`Request body exceeds ${limitBytes} bytes.`);
    this.name = 'PayloadTooLargeError';
  }
}

interface CreateTaskRequest {
  description: string;
  priority?: number;
}

interface CreateMemoryRequest {
  category: MemoryCategory;
  content: string;
  title?: string;
  tags?: string[];
}

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function route(method: string, path: string, handler: RouteHandler): void {
  const paramNames: string[] = [];
  const pattern = path.replace(/:(\w+)/g, (_, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  routes.push({ method, pattern: new RegExp(`^${pattern}$`), paramNames, handler });
}

// --- Status ---
route('GET', '/api/status', async (_req, res, ctx) => {
  const state = ctx.loop.getState();
  const taskId = ctx.loop.getCurrentTaskId();
  const paused = ctx.loop.isPaused();
  const daily = await ctx.costTracker.getDailySummary();
  json(res, { state, currentTaskId: taskId, paused, dailyCosts: daily });
});

// --- Tasks ---
route('POST', '/api/tasks', async (req, res, ctx) => {
  const validation = validateCreateTaskBody(await readBody(req));
  if (!validation.ok) {
    json(res, { error: validation.error }, 400);
    return;
  }

  const { description, priority } = validation.value;
  const task = await ctx.taskStore.createTask(ctx.config.projectPath, description, priority ?? 2);
  log.info(`Task added: ${description}`);
  json(res, task, 201);
});

route('GET', '/api/tasks', async (_req, res, ctx) => {
  const tasks = await ctx.taskStore.listTasks(ctx.config.projectPath);
  json(res, tasks);
});

route('GET', '/api/tasks/:id', async (_req, res, ctx, params) => {
  const task = await ctx.taskStore.getTask(params.id);
  if (!task) { json(res, { error: 'not found' }, 404); return; }
  const logs = await ctx.taskStore.getTaskLogs(params.id);
  json(res, { ...task, logs });
});

route('DELETE', '/api/tasks/:id', async (_req, res, ctx, params) => {
  await ctx.taskStore.deleteTask(params.id);
  json(res, { ok: true });
});

// --- Control ---
route('POST', '/api/control/pause', async (_req, res, ctx) => {
  ctx.loop.pause();
  json(res, { paused: true });
});

route('POST', '/api/control/resume', async (_req, res, ctx) => {
  ctx.loop.resume();
  json(res, { paused: false });
});

route('POST', '/api/control/scan', async (req, res, ctx) => {
  const body = await readBody(req);
  const depth = (body as { depth?: string }).depth ?? 'normal';
  // Trigger scan asynchronously
  ctx.loop.triggerScan(depth as 'quick' | 'normal' | 'deep').catch(err => log.error('Scan error', err));
  json(res, { triggered: true, depth });
});

// --- Logs (SSE) ---
route('GET', '/api/logs', async (req, res, ctx) => {
  const url = new URL(req.url ?? '', `http://${req.headers.host}`);
  const follow = url.searchParams.get('follow') === 'true';

  if (follow) {
    // SSE stream
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 15000);

    const removeListener = log.addListener((entry: LogEntry) => {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    });

    req.on('close', () => {
      clearInterval(heartbeat);
      removeListener();
    });
  } else {
    // Return recent logs (read from file)
    json(res, { message: 'Use ?follow=true for SSE stream' });
  }
});

// --- Memory ---
route('GET', '/api/memory', async (req, res, ctx) => {
  const url = new URL(req.url ?? '', `http://${req.headers.host}`);
  const q = url.searchParams.get('q') ?? '';
  if (!q) {
    const memories = await ctx.globalMemory.getByCategory('experience');
    json(res, memories);
    return;
  }
  const results = await ctx.globalMemory.search(q);
  json(res, results);
});

route('POST', '/api/memory', async (req, res, ctx) => {
  const validation = validateCreateMemoryBody(await readBody(req));
  if (!validation.ok) {
    json(res, { error: validation.error }, 400);
    return;
  }

  const { category, content, title, tags } = validation.value;
  const memory = await ctx.globalMemory.add({
    category,
    title: title ?? content.slice(0, 50),
    content,
    tags: tags ?? [],
    source_project: null,
    confidence: 1.0, // Manual entries get full confidence
  });
  json(res, memory, 201);
});

// --- Cost ---
route('GET', '/api/cost', async (_req, res, ctx) => {
  const costs = await ctx.costTracker.getDailySummary();
  json(res, { costs, sessionCost: ctx.costTracker.getSessionCost() });
});

// --- Evolution ---
route('GET', '/api/evolution/summary', async (_req, res, ctx) => {
  if (!ctx.evolutionEngine) { json(res, { error: 'Evolution engine not available' }, 503); return; }
  const summary = await ctx.evolutionEngine.getSummary(ctx.config.projectPath);
  json(res, summary);
});

route('GET', '/api/evolution/trends', async (_req, res, ctx) => {
  if (!ctx.evolutionEngine) { json(res, { error: 'Evolution engine not available' }, 503); return; }
  const summary = await ctx.evolutionEngine.getSummary(ctx.config.projectPath);
  json(res, summary.trends);
});

route('GET', '/api/evolution/goals', async (_req, res, ctx) => {
  if (!ctx.evolutionEngine) { json(res, { error: 'Evolution engine not available' }, 503); return; }
  const summary = await ctx.evolutionEngine.getSummary(ctx.config.projectPath);
  const configGoals = ctx.config.values.evolution?.goals ?? [];
  json(res, { goals: configGoals, progress: summary.goals });
});

route('GET', '/api/evolution/adjustments', async (_req, res, ctx) => {
  const adjustments = await ctx.taskStore.getActiveAdjustments(ctx.config.projectPath);
  json(res, adjustments);
});

route('GET', '/api/evolution/proposals', async (_req, res, ctx) => {
  const proposals = await ctx.taskStore.getPendingProposals(ctx.config.projectPath);
  json(res, proposals);
});

route('POST', '/api/evolution/proposals/:id/apply', async (_req, res, ctx, params) => {
  const id = parseInt(params.id, 10);
  if (isNaN(id)) { json(res, { error: 'Invalid proposal ID' }, 400); return; }
  await ctx.taskStore.updateProposalStatus(id, 'applied');
  json(res, { ok: true, status: 'applied' });
});

route('GET', '/api/evolution/review-patterns', async (_req, res, ctx) => {
  if (!ctx.evolutionEngine) { json(res, { error: 'Evolution engine not available' }, 503); return; }
  const patterns = await ctx.evolutionEngine.analyzeRecurringIssues(ctx.config.projectPath);
  const categories = await ctx.taskStore.getRecurringIssueCategories(ctx.config.projectPath, 20);
  json(res, { patterns, categories });
});

route('POST', '/api/evolution/proposals/:id/reject', async (_req, res, ctx, params) => {
  const id = parseInt(params.id, 10);
  if (isNaN(id)) { json(res, { error: 'Invalid proposal ID' }, 400); return; }
  await ctx.taskStore.updateProposalStatus(id, 'rejected');
  json(res, { ok: true, status: 'rejected' });
});

// --- Prompt Versions ---
route('GET', '/api/evolution/prompt-versions', async (_req, res, ctx) => {
  const [active, candidates] = await Promise.all([
    ctx.taskStore.getActivePromptVersions(ctx.config.projectPath),
    ctx.taskStore.getCandidatePromptVersions(ctx.config.projectPath),
  ]);
  json(res, { active, candidates });
});

route('GET', '/api/evolution/prompt-versions/:name', async (_req, res, ctx, params) => {
  const name = params.name;
  const history = await ctx.taskStore.getPromptVersionHistory(ctx.config.projectPath, name as any);
  json(res, history);
});

route('POST', '/api/evolution/prompt-versions/:id/activate', async (_req, res, ctx, params) => {
  const id = parseInt(params.id, 10);
  if (isNaN(id)) { json(res, { error: 'Invalid version ID' }, 400); return; }
  const version = await ctx.taskStore.getPromptVersion(id);
  if (!version) { json(res, { error: 'Version not found' }, 404); return; }
  await ctx.taskStore.supersedeActivePromptVersion(ctx.config.projectPath, version.prompt_name);
  await ctx.taskStore.activatePromptVersion(id);
  json(res, { ok: true, status: 'active' });
});

route('POST', '/api/evolution/prompt-versions/:id/rollback', async (_req, res, ctx, params) => {
  const id = parseInt(params.id, 10);
  if (isNaN(id)) { json(res, { error: 'Invalid version ID' }, 400); return; }
  await ctx.taskStore.updatePromptVersionStatus(id, 'rolled_back');
  json(res, { ok: true, status: 'rolled_back' });
});

// --- Plugins ---
route('GET', '/api/plugins', async (_req, res, ctx) => {
  if (!ctx.pluginMonitor) { json(res, { error: 'Plugin monitor not available' }, 503); return; }
  const result = await ctx.pluginMonitor.checkForUpdates();
  json(res, result);
});

route('GET', '/api/plugins/updates', async (_req, res, ctx) => {
  if (!ctx.pluginMonitor) { json(res, { error: 'Plugin monitor not available' }, 503); return; }
  const result = await ctx.pluginMonitor.checkForUpdates();
  json(res, { newPlugins: result.newPlugins, updatable: result.updatable, checkedAt: result.checkedAt });
});

route('POST', '/api/plugins/:name/install', async (_req, res, ctx, params) => {
  if (!ctx.pluginMonitor) { json(res, { error: 'Plugin monitor not available' }, 503); return; }
  const ok = await ctx.pluginMonitor.installPlugin(params.name);
  json(res, { ok, plugin: params.name }, ok ? 200 : 500);
});

route('POST', '/api/plugins/:name/update', async (_req, res, ctx, params) => {
  if (!ctx.pluginMonitor) { json(res, { error: 'Plugin monitor not available' }, 503); return; }
  const ok = await ctx.pluginMonitor.updatePlugin(params.name);
  json(res, { ok, plugin: params.name }, ok ? 200 : 500);
});

route('POST', '/api/plugins/:name/enable', async (_req, res, ctx, params) => {
  if (!ctx.pluginMonitor) { json(res, { error: 'Plugin monitor not available' }, 503); return; }
  const ok = await ctx.pluginMonitor.enablePlugin(params.name);
  json(res, { ok, plugin: params.name }, ok ? 200 : 500);
});

route('POST', '/api/plugins/:name/disable', async (_req, res, ctx, params) => {
  if (!ctx.pluginMonitor) { json(res, { error: 'Plugin monitor not available' }, 503); return; }
  const ok = await ctx.pluginMonitor.disablePlugin(params.name);
  json(res, { ok, plugin: params.name }, ok ? 200 : 500);
});

// --- Route matching ---
export async function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  const url = new URL(req.url ?? '', `http://${req.headers.host}`);
  const method = req.method ?? 'GET';
  const pathname = url.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (method === 'OPTIONS') { res.writeHead(204).end(); return true; }

  for (const route of routes) {
    if (route.method !== method) continue;
    const match = pathname.match(route.pattern);
    if (!match) continue;

    const params: Record<string, string> = {};
    route.paramNames.forEach((name, i) => { params[name] = match[i + 1]; });

    try {
      await route.handler(req, res, ctx, params);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        json(res, { error: err.message }, 413);
        return true;
      }
      log.error(`Route error: ${method} ${pathname}`, err);
      json(res, { error: 'Internal server error' }, 500);
    }
    return true;
  }

  return false; // Not an API route
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let settled = false;

    const cleanup = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };

    const settleResolve = (value: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const settleReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onData = (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BODY_BYTES) {
        req.resume();
        settleReject(new PayloadTooLargeError(MAX_REQUEST_BODY_BYTES));
        return;
      }
      body += chunk.toString();
    };

    const onEnd = (): void => {
      if (body.length === 0) {
        settleResolve({});
        return;
      }
      try {
        settleResolve(JSON.parse(body));
      } catch (err) {
        log.warn('Invalid JSON request body; defaulting to empty object', err);
        settleResolve({});
      }
    };

    const onError = (err: Error): void => {
      log.warn('Error while reading request body; defaulting to empty object', err);
      settleResolve({});
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

function validateCreateTaskBody(body: unknown): ValidationResult<CreateTaskRequest> {
  if (!isRecord(body)) {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }

  const description = body.description;
  if (typeof description !== 'string') {
    return { ok: false, error: 'description is required and must be a non-empty string.' };
  }

  const normalizedDescription = description.trim();
  if (normalizedDescription.length === 0) {
    return { ok: false, error: 'description is required and must be a non-empty string.' };
  }
  if (normalizedDescription.length > MAX_TASK_DESCRIPTION_LENGTH) {
    return { ok: false, error: `description must be at most ${MAX_TASK_DESCRIPTION_LENGTH} characters.` };
  }

  const priority = body.priority;
  let normalizedPriority: number | undefined;
  if (priority !== undefined) {
    if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 0 || priority > 3) {
      return { ok: false, error: 'priority must be an integer between 0 and 3.' };
    }
    normalizedPriority = priority;
  }

  return {
    ok: true,
    value: {
      description: normalizedDescription,
      ...(normalizedPriority !== undefined ? { priority: normalizedPriority } : {}),
    },
  };
}

function validateCreateMemoryBody(body: unknown): ValidationResult<CreateMemoryRequest> {
  if (!isRecord(body)) {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }

  const category = body.category;
  if (typeof category !== 'string' || category.trim().length === 0) {
    return { ok: false, error: 'category is required and must be a non-empty string.' };
  }

  const normalizedCategory = category.trim();
  if (!isMemoryCategory(normalizedCategory)) {
    return { ok: false, error: 'category must be one of: habit, experience, standard, workflow, framework, failure, simplification.' };
  }

  const content = body.content;
  if (typeof content !== 'string') {
    return { ok: false, error: 'content is required and must be a non-empty string.' };
  }

  const normalizedContent = content.trim();
  if (normalizedContent.length === 0) {
    return { ok: false, error: 'content is required and must be a non-empty string.' };
  }
  if (normalizedContent.length > MAX_MEMORY_CONTENT_LENGTH) {
    return { ok: false, error: `content must be at most ${MAX_MEMORY_CONTENT_LENGTH} characters.` };
  }

  const title = body.title;
  let normalizedTitle: string | undefined;
  if (title !== undefined) {
    if (typeof title !== 'string') {
      return { ok: false, error: 'title must be a non-empty string when provided.' };
    }
    normalizedTitle = title.trim();
    if (normalizedTitle.length === 0) {
      return { ok: false, error: 'title must be a non-empty string when provided.' };
    }
    if (normalizedTitle.length > MAX_MEMORY_TITLE_LENGTH) {
      return { ok: false, error: `title must be at most ${MAX_MEMORY_TITLE_LENGTH} characters.` };
    }
  }

  const tags = body.tags;
  let normalizedTags: string[] | undefined;
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string')) {
      return { ok: false, error: 'tags must be an array of strings when provided.' };
    }
    if (tags.length > MAX_MEMORY_TAG_COUNT) {
      return { ok: false, error: `tags must contain at most ${MAX_MEMORY_TAG_COUNT} items.` };
    }

    normalizedTags = tags.map(tag => tag.trim()).filter(tag => tag.length > 0);
    if (normalizedTags.some(tag => tag.length > MAX_MEMORY_TAG_LENGTH)) {
      return { ok: false, error: `each tag must be at most ${MAX_MEMORY_TAG_LENGTH} characters.` };
    }
  }

  return {
    ok: true,
    value: {
      category: normalizedCategory,
      content: normalizedContent,
      ...(normalizedTitle !== undefined ? { title: normalizedTitle } : {}),
      ...(normalizedTags !== undefined ? { tags: normalizedTags } : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMemoryCategory(value: string): value is MemoryCategory {
  return memoryCategories.some(category => category === value);
}
