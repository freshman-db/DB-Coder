import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MainLoop } from '../core/MainLoop.js';
import type { TaskStore } from '../memory/TaskStore.js';
import type { GlobalMemory } from '../memory/GlobalMemory.js';
import type { CostTracker } from '../utils/cost.js';
import type { Config } from '../config/Config.js';
import type { EvolutionEngine } from '../evolution/EvolutionEngine.js';
import type { PluginMonitor } from '../plugins/PluginMonitor.js';
import type { PatrolManager } from '../core/ModeManager.js';
import type { PlanWorkflow } from '../core/PlanWorkflow.js';
import type { PlanRequest } from '../prompts/brain.js';
import { log, type LogEntry } from '../utils/logger.js';
import { isRecord } from '../utils/parse.js';

interface RouteContext {
  loop: MainLoop;
  taskStore: TaskStore;
  globalMemory: GlobalMemory;
  costTracker: CostTracker;
  config: Config;
  evolutionEngine?: EvolutionEngine;
  pluginMonitor?: PluginMonitor;
  patrolManager?: PatrolManager;
  planWorkflow?: PlanWorkflow;
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
const VALID_DEPTHS = ['quick', 'normal', 'deep'] as const;
type ScanDepth = (typeof VALID_DEPTHS)[number];

class HttpError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
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

export function safeSseWrite(res: ServerResponse, data: string): boolean {
  if (res.writableEnded || res.destroyed) {
    return false;
  }
  try {
    res.write(data);
    return true;
  } catch {
    return false;
  }
}

interface SseStream {
  write(event: string, data: unknown): boolean;
  cleanup(): void;
}

interface SseStreamOptions {
  onCleanup?: () => void;
  connectionTimeoutMs?: number;
}

const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'Access-Control-Allow-Origin': '*',
};
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
const SSE_CONNECTION_TIMEOUT_MS = 30 * 60 * 1_000;
const SSE_MAX_CONNECTIONS_PER_ENDPOINT = 50;
const SSE_WARN_CONNECTION_THRESHOLD = Math.floor(SSE_MAX_CONNECTIONS_PER_ENDPOINT * 0.8);
const sseConnectionsByEndpoint = new Map<string, Set<symbol>>();

function reserveSseConnection(endpoint: string, res: ServerResponse): (() => void) | null {
  const normalizedEndpoint = endpoint.trim();
  const endpointKey = normalizedEndpoint.length > 0 ? normalizedEndpoint : 'unknown-sse-endpoint';
  const connections = sseConnectionsByEndpoint.get(endpointKey) ?? new Set<symbol>();
  if (!sseConnectionsByEndpoint.has(endpointKey)) {
    sseConnectionsByEndpoint.set(endpointKey, connections);
  }

  if (connections.size >= SSE_MAX_CONNECTIONS_PER_ENDPOINT) {
    log.warn('Rejecting SSE connection because endpoint limit was reached.', {
      endpoint: endpointKey,
      activeConnections: connections.size,
      connectionLimit: SSE_MAX_CONNECTIONS_PER_ENDPOINT,
    });
    json(res, { error: 'SSE connection limit exceeded. Please retry later.' }, 503);
    return null;
  }

  const connectionId = Symbol(endpointKey);
  connections.add(connectionId);
  const activeConnections = connections.size;
  if (activeConnections > SSE_WARN_CONNECTION_THRESHOLD) {
    log.warn('SSE connection count is nearing endpoint limit.', {
      endpoint: endpointKey,
      activeConnections,
      connectionLimit: SSE_MAX_CONNECTIONS_PER_ENDPOINT,
    });
  }

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    connections.delete(connectionId);
    if (connections.size === 0) {
      sseConnectionsByEndpoint.delete(endpointKey);
    }
  };
}

