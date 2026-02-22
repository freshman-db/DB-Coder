import type { Brain } from './Brain.js';
import type { ClaudeBridge, ChatSession } from '../bridges/ClaudeBridge.js';
import type { CodexBridge } from '../bridges/CodexBridge.js';
import type { TaskStore } from '../memory/TaskStore.js';
import type { TaskQueue } from './TaskQueue.js';
import type { Config } from '../config/Config.js';
import type { GlobalMemory } from '../memory/GlobalMemory.js';
import type { PlanRequest } from '../prompts/brain.js';
import type { PlanDraft, ChatStatus } from '../memory/types.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { log } from '../utils/logger.js';
import type { AgentResultMessage, AgentSystemPrompt } from '../types/agentSdk.js';
import { createInternalMcpServer } from '../mcp/InternalMcpServer.js';

export type { PlanRequest };

type SSEListener = (event: string, data: string) => void;

type ResultMessageContentBlock = {
  type?: unknown;
  text?: unknown;
};

type ResultMessageItem = {
  role?: unknown;
  content?: unknown;
};

type AgentResultMessageWithMessages = AgentResultMessage & {
  messages?: unknown;
};

export class PlanWorkflow {
  private chatSessions = new Map<number, ChatSession>();
  private sessionLocks = new Map<number, Promise<void>>();
  private sseListeners = new Map<number, Set<SSEListener>>();
  private streamingText = new Map<number, string>();

  constructor(
    private brain: Brain,
    private claude: ClaudeBridge,
    private codex: CodexBridge,
    private taskStore: TaskStore,
    private taskQueue: TaskQueue,
    private config: Config,
    private globalMemory: GlobalMemory,
  ) {}

  // === SSE Management ===

  addSSEListener(draftId: number, listener: SSEListener): () => void {
    let set = this.sseListeners.get(draftId);
    if (!set) {
      set = new Set();
      this.sseListeners.set(draftId, set);
    }
    set.add(listener);
    return () => { set!.delete(listener); };
  }

  private emit(draftId: number, event: string, data: unknown): void {
    const set = this.sseListeners.get(draftId);
    if (!set) return;
    const json = typeof data === 'string' ? data : JSON.stringify(data);
    for (const listener of set) {
      try { listener(event, json); } catch { /* ignore */ }
    }
  }

  // === Chat Session Lifecycle ===

  async createChatSession(projectPath: string): Promise<number> {
    const draft = await this.taskStore.createChatSession(projectPath);
    this.startSession(draft.id, projectPath);
    log.info(`Plan chat session created: #${draft.id}`);
    return draft.id;
  }

  private startSession(draftId: number, projectPath: string, resume?: string): void {
    const internalMcpServer = createInternalMcpServer({
      projectPath,
      taskStore: this.taskStore,
      globalMemory: this.globalMemory,
    });

    const systemPrompt: AgentSystemPrompt = {
      type: 'preset',
      preset: 'claude_code',
      append: `你是一个专业的代码架构师和需求分析师。你正在帮助用户梳理和细化一个编程任务的需求。

你的工作流程：
1. 仔细理解用户的需求描述
2. 使用可用的工具（Read, Glob, Grep, Bash）主动研究项目代码库
3. 优先使用 db-coder-tools 中的工具直接操作系统能力：
   - add_task(description, priority): 创建任务
   - list_tasks(status?): 查看任务状态
   - search_memory(query): 搜索历史经验
   - get_status(): 查看项目整体状态
4. 提出澄清问题，帮助用户明确需求细节
5. 分析技术可行性和潜在风险
6. 当需求足够清晰时，输出 [READY_TO_PLAN] 标记，表示可以生成正式计划

请用中文回复用户。每次回复都应该推进需求的梳理进度。`,
    };

    const session = this.claude.createChatSession(
      projectPath,
      (msg: SDKMessage) => this.handleSDKMessage(draftId, msg),
      {
        systemPrompt,
        internalMcpServers: {
          'db-coder-tools': internalMcpServer,
        },
        ...(resume && { resume }),
      },
    );
    this.chatSessions.set(draftId, session);
  }

