import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MainLoop } from '../core/MainLoop.js';
import type { TaskStore } from '../memory/TaskStore.js';
import type { GlobalMemory } from '../memory/GlobalMemory.js';
import type { CostTracker } from '../utils/cost.js';
import type { Config } from '../config/Config.js';
import { log, type LogEntry } from '../utils/logger.js';

interface RouteContext {
  loop: MainLoop;
  taskStore: TaskStore;
  globalMemory: GlobalMemory;
  costTracker: CostTracker;
  config: Config;
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse, ctx: RouteContext, params: Record<string, string>) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

const routes: Route[] = [];

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
  const body = await readBody(req);
  const { description, priority } = body as { description?: string; priority?: number };
  if (!description) { json(res, { error: 'description required' }, 400); return; }
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
  const body = await readBody(req) as { category?: string; title?: string; content?: string; tags?: string[] };
  if (!body.title || !body.content) { json(res, { error: 'title and content required' }, 400); return; }
  const memory = await ctx.globalMemory.add({
    category: (body.category as any) ?? 'experience',
    title: body.title,
    content: body.content,
    tags: body.tags ?? [],
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

// --- Route matching ---
export async function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  const url = new URL(req.url ?? '', `http://${req.headers.host}`);
  const method = req.method ?? 'GET';
  const pathname = url.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}
