import { ClaudeCodeSession } from '../bridges/ClaudeCodeSession.js';
import type { TaskStore } from '../memory/TaskStore.js';
import type { Config } from '../config/Config.js';
import { log } from '../utils/logger.js';

type SSEListener = (event: string, data: unknown) => void;

interface ActiveSession {
  draftId: number;
  sessionId: string;
  status: 'chatting' | 'processing' | 'closed';
  listeners: Set<SSEListener>;
  accumulatedText: string;
}

const PLAN_SYSTEM_PROMPT = [
  'You are a planning assistant helping the user design development tasks.',
  'Discuss requirements, clarify ambiguities, and help break down work into concrete tasks.',
  'Read CLAUDE.md for project context. Use claude-mem to search relevant past experiences.',
  'Do NOT modify source code — only read and analyze.',
].join(' ');

const GENERATE_PROMPT =
  'Based on our discussion, generate a concrete development plan with actionable tasks. ' +
  'Each task should be specific enough for an autonomous coding agent to execute independently.';

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Plan summary in markdown' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          priority: { type: 'number', minimum: 0, maximum: 3 },
        },
        required: ['description', 'priority'],
      },
    },
  },
  required: ['summary', 'tasks'],
} as const;

type PlanOutput = { summary: string; tasks: { description: string; priority: number }[] };

export class PlanChatManager {
  private sessions = new Map<number, ActiveSession>();

  constructor(
    private taskStore: TaskStore,
    private config: Config,
  ) {}

  /** Create a new plan chat session (plan_draft + in-memory state). */
  async createSession(): Promise<number> {
    const draft = await this.taskStore.createChatSession(this.config.projectPath);
    this.sessions.set(draft.id, {
      draftId: draft.id,
      sessionId: '',
      status: 'chatting',
      listeners: new Set(),
      accumulatedText: '',
    });
    return draft.id;
  }

  /** Send a user message and stream the assistant response via SSE listeners. */
  async sendMessage(draftId: number, message: string): Promise<void> {
    const session = this.getActiveSession(draftId);

    await this.taskStore.addChatMessage(draftId, 'user', message);

    session.status = 'processing';
    session.accumulatedText = '';
    this.emit(session, 'status', { status: 'researching' });

    const claude = new ClaudeCodeSession();
    try {
      const result = await claude.run(message, {
        permissionMode: 'bypassPermissions',
        resumeSessionId: session.sessionId || undefined,
        appendSystemPrompt: session.sessionId ? undefined : PLAN_SYSTEM_PROMPT,
        cwd: this.config.projectPath,
        maxTurns: 20,
        maxBudget: this.config.values.brain.maxScanBudget,
        timeout: 180_000,
        model: this.resolveModel(),
        disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
        onText: (text) => {
          session.accumulatedText = text;
          this.emit(session, 'assistant_text', { text });
        },
      });

      session.sessionId = result.sessionId;
      session.status = 'chatting';

      // Persist sessionId for potential server restart recovery
      if (result.sessionId) {
        await this.taskStore.updateChatSessionId(draftId, result.sessionId);
      }

      const responseText = result.text || session.accumulatedText;
      await this.taskStore.addChatMessage(draftId, 'assistant', responseText);

      this.emit(session, 'message', { role: 'assistant', content: responseText });
      this.emit(session, 'status', { status: 'chatting' });

      if (result.costUsd > 0) await this.taskStore.addDailyCost(result.costUsd);
    } catch (err) {
      session.status = 'chatting';
      this.emit(session, 'status', { status: 'chatting' });
      log.error('PlanChat send error', err);
      throw err;
    }
  }

  /** Ask Claude to output a structured plan from the conversation. */
  async generatePlan(draftId: number): Promise<void> {
    const session = this.getActiveSession(draftId);
    if (!session.sessionId) throw new Error('No conversation yet — send a message first');

    session.status = 'processing';
    this.emit(session, 'status', { status: 'generating' });

    const claude = new ClaudeCodeSession();
    try {
      const result = await claude.run(GENERATE_PROMPT, {
        permissionMode: 'bypassPermissions',
        resumeSessionId: session.sessionId,
        cwd: this.config.projectPath,
        maxTurns: 10,
        timeout: 120_000,
        model: this.resolveModel(),
        jsonSchema: PLAN_SCHEMA as unknown as object,
      });

      session.sessionId = result.sessionId;

      const plan = result.json as PlanOutput | undefined;
      if (plan?.tasks?.length) {
        await this.taskStore.updatePlanDraftPlan(draftId, {
          plan: { tasks: plan.tasks },
          markdown: plan.summary,
          reasoning: '',
          cost_usd: result.costUsd,
        });
        await this.taskStore.updateChatStatus(draftId, 'ready');
        session.status = 'chatting';
        this.emit(session, 'status', { status: 'ready' });
        this.emit(session, 'plan_ready', { tasks: plan.tasks.length });
      } else {
        throw new Error('Claude did not return a valid plan');
      }

      if (result.costUsd > 0) await this.taskStore.addDailyCost(result.costUsd);
    } catch (err) {
      session.status = 'chatting';
      this.emit(session, 'status', { status: 'chatting' });
      throw err;
    }
  }

  /** Create tasks in the queue from an approved plan. */
  async executePlan(draftId: number): Promise<number> {
    const draft = await this.taskStore.getPlanDraft(draftId);
    if (!draft || draft.status !== 'approved') throw new Error('Plan not approved');

    const tasks = (draft.plan as { tasks?: { description: string; priority: number }[] })?.tasks ?? [];
    let created = 0;
    for (const t of tasks) {
      await this.taskStore.createTask(this.config.projectPath, t.description, t.priority);
      created++;
    }
    return created;
  }

  async closeSession(draftId: number): Promise<void> {
    const session = this.sessions.get(draftId);
    if (session) {
      session.status = 'closed';
      this.sessions.delete(draftId);
    }
    await this.taskStore.updateChatStatus(draftId, 'closed');
  }

  async resumeSession(draftId: number): Promise<void> {
    const draft = await this.taskStore.getPlanDraft(draftId);
    if (!draft) throw new Error('Plan draft not found');

    this.sessions.set(draftId, {
      draftId,
      sessionId: draft.chat_session_id || '',
      status: 'chatting',
      listeners: new Set(),
      accumulatedText: '',
    });
    await this.taskStore.updateChatStatus(draftId, 'chatting');
  }

  /** Register an SSE listener. Returns unsubscribe function. */
  addListener(draftId: number, listener: SSEListener): () => void {
    const session = this.sessions.get(draftId);
    if (!session) return () => {};
    session.listeners.add(listener);
    // Send current status immediately
    listener('status', { status: session.status === 'processing' ? 'researching' : session.status });
    return () => session.listeners.delete(listener);
  }

  getSessionStatus(draftId: number): string {
    return this.sessions.get(draftId)?.status ?? 'closed';
  }

  // --- private ---

  private getActiveSession(draftId: number): ActiveSession {
    const session = this.sessions.get(draftId);
    if (!session) throw new Error('Session not found');
    if (session.status === 'closed') throw new Error('Session is closed');
    if (session.status === 'processing') throw new Error('Session is busy');
    return session;
  }

  private resolveModel(): string {
    return this.config.values.brain.model === 'opus' ? 'claude-opus-4-6' : 'claude-sonnet-4-6';
  }

  private emit(session: ActiveSession, event: string, data: unknown): void {
    for (const listener of session.listeners) {
      try { listener(event, data); } catch { /* listener error */ }
    }
  }
}