  private async handleSDKMessage(draftId: number, msg: SDKMessage): Promise<void> {
    // Extract text deltas from stream events and emit accumulated text
    if (msg.type === 'stream_event') {
      const event = msg.event;
      if (event?.type === 'content_block_delta' && event?.delta?.type === 'text_delta' && event.delta.text) {
        const accumulated = (this.streamingText.get(draftId) ?? '') + event.delta.text;
        this.streamingText.set(draftId, accumulated);
        this.emit(draftId, 'assistant_text', { text: accumulated });
      }
      return;
    }

    // assistant complete message — reset streaming accumulator
    if (msg.type === 'assistant') {
      this.streamingText.delete(draftId);
      return;
    }

    // result message — one round of conversation done
    if (msg.type === 'result') {
      this.streamingText.delete(draftId);
      const resultMessage: AgentResultMessage = msg;
      const text = this.extractAssistantText(resultMessage);
      const cost = resultMessage.total_cost_usd ?? 0;

      // Save assistant message to DB
      if (text) {
        await this.taskStore.addChatMessage(draftId, 'assistant', text, { cost });
        this.emit(draftId, 'message', { role: 'assistant', content: text });
      }
      await this.taskStore.addDailyCost(cost);

      // Save session ID for potential resume
      const session = this.chatSessions.get(draftId);
      if (session?.sessionId) {
        await this.taskStore.updateChatSessionId(draftId, session.sessionId);
      }

      // Check [READY_TO_PLAN]
      if (text.includes('[READY_TO_PLAN]')) {
        await this.taskStore.updateChatStatus(draftId, 'ready');
        this.emit(draftId, 'status', { status: 'ready' });
      } else {
        await this.taskStore.updateChatStatus(draftId, 'chatting');
        this.emit(draftId, 'status', { status: 'chatting' });
      }
    }
  }

  private extractAssistantText(msg: AgentResultMessage): string {
    if (msg.result) return msg.result;

    const messages = (msg as AgentResultMessageWithMessages).messages;
    if (!Array.isArray(messages)) return '';

    return messages
      .filter((message): message is ResultMessageItem & { role: 'assistant' } => (
        typeof message === 'object'
        && message !== null
        && (message as ResultMessageItem).role === 'assistant'
      ))
      .map((message) => {
        if (typeof message.content === 'string') return message.content;
        if (!Array.isArray(message.content)) return '';
        return message.content
          .filter((block): block is ResultMessageContentBlock & { type: 'text' } => (
            typeof block === 'object'
            && block !== null
            && (block as ResultMessageContentBlock).type === 'text'
          ))
          .map((block) => typeof block.text === 'string' ? block.text : '')
          .join('');
      })
      .filter(Boolean)
      .join('\n');
  }

  async processUserMessage(draftId: number, userMessage: string): Promise<void> {
    // Save user message to DB
    await this.taskStore.addChatMessage(draftId, 'user', userMessage);
    this.emit(draftId, 'message', { role: 'user', content: userMessage });

    const existingLock = this.sessionLocks.get(draftId);
    if (existingLock) {
      await existingLock;
    }

    // Get or start ChatSession
    let session = this.chatSessions.get(draftId);
    if (!session) {
      let releaseLock: (() => void) | undefined;
      const lock = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      this.sessionLocks.set(draftId, lock);

      try {
        const draft = await this.taskStore.getPlanDraft(draftId);
        if (!draft) throw new Error(`Plan draft #${draftId} not found`);
        this.startSession(draftId, draft.project_path);
        session = this.chatSessions.get(draftId)!;
      } finally {
        releaseLock?.();
        this.sessionLocks.delete(draftId);
      }
    }

    // Update status
    await this.taskStore.updateChatStatus(draftId, 'researching');
    this.emit(draftId, 'status', { status: 'researching' });

    // Push message to channel — Claude processes it automatically
    session.channel.push({
      type: 'user',
      message: { role: 'user', content: userMessage },
      parent_tool_use_id: null,
      session_id: session.sessionId || '',
    });
  }

  async generatePlan(draftId: number, projectPath: string): Promise<void> {
    // Build description from chat history
    const messages = await this.taskStore.getChatMessages(draftId);
    const description = messages.filter(m => m.role === 'user').map(m => m.content).join('\n');

    await this.taskStore.updateChatStatus(draftId, 'generating');
    this.emit(draftId, 'status', { status: 'generating' });

    try {
      // Reuse existing research → plan pipeline
      const request: PlanRequest = { description };
      const { report, cost: rCost } = await this.brain.research(projectPath, request);
      const { plan, markdown, reasoning, cost: pCost } = await this.brain.createPlanWithMarkdown(
        projectPath, report, request,
      );

      await this.taskStore.addDailyCost(rCost + pCost);
      await this.taskStore.updatePlanDraftPlan(draftId, { plan, markdown, reasoning, cost_usd: rCost + pCost });
      await this.taskStore.updateChatStatus(draftId, 'ready');
      await this.taskStore.updatePlanDraftStatus(draftId, 'draft');

      this.emit(draftId, 'status', { status: 'ready' });
      this.emit(draftId, 'plan_ready', { draftId, taskCount: plan.tasks.length });

      log.info(`Plan generated for session #${draftId}: ${plan.tasks.length} tasks`);
    } catch (err) {
      await this.taskStore.updateChatStatus(draftId, 'error');
      this.emit(draftId, 'status', { status: 'error', error: String(err) });
      throw err;
    } finally {
      // Close persistent process
      this.closeSession(draftId);
    }
  }