export function createSseStream(req: IncomingMessage, res: ServerResponse, options: SseStreamOptions = {}): SseStream {
  if (!req) {
    throw new TypeError('createSseStream requires an IncomingMessage instance.');
  }
  if (!res) {
    throw new TypeError('createSseStream requires a ServerResponse instance.');
  }

  const configuredTimeout = options.connectionTimeoutMs;
  const connectionTimeoutMs = typeof configuredTimeout === 'number' && Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : SSE_CONNECTION_TIMEOUT_MS;
  const onCleanup = options.onCleanup;

  res.writeHead(200, SSE_HEADERS);

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
    req.off('close', cleanup);
    if (typeof onCleanup === 'function') {
      try {
        onCleanup();
      } catch (error) {
        log.error('SSE cleanup callback failed.', error);
      }
    }
  };

  const write = (event: string, data: unknown): boolean => {
    if (cleanedUp) {
      return false;
    }

    const eventName = typeof event === 'string' && event.trim().length > 0 ? event.trim() : 'message';
    const serializedData = typeof data === 'string' ? data : JSON.stringify(data ?? null);
    const payload = `event: ${eventName}\ndata: ${serializedData}\n\n`;
    if (!safeSseWrite(res, payload)) {
      cleanup();
      return false;
    }
    return true;
  };

  heartbeat = setInterval(() => {
    if (!safeSseWrite(res, ': heartbeat\n\n')) {
      cleanup();
    }
  }, SSE_HEARTBEAT_INTERVAL_MS);

  timeoutHandle = setTimeout(() => {
    log.warn('SSE connection timed out and was closed automatically.', {
      timeoutMs: connectionTimeoutMs,
    });
    cleanup();
    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  }, connectionTimeoutMs);

  req.on('close', cleanup);

  return { write, cleanup };
}

interface StatusSseSnapshot {
  state: ReturnType<MainLoop['getState']>;
  currentTaskId: string | null;
  patrolling: boolean;
  paused: boolean;
}

interface StatusSsePayload extends StatusSseSnapshot {
  currentTaskTitle: string | null;
}

async function resolveCurrentTaskTitle(taskStore: TaskStore, taskId: string | null): Promise<string | null> {
  if (!taskId) {
    return null;
  }
  try {
    return (await taskStore.getTask(taskId))?.task_description ?? null;
  } catch {
    return null;
  }
}

// --- Status ---
route('GET', '/api/status', async (_req, res, ctx) => {
  const state = ctx.loop.getState();
  const taskId = ctx.loop.getCurrentTaskId();
  const currentTaskTitle = taskId
    ? (await ctx.taskStore.getTask(taskId))?.task_description ?? null
    : null;
  const paused = ctx.loop.isPaused();
  const patrolling = ctx.loop.isRunning();
  const daily = await ctx.costTracker.getDailySummary();
  const scanInterval = ctx.config.values.brain.scanInterval;
  json(res, {
    state,
    currentTaskId: taskId,
    currentTaskTitle,
    paused,
    patrolling,
    scanInterval,
    projectPath: ctx.config.projectPath,
    dailyCosts: daily,
  });
});

route('GET', '/api/status/stream', async (req, res, ctx) => {
  const releaseConnection = reserveSseConnection('/api/status/stream', res);
  if (!releaseConnection) {
    return;
  }

  let removeListener = () => {};
  const stream = createSseStream(req, res, {
    onCleanup: () => {
      releaseConnection();
      removeListener();
      removeListener = () => {};
    },
  });

  const pushStatus = async (snapshot: StatusSseSnapshot): Promise<boolean> => {
    const payload: StatusSsePayload = {
      ...snapshot,
      currentTaskTitle: await resolveCurrentTaskTitle(ctx.taskStore, snapshot.currentTaskId),
    };
    if (!stream.write('status', payload)) {
      return false;
    }
    return true;
  };

  const wroteInitialStatus = await pushStatus({
    state: ctx.loop.getState(),
    currentTaskId: ctx.loop.getCurrentTaskId(),
    patrolling: ctx.loop.isRunning(),
    paused: ctx.loop.isPaused(),
  });
  if (!wroteInitialStatus) {
    return;
  }

  removeListener = ctx.loop.addStatusListener((snapshot) => {
    void pushStatus(snapshot);
  });
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

route('GET', '/api/tasks', async (req, res, ctx) => {
  const url = new URL(req.url ?? '', `http://${req.headers.host}`);
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('pageSize') ?? '20', 10) || 20));
  const statusParam = url.searchParams.get('status');
  const status = statusParam
    ? statusParam.split(',').filter(Boolean) as import('../memory/types.js').TaskStatus[]
    : undefined;
  const result = await ctx.taskStore.listTasksPaged(ctx.config.projectPath, page, pageSize, status);
  json(res, result);
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
  if (ctx.loop.isRunning()) {
    json(res, { error: 'Cannot trigger manual scan while patrol is running' }, 409);
    return;
  }
  const body = await readBody(req);
  const rawDepth = isRecord(body) ? body.depth : undefined;
  const depth = rawDepth === undefined ? 'normal' : rawDepth;
  if (typeof depth !== 'string' || !isScanDepth(depth)) {
    throw new HttpError(400, 'Invalid depth');
  }
  ctx.loop.triggerScan(depth).catch(err => log.error('Scan error', err));
  json(res, { triggered: true, depth });
});