  // === Original submit flow (kept for backward compat) ===

  async submitRequest(projectPath: string, request: PlanRequest): Promise<number> {
    log.info(`Plan request submitted: ${request.description.slice(0, 80)}`);
    let totalCost = 0;

    const { report: researchReport, cost: researchCost } = await this.brain.research(projectPath, request);
    totalCost += researchCost;

    const { plan, markdown, reasoning, cost: planCost } = await this.brain.createPlanWithMarkdown(
      projectPath, researchReport, request,
    );
    totalCost += planCost;

    await this.taskStore.addDailyCost(totalCost);

    const draft = await this.taskStore.savePlanDraft({
      project_path: projectPath,
      plan,
      analysis_summary: researchReport.slice(0, 10000),
      reasoning,
      markdown,
      cost_usd: totalCost,
    });

    log.info(`Plan draft created: #${draft.id} with ${plan.tasks.length} tasks`);
    return draft.id;
  }

  async executeApprovedPlan(draftId: number): Promise<void> {
    const draft = await this.taskStore.getPlanDraft(draftId);
    if (!draft) throw new Error(`Plan draft #${draftId} not found`);
    if (draft.status !== 'approved') throw new Error(`Plan draft #${draftId} is not approved (status: ${draft.status})`);

    const projectPath = draft.project_path;
    const plan = draft.plan as import('./types.js').TaskPlan;

    log.info(`Executing approved plan #${draftId}: ${plan.tasks?.length ?? 0} tasks`);

    const taskIds = await this.taskQueue.enqueue(projectPath, plan);
    log.info(`Plan #${draftId} execution started: ${taskIds.length} tasks enqueued`);
  }

  async revisePlan(draftId: number): Promise<number> {
    const draft = await this.taskStore.getPlanDraft(draftId);
    if (!draft) throw new Error(`Plan draft #${draftId} not found`);

    const feedback = (draft.annotations ?? [])
      .map(a => `Task #${a.task_index}: ${a.action}${a.comment ? ` — ${a.comment}` : ''}${a.modified_description ? ` → "${a.modified_description}"` : ''}`)
      .join('\n');

    const originalPlan = draft.plan as { reasoning?: string };
    const request: PlanRequest = {
      description: `Revise the previous plan based on reviewer feedback.\n\nOriginal reasoning: ${originalPlan.reasoning ?? draft.reasoning}\n\nFeedback:\n${feedback}`,
      constraints: [`Address all reviewer feedback from plan #${draftId}`],
    };

    const newDraftId = await this.submitRequest(draft.project_path, request);
    await this.taskStore.updatePlanDraftStatus(draftId, 'expired');

    return newDraftId;
  }

  // === Process lifecycle ===

  async resumeSession(draftId: number): Promise<void> {
    if (this.chatSessions.has(draftId)) {
      throw new Error('Session is already active');
    }
    const draft = await this.taskStore.getPlanDraft(draftId) as PlanDraft | null;
    if (!draft) throw new Error('Plan draft not found');
    if (!draft.chat_session_id) throw new Error('No session ID to resume');

    this.startSession(draftId, draft.project_path, draft.chat_session_id);
    await this.taskStore.updateChatStatus(draftId, 'chatting');
    this.emit(draftId, 'status', { status: 'chatting' });
    log.info(`Plan chat session resumed: #${draftId} (session=${draft.chat_session_id})`);
  }

  async closeSession(draftId: number): Promise<void> {
    this.chatSessions.get(draftId)?.close();
    this.chatSessions.delete(draftId);
    await this.taskStore.updateChatStatus(draftId, 'closed');
    this.emit(draftId, 'status', { status: 'closed' });
    this.sseListeners.delete(draftId);
  }

  shutdown(): void {
    for (const [id] of this.chatSessions) {
      this.closeSession(id);
    }
  }
}