// --- Logs (SSE) ---
route('GET', '/api/logs', async (req, res, ctx) => {
  const url = new URL(req.url ?? '', `http://${req.headers.host}`);
  const followParam = url.searchParams.get('follow');
  const follow = followParam === null || followParam === 'true';

  if (follow) {
    const releaseConnection = reserveSseConnection('/api/logs', res);
    if (!releaseConnection) {
      return;
    }

    let removeListener = () => {};
    const stream = createSseStream(req, res, {
      onCleanup: () => {
        releaseConnection();
        removeListener();
        removeListener = () => {};
      },
    });

    removeListener = log.addListener((entry: LogEntry) => {
      if (!stream.write('message', entry)) {
        return;
      }
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

// --- Patrol Control ---
route('POST', '/api/patrol/start', async (_req, res, ctx) => {
  if (!ctx.patrolManager) { json(res, { error: 'Patrol manager not available' }, 503); return; }
  try {
    await ctx.patrolManager.startPatrol();
    json(res, { ok: true, patrolling: true });
  } catch (err) {
    if (err instanceof Error) { json(res, { error: err.message }, 409); return; }
    throw err;
  }
});

route('POST', '/api/patrol/stop', async (_req, res, ctx) => {
  if (!ctx.patrolManager) { json(res, { error: 'Patrol manager not available' }, 503); return; }
  try {
    await ctx.patrolManager.stopPatrol();
    json(res, { ok: true, patrolling: false });
  } catch (err) {
    if (err instanceof Error) { json(res, { error: err.message }, 400); return; }
    throw err;
  }
});

// --- Plans: Chat-based workflow ---
route('POST', '/api/plans/chat', async (_req, res, ctx) => {
  if (!ctx.planWorkflow) { json(res, { error: 'Plan workflow not available' }, 503); return; }
  const id = await ctx.planWorkflow.createChatSession(ctx.config.projectPath);
  json(res, { id }, 201);
});

async function handlePlanChatMessage(req: IncomingMessage, res: ServerResponse, ctx: RouteContext, params: Record<string, string>, successStatus: number): Promise<void> {
  if (!ctx.planWorkflow) { json(res, { error: 'Plan workflow not available' }, 503); return; }
  const id = parseInt(params.id, 10);
  if (isNaN(id)) { json(res, { error: 'Invalid plan ID' }, 400); return; }
  const body = await readBody(req);
  const message = isRecord(body) ? body.message : undefined;
  if (typeof message !== 'string' || message.trim().length === 0) {
    json(res, { error: 'message is required' }, 400);
    return;
  }
  ctx.planWorkflow.processUserMessage(id, message.trim())
    .catch(err => log.error(`Chat message processing failed for plan #${id}`, err));
  json(res, { ok: true }, successStatus);
}

route('POST', '/api/plans/:id/message', async (req, res, ctx, params) => {
  await handlePlanChatMessage(req, res, ctx, params, 202);
});

route('POST', '/api/plans/:id/chat', async (req, res, ctx, params) => {
  await handlePlanChatMessage(req, res, ctx, params, 200);
});

route('GET', '/api/plans/:id/messages', async (_req, res, ctx, params) => {
  const id = parseInt(params.id, 10);
  if (isNaN(id)) { json(res, { error: 'Invalid plan ID' }, 400); return; }
  const messages = await ctx.taskStore.getChatMessages(id);
  json(res, messages);
});

route('GET', '/api/plans/:id/stream', async (req, res, ctx, params) => {
  if (!ctx.planWorkflow) { json(res, { error: 'Plan workflow not available' }, 503); return; }
  const id = parseInt(params.id, 10);
  if (isNaN(id)) { json(res, { error: 'Invalid plan ID' }, 400); return; }

  const releaseConnection = reserveSseConnection('/api/plans/:id/stream', res);
  if (!releaseConnection) {
    return;
  }

  let remove = () => {};
  const stream = createSseStream(req, res, {
    onCleanup: () => {
      releaseConnection();
      remove();
      remove = () => {};
    },
  });

  remove = ctx.planWorkflow.addSSEListener(id, (event, data) => {
    if (!stream.write(event, data)) {
      return;
    }
  });
});

route('POST', '/api/plans/:id/generate', async (req, res, ctx, params) => {
  if (!ctx.planWorkflow) { json(res, { error: 'Plan workflow not available' }, 503); return; }
  const id = parseInt(params.id, 10);
  if (isNaN(id)) { json(res, { error: 'Invalid plan ID' }, 400); return; }
  ctx.planWorkflow.generatePlan(id, ctx.config.projectPath)
    .catch(err => log.error(`Plan generation failed for #${id}`, err));
  json(res, { ok: true, message: 'Plan generation started' }, 202);
});

route('POST', '/api/plans/:id/close', async (_req, res, ctx, params) => {
  if (!ctx.planWorkflow) { json(res, { error: 'Plan workflow not available' }, 503); return; }
  const id = parseInt(params.id, 10);
  if (isNaN(id)) { json(res, { error: 'Invalid plan ID' }, 400); return; }
  await ctx.planWorkflow.closeSession(id);
  json(res, { ok: true });
});

route('POST', '/api/plans/:id/resume', async (_req, res, ctx, params) => {
  if (!ctx.planWorkflow) { json(res, { error: 'Plan workflow not available' }, 503); return; }
  const id = parseInt(params.id, 10);
  if (isNaN(id)) { json(res, { error: 'Invalid plan ID' }, 400); return; }
  try {
    await ctx.planWorkflow.resumeSession(id);
    json(res, { ok: true });
  } catch (err) {
    if (err instanceof Error) { json(res, { error: err.message }, 400); return; }
    throw err;
  }
});

route('GET', '/api/plans', async (req, res, ctx) => {
  const url = new URL(req.url ?? '', `http://${req.headers.host}`);
  const status = url.searchParams.get('status') as import('../memory/types.js').PlanReviewStatus | null;
  const drafts = await ctx.taskStore.listPlanDrafts(ctx.config.projectPath, status ?? undefined);
  json(res, drafts);
});

route('GET', '/api/plans/:id', async (_req, res, ctx, params) => {
  const id = parseInt(params.id, 10);
  if (isNaN(id)) { json(res, { error: 'Invalid plan ID' }, 400); return; }
  const draft = await ctx.taskStore.getPlanDraft(id);
  if (!draft) { json(res, { error: 'not found' }, 404); return; }
  json(res, draft);
});

route('POST', '/api/plans/:id/approve', async (req, res, ctx, params) => {
  const id = parseInt(params.id, 10);
  if (isNaN(id)) { json(res, { error: 'Invalid plan ID' }, 400); return; }
  const body = await readBody(req) as Record<string, unknown>;
  const annotations = Array.isArray(body.annotations) ? body.annotations : undefined;
  await ctx.taskStore.updatePlanDraftStatus(id, 'approved', annotations);
  json(res, { ok: true, status: 'approved' });
});

route('POST', '/api/plans/:id/reject', async (_req, res, ctx, params) => {
  const id = parseInt(params.id, 10);
  if (isNaN(id)) { json(res, { error: 'Invalid plan ID' }, 400); return; }
  await ctx.taskStore.updatePlanDraftStatus(id, 'rejected');
  json(res, { ok: true, status: 'rejected' });
});

route('POST', '/api/plans/:id/revise', async (_req, res, ctx, params) => {
  if (!ctx.planWorkflow) { json(res, { error: 'Plan workflow not available' }, 503); return; }
  const id = parseInt(params.id, 10);
  if (isNaN(id)) { json(res, { error: 'Invalid plan ID' }, 400); return; }
  const revisePromise = ctx.planWorkflow.revisePlan(id);
  json(res, { ok: true, message: 'Plan revision started' }, 202);
  revisePromise.catch(err => log.error('Plan revision failed', err));
});

route('POST', '/api/plans/:id/execute', async (_req, res, ctx, params) => {
  if (!ctx.planWorkflow) { json(res, { error: 'Plan workflow not available' }, 503); return; }
  const id = parseInt(params.id, 10);
  if (isNaN(id)) { json(res, { error: 'Invalid plan ID' }, 400); return; }
  try {
    await ctx.planWorkflow.executeApprovedPlan(id);
    json(res, { ok: true, message: 'Plan tasks enqueued' });
  } catch (err) {
    if (err instanceof Error) { json(res, { error: err.message }, 400); return; }
    throw err;
  }
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
      if (err instanceof HttpError) {
        json(res, { error: err.message }, err.statusCode);
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
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_REQUEST_BODY_BYTES) {
        throw new HttpError(413, `Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes.`);
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(500, 'Failed to read request body.');
  }

  const raw = Buffer.concat(chunks).toString();
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
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

function isMemoryCategory(value: string): value is MemoryCategory {
  return memoryCategories.some(category => category === value);
}

function isScanDepth(value: string): value is ScanDepth {
  return VALID_DEPTHS.some(depth => depth === value);
}
